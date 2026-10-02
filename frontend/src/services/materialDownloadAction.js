import { materialApi } from './materialApi.js';

const messages = {
  MATERIAL_NOT_FOUND: 'Материал больше недоступен. Обнови список.',
  MATERIAL_NOT_AVAILABLE: 'Состояние материала изменилось. Обнови материал.',
  STORAGE_UNAVAILABLE: 'Хранилище сейчас недоступно. Попробуй позже.',
  SERVICE_UNAVAILABLE: 'Сервис сейчас недоступен. Попробуй позже.',
  RATE_LIMITED: 'Слишком много запросов. Подожди перед повтором.',
};

export function createMaterialDownloadAction({
  materialId,
  canAct,
  getMaterial,
  onDownload,
  onChange,
  onAccessError,
  api = materialApi,
  now = Date.now,
}) {
  let stopped = false;
  let request = null;
  let state = { pending: false, retryAt: 0, message: '' };

  const active = () => !stopped && canAct(materialId);

  function available() {
    const material = getMaterial();

    return material?.id?.toLowerCase() === materialId.toLowerCase()
      && material.status === 'stored';
  }

  function publish(changes) {
    state = { ...state, ...changes };
    if (active()) onChange({ ...state });
  }

  function stop() {
    stopped = true;
    request?.abort();
    request = null;
  }

  async function run() {
    if (!active() || request || now() < state.retryAt || !available()) return;

    const controller = new AbortController();
    request = controller;

    const current = () => active()
      && request === controller
      && !controller.signal.aborted;

    publish({ pending: true, retryAt: 0, message: '' });

    try {
      if (!current()) return;

      const { url, expiresAt } = await api.getDownload(materialId, {
        signal: controller.signal,
      });

      if (!current()) return;

      if (!available()) {
        publish({ message: messages.MATERIAL_NOT_AVAILABLE });
        return;
      }

      const expires = Date.parse(expiresAt);
      if (!Number.isFinite(expires) || expires <= now()) {
        publish({ message: 'Ссылка уже истекла. Нажми скачивание ещё раз.' });
        return;
      }

      // Синхронная передача исходной ссылки браузеру; URL не входит в state.
      onDownload(url);
    } catch (error) {
      if (!current()) return;

      const access = (
        error?.status === 401 && error.code === 'AUTHENTICATION_REQUIRED'
      ) || (
        error?.status === 403 && error.code === 'CSRF_INVALID'
      ) || error?.code === 'CSRF_NOT_INITIALIZED';

      const seconds = Number.isSafeInteger(error?.retryAfterSeconds)
        && error.retryAfterSeconds >= 0
        ? error.retryAfterSeconds
        : 0;

      publish({
        pending: false,
        retryAt: Math.min(Number.MAX_SAFE_INTEGER, now() + seconds * 1000),
        message: access
          ? 'Требуется проверить сессию. После восстановления повтори скачивание.'
          : Object.hasOwn(messages, error?.code)
            ? messages[error.code]
            : 'Не удалось получить ссылку. Попробуй ещё раз.',
      });

      if (access && current()) {
        stop();
        onAccessError(error);
      }
    } finally {
      if (request === controller) {
        request = null;
        publish({ pending: false });
      }
    }
  }

  return { run, stop };
}
