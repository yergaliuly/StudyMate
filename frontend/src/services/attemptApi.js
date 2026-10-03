import { apiClient, ApiError } from './apiClient.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const INVALID_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u;
const STATUSES = new Set(['in_progress', 'completed']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

function sameId(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase();
}

function requireUuid(value, field) {
  if (!isUuid(value)) throw new TypeError(field + ' должен быть UUID.');
  return value;
}

function isText(value, max) {
  return typeof value === 'string' && value.trim().length > 0
    && value.length <= max && !INVALID_TEXT.test(value);
}

function isTimestamp(value) {
  if (typeof value !== 'string' || !UTC_TIME.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time)
    && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}

function timeKey(value) {
  const [seconds, fraction = ''] = value.slice(0, -1).split('.');
  // Сохраняем точность серверной даты: Date.parse отбрасывает доли меньше миллисекунды.
  return seconds + '.' + fraction.padEnd(9, '0');
}

function invalidResponse(status) {
  return new ApiError('Ответ сервера не соответствует контракту попыток.', {
    status, code: 'INVALID_RESPONSE',
  });
}

function readQuestions(data, status) {
  if (!Array.isArray(data) || data.length !== 10) throw invalidResponse(status);
  const questionIds = new Set();
  const optionIds = new Set();
  return data.map((question, index) => {
    if (!isRecord(question) || !isUuid(question.id) || questionIds.has(question.id.toLowerCase())
      || question.position !== index + 1 || !isText(question.text, 1000)
      || !Array.isArray(question.options) || question.options.length !== 4) throw invalidResponse(status);
    questionIds.add(question.id.toLowerCase());
    const options = question.options.map((option, optionIndex) => {
      if (!isRecord(option) || !isUuid(option.id) || optionIds.has(option.id.toLowerCase())
        || option.position !== optionIndex + 1 || !isText(option.text, 500)) throw invalidResponse(status);
      optionIds.add(option.id.toLowerCase());
      return { id: option.id, position: option.position, text: option.text };
    });
    // Даже в completed правильность доступна только в review.
    return { id: question.id, position: question.position, text: question.text, options };
  });
}

function readReview(data, questions, status) {
  if (!Array.isArray(data) || data.length !== 10) throw invalidResponse(status);
  return data.map((item, index) => {
    const question = questions[index];
    const options = new Set(question.options.map((option) => option.id.toLowerCase()));
    if (!isRecord(item) || !sameId(item.questionId, question.id)
      || !isUuid(item.correctOptionId) || !options.has(item.correctOptionId.toLowerCase())
      || (item.selectedOptionId !== null
        && (!isUuid(item.selectedOptionId) || !options.has(item.selectedOptionId.toLowerCase())))
      || typeof item.isCorrect !== 'boolean'
      || item.isCorrect !== sameId(item.selectedOptionId, item.correctOptionId)
      || !isText(item.explanation, 2000)
      || !Array.isArray(item.sourcePages) || item.sourcePages.length < 1 || item.sourcePages.length > 8
      || item.sourcePages.some((page, pageIndex, pages) => !Number.isSafeInteger(page)
        || page < 1 || page > 200 || (pageIndex > 0 && page <= pages[pageIndex - 1]))) {
      throw invalidResponse(status);
    }
    return {
      questionId: item.questionId, selectedOptionId: item.selectedOptionId,
      correctOptionId: item.correctOptionId, isCorrect: item.isCorrect,
      explanation: item.explanation, sourcePages: [...item.sourcePages],
    };
  });
}

function readAttempt(result, expected) {
  const { data, status } = result;
  if (status !== expected.status || !isRecord(data)
    || !isUuid(data.id) || !isUuid(data.quizId) || !isUuid(data.materialId)
    || (expected.id && !sameId(data.id, expected.id))
    || (expected.quizId && !sameId(data.quizId, expected.quizId))
    || !Number.isSafeInteger(data.quizVersion) || data.quizVersion < 1
    || !STATUSES.has(data.status) || (expected.completed && data.status !== 'completed')
    || data.questionCount !== 10 || !isTimestamp(data.startedAt)) throw invalidResponse(status);
  const questions = readQuestions(data.questions, status);
  let review = null;
  if (data.status === 'in_progress') {
    if (data.completedAt !== null || data.correctCount !== null
      || data.scorePercent !== null || data.review !== null) throw invalidResponse(status);
  } else {
    if (!isTimestamp(data.completedAt) || timeKey(data.completedAt) < timeKey(data.startedAt)
      || !Number.isSafeInteger(data.correctCount) || data.correctCount < 0 || data.correctCount > 10
      || typeof data.scorePercent !== 'number' || data.scorePercent !== data.correctCount * 10) {
      throw invalidResponse(status);
    }
    review = readReview(data.review, questions, status);
    if (review.filter((item) => item.isCorrect).length !== data.correctCount) throw invalidResponse(status);
  }
  // Только поля публичного DTO; текст остаётся точным, HTML не преобразуется.
  return {
    id: data.id, quizId: data.quizId, materialId: data.materialId,
    quizVersion: data.quizVersion, status: data.status, questionCount: data.questionCount,
    startedAt: data.startedAt, completedAt: data.completedAt,
    correctCount: data.correctCount, scorePercent: data.scorePercent,
    questions, review,
  };
}

function normalizeAnswers(answers) {
  if (!Array.isArray(answers)) throw new TypeError('answers должен быть массивом.');
  if (answers.length > 10) throw new RangeError('В попытке не больше 10 ответов.');
  const ids = new Set();
  // Array.from также проверяет пустые элементы разреженного массива.
  return Array.from(answers, (answer) => {
    if (!isRecord(answer) || Object.keys(answer).some((key) => !['questionId', 'optionId'].includes(key))) {
      throw new TypeError('Ответ должен содержать только questionId и optionId.');
    }
    const questionId = requireUuid(answer.questionId, 'questionId');
    const optionId = answer.optionId === undefined || answer.optionId === null
      ? null : requireUuid(answer.optionId, 'optionId');
    if (ids.has(questionId.toLowerCase())) throw new RangeError('Вопрос не должен повторяться в answers.');
    ids.add(questionId.toLowerCase());
    return { questionId, optionId };
  });
}

function matchesSubmitted(attempt, answers) {
  const questions = new Set(attempt.questions.map((question) => question.id.toLowerCase()));
  if (answers.some((answer) => !questions.has(answer.questionId.toLowerCase()))) return false;
  const selections = new Map(answers.map((answer) => [answer.questionId.toLowerCase(), answer.optionId]));
  return attempt.review.every((item) => {
    const submitted = selections.get(item.questionId.toLowerCase()) ?? null;
    return submitted === null ? item.selectedOptionId === null : sameId(submitted, item.selectedOptionId);
  });
}

export function createAttemptApi(client = apiClient) {
  async function start(quizId, { idempotencyKey, signal } = {}) {
    requireUuid(quizId, 'quizId');
    const key = requireUuid(idempotencyKey, 'Idempotency-Key');
    return readAttempt(await client.request('/quizzes/' + quizId + '/attempts', {
      method: 'POST', idempotencyKey: key, signal,
    }), { status: 201, quizId });
  }

  async function submit(attemptId, answers, { signal } = {}) {
    requireUuid(attemptId, 'attemptId');
    const normalized = normalizeAnswers(answers);
    const result = await client.request('/attempts/' + attemptId + '/submit', {
      method: 'POST', body: { answers: normalized }, signal,
    });
    const attempt = readAttempt(result, { status: 200, id: attemptId, completed: true });
    if (!matchesSubmitted(attempt, normalized)) throw invalidResponse(result.status);
    return attempt;
  }

  async function getById(attemptId, { signal } = {}) {
    requireUuid(attemptId, 'attemptId');
    return readAttempt(await client.request('/attempts/' + attemptId, {
      method: 'GET', signal,
    }), { status: 200, id: attemptId });
  }

  // Нет автоматических повторов, генерации ключей или обращения к jobs.
  return { start, submit, getById };
}

export const attemptApi = createAttemptApi();
