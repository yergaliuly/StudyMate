import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/services/apiClient.js';
import { createJobWatcher } from '../src/services/jobWatcher.js';
import { createMaterialTextReader } from '../src/services/materialTextReader.js';

const ID = '3dfa4d7d-619d-4a97-9f09-a34d236e879b';
const SUBJECT = '6f07410e-98f7-41a3-bfab-cbc387683fc1';
const OTHER = '7f07410e-98f7-41a3-bfab-cbc387683fc1';
const JOB = '095f15c2-1f89-4e09-a9ab-b3b281766f57';

// Здесь API подменён: проверяем управление запросами и состоянием.
// Полную проверку серверных DTO покрывают тесты materialApi.
function doc(processingStatus = 'not_started', changes = {}) {
  return {
    id: ID,
    subjectId: SUBJECT,
    status: 'stored',
    processingStatus,
    processingJobId: processingStatus === 'not_started' ? null : JOB,
    ...changes,
  };
}

function pages(page = 1) {
  return {
    pages: [{ pageNumber: page, text: 'Страница ' + page }],
    meta: { page, pageSize: 5, total: 20 },
  };
}

const pause = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;

  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });

  return { promise, resolve, reject };
}

function setup(reads = [], pageReads = []) {
  const calls = [];
  const views = [];
  const watches = [];
  const access = [];

  let allowed = true;
  let notifications = 0;

  async function pull(queue) {
    const next = queue.shift();

    if (next instanceof Error) throw next;

    return typeof next === 'function' ? next() : await next;
  }

  const api = {
    getById(id, options) {
      calls.push({ kind: 'material', id, options });
      return pull(reads);
    },
    pages(id, options) {
      calls.push({ kind: 'pages', id, options });
      return pull(pageReads);
    },
  };

  const reader = createMaterialTextReader({
    materialId: ID,
    subjectId: SUBJECT,
    canAct: (id) => allowed && id === ID,
    onChange: (view) => views.push(view),
    onAccessError: (error) => access.push(error),
    onMaterialRead: () => {
      notifications += 1;
    },
    api,
    watch(id, handlers) {
      const record = { id, handlers, stopped: false };
      watches.push(record);

      return () => {
        record.stopped = true;
      };
    },
  });

  return {
    reader,
    calls,
    views,
    watches,
    access,
    deny() {
      allowed = false;
    },
    get last() {
      return views.at(-1);
    },
    get notifications() {
      return notifications;
    },
  };
}

test('Создание не отправляет запросов; stop запрещает последующий refresh', async () => {
  const s = setup();

  assert.equal(s.calls.length, 0);
  assert.equal(s.views.length, 0);

  s.reader.stop();
  s.reader.refresh();
  await pause();

  assert.equal(s.calls.length, 0);
});

test('not_started не запускает задания или страницы', async () => {
  const s = setup([doc()]);

  s.reader.refresh();
  await pause();

  assert.equal(s.calls.length, 1);
  assert.equal(s.last.material.processingStatus, 'not_started');
  assert.equal(s.watches.length, 0);
  assert.equal(s.notifications, 1);

  s.reader.stop();
});

test('ready загружает свежий материал и страницы с размером 5', async () => {
  const data = pages();
  const s = setup([doc('ready')], [data]);

  s.reader.refresh();
  await pause();

  assert.deepEqual(
    s.calls.map((call) => call.kind),
    ['material', 'pages'],
  );
  assert.equal(s.calls[1].options.pageSize, 5);
  assert.equal(s.calls[1].options.page, 1);
  assert.equal(s.last.pages.data, data);

  s.reader.stop();
});

test('Материал другого предмета не показывается', async () => {
  const s = setup([doc('ready', { subjectId: OTHER })]);

  s.reader.refresh();
  await pause();

  assert.equal(s.last.status, 'error');
  assert.equal(s.last.material, null);
  assert.equal(s.calls.length, 1);
  assert.equal(s.notifications, 0);

  s.reader.stop();
});

test('uploading и deleting не читают страницы и не запускают наблюдение', async () => {
  for (const status of ['uploading', 'deleting']) {
    const s = setup([doc('ready', { status })]);

    s.reader.refresh();
    await pause();

    assert.equal(s.calls.length, 1);
    assert.equal(s.watches.length, 0);

    s.reader.stop();
  }
});

