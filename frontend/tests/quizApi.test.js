import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, ApiError } from '../src/services/apiClient.js';
import { createQuizApi } from '../src/services/quizApi.js';

const MATERIAL_ID = '3dfa4d7d-619d-4a97-9f09-a34d236e879b';
const QUIZ_ID = '7f07410e-98f7-41a3-bfab-cbc387683fc1';
const OTHER_ID = '8f07410e-98f7-41a3-bfab-cbc387683fc1';
const JOB_ID = '095f15c2-1f89-4e09-a9ab-b3b281766f57';
const KEY = '773b6d14-d350-4c27-8db8-b3b1fdb5d159';
const TIME = '2026-09-29T10:00:00.123456789Z';

function info(changes = {}) {
  return { id: QUIZ_ID, materialId: MATERIAL_ID, version: 1, questionCount: 10,
    model: 'gpt-6-luna', createdAt: TIME, ...changes };
}

function quiz(changes = {}) {
  return { ...info(), questions: Array.from({ length: 10 }, (_, q) => ({
    id: 'a0000000-0000-4000-8000-' + String(q + 1).padStart(12, '0'),
    position: q + 1, text: 'Вопрос ' + (q + 1),
    options: Array.from({ length: 4 }, (_, o) => ({
      id: 'b0000000-0000-4000-8000-' + String(q * 4 + o + 1).padStart(12, '0'),
      position: o + 1, text: 'Вариант ' + (o + 1),
    })),
  })), ...changes };
}

function generation(status = 'ready', changes = {}) {
  return { status, jobId: status === 'not_started' ? null : JOB_ID,
    error: status === 'failed' ? { code: 'QUIZ_INSUFFICIENT_CONTENT', message: 'Недостаточно данных.' } : null,
    ...changes };
}

function page(data = [info()], changes = {}) {
  return { data, meta: { page: 1, pageSize: 20, total: data.length,
    generation: generation(data.length ? 'ready' : 'not_started'), ...changes } };
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
  return { api: createQuizApi(client), client, calls };
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

function invoke(api, method, options = {}) {
  if (method === 'generate') return api.generate(MATERIAL_ID, { idempotencyKey: KEY, ...options });
  if (method === 'list') return api.list(MATERIAL_ID, options);
  return api.getById(QUIZ_ID, options);
}

test('Создание адаптера не читает тесты и не запускает генерацию', () => {
  assert.equal(setup().calls.length, 0);
});

test('GET detail передаёт cookie/signal без query/CSRF; UUID регистр не важен', async () => {
  const { api, calls } = setup(json({ data: quiz() }));
  const controller = new AbortController();
  assert.deepEqual(await api.getById(QUIZ_ID.toUpperCase(), { signal: controller.signal }), quiz());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/quizzes/' + QUIZ_ID.toUpperCase());
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

test('GET list возвращает quizzes/meta, отправляет только page/pageSize и signal', async () => {
  const payload = page();
  const { api, calls } = setup(json(payload));
  const controller = new AbortController();
  assert.deepEqual(await api.list(MATERIAL_ID.toUpperCase(), { signal: controller.signal, query: 'ignored' }),
    { quizzes: payload.data, meta: payload.meta });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/materials/' + MATERIAL_ID.toUpperCase() + '/quizzes?page=1&pageSize=20');
  const options = calls[0].options;
  assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'include');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.signal, controller.signal);
  assert.equal(options.body, undefined);
  assert.equal(options.headers.has('X-CSRF-TOKEN'), false);
  assert.equal(options.headers.has('Idempotency-Key'), false);
});

test('POST принимает202 с materialId/jobId, отправляет выбранный ключ/CSRF/signal без тела/query', async () => {
  const data = { materialId: MATERIAL_ID, jobId: JOB_ID };
  const { api, calls } = await setupWrite(json({ data: { ...data, secret: 'ignored' } }, 202));
  const controller = new AbortController();
  assert.deepEqual(await api.generate(MATERIAL_ID.toUpperCase(), {
    idempotencyKey: KEY, signal: controller.signal, body: { ignored: true }, page: 3,
  }), data);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/materials/' + MATERIAL_ID.toUpperCase() + '/quizzes');
  const options = calls[0].options;
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'include');
  assert.equal(options.mode, 'same-origin');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.signal, controller.signal);
  assert.equal(options.body, undefined);
  assert.equal(options.headers.get('X-CSRF-TOKEN'), 'test-csrf');
  assert.equal(options.headers.get('Idempotency-Key'), KEY);
  assert.equal(options.headers.has('Content-Type'), false);
});

