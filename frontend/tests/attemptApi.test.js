import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, ApiError } from '../src/services/apiClient.js';
import { createAttemptApi } from '../src/services/attemptApi.js';

const ID = '6f07410e-98f7-41a3-bfab-cbc387683fc1';
const QUIZ_ID = '7f07410e-98f7-41a3-bfab-cbc387683fc1';
const MATERIAL_ID = '3dfa4d7d-619d-4a97-9f09-a34d236e879b';
const OTHER_ID = '8f07410e-98f7-41a3-bfab-cbc387683fc1';
const KEY = '773b6d14-d350-4c27-8db8-b3b1fdb5d159';
const STARTED = '2026-10-03T10:00:00.123456789Z';
const FINISHED = '2026-10-03T10:05:00.123456789Z';

function attempt(changes = {}) {
  return {
    id: ID, quizId: QUIZ_ID, materialId: MATERIAL_ID, quizVersion: 1,
    status: 'in_progress', questionCount: 10, startedAt: STARTED,
    completedAt: null, correctCount: null, scorePercent: null, review: null,
    questions: Array.from({ length: 10 }, (_, q) => ({
      id: 'a0000000-0000-4000-8000-' + String(q + 1).padStart(12, '0'),
      position: q + 1, text: 'Вопрос ' + (q + 1),
      options: Array.from({ length: 4 }, (_, o) => ({
        id: 'b0000000-0000-4000-8000-' + String(q * 4 + o + 1).padStart(12, '0'),
        position: o + 1, text: 'Вариант ' + (o + 1),
      })),
    })),
    ...changes,
  };
}

function correctAnswers(count = 10) {
  return attempt().questions.slice(0, count).map((question) => ({
    questionId: question.id, optionId: question.options[0].id,
  }));
}

function completed(answers = [], changes = {}) {
  const selections = new Map(answers.map((answer) => [answer.questionId.toLowerCase(), answer.optionId ?? null]));
  const data = attempt({ status: 'completed', completedAt: FINISHED });
  data.review = data.questions.map((question) => {
    const selectedOptionId = selections.get(question.id.toLowerCase()) ?? null;
    const correctOptionId = question.options[0].id;
    return {
      questionId: question.id, selectedOptionId, correctOptionId,
      isCorrect: selectedOptionId?.toLowerCase() === correctOptionId,
      explanation: 'Объяснение по тексту PDF.', sourcePages: [1, 3],
    };
  });
  data.correctCount = data.review.filter((item) => item.isCorrect).length;
  data.scorePercent = data.correctCount * 10;
  return { ...data, ...changes };
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function setup(...responses) {
  const calls = [];
  const client = createApiClient({ baseUrl: '/api/v1', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (typeof next === 'function') return next(url, options);
    if (!next) throw new Error('Незапланированный запрос.');
    return next;
  } });
  return { api: createAttemptApi(client), client, calls };
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
  if (method === 'start') return api.start(QUIZ_ID, { idempotencyKey: KEY, ...options });
  if (method === 'submit') return api.submit(ID, [], options);
  return api.getById(ID, options);
}

test('Создание адаптера не отправляет запросов и предоставляет start/submit/getById/list', () => {
  const { api, calls } = setup();
  assert.deepEqual(Object.keys(api).sort(), ['getById', 'list', 'start', 'submit']);
  assert.equal(calls.length, 0);
});

