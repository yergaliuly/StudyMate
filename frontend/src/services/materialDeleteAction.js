import { materialApi } from './materialApi.js';
import { watchJob } from './jobWatcher.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const JOB_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const sameId = (left, right) => typeof left === 'string'
  && left.toLowerCase() === right.toLowerCase();
const invalidResponse = () => ({ code: 'INVALID_RESPONSE', status: 200 });

function entry(record, id) {
  if (!record || typeof record !== 'object' || typeof id !== 'string' || !UUID.test(id)) {
    throw new TypeError('Нужны запись предмета и UUID материала.');
  }
  record.deletion ??= {};
  record.deletion[id.toLowerCase()] ??= {
    phase: 'loading', material: null, jobStatus: null, message: '', retryAt: 0,
    reading: false, pending: false, canRemove: false, operation: null,
    observation: null, succeededJobId: null,
  };
  return record.deletion[id.toLowerCase()];
}

function copyMaterial(material) {
  if (!material) return null;
  return {
    ...material,
    ...(material.processingError ? { processingError: { ...material.processingError } } : {}),
  };
}

function snapshot(draft) {
  return {
    phase: draft.phase,
    material: copyMaterial(draft.material),
    jobStatus: draft.jobStatus,
    message: draft.message,
    retryAt: draft.retryAt,
    reading: draft.reading,
    pending: draft.pending,
  };
}

export function getMaterialDeleteState(record, materialId) {
  return snapshot(entry(record, materialId));
}

