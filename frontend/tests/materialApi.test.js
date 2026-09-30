import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiClient, ApiError } from '../src/services/apiClient.js';
import { createMaterialApi } from '../src/services/materialApi.js';

const ID = '3dfa4d7d-619d-4a97-9f09-a34d236e879b';
const SUBJECT_ID = '6f07410e-98f7-41a3-bfab-cbc387683fc1';
const OTHER_ID = '7f07410e-98f7-41a3-bfab-cbc387683fc1';
const JOB_ID = '095f15c2-1f89-4e09-a9ab-b3b281766f57';
const KEY = '773b6d14-d350-4c27-8db8-b3b1fdb5d159';
const TIME = '2026-09-29T10:00:00.123456789Z';
const DOWNLOAD_URL = 'https://example.r2.cloudflarestorage.com/private/lecture.pdf?X-Amz-Signature=abc%2F123&x=a+b';

function material(changes = {}) {
  return {
    id: ID,
    subjectId: SUBJECT_ID,
    title: 'Лекция 1',
    fileName: 'Лекция 1.pdf',
    contentType: 'application/pdf',
    sizeBytes: 124800,
    status: 'stored',
    processingStatus: 'not_started',
    version: 1,
    createdAt: TIME,
    updatedAt: TIME,
    deletionJobId: null,
    processingJobId: null,
    pageCount: null,
    textCharacters: null,
    processingError: null,
    ...changes,
  };
}

function file() {
  return new File(['%PDF-1.7\n%%EOF\n'], 'Лекция 1.pdf', {
    type: 'application/pdf',
  });
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function setup(...responses) {
  const calls = [];
  const client = createApiClient({
    baseUrl: '/api/v1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const next = responses.shift();
      if (typeof next === 'function') return next(url, options);
      if (!next) throw new Error('Незапланированный запрос.');
      return next;
    },
  });

  return { api: createMaterialApi(client), client, calls };
}

async function setupWrite(...responses) {
  const state = setup(
    json({ data: { headerName: 'X-CSRF-TOKEN', token: 'test-csrf' } }),
    ...responses,
  );

  await state.client.refreshCsrf();
  state.calls.length = 0;
  return state;
}

function errorIs(code, status) {
  return (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

const operations = [
  {
    name: 'list',
    write: false,
    call: (api, signal) => api.list({ signal }),
  },
  {
    name: 'getById',
    write: false,
    call: (api, signal) => api.getById(ID, { signal }),
  },
  {
    name: 'upload',
    write: true,
    call: (api, signal) => api.upload(
      { file: file(), subjectId: SUBJECT_ID },
      { idempotencyKey: KEY, signal },
    ),
  },
  {
    name: 'rename',
    write: true,
    call: (api, signal) => api.rename(
      ID,
      { title: 'Новое название' },
      { version: 1, signal },
    ),
  },
  {
    name: 'getDownload',
    write: false,
    call: (api, signal) => api.getDownload(ID, { signal }),
  },
    {
    name: 'remove',
    write: true,
    call: (api, signal) => api.remove(ID, { signal }),
  },
  {
    name: 'process',
    write: true,
    call: (api, signal) => api.process(ID, {
      idempotencyKey: KEY,
      signal,
    }),
  },
  {
    name: 'pages',
    write: false,
    call: (api, signal) => api.pages(ID, { signal }),
  },
];

test('Создание адаптера не отправляет запросов', () => {
  assert.equal(setup().calls.length, 0);
});

test('Список передаёт фильтр, буквальный поиск и пагинацию серверу', async () => {
  const meta = { page: 2, pageSize: 5, total: 6 };
  const { api, calls } = setup(json({
    data: [material({ subjectId: SUBJECT_ID.toUpperCase() })],
    meta,
  }));
  const controller = new AbortController();

  const result = await api.list({
    subjectId: SUBJECT_ID,
    q: '  SQL  100%_  ',
    page: 2,
    pageSize: 5,
    signal: controller.signal,
  });

  assert.deepEqual(result.meta, meta);
  assert.equal(result.materials.length, 1);

  const url = new URL(calls[0].url, 'http://127.0.0.1');
  assert.equal(url.pathname, '/api/v1/materials');
  assert.equal(url.searchParams.get('subjectId'), SUBJECT_ID);
  assert.equal(url.searchParams.get('q'), 'SQL  100%_');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('pageSize'), '5');
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.cache, 'no-store');
});

test('Список по умолчанию не добавляет фильтр и пустой поиск', async () => {
  const { api, calls } = setup(json({
    data: [],
    meta: { page: 1, pageSize: 20, total: 0 },
  }));

  assert.deepEqual(await api.list(), {
    materials: [],
    meta: { page: 1, pageSize: 20, total: 0 },
  });
  assert.equal(calls[0].url, '/api/v1/materials?page=1&pageSize=20');
});