test('Пустое начало, все состояния generation и сохранённые версии читаются без POST', async () => {
  for (const status of ['not_started', 'queued', 'running', 'ready', 'failed', 'cancelled']) {
    for (const saved of status === 'not_started' ? [false] : status === 'ready' ? [true] : [false, true]) {
      const payload = page(saved ? [info()] : [], { generation: generation(status) });
      const { api, calls } = setup(json(payload));
      assert.deepEqual(await api.list(MATERIAL_ID), { quizzes: payload.data, meta: payload.meta });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].options.method, 'GET');
    }
  }
});

test('List принимает убывающие версии, неполную последнюю и пустую далёкую страницу', async () => {
  for (const payload of [
    page([info({ version: 3 }), info({ id: OTHER_ID, version: 2 })], { pageSize: 2, total: 3 }),
    page([info()], { page: 2, pageSize: 2, total: 3 }),
    page([], { page: 3, pageSize: 2, total: 3, generation: generation() }),
    page([], { page: Number.MAX_SAFE_INTEGER, pageSize: 100, total: 3, generation: generation() }),
    page([info({ version: Number.MAX_SAFE_INTEGER })], { pageSize: 1, total: Number.MAX_SAFE_INTEGER }),
    page([info({ version: 1 })], { page: Number.MAX_SAFE_INTEGER, pageSize: 1, total: Number.MAX_SAFE_INTEGER }),
  ]) {
    const { api } = setup(json(payload));
    assert.deepEqual(await api.list(MATERIAL_ID, payload.meta), { quizzes: payload.data, meta: payload.meta });
  }
});

test('fake-local, Unicode, HTML-подобный plain text и точные UTF16 границы не преобразуются', async () => {
  for (const text of ['  <script>window.bad=1</script>\r\n😀\t текст  ', '😀'.repeat(500)]) {
    const data = quiz({ model: 'fake-local', version: Number.MAX_SAFE_INTEGER });
    data.questions[0].text = text;
    data.questions[0].options[0].text = '😀'.repeat(250);
    const { api } = setup(json({ data }));
    assert.deepEqual(await api.getById(QUIZ_ID), data);
  }
  const data = quiz({ model: 'm'.repeat(80) });
  const { api } = setup(json({ data }));
  assert.equal((await api.getById(QUIZ_ID)).model.length, 80);
});

test('Только публичные поля detail, questions и options: ответы и ссылки не протекают в UI', async () => {
  const data = quiz();
  const wire = structuredClone(data);
  Object.assign(wire, { ownerId: OTHER_ID, inputTokens: 1, outputTokens: 2, answers: ['secret'] });
  for (const question of wire.questions) {
    Object.assign(question, { correctOptionId: question.options[0].id, correctIndex: 0,
      explanation: 'Секрет', sourcePages: [1], answers: ['секрет'] });
    for (const option of question.options) Object.assign(option, { correct: true, isCorrect: true, sourcePages: [1] });
  }
  const api = createQuizApi({ request: async () => ({ status: 200, data: wire }) });
  const result = await api.getById(QUIZ_ID);
  assert.deepEqual(result, data);
  result.questions[0].text = 'Изменён';
  result.questions[0].options[0].text = 'Изменён';
  result.questions.pop();
  assert.deepEqual(wire.questions[0].text, data.questions[0].text);
  assert.deepEqual(wire.questions[0].options[0].text, data.questions[0].options[0].text);
  assert.equal(wire.questions.length, 10);
});

test('List/meta/generation/error тоже копируют только публичные поля', async () => {
  const payload = page([info()], { generation: generation('failed') });
  const wire = structuredClone(payload);
  wire.data[0].questions = quiz().questions;
  wire.data[0].sourcePages = [1];
  wire.meta.ownerId = OTHER_ID;
  wire.meta.generation.payload = { secret: true };
  wire.meta.generation.error.internal = 'exception';
  const api = createQuizApi({ request: async () => ({ status: 200, ...wire }) });
  const result = await api.list(MATERIAL_ID);
  assert.deepEqual(result, { quizzes: payload.data, meta: payload.meta });
  result.meta.generation.error.message = 'Изменено';
  result.quizzes[0].model = 'Изменено';
  assert.equal(wire.meta.generation.error.message, payload.meta.generation.error.message);
  assert.equal(wire.data[0].model, payload.data[0].model);
});

