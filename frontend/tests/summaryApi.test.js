import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, ApiError } from '../src/services/apiClient.js';
import { createSummaryApi } from '../src/services/summaryApi.js';

const ID = '3dfa4d7d-619d-4a97-9f09-a34d236e879b';
const OTHER_ID = '7f07410e-98f7-41a3-bfab-cbc387683fc1';
const JOB_ID = '095f15c2-1f89-4e09-a9ab-b3b281766f57';
const KEY = '773b6d14-d350-4c27-8db8-b3b1fdb5d159';
const TIME = '2026-09-29T10:00:00.123456789Z';

function summary(changes = {}) {
  return {
    materialId: ID, status: 'ready', jobId: JOB_ID, version: 1,
    content: '- Тезис лекции (стр. 1)', sourcePages: [1], origin: 'ai',
    model: 'gpt-6-luna', inputTokens: 1200, outputTokens: 100,
    createdAt: TIME, updatedAt: TIME, error: null, ...changes,
  };
}

function unsaved(status = 'queued', changes = {}) {
  return summary({
    status, version: null, content: null, sourcePages: null, origin: null,
    model: null, inputTokens: null, outputTokens: null, createdAt: null,
    error: status === 'failed'
      ? { code: 'AI_OUTCOME_UNKNOWN', message: 'Результат неизвестен.' } : null,
    ...changes,
  });
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
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
  return { api: createSummaryApi(client), client, calls };
}

async function setupWrite(...responses) {
  const state = setup(json({ data: { headerName: 'X-CSRF-TOKEN', token: 'test-csrf' } }), ...responses);
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

test('Создание адаптера не читает конспект и не запускает генерацию', () => {
  assert.equal(setup().calls.length, 0);
});

test('GET передаёт cookie/signal без CSRF, query и генерации; регистр UUID допустим', async () => {
  const { api, calls } = setup(json({ data: summary() }));
  const controller = new AbortController();
  assert.deepEqual(await api.getByMaterial(ID.toUpperCase(), { signal: controller.signal }), summary());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/materials/' + ID.toUpperCase() + '/summary');
  const options = calls[0].options;
  assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'include');
  assert.equal(options.mode, 'same-origin');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.signal, controller.signal);
  assert.equal(options.body, undefined);
  assert.equal(options.headers.has('X-CSRF-TOKEN'), false);
  assert.equal(options.headers.has('Idempotency-Key'), false);
});

test('POST принимает только 202 и передаёт выбранный ключ, CSRF и signal без тела/query', async () => {
  const result = { materialId: ID, jobId: JOB_ID };
  const { api, calls } = await setupWrite(json({ data: { ...result, private: 'ignored' } }, 202));
  const controller = new AbortController();
  assert.deepEqual(await api.generate(ID, { idempotencyKey: KEY, signal: controller.signal }), result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/materials/' + ID + '/summary');
  const options = calls[0].options;
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'include');
  assert.equal(options.mode, 'same-origin');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.body, undefined);
  assert.equal(options.signal, controller.signal);
  assert.equal(options.headers.get('X-CSRF-TOKEN'), 'test-csrf');
  assert.equal(options.headers.get('Idempotency-Key'), KEY);
  assert.equal(options.headers.has('Content-Type'), false);
});

test('Первое задание сохраняет null; отсутствие конспекта не становится пустым текстом', async () => {
  for (const status of ['queued', 'running', 'failed', 'cancelled']) {
    const data = unsaved(status);
    const { api, calls } = setup(json({ data }));
    assert.deepEqual(await api.getByMaterial(ID), data);
    assert.equal(calls.length, 1);
  }
});

test('Сохранённая версия остаётся доступной при любом состоянии нового задания', async () => {
  for (const status of ['queued', 'running', 'ready', 'failed', 'cancelled']) {
    const data = summary({ status, error: status === 'failed'
      ? { code: 'AI_UNAVAILABLE', message: 'Генерация недоступна.' } : null });
    const { api } = setup(json({ data }));
    assert.deepEqual(await api.getByMaterial(ID), data);
  }
});