test('Пустая страница сохраняет настоящий total', async () => {
  const meta = { page: 5, pageSize: 20, total: 3 };
  const { api } = setup(json({ data: [], meta }));

  assert.deepEqual(await api.list({ page: 5 }), { materials: [], meta });
});

test('Некорректные параметры списка не отправляются', async () => {
  const { api, calls } = setup();

  for (const options of [
    { subjectId: null },
    { subjectId: 'bad' },
    { q: null },
    { q: 'x'.repeat(161) },
    { q: 'a\0b' },
    { q: '\ud800' },
    { page: 0 },
    { page: '1' },
    { page: 1.5 },
    { page: Number.MAX_SAFE_INTEGER + 1 },
    { pageSize: 0 },
    { pageSize: 101 },
  ]) {
    await assert.rejects(() => api.list(options));
  }

  assert.equal(calls.length, 0);
});

test('Некорректные meta и материал другого предмета отклоняются', async () => {
  const meta = { page: 1, pageSize: 20, total: 1 };

  for (const payload of [
    { data: [material()], meta: null },
    { data: [material()], meta: { ...meta, page: 2 } },
    { data: [material()], meta: { ...meta, pageSize: 10 } },
    { data: [], meta: { ...meta, total: -1 } },
    { data: [], meta: { ...meta, total: '1' } },
    { data: [material()], meta: { ...meta, total: 0 } },
    { data: Array(21).fill(material()), meta: { ...meta, total: 21 } },
    { data: [material({ subjectId: OTHER_ID })], meta },
  ]) {
    const { api } = setup(json(payload));

    await assert.rejects(
      () => api.list({ subjectId: SUBJECT_ID }),
      errorIs('INVALID_RESPONSE', 200),
    );
  }
});

for (const status of ['uploading', 'stored', 'deleting']) {
  test('GET материала сохраняет состояние ' + status + ' и только публичные поля', async () => {
    const data = material({
      status,
      deletionJobId: status === 'deleting' ? JOB_ID : null,
    });
    const { api, calls } = setup(json({
      data: {
        ...data,
        ownerId: 'internal',
        objectKey: 'private/object',
      },
    }));

    assert.deepEqual(await api.getById(ID.toUpperCase()), data);
    assert.equal(calls[0].url, '/api/v1/materials/' + ID.toUpperCase());
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.body, undefined);
    assert.equal(calls[0].options.headers.has('X-CSRF-TOKEN'), false);
  });
}

test('Неверный UUID отклоняется всеми методами до запроса', async () => {
  const { api, calls } = setup();

  for (const id of [undefined, null, '', '../auth/me', ID + '?q=1']) {
    for (const run of [
      () => api.getById(id),
      () => api.rename(id, { title: 'Лекция' }, { version: 1 }),
      () => api.getDownload(id),
      () => api.remove(id),
    ]) {
      await assert.rejects(run, TypeError);
    }
  }

  assert.equal(calls.length, 0);
});

test('Некорректный Material и несовместимые состояния отклоняются', async () => {
  for (const data of [
    null,
    [],
    material({ id: OTHER_ID }),
    material({ subjectId: 'bad' }),
    material({ title: ' ' }),
    material({ title: '\ud800' }),
    material({ fileName: 'lecture.txt' }),
    material({ contentType: 'text/html' }),
    material({ sizeBytes: 0 }),
    material({ sizeBytes: '1' }),
    material({ sizeBytes: Number.MAX_SAFE_INTEGER + 1 }),
    material({ version: 0 }),
    material({ version: 1.5 }),
    material({ status: 'deleted' }),
    material({ processingStatus: 'ready' }),
    material({ createdAt: 'not-a-date' }),
    material({ updatedAt: null }),
    material({ deletionJobId: JOB_ID }),
    material({ deletionJobId: undefined }),
    material({ status: 'uploading', deletionJobId: JOB_ID }),
    material({ status: 'deleting', deletionJobId: null }),
  ]) {
    const { api } = setup(json({ data }));

    await assert.rejects(
      () => api.getById(ID),
      errorIs('INVALID_RESPONSE', 200),
    );
  }
});

test('HTML, неверная оболочка и неожиданный статус GET отклоняются', async () => {
  for (const response of [
    new Response('<html>Proxy error</html>', { status: 200 }),
    json({ result: material() }),
    json({ data: material() }, 201),
    new Response(null, { status: 204 }),
  ]) {
    const { api } = setup(response);
    await assert.rejects(() => api.getById(ID), errorIs('INVALID_RESPONSE'));
  }
});