test('UUID/ключ/page/pageSize проверяются до сети', async () => {
  const { api, calls } = await setupWrite();
  for (const value of ['', undefined, null, '../auth/me', MATERIAL_ID + '?extra=1', 1, {}]) {
    await assert.rejects(() => api.getById(value), TypeError);
    await assert.rejects(() => api.list(value), TypeError);
    await assert.rejects(() => api.generate(value, { idempotencyKey: KEY }), TypeError);
    await assert.rejects(() => api.generate(MATERIAL_ID, { idempotencyKey: value }), TypeError);
  }
  for (const value of [null, '1', 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => api.list(MATERIAL_ID, { page: value }), RangeError);
    await assert.rejects(() => api.list(MATERIAL_ID, { pageSize: value }), RangeError);
  }
  await assert.rejects(() => api.list(MATERIAL_ID, { pageSize: 101 }), RangeError);
  assert.equal(calls.length, 0);
});

test('Неверные Info поля отклоняются в detail и list', async () => {
  for (const changes of [
    { id: null }, { materialId: 'bad' }, { version: 0 }, { version: '1' }, { version: 1.5 },
    { version: Number.MAX_SAFE_INTEGER + 1 }, { questionCount: 9 }, { questionCount: '10' },
    { model: null }, { model: '' }, { model: ' \t' }, { model: 'm'.repeat(81) },
    { model: 'm\nlabel' }, { model: '\ud800' }, { model: 'm\u007f' }, { model: 'm\u0085' },
    { createdAt: null }, { createdAt: '2026-02-30T10:00:00Z' },
    { createdAt: '2026-09-29T24:00:00Z' }, { createdAt: '2026-09-29T10:00:00+00:00' },
  ]) {
    for (const method of ['getById', 'list']) {
      const { api } = setup(json(method === 'list' ? page([info(changes)]) : { data: quiz(changes) }));
      await assert.rejects(() => invoke(api, method), errorIs('INVALID_RESPONSE', 200), JSON.stringify(changes));
    }
  }
  const { api } = setup(json({ data: quiz({ id: OTHER_ID }) }));
  await assert.rejects(() => api.getById(QUIZ_ID), errorIs('INVALID_RESPONSE', 200));
});

test('Все публичные поля обязательны включая nullable generation/error поля', async () => {
  const locations = [
    (data) => data, (data) => data.questions[0], (data) => data.questions[0].options[0],
  ];
  for (const location of locations) {
    for (const key of Object.keys(location(quiz()))) {
      const data = quiz();
      delete location(data)[key];
      const { api } = setup(json({ data }));
      await assert.rejects(() => api.getById(QUIZ_ID), errorIs('INVALID_RESPONSE'), key);
    }
  }
  for (const location of [(data) => data.meta, (data) => data.meta.generation,
    (data) => data.meta.generation.error]) {
    const fixture = () => page([info()], { generation: generation('failed') });
    for (const key of Object.keys(location(fixture()))) {
      const payload = fixture();
      delete location(payload)[key];
      const { api } = setup(json(payload));
      await assert.rejects(() => api.list(MATERIAL_ID), errorIs('INVALID_RESPONSE'), key);
    }
  }
});

test('Неверная форма/размер/позиции/UUID/дубликаты questions и options отклоняются', async () => {
  const mutations = [
    (d) => { d.questions = null; }, (d) => { d.questions.pop(); },
    (d) => { d.questions.push(d.questions[0]); }, (d) => { d.questions[0] = null; },
    (d) => { d.questions[0].id = 'bad'; }, (d) => { d.questions[0].position = 0; },
    (d) => { d.questions[0].position = '1'; },
    (d) => { [d.questions[0], d.questions[1]] = [d.questions[1], d.questions[0]]; },
    (d) => { d.questions[1].id = d.questions[0].id.toUpperCase(); },
    (d) => { d.questions[0].options = null; }, (d) => { d.questions[0].options.pop(); },
    (d) => { d.questions[0].options.push(d.questions[0].options[0]); },
    (d) => { d.questions[0].options[0] = null; },
    (d) => { d.questions[0].options[0].id = 'bad'; },
    (d) => { d.questions[0].options[0].position = 2; },
    (d) => { d.questions[0].options[0].position = '1'; },
    (d) => { d.questions[0].options[1].id = d.questions[0].options[0].id.toUpperCase(); },
    (d) => { d.questions[1].options[0].id = d.questions[0].options[0].id.toUpperCase(); },
  ];
  for (const mutate of mutations) {
    const data = quiz();
    mutate(data);
    const { api } = setup(json({ data }));
    await assert.rejects(() => api.getById(QUIZ_ID), errorIs('INVALID_RESPONSE', 200));
  }
});