test('Завершение задания перечитывает материал и страницы; позднее обновление игнорируется', async () => {
  const s = setup([doc('queued'), doc('ready')], [pages()]);

  s.reader.refresh();
  await pause();

  const watcher = s.watches[0];

  watcher.handlers.onUpdate({
    type: 'material.extract_text',
    status: 'running',
  });

  assert.equal(s.last.jobStatus, 'running');
  assert.equal(s.calls.length, 1);

  watcher.handlers.onUpdate({
    type: 'material.extract_text',
    status: 'succeeded',
    resultId: ID,
  });

  await pause();

  assert.deepEqual(
    s.calls.map((call) => call.kind),
    ['material', 'material', 'pages'],
  );
  assert.equal(s.last.pages.status, 'ready');
  assert.equal(watcher.stopped, true);

  watcher.handlers.onUpdate({
    type: 'material.extract_text',
    status: 'queued',
  });

  assert.equal(s.last.jobStatus, null);

  s.reader.stop();
});

test('failed и cancelled подтверждаются GET без чтения текста', async () => {
  for (const status of ['failed', 'cancelled']) {
    const s = setup([doc('queued'), doc(status)]);

    s.reader.refresh();
    await pause();

    s.watches[0].handlers.onUpdate({
      type: 'material.extract_text',
      status,
    });

    await pause();

    assert.equal(s.last.material.processingStatus, status);
    assert.equal(s.calls.length, 2);

    s.reader.stop();
  }
});

test('Неверный тип задания или resultId прекращает опрос', async () => {
  const invalidJobs = [
    { type: 'material.delete', status: 'running' },
    {
      type: 'material.extract_text',
      status: 'succeeded',
      resultId: OTHER,
    },
    {
      type: 'material.extract_text',
      status: 'succeeded',
      resultId: null,
    },
  ];

  for (const job of invalidJobs) {
    const s = setup([doc('queued')]);

    s.reader.refresh();
    await pause();

    s.watches[0].handlers.onUpdate(job);

    assert.equal(s.last.watchError, 'INVALID_RESPONSE');
    assert.equal(s.watches[0].stopped, true);
    assert.equal(s.calls.length, 1);

    s.reader.stop();
  }
});

test('Прежний queued после завершения задания не создаёт бесконечный цикл GET', async () => {
  const s = setup([doc('queued'), doc('queued'), doc('queued')]);

  s.reader.refresh();
  await pause();

  s.watches[0].handlers.onUpdate({
    type: 'material.extract_text',
    status: 'failed',
  });

  await pause();

  assert.equal(s.last.watchError, 'STATUS_NOT_CONFIRMED');
  assert.equal(s.calls.length, 2);
  assert.equal(s.watches.length, 1);

  s.reader.refresh();
  await pause();

  assert.equal(s.watches.length, 2);

  s.reader.stop();
});

test('Новое задание после завершения прежнего можно наблюдать', async () => {
  const s = setup([
    doc('queued'),
    doc('queued', { processingJobId: OTHER }),
  ]);

  s.reader.refresh();
  await pause();

  s.watches[0].handlers.onUpdate({
    type: 'material.extract_text',
    status: 'failed',
  });

  await pause();

  assert.equal(s.watches.length, 2);
  assert.equal(s.watches[1].id, OTHER);

  s.reader.stop();
});

test('Ошибка наблюдения не считается удалением материала', async () => {
  for (const code of [
    'JOB_NOT_FOUND',
    'SERVICE_UNAVAILABLE',
    'NETWORK_ERROR',
  ]) {
    const s = setup([doc('queued')]);

    s.reader.refresh();
    await pause();

    s.watches[0].handlers.onError(new ApiError('Ошибка', {
      code,
      status: code === 'JOB_NOT_FOUND' ? 404 : 503,
    }));

    assert.equal(s.last.status, 'ready');
    assert.equal(s.last.watchError, code);
    assert.equal(s.calls.length, 1);

    s.reader.stop();
  }
});

test('401 при чтении материала, страниц или задания скрывает данные и восстанавливает сессию', async () => {
  for (const stage of ['material', 'pages', 'watch']) {
    const error = new ApiError('Войди в аккаунт.', {
      status: 401,
      code: 'AUTHENTICATION_REQUIRED',
    });

    const s = setup(
      stage === 'material'
        ? [error]
        : [doc(stage === 'watch' ? 'queued' : 'ready')],
      stage === 'pages' ? [error] : [],
    );

    s.reader.refresh();
    await pause();

    if (stage === 'watch') {
      s.watches[0].handlers.onError(error);
    }

    assert.equal(s.last.status, 'checking');
    assert.equal(s.last.material, null);
    assert.equal(s.last.pages.status, 'idle');
    assert.deepEqual(s.access, [error]);

    s.reader.stop();
  }
});