test('Upload отправляет File, CSRF, прежний ключ и только нужные части FormData', async () => {
  const selected = file();
  const { api, calls } = await setupWrite(
    json({ data: material() }, 201),
  );

  const result = await api.upload({
    file: selected,
    subjectId: SUBJECT_ID,
    title: '  Лекция   1  ',
    ownerId: OTHER_ID,
    version: 99,
  }, { idempotencyKey: KEY });

  assert.deepEqual(result, material());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/materials');

  const options = calls[0].options;
  assert.equal(options.method, 'POST');
  assert.ok(options.body instanceof FormData);
  assert.deepEqual([...options.body.keys()], ['file', 'subjectId', 'title']);
  assert.equal(options.body.get('subjectId'), SUBJECT_ID);
  assert.equal(options.body.get('title'), 'Лекция 1');
  assert.equal(options.body.get('file').name, selected.name);
  assert.deepEqual(
    await options.body.get('file').arrayBuffer(),
    await selected.arrayBuffer(),
  );
  assert.equal(options.headers.get('X-CSRF-TOKEN'), 'test-csrf');
  assert.equal(options.headers.get('Idempotency-Key'), KEY);
  assert.equal(options.headers.has('Content-Type'), false);
});

test('Пропущенное и пустое title оставляют выбор названия серверу', async () => {
  for (const title of [undefined, '', ' \t ']) {
    const { api, calls } = await setupWrite(
      json({ data: material() }, 201),
    );

    await api.upload(
      { file: file(), subjectId: SUBJECT_ID, title },
      { idempotencyKey: KEY },
    );

    const body = calls[0].options.body;
    assert.equal(body.has('title'), title !== undefined);
    if (title !== undefined) assert.equal(body.get('title'), '');
  }
});

test('Неверный файл, ключ, subjectId и title отклоняются до upload', async () => {
  const { api, calls } = setup();

  for (const [values, options] of [
    [{ file: file(), subjectId: SUBJECT_ID }, {}],
    [{ file: file(), subjectId: SUBJECT_ID }, { idempotencyKey: 'bad' }],
    [{ file: file(), subjectId: 'bad' }, { idempotencyKey: KEY }],
    [{ file: new Blob(['pdf']), subjectId: SUBJECT_ID }, { idempotencyKey: KEY }],
    [{ file: null, subjectId: SUBJECT_ID }, { idempotencyKey: KEY }],
    [{ file: file(), subjectId: SUBJECT_ID, title: null }, { idempotencyKey: KEY }],
    [{ file: file(), subjectId: SUBJECT_ID, title: 'x'.repeat(161) }, { idempotencyKey: KEY }],
    [{ file: file(), subjectId: SUBJECT_ID, title: '\ud800' }, { idempotencyKey: KEY }],
  ]) {
    await assert.rejects(
      () => api.upload(values, options),
      (error) => error instanceof TypeError || error instanceof RangeError,
    );
  }

  assert.equal(calls.length, 0);
});

test('Повтор upload возвращает сохранённый DTO без дополнительных GET', async () => {
  const replay = material({ title: 'Исходное название', version: 7 });
  const { api, calls } = await setupWrite(json({ data: replay }, 201));

  assert.deepEqual(
    await api.upload(
      { file: file(), subjectId: SUBJECT_ID },
      { idempotencyKey: KEY },
    ),
    replay,
  );
  assert.equal(calls.length, 1);
});

test('Upload не принимает 202, чужой subjectId или неподтверждённое хранение', async () => {
  for (const response of [
    json({ data: { jobId: JOB_ID } }, 202),
    json({ data: material({ subjectId: OTHER_ID }) }, 201),
    json({ data: material({ status: 'uploading' }) }, 201),
    json({
      data: material({ status: 'deleting', deletionJobId: JOB_ID }),
    }, 201),
  ]) {
    const { api, calls } = await setupWrite(response);

    await assert.rejects(
      () => api.upload(
        { file: file(), subjectId: SUBJECT_ID },
        { idempotencyKey: KEY },
      ),
      errorIs('INVALID_RESPONSE'),
    );
    assert.equal(calls.length, 1);
  }
});

test('PATCH отправляет title/version, принимает новую версию даже при no-op', async () => {
  const updated = material({ version: 5 });
  const { api, calls } = await setupWrite(json({ data: updated }));

  assert.deepEqual(
    await api.rename(
      ID.toUpperCase(),
      { title: '  Лекция   1 ', ownerId: OTHER_ID },
      { version: 4 },
    ),
    updated,
  );
  assert.equal(calls.length, 1);

  const options = calls[0].options;
  assert.equal(options.method, 'PATCH');
  assert.deepEqual(JSON.parse(options.body), {
    title: 'Лекция 1',
    version: 4,
  });
  assert.equal(options.headers.get('X-CSRF-TOKEN'), 'test-csrf');
  assert.equal(options.headers.has('Idempotency-Key'), false);
});