test('Пустой, слишком длинный, control и некорректный Unicode в вопросах/вариантах отклоняются', async () => {
  for (const option of [false, true]) {
    const limit = option ? 500 : 1000;
    for (const text of [undefined, null, 1, '', ' \r\n\t', 'a'.repeat(limit + 1),
      '😀'.repeat(limit / 2 + 1), 'a\0b', 'a\u001fb', 'a\u007fb', 'a\u0085b', 'a\ud800', '\udc00b']) {
      const data = quiz();
      (option ? data.questions[0].options[0] : data.questions[0]).text = text;
      const { api } = setup(json({ data }));
      await assert.rejects(() => api.getById(QUIZ_ID), errorIs('INVALID_RESPONSE', 200));
    }
  }
});

test('List отклоняет несогласованный meta/страницы, чужой material и повторы/неверный порядок версий', async () => {
  for (const payload of [
    { data: null, meta: page().meta }, { data: [], meta: null },
    page([info()], { page: 2 }), page([info()], { pageSize: 10 }),
    page([info()], { total: -1 }), page([info()], { total: '1' }),
    page([info()], { total: 0 }), page([info()], { total: 1.5 }),
    page([info()], { total: Number.MAX_SAFE_INTEGER + 1 }), page([info()], { total: 21 }),
    page([info({ materialId: OTHER_ID })]),
    page([info({ version: 2 }), info({ id: QUIZ_ID.toUpperCase() })]),
    page([info(), info({ id: OTHER_ID, version: 2 })]),
    page([info(), info({ id: OTHER_ID })]),
  ]) {
    const { api } = setup(json(payload));
    await assert.rejects(() => api.list(MATERIAL_ID), errorIs('INVALID_RESPONSE', 200));
  }
});

test('Generation связывает status/jobId/error и не выдаёт ready без сохранённого теста', async () => {
  for (const value of [
    null, [], generation('succeeded'), generation('constructor'),
    generation('not_started'), generation('ready', { jobId: null }),
    generation('queued', { jobId: 'bad' }), generation('queued', { error: { code: 'AI_UNAVAILABLE', message: 'Ошибка' } }),
    generation('failed', { error: null }), generation('failed', { error: { code: 'INTERNAL', message: 'Ошибка' } }),
    generation('failed', { error: { code: 'PDF_INVALID', message: 'Ошибка' } }),
    generation('failed', { error: { code: 'AI_UNAVAILABLE', message: '' } }),
    generation('failed', { error: { code: 'AI_UNAVAILABLE', message: 'a\ud800' } }),
  ]) {
    const { api } = setup(json(page([info()], { generation: value })));
    await assert.rejects(() => api.list(MATERIAL_ID), errorIs('INVALID_RESPONSE', 200));
  }
  for (const value of [generation(), generation('not_started', { jobId: JOB_ID })]) {
    const { api } = setup(json(page([], { generation: value })));
    await assert.rejects(() => api.list(MATERIAL_ID), errorIs('INVALID_RESPONSE', 200));
  }
});

test('Ошибки ИИ/инфраструктуры/недостаточного материала читаются как failed HTTP200', async () => {
  for (const code of ['JOB_TEMPORARY_FAILURE', 'JOB_PROCESSING_FAILED', 'JOB_ATTEMPTS_EXHAUSTED',
    'JOB_LEASE_EXPIRED', 'JOB_OUTCOME_UNKNOWN', 'AI_UNAVAILABLE', 'AI_INVALID_RESPONSE',
    'AI_OUTCOME_UNKNOWN', 'QUIZ_INSUFFICIENT_CONTENT']) {
    const payload = page([], { generation: generation('failed', { error: { code, message: 'Ошибка задания.' } }) });
    const { api, calls } = setup(json(payload));
    assert.deepEqual(await api.list(MATERIAL_ID), { quizzes: [], meta: payload.meta });
    assert.equal(calls.length, 1);
  }
});

