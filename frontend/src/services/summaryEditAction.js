import { materialApi } from './materialApi.js';
import { summaryApi, isValidSummaryContent } from './summaryApi.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['queued', 'running', 'ready', 'failed', 'cancelled']);
const TERMINAL = new Set(['ready', 'failed', 'cancelled']);
const CONTENT_ERROR = 'Конспект должен содержать от 1 до 100 000 допустимых символов.';
const GENERATING = 'Сейчас выполняется генерация. Дождись её завершения и загрузи актуальную версию.';
const sameId = (left, right) => typeof left === 'string'
  && left.toLowerCase() === right.toLowerCase();
const invalidResponse = () => ({ status: 200, code: 'INVALID_RESPONSE' });

function entry(record, id) {
  if (!record || typeof record !== 'object' || typeof id !== 'string' || !UUID.test(id)) {
    throw new TypeError('Нужны запись предмета и UUID материала.');
  }
  record.summaryEdit ??= {};
  record.summaryEdit[id.toLowerCase()] ??= {
    open: false, content: '', baseVersion: null, pending: false, reading: false,
    gate: '', latest: null, unavailable: false, fieldError: '', message: '', retryAt: 0,
    initialized: false, lastVersion: null, operation: null,
  };
  return record.summaryEdit[id.toLowerCase()];
}

function snapshot(draft) {
  return {
    open: draft.open, content: draft.content, baseVersion: draft.baseVersion,
    pending: draft.pending, reading: draft.reading, gate: draft.gate,
    latest: draft.latest ? { ...draft.latest } : null, unavailable: draft.unavailable,
    fieldError: draft.fieldError, message: draft.message, retryAt: draft.retryAt,
  };
}

export function getSummaryEditState(record, materialId) {
  return snapshot(entry(record, materialId));
}