test('PATCH отклоняет неверные title/version до запроса', async () => {
  const { api, calls } = setup();

  for (const [title, version] of [
    ['', 1],
    [null, 1],
    [undefined, 1],
    ['x'.repeat(161), 1],
    ['a\0b', 1],
    ['Лекция', undefined],
    ['Лекция', 0],
    ['Лекция', '1'],
    ['Лекция', 1.5],
    ['Лекция', Number.MAX_SAFE_INTEGER + 1],
  ]) {
    await assert.rejects(() => api.rename(ID, { title }, { version }));
  }

  assert.equal(calls.length, 0);
});

test('PATCH требует совпадения UUID, следующую версию и stored', async () => {
  for (const data of [
    material({ id: OTHER_ID, version: 2 }),
    material({ version: 1 }),
    material({ version: 3 }),
    material({
      status: 'deleting',
      deletionJobId: JOB_ID,
      version: 2,
    }),
  ]) {
    const { api, calls } = await setupWrite(json({ data }));

    await assert.rejects(
      () => api.rename(ID, { title: 'Лекция 1' }, { version: 1 }),
      errorIs('INVALID_RESPONSE', 200),
    );
    assert.equal(calls.length, 1);
  }
});

test('Скачивание возвращает исходную подписанную ссылку без обращения к R2', async () => {
  const data = { url: DOWNLOAD_URL, expiresAt: TIME };
  const { api, calls } = setup(json({
    data: { ...data, internal: 'hidden' },
  }));

  assert.deepEqual(await api.getDownload(ID), data);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/materials/' + ID + '/download');
  assert.equal(calls[0].options.method, 'GET');
});

test('Некорректные ссылки и expiresAt отклоняются', async () => {
  for (const data of [
    { url: 'javascript:alert(1)', expiresAt: TIME },
    { url: 'http://127.0.0.1/file.pdf', expiresAt: TIME },
    { url: '//example.com/file.pdf', expiresAt: TIME },
    { url: 'https://user:pass@example.com/file.pdf', expiresAt: TIME },
    { url: 'https://example.com/file.pdf#fragment', expiresAt: TIME },
    { url: 'https://example.com/\nfile.pdf', expiresAt: TIME },
    { url: DOWNLOAD_URL, expiresAt: 'not-a-date' },
    { url: null, expiresAt: TIME },
  ]) {
    const { api } = setup(json({ data }));

    await assert.rejects(
      () => api.getDownload(ID),
      errorIs('INVALID_RESPONSE', 200),
    );
  }
});

test('DELETE принимает 202 и возвращает jobId без автоматического опроса', async () => {
  const data = { materialId: ID, jobId: JOB_ID };
  const { api, calls } = await setupWrite(json({
    data: { ...data, internal: 'hidden' },
  }, 202));

  assert.deepEqual(await api.remove(ID.toUpperCase()), data);
  assert.equal(calls.length, 1);

  const options = calls[0].options;
  assert.equal(options.method, 'DELETE');
  assert.equal(options.body, undefined);
  assert.equal(options.headers.has('Content-Type'), false);
  assert.equal(options.headers.has('Idempotency-Key'), false);
  assert.equal(options.headers.get('X-CSRF-TOKEN'), 'test-csrf');
});

test('DELETE отклоняет 204 и ответ с неверными materialId/jobId', async () => {
  for (const response of [
    new Response(null, { status: 204 }),
    json({ data: { materialId: OTHER_ID, jobId: JOB_ID } }, 202),
    json({ data: { materialId: ID, jobId: 'bad' } }, 202),
    json({ data: { materialId: ID, jobId: JOB_ID } }, 200),
  ]) {
    const { api, calls } = await setupWrite(response);

    await assert.rejects(() => api.remove(ID), errorIs('INVALID_RESPONSE'));
    assert.equal(calls.length, 1);
  }
});

test('Изменяющие операции без CSRF не отправляются', async () => {
  const { api, calls } = setup();

  for (const operation of operations.filter((item) => item.write)) {
    await assert.rejects(
      () => operation.call(api),
      errorIs('CSRF_NOT_INITIALIZED'),
    );
  }

  assert.equal(calls.length, 0);
});