test('GET передаёт cookie/signal без query, CSRF, ключа и побочных запросов', async () => {
  const { api, calls } = setup(json({ data: attempt() }));
  const controller = new AbortController();
  assert.deepEqual(await api.getById(ID.toUpperCase(), { signal: controller.signal }), attempt());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/attempts/' + ID.toUpperCase());
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

test('Start отправляет POST без тела/query с выбранным ключом, CSRF и signal; принимает 201', async () => {
  const { api, calls } = await setupWrite(json({ data: attempt() }, 201));
  const controller = new AbortController();
  assert.deepEqual(await api.start(QUIZ_ID.toUpperCase(), {
    idempotencyKey: KEY, signal: controller.signal, body: { scorePercent: 100 }, query: { ignored: true },
  }), attempt());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/quizzes/' + QUIZ_ID.toUpperCase() + '/attempts');
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

test('Start с прежним ключом принимает текущее completed состояние прежней попытки', async () => {
  const data = completed(correctAnswers(7));
  const { api, calls } = await setupWrite(json({ data }, 201), json({ data }, 201));
  assert.deepEqual(await invoke(api, 'start'), data);
  assert.deepEqual(await invoke(api, 'start'), data);
  assert.deepEqual(calls.map(({ options }) => options.headers.get('Idempotency-Key')), [KEY, KEY]);
  assert.equal(calls.length, 2);
});

test('Submit отправляет только answers, сохраняет порядок/регистр и нормализует пропуски без ключа', async () => {
  const questions = attempt().questions;
  const answers = [
    { questionId: questions[2].id },
    { questionId: questions[1].id.toUpperCase(), optionId: questions[1].options[0].id.toUpperCase() },
    { questionId: questions[0].id, optionId: null },
    { questionId: questions[3].id, optionId: undefined },
  ];
  const data = completed(answers);
  const { api, calls } = await setupWrite(json({ data }));
  const controller = new AbortController();
  assert.deepEqual(await api.submit(ID.toUpperCase(), answers, {
    signal: controller.signal, idempotencyKey: KEY, scorePercent: 100, ownerId: OTHER_ID,
  }), data);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/attempts/' + ID.toUpperCase() + '/submit');
  const options = calls[0].options;
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'include');
  assert.equal(options.mode, 'same-origin');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.signal, controller.signal);
  assert.equal(options.headers.get('X-CSRF-TOKEN'), 'test-csrf');
  assert.equal(options.headers.get('Content-Type'), 'application/json');
  assert.equal(options.headers.has('Idempotency-Key'), false);
  assert.deepEqual(JSON.parse(options.body), { answers: answers.map((answer) => ({
    questionId: answer.questionId, optionId: answer.optionId ?? null,
  })) });
  assert.equal(Object.hasOwn(answers[0], 'optionId'), false);
});

test('Пустая сдача, неправильный вариант, пропуски и все серверные баллы 0..100 согласованы', async () => {
  for (let count = 0; count <= 10; count += 1) {
    const answers = correctAnswers(count);
    const data = completed(answers);
    const { api } = await setupWrite(json({ data }));
    assert.deepEqual(await api.submit(ID, answers), data);
  }
  const questions = attempt().questions;
  const answers = [
    { questionId: questions[0].id, optionId: questions[0].options[1].id },
    { questionId: questions[1].id },
  ];
  const data = completed(answers);
  const { api } = await setupWrite(json({ data }));
  assert.deepEqual(await api.submit(ID, answers), data);
  assert.equal(data.correctCount, 0);
  assert.equal(data.scorePercent, 0);
  assert.notEqual(data.review[0].selectedOptionId, null);
  assert.equal(data.review[1].selectedOptionId, null);
});

test('GET различает null незавершённой попытки и нулевой завершённый результат', async () => {
  for (const data of [attempt(), completed(), completed(correctAnswers(10))]) {
    const { api } = setup(json({ data }));
    assert.deepEqual(await api.getById(ID), data);
  }
});

test('Даты сервера сохраняются, равное время допустимо, наносекунды не округляются', async () => {
  for (const [startedAt, completedAt] of [
    [STARTED, STARTED],
    ['2026-10-03T10:00:00Z', '2026-10-03T10:00:00.000000001Z'],
    ['2026-10-03T10:00:00.1Z', '2026-10-03T10:00:00.100000000Z'],
  ]) {
    const data = completed([], { startedAt, completedAt, quizVersion: Number.MAX_SAFE_INTEGER });
    const { api } = setup(json({ data }));
    assert.deepEqual(await api.getById(ID), data);
  }
});

test('Регистр UUID в review не меняет принадлежность вопроса и правильность', async () => {
  const data = completed(correctAnswers(3));
  data.review = data.review.map((item) => ({ ...item, questionId: item.questionId.toUpperCase(),
    correctOptionId: item.correctOptionId.toUpperCase(), selectedOptionId: item.selectedOptionId?.toUpperCase() ?? null }));
  const { api } = setup(json({ data }));
  assert.deepEqual(await api.getById(ID), data);
});

test('Публичная проекция не раскрывает поля ключей в questions/options и копирует вложенные данные', async () => {
  for (const data of [attempt(), completed(correctAnswers(1))]) {
    const wire = structuredClone(data);
    Object.assign(wire, { operationKey: KEY, ownerId: OTHER_ID, answers: ['private'], model: 'fake-local', jobId: OTHER_ID });
    for (const question of wire.questions) {
      Object.assign(question, { correctOptionId: question.options[0].id, isCorrect: true,
        correctIndex: 0, explanation: 'private', sourcePages: [1] });
      question.options.forEach((option) => Object.assign(option, { isCorrect: true, correct: true, sourcePages: [1] }));
    }
    wire.review?.forEach((item) => Object.assign(item, { ownerId: OTHER_ID, answerKey: 'private' }));
    const api = createAttemptApi({ request: async () => ({ status: 200, data: wire }) });
    const result = await api.getById(ID);
    assert.deepEqual(result, data);
    result.questions[0].text = 'changed';
    result.questions[0].options[0].text = 'changed';
    result.questions.pop();
    assert.equal(wire.questions.length, 10);
    assert.equal(wire.questions[0].text, data.questions[0].text);
    assert.equal(wire.questions[0].options[0].text, data.questions[0].options[0].text);
    if (result.review) {
      result.review[0].sourcePages.push(4);
      result.review[0].explanation = 'changed';
      assert.deepEqual(wire.review[0].sourcePages, [1, 3]);
      assert.equal(wire.review[0].explanation, data.review[0].explanation);
    }
  }
});

test('Текст, HTML-подобные строки, emoji и границы UTF-16 сохраняются без преобразований', async () => {
  for (const boundary of [false, true]) {
    const data = completed();
    const text = '  <script>не выполнять</script>\r\n\t😀  ';
    data.questions[0].text = boundary ? '😀'.repeat(500) : text;
    data.questions[0].options[0].text = boundary ? '😀'.repeat(250) : text;
    data.review[0].explanation = boundary ? '😀'.repeat(1000) : text;
    data.review[0].sourcePages = [1, 3, 7, 10, 13, 70, 150, 200];
    const { api } = setup(json({ data }));
    assert.deepEqual(await api.getById(ID), data);
  }
});

test('Неверные UUID пути и ключ начала отклоняются до HTTP', async () => {
  const { api, calls } = await setupWrite();
  for (const value of ['', null, undefined, 1, {}, '../auth/me', ID + '?extra=1']) {
    await assert.rejects(() => api.start(value, { idempotencyKey: KEY }), TypeError);
    await assert.rejects(() => api.start(QUIZ_ID, { idempotencyKey: value }), TypeError);
    await assert.rejects(() => api.getById(value), TypeError);
    await assert.rejects(() => api.submit(value, []), TypeError);
  }
  assert.equal(calls.length, 0);
});

test('Answers проверяются до HTTP: массив до10, UUID, уникальные вопросы, без лишних полей', async () => {
  const { api, calls } = await setupWrite();
  const first = correctAnswers(1)[0];
  for (const answers of [null, undefined, {}, 'answers', 1, [null], [[]], ['answer'], [{}],
    [{ optionId: first.optionId }], [{ questionId: '' }], [{ questionId: first.questionId, optionId: '' }],
    [{ questionId: first.questionId, optionId: 1 }], [{ questionId: first.questionId, optionId: {} }],
    [{ ...first, scorePercent: 100 }], [{ ...first, isCorrect: true }], [{ ...first, unexpected: undefined }],
    Array(1)]) {
    await assert.rejects(() => api.submit(ID, answers), TypeError);
  }
  await assert.rejects(() => api.submit(ID, [...correctAnswers(), first]), RangeError);
  await assert.rejects(() => api.submit(ID, [first, { ...first, questionId: first.questionId.toUpperCase() }]), RangeError);
  assert.equal(calls.length, 0);
});

test('Неизвестная принадлежность input остаётся серверной проверкой, 422 не приводит к повторам', async () => {
  const fieldErrors = { answers: 'Вариант не принадлежит вопросу.' };
  const { api, calls } = await setupWrite(json({ error: { code: 'VALIDATION_FAILED', message: 'Проверь ответы.', fieldErrors } }, 422));
  await assert.rejects(() => api.submit(ID, [{ questionId: OTHER_ID, optionId: QUIZ_ID }]), (error) => {
    errorIs('VALIDATION_FAILED', 422)(error);
    assert.deepEqual(error.fieldErrors, fieldErrors);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('Неверные базовые поля DTO, nullable состояния и даты отклоняются', async () => {
  for (const data of [
    null, [], attempt({ id: OTHER_ID }), attempt({ quizId: null }), attempt({ materialId: 'bad' }),
    attempt({ quizVersion: 0 }), attempt({ quizVersion: 1.5 }), attempt({ quizVersion: '1' }),
    attempt({ quizVersion: Number.MAX_SAFE_INTEGER + 1 }), attempt({ questionCount: 9 }),
    attempt({ questionCount: '10' }), attempt({ status: 'queued' }), attempt({ status: 'constructor' }),
    attempt({ startedAt: null }), attempt({ startedAt: '2026-02-30T10:00:00Z' }),
    attempt({ startedAt: '2026-10-03T24:00:00Z' }), attempt({ startedAt: '2026-10-03T10:00:00+00:00' }),
    attempt({ completedAt: FINISHED }), attempt({ correctCount: 0 }), attempt({ scorePercent: 0 }),
    attempt({ review: [] }), attempt({ review: completed().review }),
    completed([], { completedAt: null }), completed([], { completedAt: '2026-10-03T09:00:00Z' }),
    completed([], { completedAt: '2026-10-03T10:00:00.123456788Z' }),
    completed([], { correctCount: null }), completed([], { correctCount: '0' }),
    completed([], { correctCount: -1 }), completed([], { correctCount: 11 }),
    completed([], { correctCount: 0.5 }), completed([], { scorePercent: null }),
    completed([], { scorePercent: '0' }), completed([], { scorePercent: 0.01 }),
    completed(correctAnswers(1), { scorePercent: 9.99 }), completed(correctAnswers(1), { correctCount: 2, scorePercent: 20 }),
  ]) {
    const { api } = setup(json({ data }));
    await assert.rejects(() => api.getById(ID), errorIs('INVALID_RESPONSE', 200));
  }
});

test('Все поля DTO, questions/options/review обязательны, включая поля со значением null', async () => {
  for (const fixture of [attempt, completed]) {
    const locations = [(data) => data, (data) => data.questions[0], (data) => data.questions[0].options[0]];
    if (fixture === completed) locations.push((data) => data.review[0]);
    for (const location of locations) {
      for (const key of Object.keys(location(fixture()))) {
        const data = fixture();
        delete location(data)[key];
        const { api } = setup(json({ data }));
        await assert.rejects(() => api.getById(ID), errorIs('INVALID_RESPONSE'), key);
      }
    }
  }
});

test('Questions/options требуют10x4, UUID без повторов и позиции в сохранённом порядке', async () => {
  const mutations = [
    (d) => { d.questions = null; }, (d) => { d.questions.pop(); },
    (d) => { d.questions.push(d.questions[0]); }, (d) => { d.questions[0] = null; },
    (d) => { d.questions[0].id = 'bad'; }, (d) => { d.questions[1].id = d.questions[0].id.toUpperCase(); },
    (d) => { d.questions[0].position = 0; }, (d) => { d.questions[0].position = '1'; },
    (d) => { [d.questions[0], d.questions[1]] = [d.questions[1], d.questions[0]]; },
    (d) => { d.questions[0].options = null; }, (d) => { d.questions[0].options.pop(); },
    (d) => { d.questions[0].options.push(d.questions[0].options[0]); },
    (d) => { d.questions[0].options[0] = null; }, (d) => { d.questions[0].options[0].id = 'bad'; },
    (d) => { d.questions[0].options[0].position = 2; }, (d) => { d.questions[0].options[0].position = '1'; },
    (d) => { d.questions[0].options[1].id = d.questions[0].options[0].id.toUpperCase(); },
    (d) => { d.questions[1].options[0].id = d.questions[0].options[0].id.toUpperCase(); },
  ];
  for (const mutate of mutations) {
    const data = attempt();
    mutate(data);
    const { api } = setup(json({ data }));
    await assert.rejects(() => api.getById(ID), errorIs('INVALID_RESPONSE', 200));
  }
});

test('Review требует10 строк в порядке вопросов, принадлежность вариантов и согласованную правильность', async () => {
  const mutations = [
    (d) => { d.review = null; }, (d) => { d.review.pop(); }, (d) => { d.review.push(d.review[0]); },
    (d) => { d.review[0] = null; }, (d) => { d.review[0].questionId = OTHER_ID; },
    (d) => { d.review[1].questionId = d.review[0].questionId.toUpperCase(); },
    (d) => { [d.review[0], d.review[1]] = [d.review[1], d.review[0]]; },
    (d) => { d.review[0].correctOptionId = null; }, (d) => { d.review[0].correctOptionId = OTHER_ID; },
    (d) => { d.review[0].correctOptionId = d.questions[1].options[0].id; },
    (d) => { d.review[0].selectedOptionId = ''; }, (d) => { d.review[0].selectedOptionId = OTHER_ID; },
    (d) => { d.review[0].selectedOptionId = d.questions[1].options[0].id; },
    (d) => { d.review[0].isCorrect = 'false'; }, (d) => { d.review[0].isCorrect = true; },
    (d) => { d.review[0].selectedOptionId = d.review[0].correctOptionId; },
  ];
  for (const mutate of mutations) {
    const data = completed();
    mutate(data);
    const { api } = setup(json({ data }));
    await assert.rejects(() => api.getById(ID), errorIs('INVALID_RESPONSE', 200));
  }
});

test('Физические sourcePages непустые, не больше8, целые1..200 и возрастают без повторов', async () => {
  for (const pages of [null, [], [0], [201], [-1], [1.5], ['1'], [1, 1], [3, 1],
    Array.from({ length: 9 }, (_, index) => index + 1)]) {
    const data = completed();
    data.review[0].sourcePages = pages;
    const { api } = setup(json({ data }));
    await assert.rejects(() => api.getById(ID), errorIs('INVALID_RESPONSE', 200));
  }
});

test('Текст вопросов/вариантов/объяснений непустой, ограничен UTF-16 и валиден как Unicode', async () => {
  for (const [location, max] of [
    [(data) => data.questions[0], 1000], [(data) => data.questions[0].options[0], 500],
    [(data) => data.review[0], 2000],
  ]) {
    for (const text of [null, '', ' \r\n\t ', 1, 'a'.repeat(max + 1), '😀'.repeat(max / 2 + 1),
      'a\0b', 'a\u001fb', 'a\u007fb', 'a\u0085b', 'a\ud800', '\udc00b']) {
      const data = completed();
      location(data)[max === 2000 ? 'explanation' : 'text'] = text;
      const { api } = setup(json({ data }));
      await assert.rejects(() => api.getById(ID), errorIs('INVALID_RESPONSE', 200));
    }
  }
});

test('Start проверяет quizId, submit проверяет attemptId и принимает только completed', async () => {
  const badStart = await setupWrite(json({ data: attempt({ quizId: OTHER_ID }) }, 201));
  await assert.rejects(() => invoke(badStart.api, 'start'), errorIs('INVALID_RESPONSE', 201));
  for (const data of [attempt(), completed([], { id: OTHER_ID })]) {
    const { api, calls } = await setupWrite(json({ data }));
    await assert.rejects(() => invoke(api, 'submit'), errorIs('INVALID_RESPONSE', 200));
    assert.equal(calls.length, 1);
  }
});

test('Submit отклоняет HTTP200 с другим набором ответов или чужим questionId', async () => {
  for (const [answers, data] of [
    [correctAnswers(1), completed()],
    [[], completed(correctAnswers(1))],
    [[{ questionId: OTHER_ID, optionId: null }], completed()],
    [[{ questionId: correctAnswers(1)[0].questionId, optionId: OTHER_ID }], completed()],
  ]) {
    const { api, calls } = await setupWrite(json({ data }));
    await assert.rejects(() => api.submit(ID, answers), errorIs('INVALID_RESPONSE', 200));
    assert.equal(calls.length, 1);
  }
});

test('Submit принимает одинаковые наборы независимо от регистра/порядка и формы пропуска', async () => {
  const data = completed(correctAnswers(3));
  const answers = correctAnswers(3).reverse().map((answer) => ({
    questionId: answer.questionId.toUpperCase(), optionId: answer.optionId.toUpperCase(),
  }));
  answers.push({ questionId: data.questions[3].id });
  const { api, calls } = await setupWrite(json({ data }), json({ data }));
  assert.deepEqual(await api.submit(ID, answers), data);
  assert.deepEqual(await api.submit(ID, correctAnswers(3)), data);
  assert.equal(calls.length, 2);
});

test('Неожиданный успешный статус, HTML и неверная оболочка отклоняются без jobs/повторов', async () => {
  for (const method of ['start', 'submit', 'getById']) {
    const status = method === 'start' ? 201 : 200;
    const fixture = method === 'submit' ? completed() : attempt();
    for (const response of [
      json({ data: fixture }, method === 'start' ? 200 : 201),
      json({ data: fixture }, 202), new Response(null, { status: 204 }),
      new Response('<html>Ошибка</html>', { status }), json({ result: fixture }, status),
      json({ data: { jobId: OTHER_ID } }, status),
    ]) {
      const { api, calls } = method === 'getById' ? setup(response) : await setupWrite(response);
      await assert.rejects(() => invoke(api, method), errorIs('INVALID_RESPONSE'));
      assert.equal(calls.length, 1);
    }
  }
});

test('HTTP ошибки сохраняют code/status/fieldErrors/Retry-After без автоматических действий', async () => {
  for (const [status, code] of [
    [400, 'INVALID_REQUEST'], [400, 'MALFORMED_JSON'], [401, 'AUTHENTICATION_REQUIRED'],
    [403, 'CSRF_INVALID'], [404, 'QUIZ_NOT_FOUND'], [404, 'ATTEMPT_NOT_FOUND'],
    [409, 'MATERIAL_NOT_AVAILABLE'], [409, 'IDEMPOTENCY_KEY_REUSED'], [409, 'ATTEMPT_ALREADY_SUBMITTED'],
    [422, 'VALIDATION_FAILED'], [429, 'RATE_LIMITED'], [503, 'SERVICE_UNAVAILABLE'],
  ]) {
    for (const method of ['start', 'submit', 'getById']) {
      const fieldErrors = status === 422 ? { 'answers[0].optionId': 'Неверный UUID.' } : {};
      const response = json({ error: { code, message: 'Ошибка запроса.', fieldErrors } }, status, { 'Retry-After': '2' });
      const { api, calls } = method === 'getById' ? setup(response) : await setupWrite(response);
      await assert.rejects(() => invoke(api, method), (error) => {
        errorIs(code, status)(error);
        assert.deepEqual(error.fieldErrors, fieldErrors);
        assert.equal(error.retryAfterSeconds, 2);
        return true;
      });
      assert.equal(calls.length, 1);
    }
  }
});

test('Оба POST требуют CSRF, адаптер не читает токен автоматически', async () => {
  for (const method of ['start', 'submit']) {
    const { api, calls } = setup();
    await assert.rejects(() => invoke(api, method), errorIs('CSRF_NOT_INITIALIZED'));
    assert.equal(calls.length, 0);
  }
});

test('Потеря ответа не запускает повтор; явный повтор сохраняет ключ начала или ответы сдачи', async () => {
  for (const method of ['start', 'submit', 'getById']) {
    const data = method === 'submit' ? completed() : attempt();
    const responses = [() => { throw new TypeError('Обрыв'); }, json({ data }, method === 'start' ? 201 : 200)];
    const { api, calls } = method === 'getById' ? setup(...responses) : await setupWrite(...responses);
    await assert.rejects(() => invoke(api, method), errorIs('NETWORK_ERROR'));
    assert.equal(calls.length, 1);
    assert.deepEqual(await invoke(api, method), data);
    assert.equal(calls.length, 2);
    if (method === 'start') assert.deepEqual(calls.map(({ options }) => options.headers.get('Idempotency-Key')), [KEY, KEY]);
    if (method === 'submit') assert.deepEqual(calls.map(({ options }) => JSON.parse(options.body)), [{ answers: [] }, { answers: [] }]);
  }
});

test('Abort до запроса исключает сеть, abort текущего запроса останавливает ожидание', async () => {
  for (const method of ['start', 'submit', 'getById']) {
    for (const preAbort of [false, true]) {
      const controller = new AbortController();
      const response = (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Отмена', 'AbortError')), { once: true });
      });
      const { api, calls } = method === 'getById' ? setup(response) : await setupWrite(response);
      if (preAbort) controller.abort();
      const pending = invoke(api, method, { signal: controller.signal });
      if (!preAbort) controller.abort();
      await assert.rejects(pending, errorIs('REQUEST_CANCELLED'));
      assert.equal(calls.length, preAbort ? 0 : 1);
    }
  }
});

function info(changes = {}) {
  const { questions, review, ...value } = attempt(changes);
  return value;
}

function history(data = [info()], meta = {}) {
  return { data, meta: { page: 1, pageSize: 20, total: data.length, ...meta } };
}

test('История: GET /attempts с defaults, cookie/signal без CSRF, ключа, тела и других запросов', async () => {
  const payload = history();
  const { api, calls } = setup(json(payload));
  const controller = new AbortController();
  assert.deepEqual(await api.list({ signal: controller.signal }), { attempts: payload.data, meta: payload.meta });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/attempts?page=1&pageSize=20');
  const options = calls[0].options;
  assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'include');
  assert.equal(options.mode, 'same-origin');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.signal, controller.signal);
  assert.equal(options.body, undefined);
  assert.equal(options.headers.has('X-CSRF-TOKEN'), false);
  assert.equal(options.headers.has('Idempotency-Key'), false);
  assert.equal(options.headers.has('Content-Type'), false);
});

test('История: фильтры объединяются, UUID case-insensitive; undefined не попадает в query', async () => {
  const payload = history([info(completed())], { page: 2, pageSize: 1, total: 2 });
  const state = setup(json(payload));
  assert.deepEqual(await state.api.list({ page: 2, pageSize: 1,
    materialId: MATERIAL_ID.toUpperCase(), quizId: QUIZ_ID.toUpperCase(), status: 'completed',
    idempotencyKey: KEY, scorePercent: 100,
  }), { attempts: payload.data, meta: payload.meta });
  assert.equal(state.calls[0].url, '/api/v1/attempts?page=2&pageSize=1&materialId=' + MATERIAL_ID.toUpperCase()
    + '&quizId=' + QUIZ_ID.toUpperCase() + '&status=completed');
  const requests = [];
  const api = createAttemptApi({ request: async (path, options) => {
    requests.push({ path, options });
    return { status: 200, ...history([]) };
  } });
  await api.list({ materialId: undefined, quizId: undefined, status: undefined });
  assert.deepEqual(requests[0].options.query, { page: 1, pageSize: 20 });
  assert.equal(requests[0].path, '/attempts');
});

test('История: пустой ответ допустим при любых валидных фильтрах, не превращается в 404', async () => {
  for (const options of [undefined, {}, { materialId: OTHER_ID }, { quizId: OTHER_ID },
    { materialId: MATERIAL_ID, quizId: OTHER_ID, status: 'in_progress' }, { status: 'completed' }]) {
    const { api, calls } = setup(json(history([])));
    assert.deepEqual(await api.list(options), { attempts: [], meta: { page: 1, pageSize: 20, total: 0 } });
    assert.equal(calls.length, 1);
  }
});

test('История: только 10 публичных полей AttemptInfo и page/pageSize/total, без questions/review/ключей', async () => {
  const publicInfo = info(completed(correctAnswers(3)));
  const wire = { status: 200, ...history([{ ...completed(correctAnswers(3)), ownerId: OTHER_ID,
    operationKey: KEY, answers: correctAnswers(3), correctOptionId: OTHER_ID, secret: 'private' }], { ownerId: OTHER_ID }) };
  const api = createAttemptApi({ request: async () => wire });
  const result = await api.list();
  assert.deepEqual(result, { attempts: [publicInfo], meta: { page: 1, pageSize: 20, total: 1 } });
  assert.equal(Object.keys(result.attempts[0]).length, 10);
  result.attempts[0].scorePercent = 0;
  result.attempts.pop();
  result.meta.total = 0;
  assert.equal(wire.data.length, 1);
  assert.equal(wire.data[0].scorePercent, 30);
  assert.equal(wire.meta.total, 1);
});

test('История: in_progress сохраняет null, completed допускает все баллы 0..100 и равные даты', async () => {
  for (const data of [info(), info({ quizVersion: Number.MAX_SAFE_INTEGER }),
    ...Array.from({ length: 11 }, (_, count) => info(completed(correctAnswers(count), { completedAt: STARTED })))]) {
    const { api } = setup(json(history([data])));
    assert.deepEqual((await api.list()).attempts, [data]);
  }
});

test('История: startedAt DESC с точностью наносекунд, затем UUID DESC без зависимости от регистра', async () => {
  for (const data of [
    [info({ id: ID, startedAt: '2026-10-03T10:00:00.000000002Z' }),
      info({ id: OTHER_ID, startedAt: '2026-10-03T10:00:00.000000001Z' })],
    [info({ id: OTHER_ID.toUpperCase(), startedAt: '2026-10-03T10:00:00.1Z' }),
      info({ id: ID, startedAt: '2026-10-03T10:00:00.100000000Z' })],
    [info({ id: OTHER_ID, startedAt: '2026-10-03T10:00:00Z' }),
      info({ id: ID.toUpperCase(), startedAt: '2026-10-03T10:00:00.000Z' })],
  ]) {
    const { api } = setup(json(history(data)));
    assert.deepEqual((await api.list()).attempts, data);
  }
});

test('История: неверный порядок по дате/наносекундам/UUID и повтор ID отклоняются', async () => {
  for (const data of [
    [info({ id: ID, startedAt: '2026-10-03T10:00:00.000000001Z' }),
      info({ id: OTHER_ID, startedAt: '2026-10-03T10:00:00.000000002Z' })],
    [info({ id: ID, startedAt: '2026-10-03T10:00:00Z' }),
      info({ id: OTHER_ID, startedAt: '2026-10-03T10:00:01Z' })],
    [info({ id: ID.toUpperCase() }), info({ id: OTHER_ID })],
    [info({ id: ID }), info({ id: ID.toUpperCase(), startedAt: '2026-10-03T09:00:00Z' })],
    [info({ id: ID, startedAt: '2026-10-03T10:00:00.000Z' }),
      info({ id: OTHER_ID, startedAt: '2026-10-03T10:00:00Z' })],
  ]) {
    const { api, calls } = setup(json(history(data)));
    await assert.rejects(() => api.list(), errorIs('INVALID_RESPONSE', 200));
    assert.equal(calls.length, 1);
  }
});

test('История: пагинация допускает неполную/пустую последнюю страницу и безопасна на MAX_SAFE_INTEGER', async () => {
  const lastPage = Math.ceil(Number.MAX_SAFE_INTEGER / 100);
  const lastRows = Array.from({ length: 91 }, (_, index) => info({
    id: String(91 - index).padStart(8, '0') + '-0000-4000-8000-000000000000',
  }));
  for (const payload of [
    history([info()], { page: 2, pageSize: 2, total: 3 }),
    history([], { page: 3, pageSize: 2, total: 3 }),
    history([], { page: 1, pageSize: 100, total: 0 }),
    history([], { page: Number.MAX_SAFE_INTEGER, pageSize: 100, total: Number.MAX_SAFE_INTEGER }),
    history([info()], { page: Number.MAX_SAFE_INTEGER, pageSize: 1, total: Number.MAX_SAFE_INTEGER }),
    history(lastRows, { page: lastPage, pageSize: 100, total: Number.MAX_SAFE_INTEGER }),
    history([], { page: lastPage + 1, pageSize: 100, total: Number.MAX_SAFE_INTEGER }),
  ]) {
    const { api } = setup(json(payload));
    assert.deepEqual(await api.list({ page: payload.meta.page, pageSize: payload.meta.pageSize }),
      { attempts: payload.data, meta: payload.meta });
  }
});

test('История: пустые/неверные filters и недопустимая пагинация отклоняются до HTTP', async () => {
  const { api, calls } = setup();
  for (const value of ['', null, {}, [], 1, MATERIAL_ID + '?extra=1', '../auth/me']) {
    await assert.rejects(() => api.list({ materialId: value }), TypeError);
    await assert.rejects(() => api.list({ quizId: value }), TypeError);
  }
  for (const value of ['', null, 'ready', 'COMPLETED', 'constructor', [], {}, 1]) {
    await assert.rejects(() => api.list({ status: value }), TypeError);
  }
  for (const value of ['', null, '1', 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => api.list({ page: value }), RangeError);
    await assert.rejects(() => api.list({ pageSize: value }), RangeError);
  }
  await assert.rejects(() => api.list({ pageSize: 101 }), RangeError);
  assert.equal(calls.length, 0);
});

test('История: каждое поле AttemptInfo обязательно, включая nullable score/time', async () => {
  for (const fixture of [info(), info(completed())]) {
    for (const field of Object.keys(fixture)) {
      const data = { ...fixture };
      delete data[field];
      const { api } = setup(json(history([data])));
      await assert.rejects(() => api.list(), errorIs('INVALID_RESPONSE', 200), field);
    }
  }
});

test('История: malformed Info и несогласованные status/score/server time отклоняются', async () => {
  for (const data of [null, [],
    info({ id: null }), info({ quizId: 'bad' }), info({ materialId: 'bad' }),
    info({ quizVersion: 0 }), info({ quizVersion: 1.5 }), info({ quizVersion: '1' }),
    info({ quizVersion: Number.MAX_SAFE_INTEGER + 1 }), info({ questionCount: 0 }), info({ questionCount: '10' }),
    info({ status: 'queued' }), info({ status: null }), info({ startedAt: null }),
    info({ startedAt: '2026-02-30T10:00:00Z' }), info({ startedAt: '2026-10-03T24:00:00Z' }),
    info({ startedAt: '2026-10-03T10:00:00+00:00' }), info({ completedAt: FINISHED }),
    info({ correctCount: 0 }), info({ scorePercent: 0 }),
    info(completed([], { completedAt: null })), info(completed([], { correctCount: null })),
    info(completed([], { scorePercent: null })), info(completed([], { correctCount: '0' })),
    info(completed([], { correctCount: -1 })), info(completed([], { correctCount: 11 })),
    info(completed([], { correctCount: 0.5 })), info(completed([], { scorePercent: '0' })),
    info(completed([], { scorePercent: 0.01 })), info(completed([], { scorePercent: 101 })),
    info(completed(correctAnswers(1), { scorePercent: 9.99 })),
    info(completed([], { completedAt: '2026-10-03T10:00:00.123456788Z' })),
  ]) {
    const { api } = setup(json(history([data])));
    await assert.rejects(() => api.list(), errorIs('INVALID_RESPONSE', 200));
  }
});

test('История: response обязан соответствовать каждому заданному фильтру', async () => {
  for (const filters of [{ materialId: OTHER_ID }, { quizId: OTHER_ID }, { status: 'completed' },
    { materialId: MATERIAL_ID, quizId: OTHER_ID, status: 'in_progress' }]) {
    const { api } = setup(json(history()));
    await assert.rejects(() => api.list(filters), errorIs('INVALID_RESPONSE', 200));
  }
});

test('История: meta должен совпадать с запросом и точным размером страницы', async () => {
  for (const payload of [
    { data: null, meta: history().meta }, { data: {}, meta: history().meta }, { data: [], meta: null },
    history([info()], { page: 2 }), history([info()], { page: '1' }), history([info()], { pageSize: 1 }),
    history([info()], { total: -1 }), history([info()], { total: '1' }), history([info()], { total: 0 }),
    history([info()], { total: 1.5 }), history([info()], { total: Number.MAX_SAFE_INTEGER + 1 }),
    history([info()], { total: 2 }), history([], { total: 1 }),
  ]) {
    const { api } = setup(json(payload));
    await assert.rejects(() => api.list(), errorIs('INVALID_RESPONSE', 200));
  }
  for (const field of ['page', 'pageSize', 'total']) {
    const payload = history();
    delete payload.meta[field];
    const { api } = setup(json(payload));
    await assert.rejects(() => api.list(), errorIs('INVALID_RESPONSE', 200));
  }
  const { api } = setup(json(history([info()], { page: 3, pageSize: 1, total: 1 })));
  await assert.rejects(() => api.list({ page: 3, pageSize: 1 }), errorIs('INVALID_RESPONSE', 200));
});

test('История: HTML, неверная оболочка или неожиданный успешный HTTP статус отклоняются', async () => {
  for (const response of [
    new Response('<html>Ошибка</html>', { status: 200 }), json({ result: history() }),
    json(history(), 201), json(history(), 202), new Response(null, { status: 204 }),
  ]) {
    const { api, calls } = setup(response);
    await assert.rejects(() => api.list(), errorIs('INVALID_RESPONSE'));
    assert.equal(calls.length, 1);
  }
});

test('История: HTTP ошибки/Retry-After сохраняются без автоматического повторного чтения', async () => {
  for (const [status, code] of [[400, 'INVALID_QUERY'], [401, 'AUTHENTICATION_REQUIRED'],
    [403, 'CSRF_INVALID'], [429, 'RATE_LIMITED'], [503, 'SERVICE_UNAVAILABLE']]) {
    const { api, calls } = setup(json({ error: { code, message: 'Ошибка', fieldErrors: {} } },
      status, { 'Retry-After': '3' }));
    await assert.rejects(() => api.list(), (error) => {
      errorIs(code, status)(error);
      assert.equal(error.retryAfterSeconds, 3);
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, 'GET');
  }
});

test('История: сеть не вызывает повтор; отменённый до/во время GET запрос не продолжает чтение', async () => {
  const network = setup(() => { throw new TypeError('Обрыв'); });
  await assert.rejects(() => network.api.list(), errorIs('NETWORK_ERROR'));
  assert.equal(network.calls.length, 1);
  for (const preAbort of [false, true]) {
    const controller = new AbortController();
    const { api, calls } = setup((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Отмена', 'AbortError')), { once: true });
    }));
    if (preAbort) controller.abort();
    const pending = api.list({ signal: controller.signal });
    if (!preAbort) controller.abort();
    await assert.rejects(pending, errorIs('REQUEST_CANCELLED'));
    assert.equal(calls.length, preAbort ? 0 : 1);
  }
});