export function createSummaryEditAction({
  record, materialId, subjectId, canAct, canWrite = () => true, onChange,
  onRead = () => {}, onSaved, onAccessError,
  api = summaryApi, materials = materialApi, now = Date.now,
}) {
  if (typeof subjectId !== 'string' || !UUID.test(subjectId)) {
    throw new TypeError('Нужен UUID предмета.');
  }
  const draft = entry(record, materialId);
  let stopped = false;
  let request = null;
  const owns = () => record.summaryEdit?.[materialId.toLowerCase()] === draft;
  const active = () => !stopped && owns() && canAct(materialId);
  const busy = () => request || draft.operation || draft.pending || draft.reading;
  const waiting = () => now() < draft.retryAt;

  function publish(changes) {
    if (!active()) return;
    Object.assign(draft, changes);
    onChange(snapshot(draft));
  }

  function start() {
    const operation = { controller: new AbortController(), submitted: false };
    request = operation;
    draft.operation = operation;
    return { operation, current: () => active() && request === operation
      && draft.operation === operation && !operation.controller.signal.aborted };
  }

  function release(operation) {
    if (!active()) return;
    if (request === operation) request = null;
    if (draft.operation === operation) draft.operation = null;
  }

  function validSummary(value) {
    return sameId(value?.materialId, materialId) && STATUSES.has(value.status)
      && (value.version === null || (Number.isSafeInteger(value.version)
        && value.version >= 1 && isValidSummaryContent(value.content)));
  }

  function fail(error, writing) {
    const access = (error?.status === 401 && error.code === 'AUTHENTICATION_REQUIRED')
      || (error?.status === 403 && error.code === 'CSRF_INVALID')
      || error?.code === 'CSRF_NOT_INITIALIZED';
    const conflict = error?.status === 409 && error.code === 'SUMMARY_VERSION_CONFLICT';
    const generating = error?.status === 409 && error.code === 'SUMMARY_IN_PROGRESS';
    const unavailable = error?.status === 404 || (error?.status === 409
      && error.code === 'MATERIAL_NOT_AVAILABLE');
    const validation = error?.status === 422 && error.code === 'VALIDATION_FAILED';
    const uncertain = writing && !access && !conflict && !generating && !unavailable
      && (['INVALID_RESPONSE', 'NETWORK_ERROR', 'REQUEST_CANCELLED'].includes(error?.code)
        || ![400, 409, 422, 429].includes(error?.status));
    const seconds = Number.isSafeInteger(error?.retryAfterSeconds)
      && error.retryAfterSeconds >= 0 ? error.retryAfterSeconds : 0;
    const fieldError = validation && Object.hasOwn(error.fieldErrors ?? {}, 'content')
      && typeof error.fieldErrors.content === 'string' && error.fieldErrors.content.trim()
      ? error.fieldErrors.content : '';

    publish({
      pending: false, reading: false,
      retryAt: Math.min(Number.MAX_SAFE_INTEGER, now() + seconds * 1000),
      ...(access || conflict || generating || unavailable || uncertain
        ? { baseVersion: null, latest: null } : {}),
      ...(conflict || generating ? { gate: 'conflict' } : {}),
      ...(uncertain ? { gate: 'uncertain' } : {}),
      unavailable: unavailable || generating,
      fieldError,
      message: access
        ? 'Требуется проверить сессию. Черновик сохранён; после восстановления загрузи актуальную версию.'
        : conflict
          ? 'Конспект изменился на сервере. Загрузи актуальную версию и сравни её с черновиком.'
          : generating ? GENERATING
            : uncertain
              ? 'Не удалось подтвердить сохранение. Проверь конспект перед повторной отправкой.'
              : unavailable
                ? 'Конспект сейчас недоступен для редактирования. Черновик сохранён.'
                : validation ? 'Проверь текст конспекта. Черновик сохранён.'
                  : error?.code === 'RATE_LIMITED' ? 'Слишком много запросов. Подожди перед повтором.'
                    : writing ? 'Не удалось сохранить конспект. Черновик сохранён.'
                      : 'Не удалось загрузить конспект. Попробуй проверить его ещё раз.',
    });
    if (access && active()) {
      stop();
      onAccessError(error);
    }
  }

  async function read() {
    if (!active() || busy() || waiting() || !draft.open) return;
    const needsReview = Boolean(draft.gate);
    const { operation, current } = start();
    publish({ reading: true, baseVersion: null, latest: null, message: '', retryAt: 0 });
    try {
      if (!current()) return;
      const material = await materials.getById(materialId, { signal: operation.controller.signal });
      if (!current()) return;
      if (!sameId(material?.id, materialId) || !sameId(material.subjectId, subjectId)
        || !['stored', 'uploading', 'deleting'].includes(material.status)) throw invalidResponse();
      if (material.status !== 'stored') {
        publish({ unavailable: true, message: 'Материал сейчас недоступен для редактирования конспекта.' });
        return;
      }
      const value = await api.getByMaterial(materialId, { signal: operation.controller.signal });
      if (!current()) return;
      if (!validSummary(value)) throw invalidResponse();
      onRead(value);
      if (!current()) return;
      if (!TERMINAL.has(value.status) || value.version === null) {
        publish({ unavailable: true, message: TERMINAL.has(value.status)
          ? 'Сохранённого конспекта пока нет.' : GENERATING });
        return;
      }
      const review = draft.initialized && (needsReview || value.version !== draft.lastVersion);
      publish({
        content: draft.initialized ? draft.content : value.content,
        initialized: true,
        lastVersion: review ? draft.lastVersion : value.version,
        baseVersion: review ? null : value.version,
        gate: review ? 'review' : '',
        latest: review ? { content: value.content, version: value.version } : null,
        unavailable: false, fieldError: '',
        message: review ? 'Сравни черновик с текущим конспектом и выбери, с каким продолжить.' : '',
      });
    } catch (error) {
      if (current()) fail(error, false);
    } finally {
      if (current()) {
        release(operation);
        publish({ reading: false });
      }
    }
  }

  async function open() {
    if (!active() || busy() || !canWrite()) return;
    publish({ open: true, baseVersion: null, latest: null });
    await read();
  }

  async function review() {
    await read();
  }

  function changeContent(content) {
    if (!active() || !draft.open || busy() || !draft.initialized
      || typeof content !== 'string') return;
    publish({ content, fieldError: '', message: '' });
  }

  function chooseVersion(useServer) {
    if (!active() || !draft.open || busy() || waiting() || !canWrite()
      || draft.unavailable || draft.gate !== 'review' || !draft.latest
      || typeof useServer !== 'boolean') return;
    publish({
      content: useServer ? draft.latest.content : draft.content,
      baseVersion: draft.latest.version, lastVersion: draft.latest.version,
      latest: null, gate: '', fieldError: '',
      message: 'Выбор принят. Нажми «Сохранить конспект», чтобы отправить его.',
    });
  }

  async function save() {
    if (!active() || !draft.open || busy() || waiting() || draft.gate
      || draft.unavailable || !draft.initialized || !draft.baseVersion || !canWrite()) return;
    if (!isValidSummaryContent(draft.content)) {
      publish({ fieldError: CONTENT_ERROR, message: '' });
      return;
    }
    const content = draft.content;
    const version = draft.baseVersion;
    const { operation, current } = start();
    publish({ pending: true, fieldError: '', message: '', retryAt: 0 });
    try {
      if (!current()) return;
      if (!canWrite()) {
        publish({ pending: false, baseVersion: null, latest: null, unavailable: true, message: GENERATING });
        return;
      }
      operation.submitted = true;
      const value = await api.update(materialId, { content }, {
        version, signal: operation.controller.signal,
      });
      if (!current()) return;
      if (!validSummary(value) || !TERMINAL.has(value.status) || value.version !== version + 1
        || value.origin !== 'user' || value.model !== null || !Array.isArray(value.sourcePages)
        || value.sourcePages.length !== 0 || value.inputTokens !== null || value.outputTokens !== null) {
        throw invalidResponse();
      }
      operation.submitted = false;
      release(operation);
      publish({
        open: false, content: '', baseVersion: null, pending: false, reading: false,
        gate: '', latest: null, unavailable: false, initialized: false, lastVersion: null,
        fieldError: '', message: 'Конспект сохранён.',
      });
      if (active()) onSaved(value);
    } catch (error) {
      if (current()) {
        const writing = operation.submitted;
        operation.submitted = false;
        fail(error, writing);
      }
    } finally {
      if (current()) release(operation);
    }
  }

  function close() {
    if (!active() || draft.pending || (draft.operation && draft.operation !== request)) return;
    const operation = request;
    release(operation);
    operation?.controller.abort();
    publish({ open: false, reading: false, baseVersion: null, latest: null });
  }

  function stop() {
    if (stopped) return;
    if (owns() && (!draft.operation || draft.operation === request)) {
      Object.assign(draft, {
        ...(request?.submitted ? {
          gate: 'uncertain',
          message: 'Ожидание прервано. Проверь конспект: результат сохранения неизвестен.',
        } : {}),
        pending: false, reading: false, baseVersion: null, latest: null, operation: null,
      });
    }
    stopped = true;
    request?.controller.abort();
    request = null;
  }

  return { open, changeContent, save, review, chooseVersion, close, stop };
}
