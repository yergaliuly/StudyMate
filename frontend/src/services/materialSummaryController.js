import { materialApi } from './materialApi.js';
import { summaryApi } from './summaryApi.js';
import { watchJob } from './jobWatcher.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SUMMARY_STATUSES = new Set(['queued', 'running', 'ready', 'failed', 'cancelled']);
const JOB_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const isTerminalSummary = (value) => value && ['ready', 'failed', 'cancelled'].includes(value.status);
const matchesBaseline = (value, baseline) => Boolean(value && baseline
  && sameId(value.jobId, baseline.jobId) && value.version === baseline.version);
const validExpected = (value) => typeof value?.jobId === 'string' && UUID.test(value.jobId)
  && (value.version === null || (Number.isSafeInteger(value.version) && value.version >= 1));
const sameId = (left, right) => typeof left === 'string'
  && left.toLowerCase() === right.toLowerCase();
const invalidResponse = () => ({ status: 200, code: 'INVALID_RESPONSE' });
const messages = {
  AI_UNAVAILABLE: 'Генерация сейчас недоступна. Проверь состояние и повтори попытку позже.',
  AI_INVALID_RESPONSE: 'ИИ вернул неподходящий ответ. Сохранённый конспект не изменён.',
  AI_OUTCOME_UNKNOWN: 'Результат обращения к ИИ неизвестен. Автоматического повтора не будет.',
  JOB_OUTCOME_UNKNOWN: 'Результат задания неизвестен. Автоматического повтора не будет.',
  SUMMARY_IN_PROGRESS: 'Для материала уже выполняется генерация. Обнови состояние конспекта.',
  IDEMPOTENCY_KEY_REUSED: 'Не удалось подтвердить операцию. Обнови состояние конспекта.',
  TEXT_NOT_READY: 'Сначала дождись извлечения текста PDF, затем обнови материал.',
  RATE_LIMITED: 'Слишком много запросов. Подожди перед повтором.',
};

function emptyView() {
  return {
    phase: 'loading', material: null, summary: null, empty: false,
    pending: false, reading: false, watching: false, jobStatus: null,
    watchError: '', message: '', canGenerate: false, canRetry: false,
    canRegenerate: false, canEdit: false, mutationUnresolved: false,
  };
}

function entry(record, id) {
  if (!record || typeof record !== 'object' || typeof id !== 'string' || !UUID.test(id)) {
    throw new TypeError('Нужны запись предмета и UUID материала.');
  }
  record.summary ??= {};
  record.summary[id.toLowerCase()] ??= {
    key: null, acceptedJobId: null, seenSummary: false, blocked: false,
    attemptKind: null, baseline: null, resolved: false, acceptedTerminal: false,
    usedKeys: [],
    uncertain: false, retryAt: 0, operation: null, observation: null,
    view: emptyView(),
  };
  return record.summary[id.toLowerCase()];
}

function summaryMessage(value) {
  if (value?.status === 'cancelled') return value.version === null
    ? 'Генерация отменена. Конспект ещё не создан.'
    : 'Генерация отменена. Сохранённый конспект остаётся доступным.';
  if (value?.status !== 'failed') return '';
  return Object.hasOwn(messages, value.error?.code)
    ? messages[value.error.code] : 'Не удалось создать конспект. Автоматического повтора не будет.';
}

function copySummary(value) {
  if (!value) return null;
  return {
    ...value,
    sourcePages: value.sourcePages ? [...value.sourcePages] : null,
    error: value.error ? { code: value.error.code, message: summaryMessage(value) } : null,
  };
}

function snapshot(draft) {
  return {
    ...draft.view,
    material: draft.view.material ? {
      ...draft.view.material,
      ...(draft.view.material.processingError
        ? { processingError: { ...draft.view.material.processingError } } : {}),
    } : null,
    summary: copySummary(draft.view.summary),
    retryAt: draft.retryAt,
    uncertain: draft.uncertain,
  };
}

export function getMaterialSummaryState(record, materialId) {
  return snapshot(entry(record, materialId));
}

