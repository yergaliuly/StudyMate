import { apiClient, ApiError } from './apiClient.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const INVALID_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u;
const INVALID_LABEL = /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u;
const GENERATION_STATUSES = new Set(['not_started', 'queued', 'running', 'ready', 'failed', 'cancelled']);
const ERROR_CODES = new Set([
  'JOB_TEMPORARY_FAILURE', 'JOB_PROCESSING_FAILED', 'JOB_ATTEMPTS_EXHAUSTED',
  'JOB_LEASE_EXPIRED', 'JOB_OUTCOME_UNKNOWN', 'AI_UNAVAILABLE',
  'AI_INVALID_RESPONSE', 'AI_OUTCOME_UNKNOWN', 'QUIZ_INSUFFICIENT_CONTENT',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

function requireUuid(value, field) {
  if (!isUuid(value)) throw new TypeError(field + ' должен быть UUID.');
  return value;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isText(value, max, invalid = INVALID_TEXT) {
  return typeof value === 'string' && value.trim().length > 0
    && value.length <= max && !invalid.test(value);
}

function isTimestamp(value) {
  if (typeof value !== 'string' || !UTC_TIME.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19);
}

function invalidResponse(status) {
  return new ApiError('Ответ сервера не соответствует контракту тестов.', {
    status, code: 'INVALID_RESPONSE',
  });
}

function readInfo(data, status) {
  if (!isRecord(data) || !isUuid(data.id) || !isUuid(data.materialId)
    || !isPositiveInteger(data.version) || data.questionCount !== 10
    || !isText(data.model, 80, INVALID_LABEL) || !isTimestamp(data.createdAt)) {
    throw invalidResponse(status);
  }
  return {
    id: data.id, materialId: data.materialId, version: data.version,
    questionCount: data.questionCount, model: data.model, createdAt: data.createdAt,
  };
}

function readGeneration(data, total, status) {
  if (!isRecord(data) || !GENERATION_STATUSES.has(data.status)) throw invalidResponse(status);
  const validJob = data.status === 'not_started'
    ? data.jobId === null && total === 0 : isUuid(data.jobId);
  const validError = data.status === 'failed'
    ? isRecord(data.error) && ERROR_CODES.has(data.error.code)
      && isText(data.error.message, Number.MAX_SAFE_INTEGER)
    : data.error === null;
  if (!validJob || !validError || (data.status === 'ready' && total === 0)) {
    throw invalidResponse(status);
  }
  return {
    status: data.status, jobId: data.jobId,
    error: data.error === null ? null : { code: data.error.code, message: data.error.message },
  };
}

function readList(result, materialId, page, pageSize) {
  const { data, meta, status } = result;
  if (status !== 200 || !Array.isArray(data) || !isRecord(meta)
    || meta.page !== page || meta.pageSize !== pageSize
    || !Number.isSafeInteger(meta.total) || meta.total < 0) {
    throw invalidResponse(status);
  }
  // Не умножаем произвольный номер страницы: offset вычисляется только внутри total.
  const expectedLength = page > Math.ceil(meta.total / pageSize)
    ? 0 : Math.min(pageSize, meta.total - (page - 1) * pageSize);
  if (data.length !== expectedLength) throw invalidResponse(status);
  const ids = new Set();
  let previousVersion = Infinity;
  const quizzes = data.map((item) => {
    const info = readInfo(item, status);
    const id = info.id.toLowerCase();
    if (info.materialId.toLowerCase() !== materialId.toLowerCase()
      || ids.has(id) || info.version >= previousVersion) throw invalidResponse(status);
    ids.add(id);
    previousVersion = info.version;
    return info;
  });
  return {
    quizzes,
    meta: { page, pageSize, total: meta.total, generation: readGeneration(meta.generation, meta.total, status) },
  };
}

function readQuiz(result, requestedId) {
  const { data, status } = result;
  if (status !== 200) throw invalidResponse(status);
  const info = readInfo(data, status);
  if (info.id.toLowerCase() !== requestedId.toLowerCase()
    || !Array.isArray(data.questions) || data.questions.length !== 10) throw invalidResponse(status);
  const questionIds = new Set();
  const optionIds = new Set();
  const questions = data.questions.map((question, index) => {
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
    return { id: question.id, position: question.position, text: question.text, options };
  });
  // Копируем только публичную проекцию; ответы, объяснения и sourcePages не попадают в UI.
  // Текст остаётся точным plain text, без HTML-преобразований и нормализации.
  return { ...info, questions };
}

export function createQuizApi(client = apiClient) {
  async function generate(materialId, { idempotencyKey, signal } = {}) {
    requireUuid(materialId, 'materialId');
    const key = requireUuid(idempotencyKey, 'Idempotency-Key');
    const result = await client.request('/materials/' + materialId + '/quizzes', {
      method: 'POST', idempotencyKey: key, signal,
    });
    const data = result.data;
    if (result.status !== 202 || !isRecord(data) || !isUuid(data.materialId)
      || data.materialId.toLowerCase() !== materialId.toLowerCase() || !isUuid(data.jobId)) {
      throw invalidResponse(result.status);
    }
    // Только явный запрос вызывающего кода с его ключом; автоматических повторов нет.
    return { materialId: data.materialId, jobId: data.jobId };
  }

  async function list(materialId, { page = 1, pageSize = 20, signal } = {}) {
    requireUuid(materialId, 'materialId');
    if (!isPositiveInteger(page) || !isPositiveInteger(pageSize) || pageSize > 100) {
      throw new RangeError('Укажи положительную целую страницу и размер страницы от 1 до 100.');
    }
    return readList(await client.request('/materials/' + materialId + '/quizzes', {
      method: 'GET', query: { page, pageSize }, signal,
    }), materialId, page, pageSize);
  }

  async function getById(quizId, { signal } = {}) {
    requireUuid(quizId, 'quizId');
    return readQuiz(await client.request('/quizzes/' + quizId, { method: 'GET', signal }), quizId);
  }

  return { generate, list, getById };
}

export const quizApi = createQuizApi();