test('Ошибки upload сохраняют статус, поля и Retry-After без повторов', async () => {
  for (const [status, code] of [
    [422, 'VALIDATION_FAILED'],
    [422, 'INVALID_PDF'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [404, 'SUBJECT_NOT_FOUND'],
    [409, 'STORAGE_QUOTA_EXCEEDED'],
    [409, 'IDEMPOTENCY_KEY_REUSED'],
    [409, 'REQUEST_IN_PROGRESS'],
    [429, 'UPLOAD_BUSY'],
    [503, 'STORAGE_UNAVAILABLE'],
    [503, 'UPLOAD_FAILED'],
    [410, 'UPLOAD_ABORTED'],
  ]) {
    const { api, calls } = await setupWrite(json({
      error: {
        code,
        message: 'Ошибка загрузки.',
        fieldErrors: { file: 'Проверь файл.' },
      },
    }, status, { 'Retry-After': '2' }));

    await assert.rejects(
      () => api.upload(
        { file: file(), subjectId: SUBJECT_ID },
        { idempotencyKey: KEY },
      ),
      (error) => {
        errorIs(code, status)(error);
        assert.deepEqual(error.fieldErrors, { file: 'Проверь файл.' });
        assert.equal(error.retryAfterSeconds, 2);
        return true;
      },
    );

    assert.equal(calls.length, 1);
  }
});

test('Конфликт PATCH и недоступность материала не запускают GET или повтор', async () => {
  for (const [operation, code] of [
    [operations[3], 'MATERIAL_VERSION_CONFLICT'],
    [operations[3], 'MATERIAL_NOT_AVAILABLE'],
    [operations[4], 'MATERIAL_NOT_AVAILABLE'],
  ]) {
    const response = json({
      error: {
        code,
        message: 'Материал изменился.',
        fieldErrors: {},
      },
    }, 409);

    const { api, calls } = operation.write
      ? await setupWrite(response)
      : setup(response);

    await assert.rejects(() => operation.call(api), errorIs(code, 409));
    assert.equal(calls.length, 1);
  }
});

test('401/404/503 чтения не подменяются пустым списком или материалом', async () => {
  for (const [status, code] of [
    [401, 'AUTHENTICATION_REQUIRED'],
    [404, 'MATERIAL_NOT_FOUND'],
    [503, 'SERVICE_UNAVAILABLE'],
  ]) {
    const { api, calls } = setup(json({
      error: {
        code,
        message: 'Ошибка чтения.',
        fieldErrors: {},
      },
    }, status));

    await assert.rejects(() => api.getById(ID), errorIs(code, status));
    assert.equal(calls.length, 1);
  }
});

test('После потери ответа upload только явный повтор сохраняет ключ и файл', async () => {
  const selected = file();
  const { api, calls } = await setupWrite(
    () => {
      throw new TypeError('Соединение потеряно');
    },
    json({ data: material() }, 201),
  );

  const values = {
    file: selected,
    subjectId: SUBJECT_ID,
    title: 'Лекция 1',
  };

  await assert.rejects(
    () => api.upload(values, { idempotencyKey: KEY }),
    errorIs('NETWORK_ERROR'),
  );
  assert.equal(calls.length, 1);

  await api.upload(values, { idempotencyKey: KEY });
  assert.equal(calls.length, 2);

  for (const { options } of calls) {
    assert.equal(options.headers.get('Idempotency-Key'), KEY);
    assert.equal(options.body.get('file').name, selected.name);
    assert.deepEqual(
      await options.body.get('file').arrayBuffer(),
      await selected.arrayBuffer(),
    );
  }
});

test('Сетевая ошибка каждого метода не вызывает скрытых запросов', async () => {
  for (const operation of operations) {
    const failure = () => {
      throw new TypeError('Соединение потеряно');
    };
    const { api, calls } = operation.write
      ? await setupWrite(failure)
      : setup(failure);

    await assert.rejects(
      () => operation.call(api),
      errorIs('NETWORK_ERROR'),
    );
    assert.equal(calls.length, 1, operation.name);
  }
});

test('Заранее отменённый signal предотвращает запросы всех методов', async () => {
  const controller = new AbortController();
  controller.abort();
  const { api, calls } = setup();

  for (const operation of operations) {
    await assert.rejects(
      () => operation.call(api, controller.signal),
      errorIs('REQUEST_CANCELLED'),
      operation.name,
    );
  }

  assert.equal(calls.length, 0);
});

test('Все методы передают signal, отмена текущего запроса не вызывает повтор', async () => {
  for (const operation of operations) {
    const controller = new AbortController();

    const response = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(new DOMException('Запрос отменён', 'AbortError'));
      }, { once: true });
    });

    const { api, calls } = operation.write
      ? await setupWrite(response)
      : setup(response);

    const pending = operation.call(api, controller.signal);
    controller.abort();

    await assert.rejects(
      pending,
      errorIs('REQUEST_CANCELLED'),
      operation.name,
    );
    assert.equal(calls.length, 1, operation.name);
    assert.equal(calls[0].options.signal, controller.signal);
  }
});

function processed(changes = {}) {
  return material({
    processingStatus: 'queued',
    processingJobId: JOB_ID,
    ...changes,
  });
}

