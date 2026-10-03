import { materialApi } from './materialApi.js';
import { quizApi } from './quizApi.js';
import { watchJob } from './jobWatcher.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 20;
const STATUSES = new Set(['not_started', 'queued', 'running', 'ready', 'failed', 'cancelled']);
const JOB_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const sameId = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();
const sameJob = (left, right) => left === null && right === null || sameId(left, right);
const terminal = (value) => value && ['not_started', 'ready', 'failed', 'cancelled'].includes(value.status);
const sameGeneration = (left, right) => Boolean(left && right
  && left.status === right.status && sameJob(left.jobId, right.jobId));
const invalidResponse = () => ({ status: 200, code: 'INVALID_RESPONSE' });
const messages = {
  AI_UNAVAILABLE: 'Создание теста сейчас недоступно. Повтори запрос позже.',
  AI_INVALID_RESPONSE: 'ИИ вернул неподходящий тест. Предыдущие версии сохранены.',
  AI_OUTCOME_UNKNOWN: 'Результат обращения к ИИ неизвестен. Автоматического повтора не будет.',
  JOB_OUTCOME_UNKNOWN: 'Результат задания неизвестен. Автоматического повтора не будет.',
  QUIZ_INSUFFICIENT_CONTENT: 'В материале недостаточно информации для полноценного теста.',
  QUIZ_IN_PROGRESS: 'Тест уже создаётся. Обнови состояние задания.',
  IDEMPOTENCY_KEY_REUSED: 'Не удалось подтвердить операцию. Обнови состояние тестов.',
  TEXT_NOT_READY: 'Сначала дождись извлечения текста PDF, затем обнови материал.',
  RATE_LIMITED: 'Слишком много запросов. Подожди перед повтором.',
};

function validGeneration(value) {
  return value && STATUSES.has(value.status) && (value.status === 'not_started'
    ? value.jobId === null : typeof value.jobId === 'string' && UUID.test(value.jobId));
}

function publicGeneration(value) {
  return value ? {
    status: value.status, jobId: value.jobId,
    error: value.error ? {
      code: value.error.code,
      message: Object.hasOwn(messages, value.error.code)
        ? messages[value.error.code] : 'Не удалось создать тест. Предыдущие версии сохранены.',
    } : null,
  } : null;
}

function quizInfo(value) {
  return {
    id: value.id, materialId: value.materialId, version: value.version,
    questionCount: value.questionCount, model: value.model, createdAt: value.createdAt,
  };
}

function publicQuiz(value) {
  return value ? {
    ...quizInfo(value),
    questions: value.questions.map((question) => ({
      id: question.id, position: question.position, text: question.text,
      options: question.options.map((option) => ({
        id: option.id, position: option.position, text: option.text,
      })),
    })),
  } : null;
}

function emptyView(page) {
  return {
    phase: 'loading', material: null, quizzes: [],
    meta: { page, pageSize: PAGE_SIZE, total: 0 }, generation: null,
    pending: false, reading: false, watching: false,
    jobStatus: null, watchError: '', message: '', listStale: true,
    canGenerate: false, canRetry: false,
    quiz: null, quizStatus: 'idle', quizMessage: '',
  };
}

function entry(record, id) {
  if (!record || typeof record !== 'object' || typeof id !== 'string' || !UUID.test(id)) {
    throw new TypeError('Нужны запись предмета и UUID материала.');
  }
  record.quiz ??= {};
  record.quiz[id.toLowerCase()] ??= {
    page: 1, selectedQuizId: null, generatedQuizId: null,
    attempt: null, usedKeys: [], terminalCheck: null,
    retryAt: 0, quizRetryAt: 0, operation: null, detailOperation: null, observation: null,
    view: emptyView(1),
  };
  return record.quiz[id.toLowerCase()];
}

