import { ApiError } from './apiClient.js';
import { materialApi } from './materialApi.js';
import { isTerminalJobStatus } from './jobApi.js';
import { watchJob } from './jobWatcher.js';
import { isRateLimited, retryDeadline, retrySeconds } from './retryAfter.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 5;

function emptyView() {
  return {
    status: 'loading',
    material: null,
    jobStatus: null,
    watchError: null,
    errorCode: null,
    retryAt: 0,
    pages: { status: 'idle' },
  };
}

export function createMaterialTextReader({
  materialId,
  subjectId,
  record = {},
  canAct,
  onChange,
  onAccessError,
  onMaterialRead = () => {},
  api = materialApi,
  watch = watchJob,
  now = Date.now,
}) {
  if (
    typeof materialId !== 'string' || !UUID.test(materialId)
    || typeof subjectId !== 'string' || !UUID.test(subjectId)
  ) {
    throw new TypeError('Нужны UUID материала и предмета.');
  }

  if (
    typeof canAct !== 'function'
    || typeof onChange !== 'function'
    || typeof onAccessError !== 'function'
    || typeof onMaterialRead !== 'function'
    || typeof api?.getById !== 'function'
    || typeof api?.pages !== 'function'
    || typeof watch !== 'function'
    || typeof now !== 'function'
    || !record || typeof record !== 'object'
  ) {
    throw new TypeError('Некорректные параметры просмотра материала.');
  }

  let stopped = false;
  record.textReads ??= {};
  const cooldown = record.textReads[materialId.toLowerCase()] ??= { retryAt: 0 };
  let generation = 0;
  let materialController = null;
  let pageController = null;
  let stopWatching = null;
  let material = null;
  let view = emptyView();
  const terminalJobs = new Set();

  const active = () => !stopped && canAct(materialId);
  const current = (epoch, controller) => active()
    && epoch === generation
    && !controller?.signal.aborted;

  function publish(patch) {
    if (!active()) return;
    view = { ...view, ...patch, retryAt: cooldown.retryAt };
    onChange(view);
  }

  function coolingDown() {
    if (!retrySeconds(cooldown.retryAt, now())) return false;
    publish(view.status === 'loading'
      ? { status: 'error', errorCode: 'RATE_LIMITED' } : {});
    return true;
  }

  function invalidate() {
    generation += 1;
    materialController?.abort();
    pageController?.abort();
    stopWatching?.();
    materialController = null;
    pageController = null;
    stopWatching = null;
    material = null;
  }

  function fail(error, epoch, stage, page = 1) {
    if (!current(epoch)) return;

    const accessError = (
      error?.status === 401 && error.code === 'AUTHENTICATION_REQUIRED'
    ) || (
      error?.status === 403 && error.code === 'CSRF_INVALID'
    ) || error?.code === 'CSRF_NOT_INITIALIZED';

    if (accessError) {
      invalidate();
      publish({ ...emptyView(), status: 'checking' });
      if (active()) onAccessError(error);
      return;
    }

    if (
      stage !== 'watch'
      && error?.status === 404
      && error.code === 'MATERIAL_NOT_FOUND'
    ) {
      invalidate();
      publish({ ...emptyView(), status: 'unavailable' });
      return;
    }

    const code = isRateLimited(error) ? 'RATE_LIMITED' : error?.code || 'REQUEST_FAILED';
    if (isRateLimited(error)) {
      cooldown.retryAt = Math.max(cooldown.retryAt, retryDeadline(error, now()));
    }

    if (stage === 'watch') {
      stopWatching?.();
      stopWatching = null;
      generation += 1;
      publish({ watchError: code });
    } else if (stage === 'pages') {
      publish({ pages: { status: 'error', page, code } });
    } else {
      invalidate();
      publish({ ...emptyView(), status: 'error', errorCode: code });
    }
  }

  async function readPage(page = 1) {
    if (
      !active()
      || coolingDown()
      || material?.status !== 'stored'
      || material.processingStatus !== 'ready'
    ) {
      return;
    }

    const epoch = generation;
    pageController?.abort();
    const controller = new AbortController();
    pageController = controller;
    publish({ pages: { status: 'loading', page } });

    if (!current(epoch, controller)) return;

    try {
      const data = await api.pages(materialId, {
        page,
        pageSize: PAGE_SIZE,
        signal: controller.signal,
      });

      if (!current(epoch, controller)) return;
      publish({ pages: { status: 'ready', data } });
    } catch (error) {
      if (current(epoch, controller)) fail(error, epoch, 'pages', page);
    }
  }

  async function loadMaterial() {
    if (!active() || coolingDown()) return;

    invalidate();
    const epoch = generation;
    const controller = new AbortController();
    materialController = controller;
    publish(emptyView());

    if (!current(epoch, controller)) return;

    try {
      const data = await api.getById(materialId, {
        signal: controller.signal,
      });

      if (!current(epoch, controller)) return;

      if (data.subjectId.toLowerCase() !== subjectId.toLowerCase()) {
        throw new ApiError('Материал не принадлежит выбранному предмету.', {
          status: 200,
          code: 'INVALID_RESPONSE',
        });
      }

      material = data;
      publish({ status: 'ready', material: data });
      if (!current(epoch, controller)) return;

      onMaterialRead(data);
      if (!current(epoch, controller) || data.status !== 'stored') return;

      if (data.processingStatus === 'ready') {
        void readPage(1);
        return;
      }

      if (!['queued', 'running'].includes(data.processingStatus)) return;

      const jobId = data.processingJobId;
      if (terminalJobs.has(jobId.toLowerCase())) {
        publish({ watchError: 'STATUS_NOT_CONFIRMED' });
        return;
      }

      let halt = () => {};
      halt = watch(jobId, {
        onUpdate(job) {
          if (!current(epoch)) {
            halt();
            return;
          }

          if (
            job.type !== 'material.extract_text'
            || (
              job.status === 'succeeded'
              && (
                typeof job.resultId !== 'string'
                || job.resultId.toLowerCase() !== materialId.toLowerCase()
              )
            )
          ) {
            halt();
            fail(new ApiError('Некорректный результат обработки.', {
              code: 'INVALID_RESPONSE',
            }), epoch, 'watch');
            return;
          }

          if (isTerminalJobStatus(job.status)) {
            terminalJobs.add(jobId.toLowerCase());
            void loadMaterial();
          } else {
            publish({ jobStatus: job.status, watchError: null });
          }
        },
        onError(error) {
          fail(error, epoch, 'watch');
        },
      });

      if (current(epoch)) stopWatching = halt;
      else halt();
    } catch (error) {
      if (current(epoch, controller)) fail(error, epoch, 'material');
    }
  }

  function refresh() {
    if (!active() || coolingDown()) return;
    terminalJobs.clear();
    void loadMaterial();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    invalidate();
    terminalJobs.clear();
    view = emptyView();
  }

  return { refresh, readPage, stop };
}