test('Все состояния обработки и готовый текст при удалении сохраняются', async () => {
  for (const data of [
    material(),
    processed(),
    processed({ processingStatus: 'running' }),
    processed({
      processingStatus: 'ready',
      pageCount: 3,
      textCharacters: 250,
    }),
    processed({
      processingStatus: 'failed',
      processingError: {
        code: 'PDF_NO_TEXT',
        message: 'В PDF нет текста.',
      },
    }),
    processed({ processingStatus: 'cancelled' }),
    processed({
      status: 'deleting',
      deletionJobId: OTHER_ID,
      processingStatus: 'ready',
      pageCount: 3,
      textCharacters: 250,
    }),
  ]) {
    const { api } = setup(json({ data }));

    assert.deepEqual(await api.getById(ID), data);
  }
});

test('Ошибка обработки сохраняет только безопасные публичные поля', async () => {
  for (const code of [
    'JOB_TEMPORARY_FAILURE',
    'JOB_PROCESSING_FAILED',
    'JOB_ATTEMPTS_EXHAUSTED',
    'JOB_LEASE_EXPIRED',
    'JOB_OUTCOME_UNKNOWN',
    'PDF_INVALID',
    'PDF_ENCRYPTED',
    'PDF_NO_TEXT',
    'PDF_TOO_MANY_PAGES',
    'PDF_TEXT_LIMIT',
    'PDF_TIMEOUT',
    'PDF_RESOURCE_LIMIT',
    'PDF_WORKER_FAILED',
    'PDF_ORIGINAL_MISMATCH',
  ]) {
    const data = processed({
      processingStatus: 'failed',
      processingError: {
        code,
        message: 'Ошибка обработки.',
      },
    });

    const { api } = setup(json({
      data: {
        ...data,
        processingError: {
          ...data.processingError,
          objectKey: 'private',
        },
      },
    }));

    assert.deepEqual(await api.getById(ID), data);
  }
});

test('Некорректные новые поля материала отклоняются', async () => {
  for (const data of [
    processed({ processingStatus: 'unknown' }),
    processed({ processingJobId: null }),
    processed({ processingJobId: 'bad' }),
    material({ processingJobId: JOB_ID }),
    processed({ processingStatus: 'ready' }),
    processed({ pageCount: 1 }),
    processed({ pageCount: 0, textCharacters: 0 }),
    processed({ pageCount: 201, textCharacters: 1 }),
    processed({ pageCount: 1.5, textCharacters: 1 }),
    processed({ pageCount: 1, textCharacters: 100001 }),
    processed({ pageCount: 20, textCharacters: 1000001 }),
    processed({ pageCount: '1', textCharacters: 1 }),
    processed({
      processingError: {
        code: 'PDF_INVALID',
        message: 'Ошибка',
      },
    }),
    processed({
      processingStatus: 'failed',
      processingError: null,
    }),
    processed({
      processingStatus: 'failed',
      processingError: {
        code: 'PDF_UNKNOWN',
        message: 'Ошибка',
      },
    }),
    processed({
      processingStatus: 'failed',
      processingError: {
        code: 'PDF_INVALID',
        message: '',
      },
    }),
  ]) {
    const { api } = setup(json({ data }));

    await assert.rejects(
      () => api.getById(ID),
      errorIs('INVALID_RESPONSE', 200),
    );
  }
});

test('Старый ответ upload допустим, но не подменяет современный GET/list/PATCH', async () => {
  const legacy = material();

  for (const key of [
    'processingJobId',
    'pageCount',
    'textCharacters',
    'processingError',
  ]) {
    delete legacy[key];
  }

  const write = await setupWrite(json({ data: legacy }, 201));

  assert.deepEqual(
    await write.api.upload(
      { file: file(), subjectId: SUBJECT_ID },
      { idempotencyKey: KEY },
    ),
    legacy,
  );
  assert.equal(write.calls.length, 1);

  const read = setup(json({ data: legacy }));

  await assert.rejects(
    () => read.api.getById(ID),
    errorIs('INVALID_RESPONSE', 200),
  );

  const list = setup(json({
    data: [legacy],
    meta: { page: 1, pageSize: 20, total: 1 },
  }));

  await assert.rejects(
    () => list.api.list(),
    errorIs('INVALID_RESPONSE', 200),
  );

  const patch = await setupWrite(json({
    data: { ...legacy, version: 2 },
  }));

  await assert.rejects(
    () => patch.api.rename(
      ID,
      { title: 'Лекция' },
      { version: 1 },
    ),
    errorIs('INVALID_RESPONSE', 200),
  );
});

test('Частично потерянные новые поля не считаются старым ответом', async () => {
  for (const field of [
    'processingJobId',
    'pageCount',
    'textCharacters',
    'processingError',
  ]) {
    const data = material();
    delete data[field];

    const { api } = await setupWrite(json({ data }, 201));

    await assert.rejects(
      () => api.upload(
        { file: file(), subjectId: SUBJECT_ID },
        { idempotencyKey: KEY },
      ),
      errorIs('INVALID_RESPONSE', 201),
    );
  }
});