test('fake-local с нулевыми счётчиками и ручная версия с null различаются', async () => {
  for (const data of [
    summary({ model: 'fake-local', inputTokens: 0, outputTokens: 0 }),
    summary({ origin: 'user', model: null, sourcePages: [], inputTokens: null, outputTokens: null }),
    summary({ version: Number.MAX_SAFE_INTEGER, sourcePages: [1, 13, 200],
      inputTokens: 2_147_483_647, outputTokens: 2_147_483_647 }),
  ]) {
    const { api } = setup(json({ data }));
    assert.deepEqual(await api.getByMaterial(ID), data);
  }
});

test('Текст, переносы, emoji и HTML-подобные строки возвращаются без преобразований', async () => {
  for (const content of [
    '  Текст\tс пробелами\r\nСледующая строка 😀\n<script>не выполнять</script>  ',
    '😀'.repeat(50_000),
  ]) {
    const { api } = setup(json({ data: summary({ content }) }));
    assert.equal((await api.getByMaterial(ID)).content, content);
  }
});

test('Адаптер оставляет только публичные поля и копирует коллекции', async () => {
  const data = summary({ status: 'failed', error: { code: 'AI_INVALID_RESPONSE', message: 'Ошибка.' } });
  const wire = { ...data, ownerId: OTHER_ID, payload: { secret: 'internal' },
    error: { ...data.error, internal: 'exception' } };
  const api = createSummaryApi({ request: async () => ({ status: 200, data: wire }) });
  const result = await api.getByMaterial(ID);
  assert.deepEqual(result, data);
  result.sourcePages.push(2);
  result.error.message = 'Изменено';
  assert.deepEqual(wire.sourcePages, [1]);
  assert.equal(wire.error.message, 'Ошибка.');
});

test('Неправильные UUID и ключи отклоняются до обращения к сети', async () => {
  const { api, calls } = await setupWrite();
  for (const value of ['', undefined, null, '../auth/me', ID + '?extra=1', 1, {}]) {
    await assert.rejects(() => api.getByMaterial(value), TypeError);
    await assert.rejects(() => api.generate(value, { idempotencyKey: KEY }), TypeError);
    await assert.rejects(() => api.generate(ID, { idempotencyKey: value }), TypeError);
  }
  assert.equal(calls.length, 0);
});

test('Неверные поля и несовместимые состояния DTO отклоняются', async () => {
  const invalid = [
    null, [], summary({ materialId: OTHER_ID }), summary({ materialId: null }),
    summary({ jobId: '' }), summary({ status: 'succeeded' }), summary({ status: 'constructor' }),
    summary({ version: 0 }), summary({ version: '1' }), summary({ version: 1.5 }),
    summary({ version: Number.MAX_SAFE_INTEGER + 1 }),
    summary({ content: '' }), summary({ content: ' \n\t ' }), summary({ content: 'a'.repeat(100_001) }),
    summary({ content: 'a\u0000b' }), summary({ content: 'a\u001fb' }), summary({ content: 'a\ud800' }),
    summary({ sourcePages: null }), summary({ sourcePages: [] }), summary({ sourcePages: [0] }),
    summary({ sourcePages: [201] }), summary({ sourcePages: [1.5] }), summary({ sourcePages: ['1'] }),
    summary({ sourcePages: [1, 1] }), summary({ sourcePages: [2, 1] }),
    summary({ sourcePages: Array.from({ length: 201 }, (_, i) => i + 1) }),
    summary({ origin: 'other' }), summary({ model: null }), summary({ model: '' }),
    summary({ model: 'm'.repeat(81) }), summary({ model: 'model\nname' }),
    summary({ inputTokens: null }), summary({ inputTokens: -1 }), summary({ inputTokens: '0' }),
    summary({ outputTokens: 0.1 }), summary({ outputTokens: 2_147_483_648 }),
    summary({ createdAt: null }), summary({ updatedAt: null }),
    summary({ createdAt: '2026-02-30T10:00:00Z' }), summary({ updatedAt: '2026-09-29T24:00:00Z' }),
    summary({ updatedAt: '2026-09-29T10:00:00+00:00' }),
    summary({ error: undefined }), summary({ error: { code: 'AI_UNAVAILABLE', message: 'Ошибка' } }),
    summary({ status: 'failed', error: null }),
    summary({ status: 'failed', error: { code: 'PDF_INVALID', message: 'Ошибка' } }),
    summary({ status: 'failed', error: { code: 'AI_UNAVAILABLE', message: '' } }),
    summary({ status: 'failed', error: { code: 'constructor', message: 'Ошибка' } }),
    unsaved('ready'), unsaved('queued', { content: '' }), unsaved('queued', { sourcePages: [] }),
    unsaved('queued', { model: 'fake-local' }), unsaved('queued', { inputTokens: 0 }),
    unsaved('queued', { createdAt: TIME }), unsaved('queued', { origin: 'user' }),
    summary({ origin: 'user', model: null, inputTokens: null, outputTokens: null }),
    summary({ origin: 'user', sourcePages: [], model: null, inputTokens: 0, outputTokens: null }),
    summary({ origin: 'user', sourcePages: [], inputTokens: null, outputTokens: null }),
  ];
  for (const data of invalid) {
    const { api, calls } = setup(json({ data }));
    await assert.rejects(() => api.getByMaterial(ID), errorIs('INVALID_RESPONSE', 200));
    assert.equal(calls.length, 1);
  }
});

