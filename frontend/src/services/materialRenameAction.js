import { materialApi } from './materialApi.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const INVALID_TEXT = /[\u0000-\u001f\u007f\ud800-\udfff]/u;
const TITLE_ERROR = 'Название должно содержать от 1 до 160 допустимых символов.';
const messages = {
  MATERIAL_NOT_FOUND: 'Материал больше недоступен. Обнови список.',
  MATERIAL_NOT_AVAILABLE: 'Состояние материала изменилось. Обнови материал.',
  RATE_LIMITED: 'Слишком много запросов. Подожди перед повтором.',
  SERVICE_UNAVAILABLE: 'Сервис сейчас недоступен. Попробуй позже.',
};

function entry(record, id) {
  if (!record || typeof record !== 'object' || !UUID.test(id)) {
    throw new TypeError('Нужны запись предмета и UUID материала.');
  }

  record.rename ??= {};
  record.rename[id.toLowerCase()] ??= {
    open: false,
    title: '',
    baseVersion: null,
    pending: false,
    reading: false,
    gate: '',
    latest: null,
    unavailable: false,
    fieldError: '',
    message: '',
    retryAt: 0,
    initialized: false,
    lastVersion: null,
    operation: null,
  };
  return record.rename[id.toLowerCase()];
}

function snapshot(draft) {
  return {
    open: draft.open,
    title: draft.title,
    baseVersion: draft.baseVersion,
    pending: draft.pending,
    reading: draft.reading,
    gate: draft.gate,
    latest: draft.latest ? { ...draft.latest } : null,
    unavailable: draft.unavailable,
    fieldError: draft.fieldError,
    message: draft.message,
    retryAt: draft.retryAt,
  };
}

export function getMaterialRenameState(record, materialId) {
  return snapshot(entry(record, materialId));
}