export function createMaterialDeleteAction({
  record,
  materialId,
  subjectId,
  canAct,
  onChange,
  onRead = () => {},
  onAccepted = () => {},
  onRemoved = () => {},
  onAccessError,
  api = materialApi,
  watch = watchJob,
  now = Date.now,
}) {
  if (typeof subjectId !== 'string' || !UUID.test(subjectId)) {
    throw new TypeError('Нужен UUID предмета.');
  }
  const draft = entry(record, materialId);
  let stopped = false;
  let request = null;
  let observation = null;
  let generation = 0;

  const owns = () => record.deletion?.[materialId.toLowerCase()] === draft;
  const active = () => !stopped && owns() && canAct(materialId);
  const busy = () => request || draft.operation || draft.pending || draft.reading;
  const waiting = () => now() < draft.retryAt;
  const inScope = (epoch) => active() && generation === epoch;

  function publish(changes) {
    if (!active()) return;
    Object.assign(draft, changes);
    onChange(snapshot(draft));
  }

  function haltWatch() {
    const prior = observation;
    observation = null;
    if (owns() && draft.observation === prior) draft.observation = null;
    prior?.controller.abort();
    prior?.halt?.();
  }

  function startRequest(kind) {
    haltWatch();
    const operation = { controller: new AbortController(), epoch: ++generation, kind };
    request = operation;
    draft.operation = operation;
    return {
      operation,
      current: () => inScope(operation.epoch)
        && request === operation && draft.operation === operation
        && !operation.controller.signal.aborted,
    };
  }

  function release(operation) {
    if (!active()) return;
    if (request === operation) request = null;
    if (draft.operation === operation) draft.operation = null;
  }

  function done() {
    if (!active() || draft.phase === 'done') return;
    haltWatch();
    publish({
      phase: 'done', material: null, pending: false, reading: false,
      canRemove: false, retryAt: 0, message: 'Материал удалён.',
    });
    if (active()) onRemoved(materialId);
  }

  function failure(error, stage, previousPhase) {
    if (!active()) return;
    const access = (error?.status === 401 && error.code === 'AUTHENTICATION_REQUIRED')
      || (error?.status === 403 && error.code === 'CSRF_INVALID')
      || error?.code === 'CSRF_NOT_INITIALIZED';
    const retryable = stage === 'remove' && (
      (error?.status === 409 && error.code === 'REQUEST_IN_PROGRESS')
      || (error?.status === 429 && error.code !== 'INVALID_RESPONSE')
    );
    const uncertain = stage === 'remove' && !access && !retryable
      && (['INVALID_RESPONSE', 'NETWORK_ERROR', 'REQUEST_CANCELLED'].includes(error?.code)
        || ![400, 403, 404, 409, 422].includes(error?.status));
    const seconds = Number.isSafeInteger(error?.retryAfterSeconds)
      && error.retryAfterSeconds >= 0 ? error.retryAfterSeconds
      : error?.code === 'REQUEST_IN_PROGRESS' ? 1 : 0;
    const phase = access || stage === 'watch' ? 'paused'
      : uncertain ? 'uncertain'
        : retryable ? previousPhase : 'error';

    publish({
      phase, pending: false, reading: false,
      canRemove: retryable,
      retryAt: Math.min(Number.MAX_SAFE_INTEGER, now() + seconds * 1000),
      message: access
        ? 'Требуется проверить сессию. После восстановления проверь состояние материала.'
        : retryable
          ? 'Сейчас запрос недоступен. Подожди перед явным повтором удаления.'
          : uncertain
            ? 'Результат удаления неизвестен. Проверь материал перед повторной отправкой.'
            : stage === 'watch'
              ? 'Наблюдение за очисткой остановлено. Проверь состояние материала.'
              : stage === 'read'
                ? 'Не удалось проверить материал. Попробуй ещё раз.'
                : 'Не удалось начать удаление. Проверь состояние материала.',
    });
    if (access && active()) {
      stop();
      onAccessError(error);
    }
  }

  function startWatching(jobId) {
    if (!active()) return;
    haltWatch();
    const token = { controller: new AbortController(), epoch: ++generation, halt: null };
    observation = token;
    draft.observation = token;
    const current = () => inScope(token.epoch)
      && observation === token && draft.observation === token
      && !token.controller.signal.aborted;
    publish({ phase: 'watching', canRemove: false, jobStatus: null, message: '' });
    if (!current()) return;

    try {
      const halt = watch(jobId, {
        signal: token.controller.signal,
        onUpdate(job) {
          if (!current()) return;
          if (!sameId(job?.id, jobId) || job.type !== 'material.delete'
            || !JOB_STATUSES.has(job.status)
            || (job.status === 'succeeded'
              ? !sameId(job.resultId, materialId) : job.resultId !== null)) {
            haltWatch();
            failure(invalidResponse(), 'watch');
            return;
          }
          if (['queued', 'running'].includes(job.status)) {
            publish({ jobStatus: job.status });
            return;
          }
          haltWatch();
          if (job.status === 'succeeded') {
            publish({ jobStatus: job.status, succeededJobId: jobId.toLowerCase() });
            if (inScope(token.epoch)) void read(true);
          } else {
            publish({
              phase: 'failed', jobStatus: job.status, canRemove: true,
              message: job.status === 'cancelled'
                ? 'Очистка прервана. Можно явно повторить удаление.'
                : 'Очистка не завершилась. Можно явно повторить удаление.',
            });
          }
        },
        onError(error) {
          if (!current()) return;
          haltWatch();
          failure(error, 'watch');
        },
      });
      if (current()) token.halt = halt;
      else halt?.();
    } catch (error) {
      if (!current()) return;
      haltWatch();
      failure(error, 'watch');
    }
  }

  function validMaterial(material) {
    return sameId(material?.id, materialId)
      && sameId(material.subjectId, subjectId)
      && ['stored', 'uploading', 'deleting'].includes(material.status)
      && (material.status !== 'deleting'
        || (typeof material.deletionJobId === 'string' && UUID.test(material.deletionJobId)));
  }

  async function read(verifySuccess = false) {
    if (!active() || busy() || waiting() || draft.phase === 'done') return;
    const { operation, current } = startRequest('read');
    publish({ phase: 'loading', reading: true, canRemove: false, message: '', retryAt: 0 });
    try {
      if (!current()) return;
      // Это свой сигнал, не сигнал HTTP-чтения watcher: terminal уже отменил его.
      const material = await api.getById(materialId, { signal: operation.controller.signal });
      if (!current()) return;
      if (!validMaterial(material)) throw invalidResponse();
      publish({ material: copyMaterial(material) });
      if (!current()) return;
      onRead(material);
      if (!current()) return;
      release(operation);
      const unconfirmed = verifySuccess || (material.status === 'deleting'
        && material.deletionJobId.toLowerCase() === draft.succeededJobId);
      publish({
        reading: false,
        phase: unconfirmed ? 'paused' : material.status === 'deleting' ? 'watching' : 'confirm',
        canRemove: !unconfirmed && material.status !== 'deleting',
        jobStatus: unconfirmed ? 'succeeded' : null,
        message: unconfirmed
          ? 'Задание завершилось, но удаление материала ещё не подтверждено. Проверь состояние позже.'
          : '',
      });
      if (inScope(operation.epoch) && material.status === 'deleting' && !unconfirmed) {
        startWatching(material.deletionJobId);
      }
    } catch (error) {
      if (!current()) return;
      if (error?.status === 404 && error.code === 'MATERIAL_NOT_FOUND') {
        release(operation);
        done();
      } else failure(error, 'read');
    } finally {
      if (current()) release(operation);
    }
  }

  async function open() {
    if (!active() || busy() || draft.phase === 'done') return;
    publish({ canRemove: false });
    if (waiting()) {
      publish({ phase: 'paused', message: 'Подожди перед проверкой состояния материала.' });
      return;
    }
    await read();
  }

  async function review() {
    await read();
  }

  async function remove() {
    if (!active() || busy() || waiting() || !draft.canRemove
      || !['confirm', 'failed'].includes(draft.phase)) return;
    const previousPhase = draft.phase;
    const { operation, current } = startRequest('remove');
    publish({ phase: 'submitting', pending: true, canRemove: false, message: '', retryAt: 0 });
    try {
      if (!current()) return;
      const result = await api.remove(materialId, { signal: operation.controller.signal });
      if (!current()) return;
      if (!sameId(result?.materialId, materialId)
        || typeof result.jobId !== 'string' || !UUID.test(result.jobId)) throw invalidResponse();
      release(operation);
      publish({ pending: false, phase: 'watching', succeededJobId: null });
      if (inScope(operation.epoch)) onAccepted(result);
      if (inScope(operation.epoch)) startWatching(result.jobId);
    } catch (error) {
      if (!current()) return;
      if (error?.status === 404 && error.code === 'MATERIAL_NOT_FOUND') {
        release(operation);
        done();
      } else failure(error, 'remove', previousPhase);
    } finally {
      if (current()) release(operation);
    }
  }

  function stop() {
    if (stopped) return;
    if (owns()) {
      if (request && draft.operation === request) {
        Object.assign(draft, {
          phase: draft.pending ? 'uncertain' : draft.reading ? 'paused' : draft.phase,
          message: draft.pending
            ? 'Ожидание прервано. Результат удаления неизвестен; проверь материал.'
            : draft.message,
          pending: false, reading: false, canRemove: false, operation: null,
        });
      } else draft.canRemove = false;
    }
    stopped = true;
    generation += 1;
    request?.controller.abort();
    request = null;
    haltWatch();
  }

  return { open, review, remove, stop };
}
