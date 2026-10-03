import { attemptApi } from './attemptApi.js';
import { materialApi } from './materialApi.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sameId = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();
const invalidResponse = () => ({ status: 200, code: 'INVALID_RESPONSE' });
const copyAnswers = (answers) => answers.map(({ questionId, optionId }) => ({ questionId, optionId }));

function copyQuestions(questions) {
  return questions.map(({ id, position, text, options }) => ({
    id, position, text,
    options: options.map(({ id: optionId, position: optionPosition, text: optionText }) => ({
      id: optionId, position: optionPosition, text: optionText,
    })),
  }));
}

function copyAttempt(value) {
  return value ? {
    id: value.id, quizId: value.quizId, materialId: value.materialId,
    quizVersion: value.quizVersion, status: value.status, questionCount: value.questionCount,
    startedAt: value.startedAt, completedAt: value.completedAt,
    correctCount: value.correctCount, scorePercent: value.scorePercent,
    questions: copyQuestions(value.questions),
    review: value.status === 'completed' ? value.review.map((item) => ({
      questionId: item.questionId, selectedOptionId: item.selectedOptionId,
      correctOptionId: item.correctOptionId, isCorrect: item.isCorrect,
      explanation: item.explanation, sourcePages: [...item.sourcePages],
    })) : null,
  } : null;
}

function emptyView() {
  return {
    phase: 'idle', attempt: null, pending: false, reading: false, message: '',
    canStart: true, canRetryStart: false, canChoose: false,
    canSubmit: false, canRetrySubmit: false, canRefresh: false,
  };
}

function newDraft(attemptId = null) {
  return {
    attemptId, answers: [], frozenAnswers: null, startAttempt: null, usedKeys: [], completion: null,
    submitUncertain: false, unavailable: false, retryAt: 0, operation: null,
    view: emptyView(),
  };
}

function entry(record, id, existingAttemptId = null) {
  if (!record || typeof record !== 'object' || typeof id !== 'string' || !UUID.test(id)) {
    throw new TypeError('Нужны запись предмета и UUID теста.');
  }
  if (existingAttemptId !== null && (typeof existingAttemptId !== 'string' || !UUID.test(existingAttemptId))) {
    throw new TypeError('Нужен UUID существующей попытки.');
  }
  record.quizAttempts ??= {};
  record.attemptDrafts ??= {};
  if (existingAttemptId) {
    const key = existingAttemptId.toLowerCase();
    const current = record.quizAttempts[id.toLowerCase()];
    record.attemptDrafts[key] ??= sameId(current?.attemptId, existingAttemptId)
      ? current : newDraft(existingAttemptId);
    return record.attemptDrafts[key];
  }
  record.quizAttempts[id.toLowerCase()] ??= newDraft();
  return record.quizAttempts[id.toLowerCase()];
}

function snapshot(draft) {
  return {
    ...draft.view, attempt: copyAttempt(draft.view.attempt),
    attemptId: draft.attemptId, answers: copyAnswers(draft.answers), retryAt: draft.retryAt,
    frozen: Boolean(draft.frozenAnswers), submitUncertain: draft.submitUncertain,
    startUncertain: Boolean(draft.startAttempt?.uncertain),
  };
}

export function getQuizAttemptState(record, quizId, existingAttemptId = null) {
  return snapshot(entry(record, quizId, existingAttemptId));
}