test('Новая загрузка возвращает queued и jobId без дополнительного process', async () => {
  const data = processed();
  const { api, calls } = await setupWrite(json({ data }, 201));

  assert.deepEqual(
    await api.upload(
      { file: file(), subjectId: SUBJECT_ID },
      { idempotencyKey: KEY },
    ),
    data,
  );
  assert.equal(calls.length, 1);
});

test('process отправляет один POST с CSRF и прежним ключом, без тела', async () => {
  const data = { materialId: ID, jobId: JOB_ID };

  const { api, calls } = await setupWrite(json({
    data: { ...data, internal: 'hidden' },
  }, 202));

  const controller = new AbortController();

  assert.deepEqual(
    await api.process(ID.toUpperCase(), {
      idempotencyKey: KEY,
      signal: controller.signal,
    }),
    data,
  );

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    '/api/v1/materials/' + ID.toUpperCase() + '/process',
  );

  const { options } = calls[0];

  assert.equal(options.method, 'POST');
  assert.equal(options.body, undefined);
  assert.equal(options.headers.has('Content-Type'), false);
  assert.equal(options.headers.get('X-CSRF-TOKEN'), 'test-csrf');
  assert.equal(options.headers.get('Idempotency-Key'), KEY);
  assert.equal(options.signal, controller.signal);
});

test('Неверные UUID, ключ и пагинация отклоняются до запроса', async () => {
  const { api, calls } = setup();

  for (const id of [undefined, null, '', 'bad', ID + '?x=1']) {
    await assert.rejects(
      () => api.process(id, { idempotencyKey: KEY }),
      TypeError,
    );
    await assert.rejects(() => api.pages(id), TypeError);
  }

  for (const idempotencyKey of [undefined, null, '', 'bad']) {
    await assert.rejects(
      () => api.process(ID, { idempotencyKey }),
      TypeError,
    );
  }

  for (const options of [
    { page: 0 },
    { page: 1.5 },
    { page: '1' },
    { page: Number.MAX_SAFE_INTEGER + 1 },
    { pageSize: 0 },
    { pageSize: 101 },
    { pageSize: '20' },
  ]) {
    await assert.rejects(
      () => api.pages(ID, options),
      RangeError,
    );
  }

  assert.equal(calls.length, 0);
});

test('process отклоняет неверный успешный ответ', async () => {
  for (const response of [
    json({ data: { materialId: ID, jobId: JOB_ID } }, 200),
    json({ data: { materialId: OTHER_ID, jobId: JOB_ID } }, 202),
    json({ data: { materialId: ID, jobId: null } }, 202),
    new Response(null, { status: 204 }),
  ]) {
    const { api, calls } = await setupWrite(response);

    await assert.rejects(
      () => api.process(ID, { idempotencyKey: KEY }),
      errorIs('INVALID_RESPONSE'),
    );
    assert.equal(calls.length, 1);
  }
});

test('pages сохраняет пустые страницы, Unicode и разметку как обычный текст', async () => {
  const data = [
    {
      pageNumber: 1,
      text: '  Лекция\nКазахский: әіңғүұқөһ 😀\n<script>alert(1)</script>',
    },
    { pageNumber: 2, text: '' },
  ];
  const meta = { page: 1, pageSize: 20, total: 2 };

  const { api, calls } = setup(json({
    data: data.map((page) => ({ ...page, internal: 'hidden' })),
    meta,
  }));

  const controller = new AbortController();

  assert.deepEqual(
    await api.pages(ID, { signal: controller.signal }),
    { pages: data, meta },
  );

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    '/api/v1/materials/' + ID + '/pages?page=1&pageSize=20',
  );
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers.has('X-CSRF-TOKEN'), false);
  assert.equal(calls[0].options.signal, controller.signal);
});

test('Номер API-страницы отличается от физических номеров PDF', async () => {
  const data = [{ pageNumber: 3, text: 'Третья' }];
  const meta = { page: 2, pageSize: 2, total: 3 };
  const { api } = setup(json({ data, meta }));

  assert.deepEqual(
    await api.pages(ID, { page: 2, pageSize: 2 }),
    { pages: data, meta },
  );
});

test('За концом pages сохраняется total, даже при максимальном page', async () => {
  const meta = {
    page: Number.MAX_SAFE_INTEGER,
    pageSize: 100,
    total: 3,
  };

  const { api } = setup(json({ data: [], meta }));

  assert.deepEqual(
    await api.pages(ID, { page: meta.page, pageSize: 100 }),
    { pages: [], meta },
  );
});