test('Все обязательные поля DTO необходимы, включая nullable поля', async () => {
  for (const fixture of [summary(), unsaved()]) {
    for (const key of Object.keys(fixture)) {
      const data = { ...fixture };
      delete data[key];
      const { api } = setup(json({ data }));
      await assert.rejects(() => api.getByMaterial(ID), errorIs('INVALID_RESPONSE'), key);
    }
  }
});

test('Публичные ошибки ИИ и инфраструктуры читаются как failed', async () => {
  for (const code of [
    'AI_UNAVAILABLE', 'AI_INVALID_RESPONSE', 'AI_OUTCOME_UNKNOWN',
    'JOB_TEMPORARY_FAILURE', 'JOB_PROCESSING_FAILED', 'JOB_ATTEMPTS_EXHAUSTED',
    'JOB_LEASE_EXPIRED', 'JOB_OUTCOME_UNKNOWN',
  ]) {
    const data = unsaved('failed', { error: { code, message: 'Не удалось создать конспект.' } });
    const { api } = setup(json({ data }));
    assert.deepEqual(await api.getByMaterial(ID), data);
  }
});

test('POST отклоняет чужой материал, неверное задание, оболочку и успешный статус', async () => {
  for (const response of [
    json({ data: { materialId: OTHER_ID, jobId: JOB_ID } }, 202),
    json({ data: { materialId: ID, jobId: null } }, 202),
    json({ data: { materialId: ID } }, 202),
    json({ data: [] }, 202), json({ data: { materialId: ID, jobId: JOB_ID } }, 200),
    json({ result: { materialId: ID, jobId: JOB_ID } }, 202), new Response(null, { status: 204 }),
  ]) {
    const { api, calls } = await setupWrite(response);
    await assert.rejects(() => api.generate(ID, { idempotencyKey: KEY }), errorIs('INVALID_RESPONSE'));
    assert.equal(calls.length, 1);
  }
});

test('GET отклоняет HTML, неверную оболочку и неожиданный успешный статус', async () => {
  for (const response of [
    new Response('<html>Ошибка прокси</html>', { status: 200 }),
    json({ result: summary() }), json({ data: summary() }, 202), new Response(null, { status: 204 }),
  ]) {
    const { api, calls } = setup(response);
    await assert.rejects(() => api.getByMaterial(ID), errorIs('INVALID_RESPONSE'));
    assert.equal(calls.length, 1);
  }
});

test('HTTP ошибки сохраняют код, статус и Retry-After без автоматического чтения или POST', async () => {
  for (const [status, code] of [
    [401, 'AUTHENTICATION_REQUIRED'], [403, 'CSRF_INVALID'],
    [404, 'SUMMARY_NOT_FOUND'], [404, 'MATERIAL_NOT_FOUND'],
    [409, 'MATERIAL_NOT_AVAILABLE'], [409, 'TEXT_NOT_READY'],
    [409, 'SUMMARY_IN_PROGRESS'], [409, 'IDEMPOTENCY_KEY_REUSED'],
    [429, 'RATE_LIMITED'], [503, 'AI_UNAVAILABLE'],
  ]) {
    for (const writing of [false, true]) {
      const response = json({ error: { code, message: 'Ошибка запроса.', fieldErrors: {} } },
        status, { 'Retry-After': '2' });
      const { api, calls } = writing ? await setupWrite(response) : setup(response);
      await assert.rejects(() => writing
        ? api.generate(ID, { idempotencyKey: KEY }) : api.getByMaterial(ID), (error) => {
        errorIs(code, status)(error);
        assert.equal(error.retryAfterSeconds, 2);
        return true;
      });
      assert.equal(calls.length, 1);
    }
  }
});