function snapshot(draft) {
  return {
    ...draft.view,
    material: draft.view.material ? { ...draft.view.material } : null,
    quizzes: draft.view.quizzes.map(quizInfo),
    meta: { ...draft.view.meta }, generation: publicGeneration(draft.view.generation),
    quiz: publicQuiz(draft.view.quiz), selectedQuizId: draft.selectedQuizId,
    generatedQuizId: draft.generatedQuizId,
    retryAt: draft.retryAt, quizRetryAt: draft.quizRetryAt,
    uncertain: Boolean(draft.attempt?.uncertain),
  };
}

export function getMaterialQuizState(record, materialId) {
  return snapshot(entry(record, materialId));
}

export function createMaterialQuizController({
  record, materialId, subjectId, canAct, onChange, onAccessError,
  onMaterialRead = () => {}, materials = materialApi, api = quizApi,
  watch = watchJob, now = Date.now, makeKey = () => globalThis.crypto.randomUUID(),
}) {
  if (typeof subjectId !== 'string' || !UUID.test(subjectId)) throw new TypeError('Нужен UUID предмета.');
  const draft = entry(record, materialId);
  let stopped = false;
  let request = null;
  let detailRequest = null;
  let observation = null;
  let epoch = 0;
  let detailEpoch = 0;
  let fresh = false;

  const owns = () => record.quiz?.[materialId.toLowerCase()] === draft;
  const active = () => !stopped && owns() && canAct(materialId);
  const inScope = (value) => active() && epoch === value;
  const busy = () => request || draft.operation || draft.view.pending || draft.view.reading;
  const waiting = () => now() < draft.retryAt;
  const unresolved = () => Boolean(draft.attempt && !draft.attempt.resolved);
  const unchecked = () => Boolean(draft.terminalCheck && !draft.terminalCheck.resolved);

  function publish(changes = {}, persistent = {}) {
    if (!active()) return;
    Object.assign(draft, persistent);
    Object.assign(draft.view, changes);
    const ready = fresh && !draft.view.listStale && draft.view.material?.status === 'stored'
      && draft.view.material.processingStatus === 'ready' && terminal(draft.view.generation)
      && !draft.view.pending && !draft.view.reading && !draft.view.watching;
    draft.view.canGenerate = Boolean(ready && !unresolved() && !unchecked());
    draft.view.canRetry = Boolean(ready && unresolved() && !unchecked()
      && !draft.attempt.acceptedJobId && !draft.attempt.blocked
      && sameJob(draft.view.generation.jobId, draft.attempt.baseline.jobId));
    onChange(snapshot(draft));
  }

  function haltWatch() {
    const old = observation;
    observation = null;
    if (owns() && draft.observation === old) draft.observation = null;
    old?.controller.abort();
    old?.halt?.();
  }

  function start(kind) {
    haltWatch();
    const operation = { controller: new AbortController(), epoch: ++epoch, kind, submitted: false };
    request = operation;
    draft.operation = operation;
    return {
      operation,
      current: () => inScope(operation.epoch) && request === operation
        && draft.operation === operation && !operation.controller.signal.aborted,
    };
  }

  function release(operation) {
    if (!active()) return;
    if (request === operation) request = null;
    if (draft.operation === operation) draft.operation = null;
  }

  function cancelDetail() {
    detailEpoch += 1;
    const old = detailRequest;
    detailRequest = null;
    if (owns() && draft.detailOperation === old) draft.detailOperation = null;
    old?.controller.abort();
  }

  function inaccessible() {
    fresh = false;
    const old = request;
    request = null;
    epoch += 1;
    if (draft.operation === old) draft.operation = null;
    if (old?.submitted && draft.attempt) draft.attempt.uncertain = true;
    old?.controller.abort();
    haltWatch();
    cancelDetail();
    publish({
      ...emptyView(draft.page), phase: 'unavailable',
      message: 'Материал больше недоступен для тестов. Обнови список материалов.',
    }, { selectedQuizId: null, generatedQuizId: null });
  }

  function fail(error, stage) {
    if (!active()) return;
    const access = (error?.status === 401 && error.code === 'AUTHENTICATION_REQUIRED')
      || (error?.status === 403 && error.code === 'CSRF_INVALID')
      || error?.code === 'CSRF_NOT_INITIALIZED';
    const unavailable = (error?.status === 404 && error.code === 'MATERIAL_NOT_FOUND')
      || (error?.status === 409 && error.code === 'MATERIAL_NOT_AVAILABLE');
    const seconds = Number.isSafeInteger(error?.retryAfterSeconds)
      && error.retryAfterSeconds >= 0 ? error.retryAfterSeconds : error?.code === 'QUIZ_IN_PROGRESS' ? 2 : 0;
    const retryAt = Math.min(Number.MAX_SAFE_INTEGER, now() + seconds * 1000);
    if (stage === 'generate') {
      const definite = access || error?.code === 'AI_UNAVAILABLE'
        || ([400, 404, 409, 422, 429].includes(error?.status) && error.code !== 'INVALID_RESPONSE');
      if (draft.attempt) {
        draft.attempt.uncertain ||= !definite;
        draft.attempt.blocked ||= ['QUIZ_IN_PROGRESS', 'IDEMPOTENCY_KEY_REUSED'].includes(error?.code);
      }
    }
    if (stage === 'detail') {
      const missing = error?.status === 404 && error.code === 'QUIZ_NOT_FOUND';
      publish({
        ...(missing ? { quiz: null } : {}),
        quizStatus: missing ? 'unavailable' : 'error',
        quizMessage: missing
          ? 'Эта версия теста больше недоступна.' : 'Не удалось открыть тест. Попробуй ещё раз.',
      }, { quizRetryAt: retryAt });
    } else {
      if (stage === 'read' || stage === 'result') fresh = false;
      publish({
        phase: access ? 'checking' : stage === 'watch' ? 'ready' : 'error',
        reading: false, pending: false, watching: false,
        listStale: ['read', 'result'].includes(stage) ? true : draft.view.listStale,
        watchError: stage === 'watch' ? 'WATCH_FAILED'
          : stage === 'result' ? 'RESULT_NOT_CONFIRMED' : draft.view.watchError,
        message: Object.hasOwn(messages, error?.code) ? messages[error.code]
          : stage === 'generate' ? 'Не удалось подтвердить запуск. Явный повтор сохранит прежний ключ операции.'
            : stage === 'result' ? 'Не удалось подтвердить созданную версию теста. Обнови состояние.'
              : stage === 'watch' ? 'Наблюдение остановлено. Обнови состояние тестов.'
                : draft.view.generation
                  ? 'Не удалось обновить список тестов. Показаны последние полученные данные.'
                  : 'Не удалось получить список тестов. Попробуй обновить его.',
      }, { retryAt });
    }
    if (unavailable) inaccessible();
    if (access && active()) {
      stop();
      onAccessError(error);
    }
  }

  function validQuiz(value, id) {
    return sameId(value?.id, id) && sameId(value.materialId, materialId)
      && Array.isArray(value.questions) && value.questions.length === 10
      && value.questions.every((question) => Array.isArray(question.options) && question.options.length === 4);
  }

  async function readMaterial(operation, current) {
    const value = await materials.getById(materialId, { signal: operation.controller.signal });
    if (!current()) return false;
    if (!sameId(value?.id, materialId) || !sameId(value.subjectId, subjectId)) throw invalidResponse();
    if (value.status !== 'stored') {
      inaccessible();
      return false;
    }
    publish({ material: { ...value } });
    if (!current()) return false;
    onMaterialRead(value);
    return current();
  }

  function reconcile(generation) {
    const check = draft.terminalCheck;
    if (check && !check.resolved) {
      const same = sameId(generation.jobId, check.jobId) && terminal(generation);
      const newer = generation.jobId !== null && !sameId(generation.jobId, check.jobId)
        && !sameJob(generation.jobId, check.baselineJobId);
      if ((check.status !== 'succeeded' || check.verified) && (same || newer)) check.resolved = true;
    }
    const attempt = draft.attempt;
    if (!unresolved()) return;
    if (!attempt.acceptedJobId && generation.jobId !== null
      && !sameJob(generation.jobId, attempt.baseline.jobId)) {
      attempt.acceptedJobId = generation.jobId;
      attempt.uncertain = false;
      attempt.blocked = false;
    }
    if (!attempt.acceptedJobId) return;
    const own = sameId(generation.jobId, attempt.acceptedJobId);
    const checked = check && sameId(check.jobId, attempt.acceptedJobId) && check.resolved;
    if ((own && ['failed', 'cancelled'].includes(generation.status)) || checked) {
      attempt.resolved = true;
      attempt.uncertain = false;
      attempt.blocked = false;
    }
  }

  async function readList(operation, current) {
    let page = draft.page;
    for (let pass = 0; pass < 2; pass += 1) {
      const result = await api.list(materialId, { page, pageSize: PAGE_SIZE, signal: operation.controller.signal });
      if (!current()) return null;
      if (!Array.isArray(result?.quizzes) || result.meta?.page !== page || result.meta.pageSize !== PAGE_SIZE
        || !Number.isSafeInteger(result.meta.total) || result.meta.total < 0
        || !validGeneration(result.meta.generation)
        || result.quizzes.some((value) => !sameId(value.materialId, materialId))) throw invalidResponse();
      const lastPage = Math.max(1, Math.ceil(result.meta.total / PAGE_SIZE));
      if (page > lastPage) {
        if (pass || result.quizzes.length !== 0) throw invalidResponse();
        page = lastPage;
        continue;
      }
      reconcile(result.meta.generation);
      fresh = true;
      publish({
        quizzes: result.quizzes.map(quizInfo),
        meta: { page, pageSize: PAGE_SIZE, total: result.meta.total },
        generation: publicGeneration(result.meta.generation), listStale: false,
        jobStatus: result.meta.generation.status === 'ready' ? 'succeeded' : result.meta.generation.status,
        message: result.meta.generation.error
          ? publicGeneration(result.meta.generation).error.message : '',
      }, { page });
      return result;
    }
    return null;
  }

  async function verifyResult(operation, current) {
    const check = draft.terminalCheck;
    if (!check || check.status !== 'succeeded' || check.verified) return true;
    const selectionEpoch = detailEpoch;
    const value = await api.getById(check.resultId, { signal: operation.controller.signal });
    if (!current()) return false;
    if (!validQuiz(value, check.resultId)) throw invalidResponse();
    check.verified = true;
    const autoOpen = !draft.selectedQuizId && selectionEpoch === detailEpoch;
    publish(autoOpen ? { quiz: publicQuiz(value), quizStatus: 'ready', quizMessage: '' } : {}, {
      generatedQuizId: value.id,
      ...(autoOpen ? { selectedQuizId: value.id, quizRetryAt: 0 } : {}),
    });
    return current();
  }

  function watchTarget() {
    if (unresolved() && draft.attempt.acceptedJobId) return draft.attempt.acceptedJobId;
    if (unchecked()) return draft.terminalCheck.jobId;
    return ['queued', 'running'].includes(draft.view.generation?.status) ? draft.view.generation.jobId : null;
  }

  function finish(operation) {
    if (!inScope(operation.epoch)) return;
    release(operation);
    const jobId = watchTarget();
    const unconfirmed = jobId && draft.terminalCheck && !draft.terminalCheck.resolved
      && sameId(jobId, draft.terminalCheck.jobId);
    publish({
      phase: 'ready', reading: false, pending: false, watching: false,
      watchError: unconfirmed ? 'STATUS_NOT_CONFIRMED' : '',
      message: unconfirmed ? 'Задание завершилось, но актуальное состояние ещё не подтверждено. Обнови список.'
        : unresolved() && !draft.attempt.acceptedJobId
          ? 'Результат попытки пока не подтверждён. Повтор использует прежний ключ операции.'
          : draft.view.message,
    });
    if (!inScope(operation.epoch)) return;
    if (jobId && !unconfirmed && !waiting()) startWatching(jobId);
    if (draft.selectedQuizId && !draft.view.quiz && !detailRequest
      && now() >= draft.quizRetryAt) void openQuiz(draft.selectedQuizId);
  }

  async function load({ material = true, fallbackJobId = null } = {}) {
    if (!active() || busy() || waiting()) return;
    fresh = false;
    const { operation, current } = start('read');
    publish({ phase: 'loading', reading: true, watching: false, watchError: '', message: '' });
    let stage = 'read';
    try {
      if (!current() || (material && !await readMaterial(operation, current))) return;
      if (draft.terminalCheck?.status === 'succeeded' && !draft.terminalCheck.verified) {
        stage = 'result';
        if (!await verifyResult(operation, current)) return;
      }
      stage = 'read';
      await readList(operation, current);
      if (current()) finish(operation);
    } catch (error) {
      if (!current()) return;
      fail(error, stage);
      if (current() && fallbackJobId && !unchecked()
        && !['unavailable', 'checking'].includes(draft.view.phase) && !waiting()) {
        release(operation);
        if (inScope(operation.epoch)) startWatching(fallbackJobId);
      }
    } finally {
      if (current()) release(operation);
    }
  }

  function startWatching(jobId) {
    if (!active() || waiting()) return;
    haltWatch();
    const token = { controller: new AbortController(), epoch: ++epoch, halt: null };
    observation = token;
    draft.observation = token;
    const current = () => inScope(token.epoch) && observation === token
      && draft.observation === token && !token.controller.signal.aborted;
    publish({ watching: true, watchError: '' });
    if (!current()) return;
    try {
      const halt = watch(jobId, {
        signal: token.controller.signal,
        onUpdate(job) {
          if (!current()) return;
          if (!sameId(job?.id, jobId) || job.type !== 'material.quiz' || !JOB_STATUSES.has(job.status)
            || (job.status === 'succeeded'
              ? typeof job.resultId !== 'string' || !UUID.test(job.resultId) : job.resultId !== null)) {
            haltWatch();
            fail(invalidResponse(), 'watch');
            return;
          }
          publish({ jobStatus: job.status });
          if (!current() || ['queued', 'running'].includes(job.status)) return;
          haltWatch();
          publish({ watching: false }, {
            terminalCheck: {
              jobId, status: job.status, resultId: job.resultId,
              verified: job.status !== 'succeeded', resolved: false,
              baselineJobId: unresolved() && sameId(draft.attempt.acceptedJobId, jobId)
                ? draft.attempt.baseline.jobId : jobId,
            },
          });
          // Опрос уже отменил свой HTTP-сигнал. Проверка результата получает отдельный.
          if (inScope(token.epoch)) void load({ material: false });
        },
        onError(error) {
          if (!current()) return;
          haltWatch();
          fail(error, 'watch');
        },
      });
      if (current()) token.halt = halt;
      else halt?.();
    } catch (error) {
      if (!current()) return;
      haltWatch();
      fail(error, 'watch');
    }
  }

  async function refresh() {
    await load();
  }

  async function changePage(page) {
    if (!active() || busy() || waiting() || !Number.isSafeInteger(page) || page < 1) return;
    draft.page = page;
    await load();
  }

  async function generate(expected) {
    if (!active() || busy() || waiting() || (!draft.view.canGenerate && !draft.view.canRetry)
      || !validGeneration(expected) || !terminal(expected)) return;
    const retry = draft.view.canRetry;
    fresh = false;
    const { operation, current } = start('generate');
    publish({ phase: 'loading', pending: true, reading: true, watching: false, watchError: '', message: '' });
    try {
      if (!current() || !await readMaterial(operation, current)) return;
      await readList(operation, current);
      if (!current()) return;
      if (draft.view.material.processingStatus !== 'ready'
        || !sameGeneration(draft.view.generation, expected)
        || !terminal(draft.view.generation)
        || (retry && (!unresolved() || draft.attempt.acceptedJobId || draft.attempt.blocked))) {
        finish(operation);
        if (inScope(operation.epoch)) publish({ message: 'Состояние тестов изменилось. Проверь его и подтверди запрос заново.' });
        return;
      }
      if (!retry) {
        const key = makeKey();
        if (typeof key !== 'string' || !UUID.test(key) || draft.usedKeys.some((value) => sameId(value, key))) throw invalidResponse();
        draft.usedKeys.push(key);
        draft.attempt = {
          key, baseline: { jobId: expected.jobId, status: expected.status },
          acceptedJobId: null, resolved: false, uncertain: false, blocked: false,
        };
        draft.terminalCheck = null;
      }
      publish({ reading: false });
      if (!current()) return;
      operation.submitted = true;
      const result = await api.generate(materialId, { idempotencyKey: draft.attempt.key, signal: operation.controller.signal });
      if (!current()) return;
      if (!sameId(result?.materialId, materialId) || typeof result.jobId !== 'string'
        || !UUID.test(result.jobId) || sameId(result.jobId, draft.attempt.baseline.jobId)) throw invalidResponse();
      operation.submitted = false;
      Object.assign(draft.attempt, { acceptedJobId: result.jobId, uncertain: false });
      fresh = false;
      release(operation);
      publish({ phase: 'ready', pending: false, listStale: true }, { retryAt: 0 });
      if (inScope(operation.epoch)) await load({ material: false, fallbackJobId: result.jobId });
    } catch (error) {
      if (current()) {
        const stage = operation.submitted ? 'generate' : 'read';
        operation.submitted = false;
        fail(error, stage);
      }
    } finally {
      if (current()) release(operation);
    }
  }

  async function openQuiz(id) {
    if (!active() || typeof id !== 'string' || !UUID.test(id) || draft.view.material?.status !== 'stored') return;
    cancelDetail();
    const oldQuiz = sameId(draft.view.quiz?.id, id) ? draft.view.quiz : null;
    publish({ quiz: oldQuiz, quizStatus: 'loading', quizMessage: '' }, { selectedQuizId: id });
    if (!active()) return;
    if (now() < draft.quizRetryAt) {
      publish({ quizStatus: 'error', quizMessage: 'Подожди перед повторным открытием теста.' });
      return;
    }
    const operation = { controller: new AbortController(), epoch: detailEpoch };
    detailRequest = operation;
    draft.detailOperation = operation;
    const current = () => active() && detailRequest === operation && draft.detailOperation === operation
      && detailEpoch === operation.epoch && sameId(draft.selectedQuizId, id) && !operation.controller.signal.aborted;
    try {
      if (!current()) return;
      const value = await api.getById(id, { signal: operation.controller.signal });
      if (!current()) return;
      if (!validQuiz(value, id)) throw invalidResponse();
      publish({ quiz: publicQuiz(value), quizStatus: 'ready', quizMessage: '' }, { quizRetryAt: 0 });
    } catch (error) {
      if (current()) fail(error, 'detail');
    } finally {
      if (current()) {
        detailRequest = null;
        draft.detailOperation = null;
      }
    }
  }

  function closeQuiz() {
    if (!active()) return;
    cancelDetail();
    publish({ quiz: null, quizStatus: 'idle', quizMessage: '' }, { selectedQuizId: null });
  }

  function stop() {
    if (stopped) return;
    if (owns()) {
      if (request && draft.operation === request) {
        if (request.submitted && draft.attempt) draft.attempt.uncertain = true;
        draft.operation = null;
      }
      draft.view = emptyView(draft.page);
    }
    fresh = false;
    stopped = true;
    epoch += 1;
    request?.controller.abort();
    request = null;
    haltWatch();
    cancelDetail();
  }

  return { refresh, changePage, openQuiz, closeQuiz, generate, stop };
}