function normalizeTitle(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function validTitle(title) {
  return typeof title === 'string'
    && title.length >= 1
    && title.length <= 160
    && !INVALID_TEXT.test(title);
}

function invalidResponse() {
  return { status: 200, code: 'INVALID_RESPONSE' };
}

export function createMaterialRenameAction({
  record,
  materialId,
  subjectId,
  canAct,
  onChange,
  onSaved,
  onRead = () => {},
  onAccessError,
  api = materialApi,
  now = Date.now,
}) {
  if (typeof subjectId !== 'string' || !UUID.test(subjectId)) {
    throw new TypeError('Нужен UUID предмета.');
  }

  const draft = entry(record, materialId);
  let stopped = false;
  let request = null;

  const owns = () => record.rename?.[materialId.toLowerCase()] === draft;
  const active = () => !stopped && owns() && canAct(materialId);
  const busy = () => request || draft.operation || draft.pending || draft.reading;
  const waiting = () => now() < draft.retryAt;

  function publish(changes) {
    if (!active()) return;
    Object.assign(draft, changes);
    onChange(snapshot(draft));
  }

  function validMaterial(material) {
    return typeof material?.id === 'string'
      && material.id.toLowerCase() === materialId.toLowerCase()
      && typeof material.subjectId === 'string'
      && material.subjectId.toLowerCase() === subjectId.toLowerCase()
      && Number.isSafeInteger(material.version)
      && material.version >= 1
      && validTitle(material.title)
      && ['uploading', 'stored', 'deleting'].includes(material.status);
  }

  function comparison(material) {
    return {
      id: material.id,
      subjectId: material.subjectId,
      title: material.title,
      version: material.version,
      status: material.status,
    };
  }

  function start() {
    const controller = new AbortController();
    request = controller;
    draft.operation = controller;
    return {
      controller,
      current: () => active()
        && !controller.signal.aborted
        && request === controller
        && draft.operation === controller,
    };
  }

  function release(controller) {
    if (!active()) return;
    if (request === controller) request = null;
    if (draft.operation === controller) draft.operation = null;
  }

  function fail(error, writing) {
    const access = (
      error?.status === 401 && error.code === 'AUTHENTICATION_REQUIRED'
    ) || (
      error?.status === 403 && error.code === 'CSRF_INVALID'
    ) || error?.code === 'CSRF_NOT_INITIALIZED';
    const conflict = error?.status === 409
      && error.code === 'MATERIAL_VERSION_CONFLICT';
    const unavailable = error?.status === 404 || (
      error?.status === 409 && error.code === 'MATERIAL_NOT_AVAILABLE'
    );
    const validation = error?.status === 422 && error.code === 'VALIDATION_FAILED';
    const uncertain = writing && !access && !conflict && !unavailable
      && (['INVALID_RESPONSE', 'NETWORK_ERROR', 'REQUEST_CANCELLED'].includes(error?.code)
        || ![400, 409, 422, 429].includes(error?.status));
    const seconds = Number.isSafeInteger(error?.retryAfterSeconds)
      && error.retryAfterSeconds >= 0 ? error.retryAfterSeconds : 0;
    const titleError = validation
      && Object.hasOwn(error.fieldErrors ?? {}, 'title')
      && typeof error.fieldErrors.title === 'string'
      && error.fieldErrors.title.trim().length > 0
      ? error.fieldErrors.title : '';

    publish({
      pending: false,
      reading: false,
      retryAt: Math.min(Number.MAX_SAFE_INTEGER, now() + seconds * 1000),
      ...(access || conflict || unavailable || uncertain
        ? { baseVersion: null, latest: null } : {}),
      ...(conflict ? { gate: 'conflict' } : {}),
      ...(uncertain ? { gate: 'uncertain' } : {}),
      unavailable,
      fieldError: titleError,
      message: access
        ? 'Требуется проверить сессию. Черновик сохранён; после восстановления проверь материал.'
        : conflict
          ? 'Название изменилось на сервере. Загрузи актуальные данные и сравни их с черновиком.'
          : uncertain
            ? 'Не удалось подтвердить сохранение. Проверь материал перед повторной отправкой.'
            : validation
              ? 'Проверь название. Черновик сохранён.'
              : Object.hasOwn(messages, error?.code)
                ? messages[error.code]
                : writing
                  ? 'Не удалось сохранить название. Черновик сохранён.'
                  : 'Не удалось загрузить материал. Попробуй проверить его ещё раз.',
    });

    if (access && active()) {
      stop();
      onAccessError(error);
    }
  }

  async function read() {
    if (!active() || busy() || waiting() || !draft.open) return;
    const needsReview = Boolean(draft.gate);
    const { controller, current } = start();
    publish({ reading: true, baseVersion: null, latest: null, message: '', retryAt: 0 });

    try {
      if (!current()) return;
      const material = await api.getById(materialId, { signal: controller.signal });
      if (!current()) return;
      if (!validMaterial(material)) throw invalidResponse();
      onRead(material);
      if (!current()) return;

      if (material.status !== 'stored') {
        publish({
          unavailable: true,
          message: messages.MATERIAL_NOT_AVAILABLE,
        });
        return;
      }

      const review = draft.initialized
        && (needsReview || material.version !== draft.lastVersion);
      publish({
        title: draft.initialized ? draft.title : material.title,
        initialized: true,
        lastVersion: review ? draft.lastVersion : material.version,
        baseVersion: review ? null : material.version,
        gate: review ? 'review' : '',
        latest: review ? comparison(material) : null,
        unavailable: false,
        fieldError: '',
        message: review
          ? 'Сравни черновик с текущим названием и выбери, с каким продолжить.'
          : '',
      });
    } catch (error) {
      if (current()) fail(error, false);
    } finally {
      if (current()) {
        release(controller);
        publish({ reading: false });
      }
    }
  }

  async function open() {
    if (!active() || busy()) return;
    publish({ open: true, baseVersion: null, latest: null });
    await read();
  }

  async function review() {
    await read();
  }

  function changeTitle(title) {
    if (!active() || !draft.open || busy() || !draft.initialized
      || typeof title !== 'string') return;
    publish({ title, fieldError: '', message: '' });
  }

  function chooseVersion(useServer) {
    if (!active() || !draft.open || busy() || waiting()
      || draft.unavailable || draft.gate !== 'review' || !draft.latest
      || typeof useServer !== 'boolean') return;

    publish({
      title: useServer ? draft.latest.title : draft.title,
      baseVersion: draft.latest.version,
      lastVersion: draft.latest.version,
      latest: null,
      gate: '',
      fieldError: '',
      message: 'Выбор принят. Нажми «Сохранить название», чтобы отправить его.',
    });
  }

  async function save() {
    if (!active() || !draft.open || busy() || waiting() || draft.gate
      || draft.unavailable || !draft.initialized || !draft.baseVersion) return;
    const title = normalizeTitle(draft.title);
    if (!validTitle(title)) {
      publish({ fieldError: TITLE_ERROR, message: '' });
      return;
    }

    const version = draft.baseVersion;
    const { controller, current } = start();
    publish({ pending: true, fieldError: '', message: '', retryAt: 0 });

    try {
      if (!current()) return;
      const material = await api.rename(materialId, { title }, {
        version,
        signal: controller.signal,
      });
      if (!current()) return;
      if (!validMaterial(material) || material.status !== 'stored'
        || material.version !== version + 1 || material.title !== title) {
        throw invalidResponse();
      }

      // Освобождаем запрос до уведомления: обновление родителя может закрыть панель.
      release(controller);
      publish({
        open: false,
        title: '',
        baseVersion: null,
        pending: false,
        gate: '',
        latest: null,
        initialized: false,
        lastVersion: null,
        message: 'Название сохранено.',
      });
      if (active()) onSaved(material);
    } catch (error) {
      if (current()) fail(error, true);
    } finally {
      if (current()) release(controller);
    }
  }

  function close() {
    if (!active() || draft.pending
      || (draft.operation && draft.operation !== request)) return;
    const controller = request;
    release(controller);
    controller?.abort();
    publish({ open: false, reading: false, baseVersion: null, latest: null });
  }

  function stop() {
    if (stopped) return;
    // Только владелец записи завершает ожидание. Поздний ответ её уже не изменит.
    if (owns() && request && draft.operation === request) {
      Object.assign(draft, {
        ...(draft.pending ? {
          gate: 'uncertain',
          message: 'Ожидание прервано. Проверь материал: результат сохранения неизвестен.',
        } : {}),
        pending: false,
        reading: false,
        baseVersion: null,
        latest: null,
        operation: null,
      });
    }
    stopped = true;
    request?.abort();
    request = null;
  }

  return { open, changeTitle, save, review, chooseVersion, close, stop };
}