export function createMaterialSummaryController({
  record,
  materialId,
  subjectId,
  canAct,
  canMutate = () => true,
  onChange,
  onAccessError,
  onMaterialRead = () => {},
  materials = materialApi,
  api = summaryApi,
  watch = watchJob,
  now = Date.now,
  makeKey = () => globalThis.crypto.randomUUID(),
}) {
  if (typeof subjectId !== 'string' || !UUID.test(subjectId)) {
    throw new TypeError('Нужен UUID предмета.');
  }
  const draft = entry(record, materialId);
  const terminalJobs = new Set();
  let stopped = false;
  let request = null;
  let observation = null;
  let generation = 0;
  let eligible = false;
  let fresh = false;

  const owns = () => record.summary?.[materialId.toLowerCase()] === draft;
  const active = () => !stopped && owns() && canAct(materialId);
  const inScope = (epoch) => active() && generation === epoch;
  const waiting = () => now() < draft.retryAt;
  const busy = () => request || draft.operation || draft.view.pending || draft.view.reading;
  const unresolved = () => Boolean((draft.key || draft.acceptedJobId || draft.blocked) && !draft.resolved);
  const retryMatches = () => draft.attemptKind === 'regenerate'
    ? isTerminalSummary(draft.view.summary) && sameId(draft.view.summary.jobId, draft.baseline.jobId)
    : draft.view.empty && !draft.view.summary;

  function publish(changes = {}, persistent = {}) {
    if (!active()) return;
    Object.assign(draft, persistent);
    Object.assign(draft.view, changes);
    const idle = !draft.view.pending && !draft.view.reading && !draft.view.watching;
    const readyText = draft.view.material?.status === 'stored'
      && draft.view.material.processingStatus === 'ready';
    const terminal = isTerminalSummary(draft.view.summary);
    draft.view.mutationUnresolved = unresolved() || Boolean(draft.view.pending
      || draft.view.watching || (draft.view.summary && !terminal));
    draft.view.canGenerate = Boolean(fresh && eligible && idle && !draft.blocked
      && !draft.seenSummary && !draft.key && !draft.acceptedJobId);
    draft.view.canRetry = Boolean(fresh && readyText && idle && unresolved()
      && draft.key && !draft.acceptedJobId && !draft.blocked && retryMatches());
    draft.view.canRegenerate = Boolean(fresh && readyText && terminal && idle
      && !unresolved() && !draft.view.watchError);
    draft.view.canEdit = Boolean(fresh && terminal && draft.view.summary.version !== null
      && idle && !unresolved() && !draft.view.watchError);
    onChange(snapshot(draft));
  }

  function haltWatch() {
    const prior = observation;
    observation = null;
    if (owns() && draft.observation === prior) draft.observation = null;
    prior?.controller.abort();
    prior?.halt?.();
  }

  function start(kind) {
    haltWatch();
    const operation = { controller: new AbortController(), epoch: ++generation, kind, submitted: false };
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

  function unavailable() {
    eligible = false;
    fresh = false;
    publish({
      phase: 'unavailable', material: null, summary: null, empty: false,
      pending: false, reading: false, watching: false,
      jobStatus: null, watchError: '',
      message: 'Материал больше недоступен для конспекта. Обнови список.',
    });
  }

  function fail(error, stage) {
    if (!active()) return;
    const access = (error?.status === 401 && error.code === 'AUTHENTICATION_REQUIRED')
      || (error?.status === 403 && error.code === 'CSRF_INVALID')
      || error?.code === 'CSRF_NOT_INITIALIZED';
    const missing = error?.status === 404 && error.code === 'MATERIAL_NOT_FOUND';
    const unavailableState = error?.status === 409 && error.code === 'MATERIAL_NOT_AVAILABLE';
    const seconds = Number.isSafeInteger(error?.retryAfterSeconds)
      && error.retryAfterSeconds >= 0 ? error.retryAfterSeconds : 0;
    const persistent = {
      retryAt: Math.min(Number.MAX_SAFE_INTEGER, now() + seconds * 1000),
    };
    if (stage === 'generate') {
      const definite = access || error?.code === 'AI_UNAVAILABLE'
        || ([400, 404, 409, 422, 429].includes(error?.status)
          && error?.code !== 'INVALID_RESPONSE');
      persistent.uncertain = draft.uncertain || !definite;
      if (['SUMMARY_IN_PROGRESS', 'IDEMPOTENCY_KEY_REUSED'].includes(error?.code)) {
        persistent.blocked = true;
        eligible = false;
      }
    }
    if (access || missing || unavailableState) {
      eligible = false;
      fresh = false;
    }
    publish({
      phase: access ? 'checking' : stage === 'watch' ? 'ready' : 'error',
      pending: false, reading: false, watching: false,
      watchError: stage === 'watch' ? 'WATCH_FAILED' : draft.view.watchError,
      message: access
        ? 'Требуется проверить сессию. После восстановления обнови конспект.'
        : Object.hasOwn(messages, error?.code)
          ? messages[error.code]
          : stage === 'generate'
            ? 'Не удалось подтвердить запуск. Обнови состояние или явно повтори прежнюю попытку.'
            : stage === 'watch'
              ? 'Наблюдение остановлено. Обнови состояние конспекта.'
              : 'Не удалось прочитать конспект. Попробуй обновить его.',
    }, persistent);
    if (missing || unavailableState) unavailable();
    if (access && active()) {
      stop();
      onAccessError(error);
    }
  }

  async function readMaterial(operation, current) {
    const value = await materials.getById(materialId, { signal: operation.controller.signal });
    if (!current()) return false;
    if (!sameId(value?.id, materialId) || !sameId(value.subjectId, subjectId)) throw invalidResponse();
    if (value.status !== 'stored') {
      unavailable();
      return false;
    }
    publish({ material: { ...value } });
    if (!current()) return false;
    onMaterialRead(value);
    return current();
  }

  async function readSummary(operation, current) {
    let value;
    try {
      value = await api.getByMaterial(materialId, { signal: operation.controller.signal });
    } catch (error) {
      if (!current()) return null;
      if (error?.status !== 404 || error.code !== 'SUMMARY_NOT_FOUND') throw error;
      eligible = draft.view.material?.processingStatus === 'ready';
      fresh = !draft.acceptedJobId && !draft.seenSummary;
      publish({
        summary: draft.view.summary?.version != null ? draft.view.summary : null,
        empty: fresh,
        jobStatus: null,
      });
      return { absent: true };
    }
    if (!current()) return null;
    if (!sameId(value?.materialId, materialId) || typeof value.jobId !== 'string'
      || !UUID.test(value.jobId) || !SUMMARY_STATUSES.has(value.status)) throw invalidResponse();
    const previousVersion = draft.view.summary?.version ?? draft.baseline?.version;
    if (previousVersion !== null && previousVersion !== undefined
      && (value.version === null || value.version < previousVersion)) throw invalidResponse();
    eligible = false;
    fresh = true;
    const reconciliation = {};
    if (unresolved()) {
      if (draft.acceptedJobId) {
        const ownJob = sameId(value.jobId, draft.acceptedJobId);
        const advanced = !draft.baseline || !sameId(value.jobId, draft.baseline.jobId);
        if (isTerminalSummary(value) && (ownJob || (draft.acceptedTerminal && advanced))) {
          Object.assign(reconciliation, { resolved: true, blocked: false, uncertain: false });
        }
      } else if (!draft.baseline || !sameId(value.jobId, draft.baseline.jobId)) {
        // После потерянного POST новый job — основание наблюдать, а не посылать новый ключ.
        Object.assign(reconciliation, {
          acceptedJobId: value.jobId,
          uncertain: false,
          resolved: Boolean(isTerminalSummary(value)),
          blocked: false,
        });
      }
    }
    publish({
      summary: copySummary(value), empty: false,
      jobStatus: value.status === 'ready' ? 'succeeded' : value.status,
      message: summaryMessage(value),
    }, { seenSummary: true, ...reconciliation });
    return { summary: value };
  }

  function finish(operation, result, fallbackJobId = null) {
    if (!inScope(operation.epoch)) return;
    release(operation);
    const value = result?.summary;
    const jobId = unresolved() && draft.acceptedJobId
      ? draft.acceptedJobId
      : value && ['queued', 'running'].includes(value.status)
        ? value.jobId : !value && unresolved() ? fallbackJobId : null;
    const unconfirmed = jobId && terminalJobs.has(jobId.toLowerCase());
    publish({
      phase: 'ready', pending: false, reading: false,
      watching: false,
      watchError: unconfirmed ? 'STATUS_NOT_CONFIRMED' : '',
      message: unconfirmed
        ? 'Задание завершилось, но состояние конспекта ещё не подтверждено. Обнови его позже.'
        : result?.absent && (draft.acceptedJobId || draft.seenSummary)
          ? 'Состояние ранее запущенного конспекта пока не подтверждено. Обнови его.'
          : unresolved() && !draft.acceptedJobId
            ? 'Результат попытки пока не подтверждён. Повтор использует прежний ключ операции.'
          : result?.absent && draft.view.material?.processingStatus !== 'ready'
            ? messages.TEXT_NOT_READY : draft.view.message,
    });
    if (inScope(operation.epoch) && jobId && !unconfirmed && !waiting()) startWatching(jobId);
  }

  async function loadSummaryOnly(fallbackJobId) {
    if (!active() || busy()) return;
    eligible = false;
    fresh = false;
    const { operation, current } = start('summary');
    publish({ reading: true, watching: false, watchError: '' });
    try {
      if (!current()) return;
      const result = await readSummary(operation, current);
      if (current()) finish(operation, result, fallbackJobId);
    } catch (error) {
      if (current()) {
        fail(error, 'read');
        if (current() && fallbackJobId && !terminalJobs.has(fallbackJobId.toLowerCase())
          && !['unavailable', 'checking'].includes(draft.view.phase) && !waiting()) {
          release(operation);
          if (inScope(operation.epoch)) startWatching(fallbackJobId);
        }
      }
    } finally {
      if (current()) release(operation);
    }
  }

  function startWatching(jobId) {
    if (!active() || waiting()) return;
    haltWatch();
    const token = { controller: new AbortController(), epoch: ++generation, halt: null };
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
          if (!sameId(job?.id, jobId) || job.type !== 'material.summary'
            || !JOB_STATUSES.has(job.status)
            || (job.status === 'succeeded' ? !sameId(job.resultId, materialId) : job.resultId !== null)) {
            haltWatch();
            fail(invalidResponse(), 'watch');
            return;
          }
          publish({ jobStatus: job.status });
          if (!current()) return;
          if (['queued', 'running'].includes(job.status)) return;
          terminalJobs.add(jobId.toLowerCase());
          if (sameId(jobId, draft.acceptedJobId ?? '')) {
            publish({}, { acceptedTerminal: true });
            if (!current()) return;
          }
          haltWatch();
          publish({ watching: false });
          // У watcher уже отменён HTTP-сигнал; чтение использует новый контроллер.
          if (inScope(token.epoch)) void loadSummaryOnly(jobId);
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
    if (!active() || busy() || waiting()) return;
    eligible = false;
    fresh = false;
    terminalJobs.clear();
    const { operation, current } = start('read');
    publish({ phase: 'loading', reading: true, watching: false, watchError: '', message: '' });
    try {
      if (!current() || !await readMaterial(operation, current)) return;
      const result = await readSummary(operation, current);
      if (current()) finish(operation, result, draft.acceptedJobId);
    } catch (error) {
      if (current()) fail(error, 'read');
    } finally {
      if (current()) release(operation);
    }
  }

  async function submit(kind, expected = null, retry = false) {
    eligible = false;
    fresh = false;
    const { operation, current } = start('generate');
    publish({ phase: 'loading', pending: true, reading: true, watching: false, watchError: '', message: '' });
    try {
      if (!current() || !await readMaterial(operation, current)) return;
      const before = await readSummary(operation, current);
      if (!current()) return;
      const readyText = draft.view.material?.processingStatus === 'ready';
      const suitable = kind === 'regenerate'
        ? isTerminalSummary(before?.summary) && matchesBaseline(before.summary, expected)
        : before?.absent && eligible && !draft.seenSummary;
      if (!readyText || !suitable || (retry && (!unresolved() || draft.acceptedJobId || draft.blocked))) {
        finish(operation, before);
        if (inScope(operation.epoch) && kind === 'regenerate' && !suitable) publish({
          message: 'Конспект изменился. Проверь актуальные данные и подтверди повторную генерацию заново.',
        });
        return;
      }
      if (!canMutate()) {
        finish(operation, before);
        if (inScope(operation.epoch)) publish({ message: 'Сначала заверши работу с правками конспекта.' });
        return;
      }
      let previousAttempt;
      if (!retry) {
        const key = makeKey();
        if (typeof key !== 'string' || !UUID.test(key)
          || draft.usedKeys.some((used) => sameId(key, used))) throw invalidResponse();
        previousAttempt = {
          key: draft.key, attemptKind: draft.attemptKind, baseline: draft.baseline,
          acceptedJobId: draft.acceptedJobId, acceptedTerminal: draft.acceptedTerminal,
          resolved: draft.resolved, uncertain: draft.uncertain, blocked: draft.blocked,
          usedKeys: [...draft.usedKeys],
        };
        Object.assign(draft, {
          key, attemptKind: kind, baseline: kind === 'regenerate' ? { ...expected } : null,
          acceptedJobId: null, acceptedTerminal: false, resolved: false,
          uncertain: false, blocked: false,
        });
        draft.usedKeys.push(key);
      }
      publish({ reading: false });
      if (!current()) return;
      if (!canMutate()) {
        // Если редактор занял форму до отправки, платной попытки ещё не было.
        if (previousAttempt) Object.assign(draft, previousAttempt);
        finish(operation, before);
        return;
      }
      operation.submitted = true;
      const result = await api.generate(materialId, {
        idempotencyKey: draft.key,
        signal: operation.controller.signal,
      });
      if (!current()) return;
      if (!sameId(result?.materialId, materialId) || typeof result.jobId !== 'string'
        || !UUID.test(result.jobId)
        || (kind === 'regenerate' && sameId(result.jobId, draft.baseline.jobId))) throw invalidResponse();
      operation.submitted = false;
      eligible = false;
      release(operation);
      publish({ phase: 'ready', pending: false, empty: false }, {
        acceptedJobId: result.jobId, acceptedTerminal: false, resolved: false,
        uncertain: false, retryAt: 0,
      });
      if (inScope(operation.epoch)) await loadSummaryOnly(result.jobId);
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

  async function generate(expected) {
    if (!active() || busy() || waiting() || !canMutate()
      || (!draft.view.canGenerate && !draft.view.canRetry)) return;
    const retry = draft.view.canRetry;
    const kind = retry ? draft.attemptKind ?? 'initial' : 'initial';
    if (kind === 'regenerate' && !validExpected(expected)) return;
    await submit(kind, kind === 'regenerate'
      ? { jobId: expected.jobId, version: expected.version } : null, retry);
  }

  async function regenerate(expected) {
    if (!active() || busy() || waiting() || !canMutate() || !draft.view.canRegenerate
      || !validExpected(expected)) return;
    await submit('regenerate', { jobId: expected.jobId, version: expected.version });
  }

  function stop() {
    if (stopped) return;
    if (owns()) {
      if (request && draft.operation === request) {
        if (request.submitted) draft.uncertain = true;
        draft.operation = null;
      }
      // Контент читается заново при открытии; ключ и исход попытки остаются в аккаунте.
      draft.view = emptyView();
    }
    eligible = false;
    fresh = false;
    stopped = true;
    generation += 1;
    request?.controller.abort();
    request = null;
    haltWatch();
  }

  return { refresh, generate, regenerate, stop };
}