test('pages отклоняет повреждённые данные, метаданные и нарушенный порядок', async () => {
  const meta = { page: 1, pageSize: 20, total: 2 };
  const valid = [
    { pageNumber: 1, text: 'Текст' },
    { pageNumber: 2, text: '' },
  ];

  for (const payload of [
    { data: valid, meta: null },
    { data: valid, meta: { ...meta, page: 2 } },
    { data: valid, meta: { ...meta, pageSize: 10 } },
    { data: [], meta: { ...meta, total: 0 } },
    { data: [], meta: { ...meta, total: 201 } },
    { data: valid, meta: { ...meta, total: '2' } },
    { data: [], meta },
    { data: valid.slice(0, 1), meta },
    { data: valid.slice().reverse(), meta },
    { data: [valid[0], valid[0]], meta },
    {
      data: [{ pageNumber: 1, text: null }, valid[1]],
      meta,
    },
    {
      data: [{ pageNumber: 1, text: 'x'.repeat(100001) }, valid[1]],
      meta,
    },
    {
      data: [{ pageNumber: 1, text: '\u0000' }, valid[1]],
      meta,
    },
    {
      data: [{ pageNumber: 1, text: '\ud800' }, valid[1]],
      meta,
    },
    {
      data: [{ pageNumber: 1, text: 'Текст' }],
      meta: { page: 2, pageSize: 20, total: 1 },
    },
  ]) {
    const { api } = setup(json(payload));

    const requestedPage = payload.meta?.page === 2
      && payload.meta.total === 1
      ? 2
      : 1;

    await assert.rejects(
      () => api.pages(ID, { page: requestedPage }),
      errorIs('INVALID_RESPONSE', 200),
    );
  }
});

test('Границы текста и числа страниц допустимы', async () => {
  const data = Array.from({ length: 100 }, (_, index) => ({
    pageNumber: index + 1,
    text: index < 10 ? 'я'.repeat(100000) : '',
  }));

  const meta = { page: 1, pageSize: 100, total: 200 };
  const { api } = setup(json({ data, meta }));

  assert.deepEqual(
    await api.pages(ID, { pageSize: 100 }),
    { pages: data, meta },
  );

  const bad = setup(json({
    data: data.map((page, index) =>
      index === 10 ? { ...page, text: 'я' } : page),
    meta,
  }));

  await assert.rejects(
    () => bad.api.pages(ID, { pageSize: 100 }),
    errorIs('INVALID_RESPONSE', 200),
  );
});

test('Ошибки process и pages сохраняются без повторов и новых заданий', async () => {
  for (const [name, status, code] of [
    ['process', 401, 'AUTHENTICATION_REQUIRED'],
    ['process', 403, 'CSRF_INVALID'],
    ['process', 404, 'MATERIAL_NOT_FOUND'],
    ['process', 409, 'MATERIAL_NOT_AVAILABLE'],
    ['process', 409, 'PROCESSING_IN_PROGRESS'],
    ['process', 409, 'TEXT_ALREADY_EXTRACTED'],
    ['process', 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['process', 503, 'STORAGE_UNAVAILABLE'],
    ['pages', 409, 'TEXT_NOT_READY'],
    ['pages', 409, 'MATERIAL_NOT_AVAILABLE'],
    ['pages', 401, 'AUTHENTICATION_REQUIRED'],
    ['pages', 404, 'MATERIAL_NOT_FOUND'],
    ['pages', 503, 'SERVICE_UNAVAILABLE'],
  ]) {
    const response = json({
      error: {
        code,
        message: 'Ошибка.',
        fieldErrors: {},
      },
    }, status, { 'Retry-After': '2' });

    const { api, calls } = name === 'process'
      ? await setupWrite(response)
      : setup(response);

    await assert.rejects(
      () => name === 'process'
        ? api.process(ID, { idempotencyKey: KEY })
        : api.pages(ID),
      (error) => {
        errorIs(code, status)(error);
        assert.equal(error.retryAfterSeconds, 2);
        return true;
      },
    );

    assert.equal(calls.length, 1);
  }
});

test('После потери ответа process повторяется явно с прежним ключом', async () => {
  const data = { materialId: ID, jobId: JOB_ID };

  const { api, calls } = await setupWrite(
    () => {
      throw new TypeError('Сеть');
    },
    json({ data }, 202),
  );

  await assert.rejects(
    () => api.process(ID, { idempotencyKey: KEY }),
    errorIs('NETWORK_ERROR'),
  );
  assert.equal(calls.length, 1);

  assert.deepEqual(
    await api.process(ID, { idempotencyKey: KEY }),
    data,
  );
  assert.equal(calls.length, 2);

  for (const { options } of calls) {
    assert.equal(options.headers.get('Idempotency-Key'), KEY);
  }
});