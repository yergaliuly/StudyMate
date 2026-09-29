import { jobApi, isTerminalJobStatus } from './jobApi.js';

export function createJobWatcher(api = jobApi, {
  intervalMs = 2000,
  setTimeoutFn = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeoutFn = (timer) => globalThis.clearTimeout(timer),
} = {}) {
  if (typeof api?.getById !== 'function') {
    throw new TypeError('Нужен API с методом getById.');
  }

  if (
    !Number.isSafeInteger(intervalMs)
    || intervalMs < 2000
    || intervalMs > 2_147_483_647
  ) {
    throw new RangeError('Интервал должен быть целым числом от 2000 до 2147483647 мс.');
  }

  if (typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
    throw new TypeError('Нужны функции установки и отмены таймера.');
  }

  return function watchJob(id, { onUpdate, onError, signal } = {}) {
    if (typeof onUpdate !== 'function' || typeof onError !== 'function') {
      throw new TypeError('Передай функции onUpdate и onError.');
    }

    const controller = new AbortController();
    let stopped = false;
    let timer = null;

    function isActive() {
      return !stopped && !controller.signal.aborted && !signal?.aborted;
    }

    // Отменяем только наблюдение и HTTP-чтение, не само задание.
    function stop() {
      if (stopped) return;
      stopped = true;

      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }

      signal?.removeEventListener('abort', stop);
      controller.abort();
    }

    async function read() {
      if (!isActive()) return;

      let job;
      try {
        job = await api.getById(id, { signal: controller.signal });
      } catch (error) {
        if (!isActive()) return;
        stop();
        onError(error);
        return;
      }

      // Даже если транспорт не отреагировал на abort, старый ответ игнорируется.
      if (!isActive()) return;

      if (isTerminalJobStatus(job.status)) {
        stop();
      }

      // Колбэки синхронные: например, обновление состояния React.
      // Ошибка внутри onUpdate тоже прекращает наблюдение.
      try {
        onUpdate(job);
      } catch (error) {
        stop();
        onError(error);
        return;
      }

      // onUpdate мог вызвать stop() или отменить внешний signal.
      if (!isActive()) return;

      // Следующий запрос — после завершения текущего и отдельной паузы.
      timer = setTimeoutFn(() => {
        timer = null;
        void read();
      }, intervalMs);
    }

    signal?.addEventListener('abort', stop, { once: true });

    if (signal?.aborted) {
      stop();
    } else {
      // Вызывающий код сначала получит функцию stop.
      queueMicrotask(() => {
        void read();
      });
    }

    return stop;
  };
}

// При ошибке опрос заканчивается. Повторный запуск — явно с прежним id.
export const watchJob = createJobWatcher();