export function createQuizAttemptController({
  record, quiz, materialId, subjectId, canAct, onChange, onAccessError,
  existingAttemptId = null,
  api = attemptApi, materials = materialApi, now = Date.now,
  makeKey = () => globalThis.crypto.randomUUID(),
}) {
  if (typeof materialId !== 'string' || !UUID.test(materialId)
    || typeof subjectId !== 'string' || !UUID.test(subjectId)
    || !sameId(quiz?.materialId, materialId) || !Number.isSafeInteger(quiz.version)
    || quiz.version < 1 || quiz.questionCount !== 10 || !Array.isArray(quiz.questions)
    || quiz.questions.length !== 10 || quiz.questions.some((question) => !Array.isArray(question.options)
      || question.options.length !== 4)) throw new TypeError('Нужна сохранённая версия теста и UUID предмета.');
  const quizId = quiz.id;
  const quizVersion = quiz.version;
  const questions = copyQuestions(quiz.questions);
  const blankAnswers = () => questions.map(({ id }) => ({ questionId: id, optionId: null }));
  const draft = entry(record, quizId, existingAttemptId);
  if (!draft.answers.length) draft.answers = blankAnswers();
  let stopped = false;
  let request = null;
  let epoch = 0;
  let verified = false;

  const owns = () => existingAttemptId
    ? record.attemptDrafts?.[existingAttemptId.toLowerCase()] === draft
    : record.quizAttempts?.[quizId.toLowerCase()] === draft;
  const active = () => !stopped && owns() && canAct(quizId);
  const busy = () => request || draft.operation || draft.view.pending || draft.view.reading;
  const waiting = () => now() < draft.retryAt;
  const unresolvedStart = () => Boolean(draft.startAttempt && !draft.startAttempt.resolved);

  function flags() {
    const idle = !draft.view.pending && !draft.view.reading && !draft.unavailable;
    const current = idle && verified && draft.view.attempt;
    return {
      canStart: Boolean(!existingAttemptId && idle && !unresolvedStart()
        && (!draft.attemptId || (current && draft.view.attempt.status === 'completed'))),
      canRetryStart: Boolean(!existingAttemptId && idle && unresolvedStart() && !draft.startAttempt.blocked),
      canChoose: Boolean(current && draft.view.attempt.status === 'in_progress' && !draft.frozenAnswers),
      canSubmit: Boolean(current && draft.view.attempt.status === 'in_progress' && !draft.frozenAnswers),
      canRetrySubmit: Boolean(current && draft.view.attempt.status === 'in_progress' && draft.frozenAnswers),
      canRefresh: Boolean(draft.attemptId && !draft.view.pending && !draft.view.reading),
    };
  }

  function publish(changes = {}, persistent = {}) {
    if (!active()) return;
    Object.assign(draft, persistent);
    Object.assign(draft.view, changes);
    Object.assign(draft.view, flags());
    onChange(snapshot(draft));
  }

  // A restored attempt must be read before its questions or result become actionable.
  Object.assign(draft.view, emptyView(), flags());

  function begin(kind) {
    const operation = { kind, controller: new AbortController(), epoch: ++epoch, submitted: false };
    request = operation;
    draft.operation = operation;
    return {
      operation,
      current: () => active() && request === operation && draft.operation === operation
        && epoch === operation.epoch && !operation.controller.signal.aborted,
    };
  }

  function release(operation) {
    if (!active()) return;
    if (request === operation) request = null;
    if (draft.operation === operation) draft.operation = null;
  }

  function matchingQuestions(value) {
    return Array.isArray(value) && value.length === questions.length && value.every((question, index) => {
      const expected = questions[index];
      return sameId(question?.id, expected.id) && question.position === expected.position
        && question.text === expected.text && Array.isArray(question.options)
        && question.options.length === expected.options.length && question.options.every((option, optionIndex) => {
          const expectedOption = expected.options[optionIndex];
          return sameId(option?.id, expectedOption.id) && option.position === expectedOption.position
            && option.text === expectedOption.text;
        });
    });
  }

  function validAttempt(value, expectedId = null) {
    const valid = typeof value?.id === 'string' && UUID.test(value.id)
      && (!expectedId || sameId(value.id, expectedId)) && sameId(value.quizId, quizId)
      && sameId(value.materialId, materialId) && value.quizVersion === quizVersion
      && value.questionCount === 10 && matchingQuestions(value.questions)
      && (value.status === 'in_progress' ? value.review === null
        : value.status === 'completed' && Array.isArray(value.review) && value.review.length === 10
          && value.review.every((item, index) => sameId(item?.questionId, questions[index].id)
            && (item.selectedOptionId === null || questions[index].options.some((option) => sameId(option.id, item.selectedOptionId)))
            && questions[index].options.some((option) => sameId(option.id, item.correctOptionId))
            && Array.isArray(item.sourcePages)));
    if (!valid) return false;
    const known = record.attemptDrafts?.[value.id.toLowerCase()];
    const completedDraft = draft.completion ? draft : known;
    const completion = completedDraft?.completion;
    return !completion || !sameId(completion.id, value.id)
      || (value.status === 'completed' && value.startedAt === completion.startedAt
        && value.completedAt === completion.completedAt && value.correctCount === completion.correctCount
        && value.scorePercent === completion.scorePercent
        && sameAnswers(value.review.map(({ questionId, selectedOptionId }) => ({ questionId, optionId: selectedOptionId })), completedDraft.answers));
  }

  function normalizedAnswers(value) {
    if (!Array.isArray(value) || value.length > questions.length) return null;
    const seen = new Set();
    const selected = new Map();
    for (const answer of value) {
      if (!answer || typeof answer !== 'object' || typeof answer.questionId !== 'string') return null;
      const question = questions.find((item) => sameId(item.id, answer.questionId));
      const key = answer.questionId.toLowerCase();
      if (!question || seen.has(key)) return null;
      const optionId = answer.optionId ?? null;
      const option = optionId === null ? null : question.options.find((item) => sameId(item.id, optionId));
      if (optionId !== null && !option) return null;
      seen.add(key);
      selected.set(key, option?.id ?? null);
    }
    return questions.map(({ id }) => ({ questionId: id, optionId: selected.get(id.toLowerCase()) ?? null }));
  }

  function sameAnswers(left, right) {
    return left.length === right.length && left.every((answer, index) => sameId(answer.questionId, right[index].questionId)
      && (answer.optionId === null && right[index].optionId === null || sameId(answer.optionId, right[index].optionId)));
  }

  function accept(value, operation) {
    const known = record.attemptDrafts[value.id.toLowerCase()];
    // An unresolved start may already be visible in history. Its replay must
    // preserve answers and a frozen submission created through that view.
    if (known && known !== draft) {
      Object.assign(draft, {
        answers: copyAnswers(known.answers),
        frozenAnswers: known.frozenAnswers ? copyAnswers(known.frozenAnswers) : null,
        submitUncertain: known.submitUncertain,
        completion: known.completion ? { ...known.completion } : null,
        retryAt: Math.max(draft.retryAt, known.retryAt),
      });
    }
    operation.submitted = false;
    release(operation);
    verified = true;
    if (draft.startAttempt) Object.assign(draft.startAttempt, { resolved: true, uncertain: false, blocked: false });
    const completed = value.status === 'completed';
    record.attemptDrafts[value.id.toLowerCase()] = draft;
    publish({
      phase: value.status, attempt: copyAttempt(value), pending: false, reading: false,
      message: completed ? 'Результат попытки сохранён.'
        : draft.frozenAnswers ? 'Попытка ещё не завершена. Можно повторить отправку только сохранённых ответов.' : '',
    }, {
      attemptId: value.id, unavailable: false,
      retryAt: value.status === 'completed' ? 0 : draft.retryAt,
      ...(completed ? {
        completion: {
          id: value.id, startedAt: value.startedAt, completedAt: value.completedAt,
          correctCount: value.correctCount, scorePercent: value.scorePercent,
        },
        answers: value.review.map(({ questionId, selectedOptionId }) => ({ questionId, optionId: selectedOptionId })),
        frozenAnswers: null, submitUncertain: false,
      } : {}),
    });
  }

  function fail(error, stage) {
    if (!active()) return;
    const access = (error?.status === 401 && error.code === 'AUTHENTICATION_REQUIRED')
      || (error?.status === 403 && error.code === 'CSRF_INVALID') || error?.code === 'CSRF_NOT_INITIALIZED';
    const unavailable = error?.status === 404 || (error?.status === 409 && error.code === 'MATERIAL_NOT_AVAILABLE');
    const validation = error?.status === 422 && error.code === 'VALIDATION_FAILED';
    const collision = stage === 'start' && error?.status === 409 && error.code === 'IDEMPOTENCY_KEY_REUSED';
    const uncertain = !access && !unavailable && ![400, 409, 422, 429].includes(error?.status);
    const seconds = Number.isSafeInteger(error?.retryAfterSeconds) && error.retryAfterSeconds >= 0 ? error.retryAfterSeconds : 0;
    if (stage === 'start' && draft.startAttempt) {
      draft.startAttempt.uncertain ||= uncertain;
      draft.startAttempt.blocked ||= collision;
    }
    if (stage === 'submit') {
      if (validation && !draft.submitUncertain) {
        draft.frozenAnswers = null;
        draft.submitUncertain = false;
      } else draft.submitUncertain ||= uncertain;
    }
    if (stage === 'read' || stage === 'material' || unavailable || access) verified = false;
    publish({
      phase: unavailable ? 'unavailable' : 'error', pending: false, reading: false,
      ...(verified ? {} : { attempt: null }),
      message: unavailable ? 'Эта попытка или её материал больше недоступны.'
        : access ? 'Требуется проверить сессию. Выбор и данные запроса сохранены.'
          : collision ? 'Не удалось подтвердить начало попытки. Новый запуск заблокирован.'
            : error?.status === 429 ? 'Слишком много запросов. Подожди перед повтором.'
              : stage === 'start' ? 'Не удалось подтвердить начало. Повтор использует прежний ключ операции.'
                : stage === 'submit' && validation && !draft.submitUncertain ? 'Не удалось принять ответы. Проверь выбор и отправь его ещё раз.'
                  : stage === 'submit' ? 'Результат отправки пока не подтверждён. Проверь попытку или повтори те же ответы.'
                    : stage === 'material' ? 'Не удалось проверить материал. Попробуй ещё раз.'
                      : 'Не удалось получить попытку. Обнови её перед продолжением.',
    }, { retryAt: Math.min(Number.MAX_SAFE_INTEGER, now() + seconds * 1000), unavailable });
    if (access && active()) {
      stop();
      onAccessError(error);
    }
  }

  async function refresh() {
    if (!active() || busy()) return;
    if (waiting() || !draft.attemptId) {
      publish();
      return;
    }
    const { operation, current } = begin('read');
    verified = false;
    publish({ phase: 'loading', attempt: null, reading: true, message: '' });
    try {
      if (!current()) return;
      const value = await api.getById(draft.attemptId, { signal: operation.controller.signal });
      if (!current()) return;
      if (!validAttempt(value, draft.attemptId)) throw invalidResponse();
      accept(value, operation);
    } catch (error) {
      if (current()) fail(error, 'read');
    } finally {
      if (current()) release(operation);
    }
  }

  async function start() {
    if (!active() || busy() || waiting() || (!draft.view.canStart && !draft.view.canRetryStart)) return;
    const { operation, current } = begin('start');
    publish({ phase: 'loading', pending: true, reading: true, message: '' });
    try {
      if (!current()) return;
      const material = await materials.getById(materialId, { signal: operation.controller.signal });
      if (!current()) return;
      if (!sameId(material?.id, materialId) || !sameId(material.subjectId, subjectId)) throw invalidResponse();
      if (material.status !== 'stored') throw { status: 409, code: 'MATERIAL_NOT_AVAILABLE' };
      if (!unresolvedStart()) {
        const key = makeKey();
        if (typeof key !== 'string' || !UUID.test(key) || draft.usedKeys.some((used) => sameId(used, key))) throw invalidResponse();
        // The current quiz slot can begin another run. Keep the previous run's
        // state addressable by its own ID, without sharing answers or locks.
        if (draft.attemptId) {
          record.attemptDrafts[draft.attemptId.toLowerCase()] = {
            ...draft, answers: copyAnswers(draft.answers),
            frozenAnswers: draft.frozenAnswers ? copyAnswers(draft.frozenAnswers) : null,
            startAttempt: draft.startAttempt ? { ...draft.startAttempt } : null,
            completion: draft.completion ? { ...draft.completion } : null,
            usedKeys: [...draft.usedKeys], operation: null, view: emptyView(),
          };
        }
        draft.usedKeys.push(key);
        draft.startAttempt = { key, resolved: false, uncertain: false, blocked: false };
        draft.attemptId = null;
        draft.answers = blankAnswers();
        draft.frozenAnswers = null;
        draft.submitUncertain = false;
        draft.completion = null;
      }
      verified = false;
      publish({ attempt: null, reading: false });
      if (!current()) return;
      operation.submitted = true;
      const value = await api.start(quizId, { idempotencyKey: draft.startAttempt.key, signal: operation.controller.signal });
      if (!current()) return;
      if (!validAttempt(value)) throw invalidResponse();
      accept(value, operation);
    } catch (error) {
      if (current()) {
        const stage = operation.submitted ? 'start' : 'material';
        operation.submitted = false;
        fail(error, stage);
      }
    } finally {
      if (current()) release(operation);
    }
  }

  function choose(questionId, optionId) {
    if (!active() || busy() || !draft.view.canChoose) return;
    if (optionId !== null && typeof optionId !== 'string') return;
    const answer = normalizedAnswers([{ questionId, optionId }]);
    if (!answer) return;
    const index = questions.findIndex((question) => sameId(question.id, questionId));
    const answers = copyAnswers(draft.answers);
    answers[index] = answer[index];
    publish({ message: '' }, { answers });
  }

  async function submit(answersSnapshot) {
    if (!active() || busy() || waiting() || (!draft.view.canSubmit && !draft.view.canRetrySubmit)) return;
    const answers = copyAnswers(draft.frozenAnswers ?? draft.answers);
    if (answersSnapshot !== undefined) {
      const confirmation = normalizedAnswers(answersSnapshot);
      if (!confirmation || !sameAnswers(confirmation, answers)) {
        publish({ message: 'Выбор изменился. Проверь ответы и подтверди отправку заново.' });
        return;
      }
    }
    const { operation, current } = begin('submit');
    publish({ pending: true, message: '' }, { frozenAnswers: copyAnswers(answers) });
    let readConflict = false;
    try {
      if (!current()) return;
      operation.submitted = true;
      const value = await api.submit(draft.attemptId, copyAnswers(answers), { signal: operation.controller.signal });
      if (!current()) return;
      if (!validAttempt(value, draft.attemptId) || value.status !== 'completed'
        || !sameAnswers(value.review.map(({ questionId, selectedOptionId }) => ({ questionId, optionId: selectedOptionId })), answers)) {
        throw invalidResponse();
      }
      accept(value, operation);
    } catch (error) {
      if (current()) {
        operation.submitted = false;
        if (error?.status === 409 && error.code === 'ATTEMPT_ALREADY_SUBMITTED') {
          draft.submitUncertain = true;
          release(operation);
          publish({ pending: false });
          readConflict = active();
        } else fail(error, 'submit');
      }
    } finally {
      if (current()) release(operation);
    }
    if (readConflict && active()) await refresh();
  }

  function stop() {
    if (stopped) return;
    if (owns() && (!draft.operation || draft.operation === request)) {
      if (request?.submitted) {
        if (request.kind === 'start' && draft.startAttempt) draft.startAttempt.uncertain = true;
        if (request.kind === 'submit') draft.submitUncertain = true;
      }
      draft.operation = null;
      draft.view = { ...emptyView(), canStart: false };
    }
    verified = false;
    stopped = true;
    epoch += 1;
    request?.controller.abort();
    request = null;
  }

  return { refresh, start, choose, submit, stop };
}