test('Поздний ответ материала после refresh или stop игнорируется', async () => {
  const pending = deferred();
  const s = setup([pending.promise, doc()]);

  s.reader.refresh();
  s.reader.refresh();
  await pause();

  const count = s.views.length;
  pending.resolve(doc('ready'));
  await pause();

  assert.equal(s.views.length, count);
  assert.equal(s.calls[0].options.signal.aborted, true);

  s.reader.stop();

  const late = deferred();
  const other = setup([late.promise]);

  other.reader.refresh();
  other.reader.stop();

  late.resolve(doc('ready'));
  await pause();

  assert.equal(other.calls.length, 1);
  assert.equal(other.notifications, 0);
});

test('Быстрая смена страниц отменяет и игнорирует прежний ответ', async () => {
  const old = deferred();
  const s = setup(
    [doc('ready')],
    [pages(1), old.promise, pages(3)],
  );

  s.reader.refresh();
  await pause();

  void s.reader.readPage(2);

  assert.equal(s.last.pages.status, 'loading');
  assert.equal(s.last.pages.data, undefined);

  void s.reader.readPage(3);
  await pause();

  assert.equal(s.last.pages.data.meta.page, 3);

  old.resolve(pages(2));
  await pause();

  assert.equal(s.last.pages.data.meta.page, 3);
  assert.equal(s.calls[2].options.signal.aborted, true);

  s.reader.stop();
});

test('Потеря активности останавливает наблюдение и скрывает поздние страницы', async () => {
  const s = setup([doc('queued')]);

  s.reader.refresh();
  await pause();

  const count = s.views.length;
  s.deny();

  s.watches[0].handlers.onUpdate({
    type: 'material.extract_text',
    status: 'queued',
  });

  assert.equal(s.watches[0].stopped, true);
  assert.equal(s.views.length, count);

  s.reader.stop();

  const late = deferred();
  const other = setup([doc('ready')], [late.promise]);

  other.reader.refresh();
  await pause();

  const previousCount = other.views.length;
  other.deny();

  late.resolve(pages());
  await pause();

  assert.equal(other.views.length, previousCount);

  other.reader.stop();
});

test('404 материала скрывает данные; ошибка загрузки страниц повторяется вручную', async () => {
  for (const stage of ['material', 'pages']) {
    const error = new ApiError('Материал не найден.', {
      status: 404,
      code: 'MATERIAL_NOT_FOUND',
    });

    const s = setup(
      stage === 'material' ? [error] : [doc('ready')],
      stage === 'pages' ? [error] : [],
    );

    s.reader.refresh();
    await pause();

    assert.equal(s.last.status, 'unavailable');
    assert.equal(s.last.material, null);
    assert.equal(s.last.pages.status, 'idle');

    s.reader.stop();
  }

  const s = setup(
    [doc('ready')],
    [new ApiError('Ошибка сети.', { code: 'NETWORK_ERROR' }), pages()],
  );

  s.reader.refresh();
  await pause();

  assert.equal(s.calls.length, 2);
  assert.equal(s.last.pages.status, 'error');

  await s.reader.readPage(1);

  assert.equal(s.last.pages.status, 'ready');
  assert.equal(s.calls.length, 3);

  s.reader.stop();
});

test('Реальный watcher завершает наблюдение перед колбэком, но reader получает текст', async () => {
  const views = [];
  let materialCalls = 0;
  let pagesCalls = 0;
  let jobSignal;

  const watcher = createJobWatcher({
    async getById(id, { signal }) {
      jobSignal = signal;

      return {
        type: 'material.extract_text',
        status: 'succeeded',
        resultId: ID,
      };
    },
  });

  const reader = createMaterialTextReader({
    materialId: ID,
    subjectId: SUBJECT,
    canAct: () => true,
    onChange: (view) => views.push(view),
    onAccessError: () => assert.fail('Не ожидали ошибку доступа.'),
    api: {
      async getById() {
        materialCalls += 1;
        return materialCalls === 1 ? doc('queued') : doc('ready');
      },
      async pages() {
        pagesCalls += 1;
        return pages();
      },
    },
    watch: watcher,
  });

  reader.refresh();
  await pause();

  assert.equal(jobSignal.aborted, true);
  assert.equal(materialCalls, 2);
  assert.equal(pagesCalls, 1);
  assert.equal(views.at(-1).pages.status, 'ready');

  reader.stop();
});