test('POST отклоняет чужой материал, неверный jobId/оболочку/статус без повторов', async () => {
  for (const response of [
    json({ data: { materialId: OTHER_ID, jobId: JOB_ID } }, 202),
    json({ data: { materialId: MATERIAL_ID, jobId: null } }, 202),
    json({ data: { materialId: MATERIAL_ID } }, 202), json({ data: [] }, 202),
    json({ data: { materialId: MATERIAL_ID, jobId: JOB_ID } }, 200),
    json({ result: { materialId: MATERIAL_ID, jobId: JOB_ID } }, 202), new Response(null, { status: 204 }),
  ]) {
    const { api, calls } = await setupWrite(response);
    await assert.rejects(() => invoke(api, 'generate'), errorIs('INVALID_RESPONSE'));
    assert.equal(calls.length, 1);
  }
});

test('GET отклоняет HTML, неверную оболочку и неожиданный успешный статус', async () => {
  for (const method of ['list', 'getById']) {
    for (const response of [
      new Response('<html>Ошибка прокси</html>', { status: 200 }),
      json({ result: quiz() }), json(method === 'list' ? page() : { data: quiz() }, 202),
      new Response(null, { status: 204 }), json({ data: null }), json({ data: [] }),
    ]) {
      const { api, calls } = setup(response);
      await assert.rejects(() => invoke(api, method), errorIs('INVALID_RESPONSE'));
      assert.equal(calls.length, 1);
    }
  }
});

test('HTTP ошибки сохраняют code/status/Retry-After без автоматического GET/POST', async () => {
  for (const [status, code] of [
    [401, 'AUTHENTICATION_REQUIRED'], [403, 'CSRF_INVALID'], [404, 'MATERIAL_NOT_FOUND'],
    [404, 'QUIZ_NOT_FOUND'], [409, 'MATERIAL_NOT_AVAILABLE'], [409, 'TEXT_NOT_READY'],
    [409, 'QUIZ_IN_PROGRESS'], [409, 'IDEMPOTENCY_KEY_REUSED'], [429, 'RATE_LIMITED'], [503, 'AI_UNAVAILABLE'],
  ]) {
    for (const method of ['generate', 'list', 'getById']) {
      const response = json({ error: { code, message: 'Ошибка запроса.', fieldErrors: {} } },
        status, { 'Retry-After': '2' });
      const { api, calls } = method === 'generate' ? await setupWrite(response) : setup(response);
      await assert.rejects(() => invoke(api, method), (error) => {
        errorIs(code, status)(error);
        assert.equal(error.retryAfterSeconds, 2);
        return true;
      });
      assert.equal(calls.length, 1);
    }
  }
});

test('Без CSRF генерация не отправляется и токен не читается автоматически', async () => {
  const { api, calls } = setup();
  await assert.rejects(() => invoke(api, 'generate'), errorIs('CSRF_NOT_INITIALIZED'));
  assert.equal(calls.length, 0);
});

test('Сеть не вызывает повтор; только явный новый вызов POST использует переданный прежний ключ', async () => {
  const result = { materialId: MATERIAL_ID, jobId: JOB_ID };
  const { api, calls } = await setupWrite(() => { throw new TypeError('Обрыв'); }, json({ data: result }, 202));
  await assert.rejects(() => invoke(api, 'generate'), errorIs('NETWORK_ERROR'));
  assert.equal(calls.length, 1);
  assert.deepEqual(await invoke(api, 'generate'), result);
  assert.deepEqual(calls.map(({ options }) => options.headers.get('Idempotency-Key')), [KEY, KEY]);
  for (const method of ['list', 'getById']) {
    const state = setup(() => { throw new TypeError('Обрыв'); });
    await assert.rejects(() => invoke(state.api, method), errorIs('NETWORK_ERROR'));
    assert.equal(state.calls.length, 1);
  }
});

test('Abort до запроса исключает сеть; abort текущего GET/POST прекращает ожидание', async () => {
  for (const method of ['generate', 'list', 'getById']) {
    for (const preAbort of [false, true]) {
      const controller = new AbortController();
      const response = (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Отмена', 'AbortError')), { once: true });
      });
      const { api, calls } = method === 'generate' ? await setupWrite(response) : setup(response);
      if (preAbort) controller.abort();
      const pending = invoke(api, method, { signal: controller.signal });
      if (!preAbort) controller.abort();
      await assert.rejects(pending, errorIs('REQUEST_CANCELLED'));
      assert.equal(calls.length, preAbort ? 0 : 1);
    }
  }
});