test('Без CSRF генерация не отправляется и токен не запрашивается автоматически', async () => {
  const { api, calls } = setup();
  await assert.rejects(() => api.generate(ID, { idempotencyKey: KEY }), errorIs('CSRF_NOT_INITIALIZED'));
  assert.equal(calls.length, 0);
});

test('Сеть не вызывает повтор; явный повтор использует переданный прежний ключ', async () => {
  const result = { materialId: ID, jobId: JOB_ID };
  const { api, calls } = await setupWrite(() => { throw new TypeError('Обрыв'); }, json({ data: result }, 202));
  await assert.rejects(() => api.generate(ID, { idempotencyKey: KEY }), errorIs('NETWORK_ERROR'));
  assert.equal(calls.length, 1);
  assert.deepEqual(await api.generate(ID, { idempotencyKey: KEY }), result);
  assert.deepEqual(calls.map(({ options }) => options.headers.get('Idempotency-Key')), [KEY, KEY]);
});

test('Предварительный abort не отправляет GET/POST; текущий abort прекращает ожидание', async () => {
  for (const writing of [false, true]) {
    for (const preAbort of [false, true]) {
      const controller = new AbortController();
      const response = (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Отменён', 'AbortError')), { once: true });
      });
      const { api, calls } = writing ? await setupWrite(response) : setup(response);
      if (preAbort) controller.abort();
      const pending = writing
        ? api.generate(ID, { idempotencyKey: KEY, signal: controller.signal })
        : api.getByMaterial(ID, { signal: controller.signal });
      if (!preAbort) controller.abort();
      await assert.rejects(pending, errorIs('REQUEST_CANCELLED'));
      assert.equal(calls.length, preAbort ? 0 : 1);
    }
  }
});

function edited(changes = {}) {
  return summary({ version: 2, origin: 'user', model: null, sourcePages: [],
    inputTokens: null, outputTokens: null, ...changes });
}

test('PATCH передаёт только исходный content/version, cookie/CSRF/signal без Idempotency-Key', async () => {
  const content = '  Первая строка\r\n\tВторая 😀\n  ';
  const result = edited({ content: content.trim() });
  const { api, calls } = await setupWrite(json({ data: result }));
  const controller = new AbortController();
  assert.deepEqual(await api.update(ID, { content, ownerId: OTHER_ID }, {
    version: 1, signal: controller.signal, idempotencyKey: KEY,
  }), result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/materials/' + ID + '/summary');
  const options = calls[0].options;
  assert.equal(options.method, 'PATCH');
  assert.equal(options.credentials, 'include');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.signal, controller.signal);
  assert.equal(options.headers.get('X-CSRF-TOKEN'), 'test-csrf');
  assert.equal(options.headers.get('Content-Type'), 'application/json');
  assert.equal(options.headers.has('Idempotency-Key'), false);
  assert.deepEqual(JSON.parse(options.body), { content, version: 1 });
});

test('PATCH принимает ручную версию при ready/failed/cancelled и не стирает состояние задания', async () => {
  for (const status of ['ready', 'failed', 'cancelled']) {
    const data = edited({ status, error: status === 'failed'
      ? { code: 'AI_UNAVAILABLE', message: 'Ошибка прежней генерации.' } : null });
    const { api } = await setupWrite(json({ data }));
    assert.deepEqual(await api.update(ID, { content: data.content }, { version: 1 }), data);
  }
});

