import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/services/apiClient.js';
import { createJobWatcher } from '../src/services/jobWatcher.js';
import { createMaterialQuizController, getMaterialQuizState } from '../src/services/materialQuizController.js';

const uuid = (number) => number.toString(16).padStart(8, '0') + '-1111-4111-8111-111111111111';
const ID = uuid(1);
const SUBJECT = uuid(2);
const OTHER = uuid(3);
const JOB = uuid(4);
const OLD_JOB = uuid(5);
const NEXT_JOB = uuid(6);
const KEY = uuid(7);
const KEY2 = uuid(8);
const quizId = (version) => uuid(100 + version);
const material = (changes = {}) => ({ id: ID, subjectId: SUBJECT, status: 'stored', processingStatus: 'ready', title: 'Лекция', ...changes });
const failure = (code, status = 0, extra = {}) => new ApiError('Сырые сведения сервера', { code, status, ...extra });
const gen = (status = 'not_started', jobId = status === 'not_started' ? null : OLD_JOB) => ({
  status, jobId, error: status === 'failed' ? { code: 'QUIZ_INSUFFICIENT_CONTENT', message: 'Сырые сведения ИИ' } : null,
});
const expected = (generation) => ({ status: generation.status, jobId: generation.jobId });
const info = (version, changes = {}) => ({
  id: quizId(version), materialId: ID, version, questionCount: 10,
  model: 'fake-local', createdAt: '2026-10-03T00:00:00Z', ...changes,
});
const quiz = (version = 1, changes = {}) => ({
  ...info(version),
  questions: Array.from({ length: 10 }, (_, index) => ({
    id: uuid(1000 + version * 100 + index), position: index + 1, text: 'Вопрос ' + (index + 1),
    options: Array.from({ length: 4 }, (_, option) => ({
      id: uuid(10000 + version * 100 + index * 4 + option), position: option + 1, text: 'Вариант ' + (option + 1),
    })),
  })),
  ...changes,
});
const list = (total = 0, generation = gen(), page = 1) => ({
  quizzes: Array.from({ length: total }, (_, index) => info(total - index)).slice((page - 1) * 20, page * 20),
  meta: { page, pageSize: 20, total, generation },
});
const job = (status = 'running', changes = {}) => ({
  id: JOB, type: 'material.quiz', status,
  resultId: status === 'succeeded' ? quizId(1) : null,
  error: status === 'failed' ? { code: 'AI_OUTCOME_UNKNOWN', message: 'Сырые сведения worker' } : null,
  ...changes,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function setup({ record = {}, materialReads = [], listReads = [], details = [], generations = [], watch, onMaterialRead, makeKey } = {}) {
  let allowed = true;
  let timestamp = 1000;
  let currentMaterial = material();
  let total = 0;
  let generation = gen();
  let keys = 0;
  const calls = [];
  const states = [];
  const watches = [];
  const access = [];
  const materialsSeen = [];
  async function respond(queue, fallback) {
    const result = queue.length ? queue.shift() : fallback;
    if (result instanceof Error) throw result;
    return await result;
  }
  const controller = createMaterialQuizController({
    record, materialId: ID, subjectId: SUBJECT,
    canAct: () => allowed,
    onChange: (value) => states.push(value),
    onAccessError: (error) => access.push(error),
    onMaterialRead: (value) => { materialsSeen.push(value); onMaterialRead?.(value); },
    now: () => timestamp,
    makeKey: () => { keys += 1; return makeKey ? makeKey() : KEY; },
    materials: {
      async getById(id, options) {
        calls.push({ kind: 'material', id, ...options });
        return await respond(materialReads, currentMaterial);
      },
    },
    api: {
      async list(id, options) {
        calls.push({ kind: 'list', id, ...options });
        return await respond(listReads, list(total, generation, options.page));
      },
      async generate(id, options) {
        calls.push({ kind: 'generate', id, ...options });
        const value = await respond(generations, { materialId: ID, jobId: JOB });
        generation = gen('queued', value?.jobId ?? JOB);
        return value;
      },
      async getById(id, options) {
        calls.push({ kind: 'detail', id, ...options });
        return await respond(details, quiz(parseInt(id.slice(0, 8), 16) - 100));
      },
    },
    watch: watch ?? ((id, handlers) => {
      const value = { id, handlers, stopped: false };
      watches.push(value);
      return () => { value.stopped = true; };
    }),
  });
  return {
    controller, record, calls, states, watches, access, materialsSeen,
    get state() { return getMaterialQuizState(record, ID); },
    get posts() { return calls.filter((call) => call.kind === 'generate'); },
    get lists() { return calls.filter((call) => call.kind === 'list'); },
    get detailCalls() { return calls.filter((call) => call.kind === 'detail'); },
    get keyCount() { return keys; },
    deny() { allowed = false; },
    setNow(value) { timestamp = value; },
    setMaterial(value) { currentMaterial = value; },
    setCatalog(count, value = generation) { total = count; generation = value; },
    update(value, index = watches.length - 1) { watches[index].handlers.onUpdate(value); },
    failWatch(value, index = watches.length - 1) { watches[index].handlers.onError(value); },
  };
}

test('Создание/refresh не генерируют; явный POST требует fresh stored+ready и подтверждённую generation', async () => {
  const s = setup();
  await s.controller.generate(expected(gen()));
  assert.equal(s.calls.length, 0);
  await s.controller.refresh();
  assert.equal(s.state.phase, 'ready');
  assert.equal(s.state.canGenerate, true);
  assert.equal(s.state.listStale, false);
  await s.controller.generate();
  assert.equal(s.posts.length, 0);
  await s.controller.generate(expected(s.state.generation));
  assert.deepEqual(s.calls.map((value) => value.kind), ['material', 'list', 'material', 'list', 'generate', 'list']);
  assert.equal(s.posts[0].idempotencyKey, KEY);
  assert.deepEqual(Object.keys(s.posts[0]).sort(), ['id', 'idempotencyKey', 'kind', 'signal']);
  assert.equal(s.state.watching, true);
  assert.equal(s.watches[0].id, JOB);
});

test('Очередь/обработка и неподготовленный текст не разрешают платный вызов', async () => {
  for (const status of ['queued', 'running']) {
    const s = setup({ listReads: [list(1, gen(status))] });
    await s.controller.refresh();
    assert.equal(s.state.canGenerate, false);
    assert.equal(s.state.watching, true);
    await s.controller.generate(expected(s.state.generation));
    assert.equal(s.posts.length, 0);
  }
  const s = setup({ materialReads: [material({ processingStatus: 'running' })] });
  await s.controller.refresh();
  assert.equal(s.state.canGenerate, false);
  await s.controller.generate(expected(gen()));
  assert.equal(s.posts.length, 0);
});

test('Все terminal состояния разрешают новую явную попытку, старые версии сохраняются', async () => {
  for (const status of ['ready', 'failed', 'cancelled']) {
    const s = setup();
    s.setCatalog(2, gen(status));
    await s.controller.refresh();
    await s.controller.openQuiz(quizId(1));
    await s.controller.generate(expected(s.state.generation));
    assert.equal(s.posts.length, 1);
    assert.equal(s.state.quizzes.length, 2);
    assert.equal(s.state.quiz.id, quizId(1));
    assert.equal(s.state.quizStatus, 'ready');
    assert.equal(s.state.canGenerate, false);
  }
});

test('Double click синхронно блокируется до preflight и во время POST', async () => {
  const preflight = deferred();
  const post = deferred();
  const s = setup({ materialReads: [material(), preflight.promise], generations: [post.promise] });
  await s.controller.refresh();
  const confirmation = expected(s.state.generation);
  const generating = s.controller.generate(confirmation);
  await s.controller.generate(confirmation);
  await s.controller.refresh();
  assert.equal(s.calls.length, 3);
  preflight.resolve(material());
  await tick();
  await s.controller.generate(confirmation);
  assert.equal(s.posts.length, 1);
  post.resolve({ materialId: ID, jobId: JOB });
  await generating;
  assert.equal(s.keyCount, 1);
});

test('Смена generation или состояния материала после подтверждения отменяет POST', async () => {
  for (const changed of [gen('queued'), gen('ready'), gen('failed')]) {
    const s = setup();
    await s.controller.refresh();
    const confirmation = expected(s.state.generation);
    s.setCatalog(1, changed);
    await s.controller.generate(confirmation);
    assert.equal(s.posts.length, 0);
    assert.equal(s.keyCount, 0);
    assert.equal(s.state.generation.status, changed.status);
  }
  for (const changes of [{ subjectId: OTHER }, { status: 'deleting' }, { processingStatus: 'running' }]) {
    const s = setup();
    await s.controller.refresh();
    s.setMaterial(material(changes));
    await s.controller.generate(expected(gen()));
    assert.equal(s.posts.length, 0);
  }
});

test('Неизвестный исход и AI503 сохраняют ключ; refresh ничего не отправляет', async () => {
  for (const error of [failure('NETWORK_ERROR'), failure('INTERNAL_ERROR', 500), failure('INVALID_RESPONSE', 200), failure('AI_UNAVAILABLE', 503)]) {
    const s = setup({ generations: [error] });
    await s.controller.refresh();
    await s.controller.generate(expected(gen()));
    assert.equal(s.state.canRetry, true);
    assert.equal(s.state.uncertain, error.code !== 'AI_UNAVAILABLE');
    await s.controller.refresh();
    assert.equal(s.posts.length, 1);
    await s.controller.generate(expected(s.state.generation));
    assert.equal(s.posts[1].idempotencyKey, KEY);
    assert.equal(s.keyCount, 1);
  }
});

test('Unknown со старым terminal после закрытия сохраняет retry прежней операции', async () => {
  const record = {};
  const first = setup({ record, generations: [failure('NETWORK_ERROR')] });
  first.setCatalog(1, gen('ready'));
  await first.controller.refresh();
  await first.controller.generate(expected(first.state.generation));
  first.controller.stop();
  const restored = setup({ record });
  restored.setCatalog(1, gen('ready'));
  await restored.controller.refresh();
  assert.equal(restored.state.canRetry, true);
  assert.equal(restored.state.canGenerate, false);
  assert.equal(restored.posts.length, 0);
  await restored.controller.generate(expected(restored.state.generation));
  assert.equal(restored.posts[0].idempotencyKey, KEY);
  assert.equal(restored.keyCount, 0);
});

test('Новая generation после потерянного ответа наблюдается без повторного POST', async () => {
  const s = setup({ generations: [failure('NETWORK_ERROR')] });
  await s.controller.refresh();
  await s.controller.generate(expected(gen()));
  s.setCatalog(0, gen('queued', JOB));
  await s.controller.refresh();
  assert.equal(s.state.canRetry, false);
  assert.equal(s.state.uncertain, false);
  assert.equal(s.watches[0].id, JOB);
  assert.equal(s.posts.length, 1);
});

test('Accepted202 со старым ready наблюдает возвращённый job, не разрешая новый ключ', async () => {
  const old = list(1, gen('ready'));
  const s = setup({ listReads: [old, old, old] });
  await s.controller.refresh();
  await s.controller.generate(expected(s.state.generation));
  assert.equal(s.watches[0].id, JOB);
  assert.equal(s.state.canGenerate, false);
  assert.equal(s.state.canRetry, false);
  await s.controller.generate(expected(s.state.generation));
  assert.equal(s.posts.length, 1);
});

test('succeeded проверяет quizId результата, потом список, и автоматически открывает точную версию', async () => {
  const s = setup();
  await s.controller.refresh();
  await s.controller.generate(expected(gen()));
  s.setCatalog(2, gen('ready', JOB));
  s.update(job('succeeded', { resultId: quizId(1) }));
  await tick();
  const last = s.calls.slice(-2);
  assert.deepEqual(last.map((value) => value.kind), ['detail', 'list']);
  assert.equal(last[0].id, quizId(1));
  assert.notEqual(last[0].id, ID);
  assert.equal(s.state.quiz.id, quizId(1));
  assert.equal(s.state.generatedQuizId, quizId(1));
  assert.equal(s.state.quizzes[0].id, quizId(2));
  assert.equal(s.state.canGenerate, true);
  assert.equal(s.watches[0].stopped, true);
  assert.equal(last[0].signal.aborted, false);
});

test('Текущая страница и выбранная старая версия сохраняются после нового результата', async () => {
  const s = setup();
  s.setCatalog(21, gen('ready'));
  await s.controller.refresh();
  await s.controller.changePage(2);
  await s.controller.openQuiz(quizId(1));
  await s.controller.generate(expected(s.state.generation));
  s.setCatalog(22, gen('ready', JOB));
  s.update(job('succeeded', { resultId: quizId(22) }));
  await tick();
  assert.equal(s.state.meta.page, 2);
  assert.equal(s.lists.at(-1).page, 2);
  assert.equal(s.state.quiz.id, quizId(1));
  assert.equal(s.state.selectedQuizId, quizId(1));
  assert.equal(s.state.generatedQuizId, quizId(22));
  await s.controller.openQuiz(s.state.generatedQuizId);
  assert.equal(s.state.quiz.id, quizId(22));
});

test('Настоящий watcher terminal отменяет свой сигнал, GET результата использует независимый', async () => {
  let signal;
  const watch = createJobWatcher({ async getById(id, options) { signal = options.signal; return job('succeeded'); } });
  const s = setup({ listReads: [list(0, gen('queued', JOB)), list(1, gen('ready', JOB))], watch });
  await s.controller.refresh();
  await tick();
  assert.equal(signal.aborted, true);
  assert.equal(s.detailCalls[0].signal.aborted, false);
  assert.notEqual(signal, s.detailCalls[0].signal);
  assert.equal(s.state.quiz.id, quizId(1));
});

test('Чужой материал результата не раскрывается и не завершает попытку; refresh повторяет точный GET', async () => {
  const s = setup({ details: [quiz(1, { materialId: OTHER }), quiz(1)] });
  await s.controller.refresh();
  await s.controller.generate(expected(gen()));
  s.setCatalog(1, gen('ready', JOB));
  s.update(job('succeeded'));
  await tick();
  assert.equal(s.state.quiz, null);
  assert.equal(s.state.generatedQuizId, null);
  assert.equal(s.state.canGenerate, false);
  assert.ok(s.state.watchError);
  await s.controller.refresh();
  assert.deepEqual(s.detailCalls.map((value) => value.id), [quizId(1), quizId(1)]);
  assert.equal(s.state.generatedQuizId, quizId(1));
  assert.equal(s.state.canGenerate, true);
  assert.equal(s.posts.length, 1);
});

test('Ошибка GET результата сохраняет прежние вопросы и не сообщает об успехе без проверки', async () => {
  for (const error of [failure('QUIZ_NOT_FOUND', 404), failure('SERVICE_UNAVAILABLE', 503)]) {
    const s = setup({ details: [quiz(1), error, quiz(2)] });
    s.setCatalog(1, gen('ready'));
    await s.controller.refresh();
    await s.controller.openQuiz(quizId(1));
    await s.controller.generate(expected(s.state.generation));
    s.setCatalog(2, gen('ready', JOB));
    s.update(job('succeeded', { resultId: quizId(2) }));
    await tick();
    assert.equal(s.state.quiz.id, quizId(1));
    assert.equal(s.state.quizzes.length, 1);
    assert.equal(s.state.listStale, true);
    assert.equal(s.state.generatedQuizId, null);
    assert.equal(s.state.canGenerate, false);
    await s.controller.refresh();
    assert.equal(s.state.generatedQuizId, quizId(2));
    assert.equal(s.state.quiz.id, quizId(1));
  }
});

test('Старый generation после terminal не создаёт бесконечный опрос', async () => {
  const old = list(1, gen('ready'));
  const s = setup({ listReads: [old, old, old, old, list(2, gen('ready', JOB))] });
  await s.controller.refresh();
  await s.controller.generate(expected(s.state.generation));
  s.update(job('succeeded', { resultId: quizId(2) }));
  await tick();
  assert.equal(s.state.canGenerate, false);
  assert.equal(s.state.watchError, 'STATUS_NOT_CONFIRMED');
  assert.equal(s.watches.length, 1);
  assert.equal(s.state.watching, false);
  await s.controller.refresh();
  assert.equal(s.state.canGenerate, true);
  assert.equal(s.detailCalls.length, 1);
});

test('failed/cancelled сохраняют версии и разрешают новый ключ только после свежего list', async () => {
  for (const status of ['failed', 'cancelled']) {
    const keys = [KEY, KEY2];
    const s = setup({ makeKey: () => keys.shift(), generations: [{ materialId: ID, jobId: JOB }, { materialId: ID, jobId: NEXT_JOB }] });
    s.setCatalog(1, gen('ready'));
    await s.controller.refresh();
    await s.controller.generate(expected(s.state.generation));
    s.setCatalog(1, gen(status, JOB));
    s.update(job(status));
    await tick();
    assert.equal(s.state.quizzes.length, 1);
    assert.equal(s.state.canGenerate, true);
    assert.doesNotMatch(s.state.message + (s.state.generation.error?.message ?? ''), /Сырые/);
    await s.controller.generate(expected(s.state.generation));
    assert.equal(s.posts[1].idempotencyKey, KEY2);
  }
});

test('Пагинация из21версии и восстановление page/selection не делает POST', async () => {
  const record = {};
  const first = setup({ record });
  first.setCatalog(21, gen('ready'));
  await first.controller.refresh();
  assert.equal(first.state.quizzes.length, 20);
  await first.controller.changePage(2);
  assert.deepEqual(first.state.quizzes.map((value) => value.version), [1]);
  await first.controller.openQuiz(quizId(1));
  first.controller.stop();
  assert.equal(first.state.quiz, null);
  assert.deepEqual(first.state.quizzes, []);
  const second = setup({ record });
  second.setCatalog(21, gen('ready'));
  await second.controller.openQuiz(quizId(1));
  assert.equal(second.calls.length, 0);
  await second.controller.refresh();
  await tick();
  assert.equal(second.lists[0].page, 2);
  assert.equal(second.state.quiz.id, quizId(1));
  assert.equal(second.posts.length, 0);
});

test('Страница за концом корректируется один раз; ошибочный refresh не подменяет список пустым', async () => {
  const s = setup();
  s.setCatalog(21, gen('ready'));
  await s.controller.refresh();
  await s.controller.changePage(99);
  assert.deepEqual(s.lists.slice(-2).map((value) => value.page), [99, 2]);
  assert.equal(s.state.meta.page, 2);
  const failed = setup({ listReads: [list(21, gen('ready')), failure('NETWORK_ERROR')] });
  await failed.controller.refresh();
  const rows = failed.state.quizzes;
  await failed.controller.changePage(2);
  assert.deepEqual(failed.state.quizzes, rows);
  assert.equal(failed.state.meta.page, 1);
  assert.equal(failed.state.listStale, true);
  assert.equal(failed.state.canGenerate, false);
});

test('Выбор другого теста отменяет старый detail GET; close не останавливает job', async () => {
  const old = deferred();
  const s = setup({ details: [old.promise, quiz(2)] });
  s.setCatalog(2, gen('queued', JOB));
  await s.controller.refresh();
  const opening = s.controller.openQuiz(quizId(1));
  await s.controller.openQuiz(quizId(2));
  assert.equal(s.detailCalls[0].signal.aborted, true);
  old.resolve(quiz(1));
  await opening;
  assert.equal(s.state.quiz.id, quizId(2));
  s.controller.closeQuiz();
  assert.equal(s.state.quiz, null);
  assert.equal(s.state.selectedQuizId, null);
  assert.equal(s.watches[0].stopped, false);
  assert.equal(s.state.watching, true);
});

test('Detail404/чужой quiz не раскрывает данные; ограничение detail Retry-After независимо от list', async () => {
  for (const response of [quiz(1, { materialId: OTHER }), quiz(2), failure('QUIZ_NOT_FOUND', 404)]) {
    const s = setup({ details: [response] });
    await s.controller.refresh();
    await s.controller.openQuiz(quizId(1));
    assert.equal(s.state.quiz, null);
    assert.ok(['error', 'unavailable'].includes(s.state.quizStatus));
  }
  const s = setup({ details: [failure('RATE_LIMITED', 429, { retryAfterSeconds: 2 })] });
  await s.controller.refresh();
  await s.controller.openQuiz(quizId(1));
  assert.equal(s.state.quizRetryAt, 3000);
  await s.controller.openQuiz(quizId(1));
  assert.equal(s.detailCalls.length, 1);
  await s.controller.refresh();
  assert.equal(s.lists.length, 2);
  s.setNow(3000);
  assert.equal(s.detailCalls.length, 1);
  await s.controller.openQuiz(quizId(1));
  assert.equal(s.state.quizStatus, 'ready');
});

test('Повторное открытие immutable quiz сохраняет вопросы при сети, но очищает при подтверждённом 404', async () => {
  const s = setup({ details: [quiz(1), failure('NETWORK_ERROR'), failure('QUIZ_NOT_FOUND', 404)] });
  s.setCatalog(1, gen('ready'));
  await s.controller.refresh();
  await s.controller.openQuiz(quizId(1));
  await s.controller.openQuiz(quizId(1));
  assert.equal(s.state.quiz.id, quizId(1));
  assert.equal(s.state.quizStatus, 'error');
  await s.controller.openQuiz(quizId(1));
  assert.equal(s.state.quiz, null);
  assert.equal(s.state.quizStatus, 'unavailable');
  assert.equal(s.state.selectedQuizId, quizId(1));
});

test('Detail MATERIAL_NOT_AVAILABLE отменяет параллельный main GET и подавляет поздние ответ и ошибку', async () => {
  for (const outcome of ['success', 'error']) {
    const pending = deferred();
    const s = setup({
      listReads: [list(1, gen('ready')), pending.promise],
      details: [quiz(1), failure('MATERIAL_NOT_AVAILABLE', 409)],
    });
    s.setCatalog(1, gen('ready'));
    await s.controller.refresh();
    await s.controller.openQuiz(quizId(1));
    const reading = s.controller.refresh();
    await tick();
    const oldSignal = s.lists.at(-1).signal;
    await s.controller.openQuiz(quizId(1));
    assert.equal(oldSignal.aborted, true);
    assert.equal(s.record.quiz[ID].operation, null);
    assert.equal(s.state.phase, 'unavailable');
    assert.equal(s.state.reading, false);
    assert.equal(s.state.quiz, null);
    assert.deepEqual(s.state.quizzes, []);
    const unavailable = s.state;
    const count = s.states.length;
    if (outcome === 'success') pending.resolve(list(2, gen('ready')));
    else pending.reject(failure('AUTHENTICATION_REQUIRED', 401));
    await reading;
    assert.deepEqual(s.state, unavailable);
    assert.equal(s.states.length, count);
    assert.equal(s.access.length, 0);
    await s.controller.refresh();
    assert.equal(s.state.phase, 'ready');
    assert.equal(s.state.quizzes.length, 1);
  }
});

test('Detail MATERIAL_NOT_AVAILABLE прерывает отправленный POST с uncertain без позднего восстановления view', async () => {
  const pending = deferred();
  const s = setup({ generations: [pending.promise], details: [failure('MATERIAL_NOT_AVAILABLE', 409)] });
  await s.controller.refresh();
  const generating = s.controller.generate(expected(gen()));
  await tick();
  await s.controller.openQuiz(quizId(1));
  assert.equal(s.posts[0].signal.aborted, true);
  assert.equal(s.state.uncertain, true);
  assert.equal(s.state.pending, false);
  assert.equal(s.record.quiz[ID].operation, null);
  const unavailable = s.state;
  pending.resolve({ materialId: ID, jobId: JOB });
  await generating;
  assert.deepEqual(s.state, unavailable);
  assert.equal(s.watches.length, 0);
});

test('Начальная ошибка списка не обещает ещё не полученные данные', async () => {
  const s = setup({ listReads: [failure('NETWORK_ERROR')] });
  await s.controller.refresh();
  assert.equal(s.state.message, 'Не удалось получить список тестов. Попробуй обновить его.');
  assert.equal(s.state.generation, null);
});

test('User selection/close во время проверки результата не подменяются автоматическим открытием', async () => {
  const result = deferred();
  const s = setup({ details: [result.promise, quiz(2)] });
  s.setCatalog(0, gen('queued', JOB));
  await s.controller.refresh();
  s.setCatalog(2, gen('ready', JOB));
  s.update(job('succeeded'));
  await s.controller.openQuiz(quizId(2));
  s.controller.closeQuiz();
  result.resolve(quiz(1));
  await tick();
  assert.equal(s.state.generatedQuizId, quizId(1));
  assert.equal(s.state.selectedQuizId, null);
  assert.equal(s.state.quiz, null);
});

test('Watch errors и неверные job identities прекращают наблюдение без результата/POST', async () => {
  for (const value of [job('succeeded', { id: NEXT_JOB }), job('succeeded', { type: 'material.summary' }), job('succeeded', { resultId: null }), job('running', { resultId: quizId(1) })]) {
    const s = setup({ listReads: [list(0, gen('queued', JOB))] });
    await s.controller.refresh();
    s.update(value);
    assert.equal(s.state.watching, false);
    assert.ok(s.state.watchError);
    assert.equal(s.detailCalls.length, 0);
    assert.equal(s.posts.length, 0);
  }
  const s = setup({ listReads: [list(0, gen('queued', JOB)), list(0, gen('queued', JOB))] });
  await s.controller.refresh();
  s.failWatch(failure('JOB_NOT_FOUND', 404));
  assert.equal(s.state.watching, false);
  await s.controller.refresh();
  assert.equal(s.watches.length, 2);
  const count = s.states.length;
  s.update(job('succeeded'), 0);
  assert.equal(s.states.length, count);
});

test('POST202+ошибка list сохраняет известный job и старую страницу', async () => {
  const old = list(1, gen('ready'));
  const s = setup({ listReads: [old, old, failure('SERVICE_UNAVAILABLE', 503)] });
  await s.controller.refresh();
  await s.controller.generate(expected(s.state.generation));
  assert.equal(s.state.quizzes.length, 1);
  assert.equal(s.state.listStale, true);
  assert.equal(s.watches[0].id, JOB);
  assert.equal(s.state.canRetry, false);
});

test('Коды ошибки и malformed202 не раскрывают raw details и не вращают ключ', async () => {
  for (const response of [{ materialId: OTHER, jobId: JOB }, { materialId: ID, jobId: 'bad' }, failure('constructor', 400)]) {
    const s = setup({ generations: [response] });
    await s.controller.refresh();
    await s.controller.generate(expected(gen()));
    assert.equal(s.posts.length, 1);
    assert.equal(s.keyCount, 1);
    assert.equal(typeof s.state.message, 'string');
    assert.doesNotMatch(s.state.message, /Сырые/);
    assert.equal(s.watches.length, 0);
  }
});

test('QUIZ_IN_PROGRESS/KEY_REUSED старый terminal не разрешают новый ключ; Retry-After хранится после close', async () => {
  for (const code of ['QUIZ_IN_PROGRESS', 'IDEMPOTENCY_KEY_REUSED']) {
    const s = setup({ generations: [failure(code, 409)] });
    await s.controller.refresh();
    await s.controller.generate(expected(gen()));
    s.setNow(5000);
    await s.controller.refresh();
    assert.equal(s.state.canGenerate, false);
    assert.equal(s.state.canRetry, false);
    assert.equal(s.keyCount, 1);
  }
  const record = {};
  const first = setup({ record, generations: [failure('RATE_LIMITED', 429, { retryAfterSeconds: 2 })] });
  await first.controller.refresh();
  await first.controller.generate(expected(gen()));
  first.controller.stop();
  const second = setup({ record });
  second.setNow(2999);
  await second.controller.refresh();
  assert.equal(second.calls.length, 0);
  second.setNow(3000);
  assert.equal(second.calls.length, 0);
  await second.controller.refresh();
  assert.equal(second.state.canRetry, true);
  await second.controller.generate(expected(second.state.generation));
  assert.equal(second.posts[0].idempotencyKey, KEY);
});

test('Сессия в material/list/detail/POST/watch вызывает общий обработчик и очищает приватный view', async () => {
  for (const stage of ['material', 'list', 'detail', 'post', 'watch']) {
    const error = failure(stage === 'post' ? 'CSRF_INVALID' : 'AUTHENTICATION_REQUIRED', stage === 'post' ? 403 : 401);
    const s = setup({
      materialReads: stage === 'material' ? [error] : [],
      listReads: stage === 'list' ? [error] : stage === 'watch' ? [list(0, gen('queued', JOB))] : [],
      details: stage === 'detail' ? [error] : [], generations: stage === 'post' ? [error] : [],
    });
    await s.controller.refresh();
    if (stage === 'detail') await s.controller.openQuiz(quizId(1));
    if (stage === 'post') await s.controller.generate(expected(gen()));
    if (stage === 'watch') s.failWatch(error);
    assert.deepEqual(s.access, [error], stage);
    assert.equal(s.state.material, null);
    assert.equal(s.state.quiz, null);
    assert.deepEqual(s.state.quizzes, []);
    assert.equal(s.state.pending, false);
  }
});

test('Закрытие отправленного POST сохраняет uncertain и игнорирует поздний ответ после восстановления', async () => {
  const record = {};
  const pending = deferred();
  const first = setup({ record, generations: [pending.promise] });
  await first.controller.refresh();
  const generating = first.controller.generate(expected(gen()));
  await tick();
  first.deny();
  first.controller.stop();
  assert.equal(first.state.uncertain, true);
  assert.equal(first.posts[0].signal.aborted, true);
  const second = setup({ record });
  await second.controller.refresh();
  const state = second.state;
  pending.resolve({ materialId: ID, jobId: JOB });
  await generating;
  assert.deepEqual(second.state, state);
  assert.equal(first.watches.length, 0);
  assert.equal(second.posts.length, 0);
});

test('Поздние HTTP ответ/ошибка после scope или record change не изменяют приватную запись', async () => {
  for (const stage of ['list', 'detail', 'post']) {
    for (const mode of ['deny', 'replace']) {
      for (const outcome of ['success', 'error']) {
        const pending = deferred();
        const s = setup({ listReads: stage === 'list' ? [pending.promise] : [], details: stage === 'detail' ? [pending.promise] : [], generations: stage === 'post' ? [pending.promise] : [] });
        let running;
        if (stage === 'list') running = s.controller.refresh();
        else { await s.controller.refresh(); running = stage === 'detail' ? s.controller.openQuiz(quizId(1)) : s.controller.generate(expected(gen())); }
        await tick();
        const draft = s.record.quiz[ID];
        const before = { ...draft, attempt: draft.attempt ? { ...draft.attempt } : null, view: { ...draft.view } };
        const count = s.states.length;
        if (mode === 'deny') s.deny();
        else s.record.quiz = {};
        if (outcome === 'error') pending.reject(failure('AUTHENTICATION_REQUIRED', 401));
        else pending.resolve(stage === 'list' ? list() : stage === 'detail' ? quiz(1) : { materialId: ID, jobId: JOB });
        await running;
        assert.deepEqual(draft, before, `${stage}/${mode}/${outcome}`);
        assert.equal(s.states.length, count);
        assert.equal(s.access.length, 0);
        s.controller.stop();
      }
    }
  }
});

test('Material unavailable очищает старые версии, детали и generated id', async () => {
  const s = setup();
  s.setCatalog(1, gen('ready'));
  await s.controller.refresh();
  await s.controller.openQuiz(quizId(1));
  s.setMaterial(material({ status: 'deleting' }));
  await s.controller.refresh();
  assert.equal(s.state.phase, 'unavailable');
  assert.deepEqual(s.state.quizzes, []);
  assert.equal(s.state.quiz, null);
  assert.equal(s.state.selectedQuizId, null);
  assert.equal(s.state.generatedQuizId, null);
  assert.equal(s.state.material, null);
});

test('Snapshot не раскрывает ключи/ответы и не позволяет менять вложенные questions/options', async () => {
  const value = quiz(1, { correctIndex: 2 });
  value.questions[0].answer = 'secret';
  value.questions[0].options[0].correct = true;
  const s = setup({ details: [value] });
  await s.controller.refresh();
  await s.controller.openQuiz(quizId(1));
  const state = s.state;
  assert.equal(Object.hasOwn(state.quiz, 'correctIndex'), false);
  assert.equal(Object.hasOwn(state.quiz.questions[0], 'answer'), false);
  assert.equal(Object.hasOwn(state.quiz.questions[0].options[0], 'correct'), false);
  state.quiz.questions[0].options[0].text = 'Подмена';
  assert.notEqual(s.state.quiz.questions[0].options[0].text, 'Подмена');
  for (const key of ['attempt', 'usedKeys', 'operation', 'detailOperation']) assert.equal(Object.hasOwn(state, key), false);
});
