import { materialApi } from './materialApi.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const RETRYABLE_ERRORS = new Set([
  'PDF_TIMEOUT',
  'PDF_RESOURCE_LIMIT',
  'PDF_WORKER_FAILED',
  'JOB_TEMPORARY_FAILURE',
  'JOB_PROCESSING_FAILED',
  'JOB_ATTEMPTS_EXHAUSTED',
  'JOB_LEASE_EXPIRED',
  'JOB_OUTCOME_UNKNOWN',
]);

const messages = {
  STORAGE_UNAVAILABLE: 'Хранилище сейчас недоступно. Попробуй позже.',
  SERVICE_UNAVAILABLE: 'Сервис сейчас недоступен. Попробуй позже.',
  RATE_LIMITED: 'Слишком много запросов. Подожди перед повтором.',
  REQUEST_IN_PROGRESS: 'Запрос ещё выполняется. Подожди перед повтором.',
  MATERIAL_NOT_AVAILABLE:
    'Материал сейчас недоступен для обработки. Обнови его состояние.',
};

function entry(record, id) {
  if (!record || typeof record !== 'object' || !UUID.test(id)) {
    throw new TypeError('Нужны запись предмета и UUID материала.');
  }

  record.processing ??= {};
  record.processing[id.toLowerCase()] ??= {
    key: null,
    pending: false,
    uncertain: false,
    awaitingRead: false,
    retryAt: 0,
    message: '',
    operation: null,
    latestMaterial: null,
  };

  return record.processing[id.toLowerCase()];
}

function snapshot(draft) {
  return {
    hasAttempt: Boolean(draft.key),
    pending: draft.pending,
    uncertain: draft.uncertain,
    awaitingRead: draft.awaitingRead,
    retryAt: draft.retryAt,
    message: draft.message,
  };
}

export function getMaterialProcessingState(record, id) {
  return snapshot(entry(record, id));
}

export function canProcessMaterial(material) {
  if (material?.status !== 'stored') return false;

  if (['not_started', 'cancelled'].includes(material.processingStatus)) {
    return true;
  }

  return material.processingStatus === 'failed'
    && RETRYABLE_ERRORS.has(material.processingError?.code);
}

// Вызывать только после свежего GET, а не с карточкой из списка.
export function reconcileMaterialProcessing(record, material) {
  const draft = record.processing?.[material.id.toLowerCase()];
  if (!draft) return;

  draft.latestMaterial = {
    id: material.id,
    status: material.status,
    processingStatus: material.processingStatus,
    processingError: material.processingError,
  };

  if (!draft.awaitingRead || draft.pending || draft.uncertain) return;

  Object.assign(draft, {
    key: null,
    uncertain: false,
    awaitingRead: false,
    message: '',
  });
}

export function createMaterialProcessingAction({
  record,
  materialId,
  canAct,
  getMaterial,
  onChange,
  onRefresh,
  onAccessError,
  api = materialApi,
  makeKey = () => globalThis.crypto.randomUUID(),
  now = Date.now,
}) {
  const draft = entry(record, materialId);
  let stopped = false;
  let request = null;

  const active = () => !stopped
    && canAct(materialId)
    && record.processing?.[materialId.toLowerCase()] === draft;

  function publish(changes) {
    Object.assign(draft, changes);
    if (active()) onChange(snapshot(draft));
  }

  async function run() {
    if (
      !active()
      || request
      || draft.pending
      || draft.awaitingRead
      || now() < draft.retryAt
    ) {
      return;
    }

    const material = draft.latestMaterial ?? getMaterial();

    if (
      material?.id?.toLowerCase() !== materialId.toLowerCase()
      || material.status !== 'stored'
      || (!draft.key && !canProcessMaterial(material))
    ) {
      return;
    }

    if (!draft.key) {
      try {
        const key = makeKey();

        if (typeof key !== 'string' || !UUID.test(key)) {
          throw new TypeError('Некорректный ключ.');
        }

        draft.key = key;
      } catch {
        publish({
          message: 'Не удалось подготовить запрос. Попробуй снова.',
        });
        return;
      }
    }

    const key = draft.key;
    const wasUncertain = draft.uncertain;
    const controller = new AbortController();

    request = controller;
    draft.operation = controller;

    const current = () => active()
      && !controller.signal.aborted
      && request === controller
      && draft.operation === controller
      && draft.key === key;

    publish({ pending: true, message: '' });
    if (!current()) return;

    try {
      // Результат уже проверен materialApi.
      // Актуальное состояние читаем отдельным GET.
      await api.process(materialId, {
        idempotencyKey: key,
        signal: controller.signal,
      });

      if (!current()) return;

      // Сначала блокируем новый запуск, затем перечитываем материал.
      publish({
        pending: false,
        uncertain: false,
        awaitingRead: true,
      });

      if (active()) onRefresh();
    } catch (error) {
      if (!current()) return;

      const access = (
        error?.status === 401
        && error.code === 'AUTHENTICATION_REQUIRED'
      ) || (
        error?.status === 403
        && error.code === 'CSRF_INVALID'
      ) || error?.code === 'CSRF_NOT_INITIALIZED';

      const seconds = Number.isSafeInteger(error?.retryAfterSeconds)
        && error.retryAfterSeconds >= 0
        ? error.retryAfterSeconds
        : error?.code === 'PROCESSING_IN_PROGRESS' ? 2 : 0;

      const retryAt = Math.min(
        Number.MAX_SAFE_INTEGER,
        now() + seconds * 1000,
      );

      const stateConflict = error?.status === 409
        && [
          'PROCESSING_IN_PROGRESS',
          'TEXT_ALREADY_EXTRACTED',
        ].includes(error.code);

      const wrongKey = error?.status === 409
        && error.code === 'IDEMPOTENCY_KEY_REUSED';

      if (stateConflict || wrongKey) {
        publish({
          pending: false,
          // После неизвестного исхода не забываем прежнюю попытку.
          uncertain: wrongKey ? false : wasUncertain,
          awaitingRead: wrongKey || !wasUncertain,
          retryAt,
          message: 'Состояние изменилось. Проверяем материал…',
        });

        if (active()) onRefresh();
        return;
      }

      const definite = access
        || [400, 404, 409, 422, 429].includes(error?.status);

      publish({
        pending: false,
        uncertain: wasUncertain || !definite,
        retryAt,
        message: access
          ? 'После восстановления доступа повтори запрос вручную.'
          : messages[error?.code]
            || 'Не удалось подтвердить запуск обработки.',
      });

      if (!active()) return;

      if (access) {
        onAccessError(error);
      } else if (
        error?.status === 404
        && error.code === 'MATERIAL_NOT_FOUND'
      ) {
        onRefresh();
      }
    } finally {
      if (draft.operation === controller) draft.operation = null;
      if (request === controller) request = null;
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;

    if (request && draft.operation === request && draft.pending) {
      Object.assign(draft, {
        pending: false,
        uncertain: true,
        message: 'Ожидание прервано. Результат запроса пока неизвестен.',
        operation: null,
      });
    }

    request?.abort();
    request = null;
  }

  return { run, stop };
}