test('PATCH проверяет UUID/version/непустой Unicode до сети и считает UTF-16 без trim', async () => {
  const { api, calls } = await setupWrite();
  for (const id of ['', null, OTHER_ID + '?query=1']) {
    await assert.rejects(() => api.update(id, { content: 'Текст' }, { version: 1 }), TypeError);
  }
  for (const version of [undefined, null, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => api.update(ID, { content: 'Текст' }, { version }), RangeError);
  }
  for (const content of [undefined, null, 1, '', ' \t\r\n', '\ud800', 'a\0b',
    'a'.repeat(100_001), '😀'.repeat(50_001), ' '.repeat(100_000) + 'a']) {
    await assert.rejects(() => api.update(ID, { content }, { version: 1 }), RangeError);
  }
  assert.equal(calls.length, 0);
  const content = '😀'.repeat(50_000);
  const valid = await setupWrite(json({ data: edited({ content }) }));
  assert.equal((await valid.api.update(ID, { content }, { version: 1 })).content, content);
});

test('PATCH не принимает старую/чужую/машинную версию или признаки выполняющейся генерации', async () => {
  for (const data of [
    edited({ materialId: OTHER_ID }), edited({ version: 1 }), edited({ version: 3 }),
    summary({ version: 2 }), edited({ status: 'queued' }), edited({ status: 'running' }),
    edited({ model: 'fake-local' }), edited({ sourcePages: [1] }), edited({ inputTokens: 0 }),
  ]) {
    const { api, calls } = await setupWrite(json({ data }));
    await assert.rejects(() => api.update(ID, { content: 'Текст' }, { version: 1 }), errorIs('INVALID_RESPONSE'));
    assert.equal(calls.length, 1);
  }
  for (const response of [json({ data: edited() }, 201), json({ result: edited() }), new Response(null, { status: 204 })]) {
    const { api } = await setupWrite(response);
    await assert.rejects(() => api.update(ID, { content: 'Текст' }, { version: 1 }), errorIs('INVALID_RESPONSE'));
  }
});

test('PATCH сохраняет ошибки и fieldErrors без автоматической перезаписи или чтения', async () => {
  for (const [status, code] of [
    [401, 'AUTHENTICATION_REQUIRED'], [403, 'CSRF_INVALID'], [404, 'SUMMARY_NOT_FOUND'],
    [404, 'MATERIAL_NOT_FOUND'], [409, 'MATERIAL_NOT_AVAILABLE'], [409, 'SUMMARY_IN_PROGRESS'],
    [409, 'SUMMARY_VERSION_CONFLICT'], [422, 'VALIDATION_FAILED'], [429, 'RATE_LIMITED'],
    [503, 'SERVICE_UNAVAILABLE'],
  ]) {
    const fieldErrors = status === 422 ? { content: 'Недопустимое значение.' } : {};
    const { api, calls } = await setupWrite(json({ error: { code, message: 'Ошибка', fieldErrors } },
      status, { 'Retry-After': '2' }));
    await assert.rejects(() => api.update(ID, { content: 'Текст' }, { version: 1 }), (error) => {
      errorIs(code, status)(error);
      assert.deepEqual(error.fieldErrors, fieldErrors);
      assert.equal(error.retryAfterSeconds, 2);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('PATCH не обходит CSRF, не повторяет сетевую ошибку и учитывает abort', async () => {
  const noCsrf = setup();
  await assert.rejects(() => noCsrf.api.update(ID, { content: 'Текст' }, { version: 1 }), errorIs('CSRF_NOT_INITIALIZED'));
  assert.equal(noCsrf.calls.length, 0);
  const network = await setupWrite(() => { throw new TypeError('Сеть'); });
  await assert.rejects(() => network.api.update(ID, { content: 'Текст' }, { version: 1 }), errorIs('NETWORK_ERROR'));
  assert.equal(network.calls.length, 1);
  for (const preAbort of [false, true]) {
    const controller = new AbortController();
    const s = await setupWrite((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Отмена', 'AbortError')), { once: true });
    }));
    if (preAbort) controller.abort();
    const pending = s.api.update(ID, { content: 'Текст' }, { version: 1, signal: controller.signal });
    if (!preAbort) controller.abort();
    await assert.rejects(pending, errorIs('REQUEST_CANCELLED'));
    assert.equal(s.calls.length, preAbort ? 0 : 1);
  }
});
