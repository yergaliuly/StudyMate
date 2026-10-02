import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/services/apiClient.js';
import { createJobWatcher } from '../src/services/jobWatcher.js';
import {
  createMaterialSummaryController,
  getMaterialSummaryState,
} from '../src/services/materialSummaryController.js';

const ID = '3dfa4d7d-619d-4a97-9f09-a34d236e879b';
const SUBJECT = '6f07410e-98f7-41a3-bfab-cbc387683fc1';
const OTHER = '7f07410e-98f7-41a3-bfab-cbc387683fc1';
const JOB = '095f15c2-1f89-4e09-a9ab-b3b281766f57';
const OTHER_JOB = '195f15c2-1f89-4e09-a9ab-b3b281766f57';
const KEY = '295f15c2-1f89-4e09-a9ab-b3b281766f57';
const material = (changes = {}) => ({ id: ID, subjectId: SUBJECT, status: 'stored', processingStatus: 'ready', title: 'Лекция', ...changes });
const failure = (code, status = 0, extra = {}) => new ApiError('Частные детали сервера', { code, status, ...extra });
const missing = () => failure('SUMMARY_NOT_FOUND', 404);
const summary = (status = 'queued', changes = {}) => ({
  materialId: ID, jobId: JOB, status,
  version: status === 'ready' ? 1 : null,
  content: status === 'ready' ? '- Тезис (стр. 1)' : null,
  sourcePages: status === 'ready' ? [1] : null,
  origin: status === 'ready' ? 'ai' : null,
  model: status === 'ready' ? 'fake-local' : null,
  inputTokens: status === 'ready' ? 30 : null,
  outputTokens: status === 'ready' ? 10 : null,
  createdAt: status === 'ready' ? '2026-10-02T01:00:00Z' : null,
  updatedAt: '2026-10-02T01:00:00Z',
  error: status === 'failed' ? { code: 'AI_OUTCOME_UNKNOWN', message: 'Частные детали ИИ' } : null,
  ...changes,
});
const job = (status = 'running', changes = {}) => ({
  id: JOB, type: 'material.summary', status,
  resultId: status === 'succeeded' ? ID : null,
  error: status === 'failed' ? { code: 'AI_OUTCOME_UNKNOWN', message: 'Частные детали worker' } : null,
  ...changes,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function setup({ record = {}, materialReads = [], summaryReads = [], generations = [], watch, onMaterialRead, makeKey } = {}) {
  let allowed = true;
  let timestamp = 1000;
  let currentSummary = missing();
  let currentMaterial = material();
  let keys = 0;
  const calls = [];
  const states = [];
  const access = [];
  const watches = [];
  const freshMaterials = [];
  async function respond(queue, fallback) {
    const result = queue.length ? queue.shift() : fallback;
    if (result instanceof Error) throw result;
    return await result;
  }
  const controller = createMaterialSummaryController({
    record, materialId: ID, subjectId: SUBJECT,
    canAct: () => allowed,
    onChange: (value) => states.push(value),
    onAccessError: (error) => access.push(error),
    onMaterialRead: (value) => { freshMaterials.push(value); onMaterialRead?.(value); },
    now: () => timestamp,
    makeKey: () => { keys += 1; return makeKey ? makeKey() : KEY; },
    materials: {
      async getById(id, options) {
        calls.push({ kind: 'material', id, ...options });
        return await respond(materialReads, currentMaterial);
      },
    },
    api: {
      async getByMaterial(id, options) {
        calls.push({ kind: 'summary', id, ...options });
        return await respond(summaryReads, currentSummary);
      },
      async generate(id, options) {
        calls.push({ kind: 'generate', id, ...options });
        const result = await respond(generations, { materialId: ID, jobId: JOB });
        currentSummary = summary();
        return result;
      },
    },
    watch: watch ?? ((id, handlers) => {
      const entry = { id, handlers, stopped: false };
      watches.push(entry);
      return () => { entry.stopped = true; };
    }),
  });
  return {
    controller, record, calls, states, access, watches, freshMaterials,
    get state() { return getMaterialSummaryState(record, ID); },
    get posts() { return calls.filter((call) => call.kind === 'generate'); },
    get summaryCalls() { return calls.filter((call) => call.kind === 'summary'); },
    get keyCount() { return keys; },
    setSummary(value) { currentSummary = value; },
    setMaterial(value) { currentMaterial = value; },
    setNow(value) { timestamp = value; },
    deny() { allowed = false; },
    update(value, index = watches.length - 1) { watches[index].handlers.onUpdate(value); },
    failWatch(value, index = watches.length - 1) { watches[index].handlers.onError(value); },
  };
}

test('Создание/refresh не генерируют; первая кнопка требует fresh stored+ready и SUMMARY_NOT_FOUND', async () => {
  const s = setup();
  await s.controller.generate();
  assert.equal(s.calls.length, 0);
  await s.controller.refresh();
  assert.deepEqual(s.calls.map((call) => call.kind), ['material', 'summary']);
  assert.equal(s.state.phase, 'ready');
  assert.equal(s.state.empty, true);
  assert.equal(s.state.canGenerate, true);
  assert.equal(s.state.canRetry, false);
  assert.equal(s.keyCount, 0);
  assert.equal(s.posts.length, 0);
  for (const processingStatus of ['queued', 'running', 'failed', 'not_started']) {
    const blocked = setup({ materialReads: [material({ processingStatus })] });
    await blocked.controller.refresh();
    assert.equal(blocked.state.empty, true);
    assert.equal(blocked.state.canGenerate, false);
    await blocked.controller.generate();
    assert.equal(blocked.posts.length, 0);
  }
});

test('Каждый явный generate заново читает material+summary, затем один POST с UUID ключом', async () => {
  const s = setup();
  await s.controller.refresh();
  await s.controller.generate();
  assert.deepEqual(s.calls.map((call) => call.kind), ['material', 'summary', 'material', 'summary', 'generate', 'summary']);
  assert.deepEqual(Object.keys(s.posts[0]).sort(), ['id', 'idempotencyKey', 'kind', 'signal']);
  assert.equal(s.posts[0].idempotencyKey, KEY);
  assert.equal(s.posts[0].id, ID);
  assert.equal(s.keyCount, 1);
  assert.equal(s.state.pending, false);
  assert.equal(s.state.watching, true);
  assert.equal(s.watches[0].id, JOB);
  assert.equal(s.state.canGenerate, false);
  assert.equal(s.state.canRetry, false);
  await s.controller.generate();
  assert.equal(s.posts.length, 1);
});

test('Double click блокируется уже во время предварительного GET и до завершения POST', async () => {
  const preflight = deferred();
  const post = deferred();
  const s = setup({ materialReads: [material(), preflight.promise], generations: [post.promise] });
  await s.controller.refresh();
  const generating = s.controller.generate();
  await s.controller.generate();
  await s.controller.refresh();
  assert.equal(s.calls.length, 3);
  assert.equal(s.state.pending, true);
  assert.equal(s.state.reading, true);
  preflight.resolve(material());
  await tick();
  await s.controller.generate();
  await s.controller.refresh();
  assert.equal(s.posts.length, 1);
  post.resolve({ materialId: ID, jobId: JOB });
  await generating;
  assert.equal(s.posts.length, 1);
});

test('Появившийся перед POST конспект любого статуса останавливает создание новой попытки', async () => {
  for (const status of ['queued', 'running', 'ready', 'failed', 'cancelled']) {
    const s = setup();
    await s.controller.refresh();
    s.setSummary(summary(status));
    await s.controller.generate();
    assert.equal(s.posts.length, 0, status);
    assert.equal(s.keyCount, 0);
    assert.equal(s.state.summary.status, status);
    assert.equal(s.state.canGenerate, false);
    assert.equal(s.state.canRetry, false);
  }
});

test('Изменившийся subject/status/текст перед POST запрещает генерацию', async () => {
  for (const changes of [{ subjectId: OTHER }, { status: 'deleting' }, { status: 'uploading' }, { processingStatus: 'running' }]) {
    const s = setup();
    await s.controller.refresh();
    s.setMaterial(material(changes));
    await s.controller.generate();
    assert.equal(s.posts.length, 0);
    assert.equal(s.keyCount, 0);
    assert.equal(s.state.canGenerate, false);
    assert.equal(s.state.pending, false);
  }
});

test('Неизвестный результат и AI503 повторяются только явно с тем же ключом', async () => {
  for (const error of [failure('NETWORK_ERROR'), failure('INTERNAL_ERROR', 500), failure('INVALID_RESPONSE', 200), failure('AI_UNAVAILABLE', 503)]) {
    const s = setup({ generations: [error] });
    await s.controller.refresh();
    await s.controller.generate();
    assert.equal(s.posts.length, 1);
    assert.equal(s.state.canGenerate, false);
    assert.equal(s.state.canRetry, true);
    assert.equal(s.state.uncertain, error.code !== 'AI_UNAVAILABLE');
    await s.controller.refresh();
    assert.equal(s.posts.length, 1);
    await s.controller.generate();
    assert.equal(s.posts.length, 2);
    assert.equal(s.posts[1].idempotencyKey, KEY);
    assert.equal(s.keyCount, 1);
  }
});

test('Потерянный POST, обнаруженный через GET, наблюдается без повторного POST', async () => {
  const s = setup({ generations: [failure('NETWORK_ERROR')] });
  await s.controller.refresh();
  await s.controller.generate();
  s.setSummary(summary());
  await s.controller.refresh();
  assert.equal(s.posts.length, 1);
  assert.equal(s.state.uncertain, false);
  assert.equal(s.state.watching, true);
  assert.equal(s.state.canRetry, false);
  await s.controller.generate();
  assert.equal(s.posts.length, 1);
});

test('Ключ переживает закрытие; повторное открытие читает сервер и само ничего не отправляет', async () => {
  const record = {};
  const first = setup({ record, generations: [failure('AI_UNAVAILABLE', 503)] });
  await first.controller.refresh();
  await first.controller.generate();
  first.controller.stop();
  assert.equal(first.state.material, null);
  assert.equal(first.state.summary, null);
  const second = setup({ record, makeKey: () => OTHER });
  await second.controller.generate();
  assert.equal(second.calls.length, 0);
  await second.controller.refresh();
  assert.equal(second.posts.length, 0);
  assert.equal(second.state.canRetry, true);
  await second.controller.generate();
  assert.equal(second.posts[0].idempotencyKey, KEY);
  assert.equal(second.keyCount, 0);
});

test('Прерывание POST сохраняет uncertain; прерывание preflight не выдумывает платный запрос', async () => {
  for (const stage of ['preflight', 'post']) {
    const pending = deferred();
    const record = {};
    const first = setup({
      record,
      materialReads: stage === 'preflight' ? [material(), pending.promise] : [],
      generations: stage === 'post' ? [pending.promise] : [],
    });
    await first.controller.refresh();
    const generating = first.controller.generate();
    await tick();
    first.deny();
    first.controller.stop();
    assert.equal(first.state.pending, false);
    assert.equal(first.state.uncertain, stage === 'post');
    assert.equal(first.calls.at(-1).signal.aborted, true);
    const restored = setup({ record });
    await restored.controller.refresh();
    const state = restored.state;
    pending.resolve(stage === 'post' ? { materialId: ID, jobId: JOB } : material());
    await generating;
    assert.deepEqual(restored.state, state);
    assert.equal(first.watches.length, 0);
    assert.equal(restored.posts.length, 0);
  }
});

test('Принятый job или когда-либо существовавший конспект запрещают новые ключи даже после GET404', async () => {
  for (const accepted of [true, false]) {
    const record = {};
    const first = setup({ record, summaryReads: accepted ? [] : [summary('failed')] });
    await first.controller.refresh();
    if (accepted) await first.controller.generate();
    first.controller.stop();
    const second = setup({ record });
    await second.controller.refresh();
    assert.equal(second.state.canGenerate, false);
    assert.equal(second.state.canRetry, false);
    assert.equal(second.state.empty, false);
    await second.controller.generate();
    assert.equal(second.posts.length, 0);
    assert.equal(second.keyCount, 0);
  }
});

test('SUMMARY_IN_PROGRESS/KEY_REUSED не вращают ключ и не запускают повторную генерацию', async () => {
  for (const code of ['SUMMARY_IN_PROGRESS', 'IDEMPOTENCY_KEY_REUSED']) {
    const s = setup({ generations: [failure(code, 409)] });
    await s.controller.refresh();
    await s.controller.generate();
    assert.equal(s.state.canRetry, false);
    await s.controller.refresh();
    await s.controller.generate();
    assert.equal(s.posts.length, 1);
    assert.equal(s.keyCount, 1);
  }
});

test('Старый content остаётся доступным при queued/running/failed/cancelled; сообщения ИИ безопасны', async () => {
  for (const status of ['queued', 'running', 'failed', 'cancelled']) {
    const stored = summary('ready', { status, error: status === 'failed' ? { code: 'AI_OUTCOME_UNKNOWN', message: 'Частные детали ИИ' } : null });
    const s = setup({ summaryReads: [stored, failure('NETWORK_ERROR')] });
    await s.controller.refresh();
    assert.equal(s.state.summary.content, '- Тезис (стр. 1)');
    assert.doesNotMatch(s.state.message + (s.state.summary.error?.message ?? ''), /Частные/);
    await s.controller.refresh();
    assert.equal(s.state.summary.content, '- Тезис (стр. 1)');
    assert.equal(s.state.phase, 'error');
    assert.equal(s.state.canGenerate, false);
  }
});

test('Job terminal вызывает только независимый GETsummary и не создаёт цикл при старом queued', async () => {
  for (const status of ['succeeded', 'failed', 'cancelled']) {
    const s = setup({ summaryReads: [summary(), summary(), summary('ready')] });
    await s.controller.refresh();
    s.update(job(status));
    await tick();
    assert.equal(s.watches[0].stopped, true);
    assert.equal(s.watches[0].handlers.signal.aborted, true);
    assert.equal(s.summaryCalls[1].signal.aborted, false);
    assert.notEqual(s.summaryCalls[1].signal, s.watches[0].handlers.signal);
    assert.equal(s.state.watching, false);
    assert.equal(s.state.watchError, 'STATUS_NOT_CONFIRMED');
    assert.equal(s.watches.length, 1);
    assert.equal(s.posts.length, 0);
    s.update(job(status), 0);
    assert.equal(s.summaryCalls.length, 2);
    await s.controller.refresh();
    assert.equal(s.state.summary.status, 'ready');
  }
});

test('Настоящий watcher отменяет HTTP-сигнал до terminal callback; GETsummary остаётся живым', async () => {
  let jobSignal;
  const watch = createJobWatcher({
    async getById(id, { signal }) { assert.equal(id, JOB); jobSignal = signal; return job('succeeded'); },
  });
  const s = setup({ summaryReads: [summary(), summary('ready')], watch });
  await s.controller.refresh();
  await tick();
  assert.equal(jobSignal.aborted, true);
  assert.equal(s.summaryCalls[1].signal.aborted, false);
  assert.notEqual(jobSignal, s.summaryCalls[1].signal);
  assert.equal(s.state.summary.status, 'ready');
  assert.equal(s.state.watching, false);
  assert.equal(s.posts.length, 0);
});

test('После202 временный сбой GETsummary не теряет наблюдение известного job', async () => {
  const s = setup({ summaryReads: [missing(), missing(), failure('SERVICE_UNAVAILABLE', 503), summary('ready')] });
  await s.controller.refresh();
  await s.controller.generate();
  assert.equal(s.posts.length, 1);
  assert.equal(s.watches.length, 1);
  assert.equal(s.state.watching, true);
  assert.equal(s.state.canRetry, false);
  s.update(job('succeeded'));
  await tick();
  assert.equal(s.state.summary.status, 'ready');
  assert.equal(s.state.watching, false);
  assert.equal(s.posts.length, 1);
});

test('Watch error прекращает опрос; явный refresh восстанавливает безPOST и игнорирует старые callbacks', async () => {
  const s = setup({ summaryReads: [summary(), summary()] });
  await s.controller.refresh();
  s.failWatch(failure('JOB_NOT_FOUND', 404));
  assert.equal(s.state.watching, false);
  assert.ok(s.state.watchError);
  assert.equal(s.watches[0].stopped, true);
  await s.controller.refresh();
  assert.equal(s.watches.length, 2);
  const count = s.states.length;
  s.update(job('succeeded'), 0);
  s.failWatch(failure('AUTHENTICATION_REQUIRED', 401), 0);
  assert.equal(s.states.length, count);
  assert.equal(s.access.length, 0);
  assert.equal(s.posts.length, 0);
});

test('Неверные job id/type/resultId останавливают наблюдение без чтения и автоматических попыток', async () => {
  for (const value of [job('running', { id: OTHER_JOB }), job('running', { type: 'material.delete' }), job('succeeded', { resultId: OTHER }), job('succeeded', { resultId: null }), job('running', { resultId: ID })]) {
    const s = setup({ summaryReads: [summary()] });
    await s.controller.refresh();
    s.update(value);
    assert.equal(s.state.watching, false);
    assert.equal(s.watches[0].stopped, true);
    assert.ok(s.state.watchError);
    assert.equal(s.summaryCalls.length, 1);
    assert.equal(s.posts.length, 0);
  }
});

test('Чужой subject/material/summary не попадает в контент и не разрешает POST', async () => {
  for (const value of [material({ id: OTHER }), material({ subjectId: OTHER })]) {
    const s = setup({ materialReads: [value] });
    await s.controller.refresh();
    assert.equal(s.summaryCalls.length, 0);
    assert.equal(s.freshMaterials.length, 0);
    assert.equal(s.state.material, null);
    assert.equal(s.state.canGenerate, false);
  }
  for (const changes of [{ materialId: OTHER }, { jobId: 'bad' }, { status: 'bad' }]) {
    const s = setup({ summaryReads: [summary('ready', changes)] });
    await s.controller.refresh();
    assert.equal(s.state.summary, null);
    assert.equal(s.state.canGenerate, false);
    assert.equal(s.watches.length, 0);
  }
});

test('Мalformed202 сохраняет неизвестный исход и прежний key', async () => {
  for (const result of [{ materialId: OTHER, jobId: JOB }, { materialId: ID, jobId: 'bad' }, null]) {
    const s = setup({ generations: [result] });
    await s.controller.refresh();
    await s.controller.generate();
    assert.equal(s.state.uncertain, true);
    assert.equal(s.state.canRetry, true);
    assert.equal(s.watches.length, 0);
    assert.equal(s.keyCount, 1);
  }
});

test('Недоступный материал очищает старый конспект; SUMMARY404 отличается от MATERIAL404', async () => {
  for (const error of [failure('MATERIAL_NOT_FOUND', 404), failure('MATERIAL_NOT_AVAILABLE', 409)]) {
    const s = setup({ summaryReads: [summary('ready'), error] });
    await s.controller.refresh();
    await s.controller.refresh();
    assert.equal(s.state.phase, 'unavailable');
    assert.equal(s.state.summary, null);
    assert.equal(s.state.material, null);
    assert.equal(s.state.empty, false);
    assert.equal(s.state.jobStatus, null);
    assert.equal(s.state.watchError, '');
  }
  const technical = setup({ summaryReads: [failure('NOT_FOUND', 404)] });
  await technical.controller.refresh();
  assert.equal(technical.state.phase, 'error');
  assert.equal(technical.state.empty, false);
  assert.equal(technical.state.canGenerate, false);
});

test('Отмена первой генерации не обещает несуществующий сохранённый конспект', async () => {
  const s = setup({ summaryReads: [summary('cancelled')] });
  await s.controller.refresh();
  assert.equal(s.state.message, 'Генерация отменена. Конспект ещё не создан.');
  assert.equal(s.state.summary.version, null);
});

test('Session/CSRF: ключ сохраняется, данные скрываются, восстановление только читает', async () => {
  for (const error of [failure('AUTHENTICATION_REQUIRED', 401), failure('CSRF_INVALID', 403), failure('CSRF_NOT_INITIALIZED')]) {
    const record = {};
    const first = setup({ record, generations: [error] });
    await first.controller.refresh();
    await first.controller.generate();
    assert.deepEqual(first.access, [error]);
    assert.equal(first.state.pending, false);
    assert.equal(first.state.material, null);
    const restored = setup({ record });
    await restored.controller.refresh();
    assert.equal(restored.posts.length, 0);
    assert.equal(restored.state.canRetry, true);
    await restored.controller.generate();
    assert.equal(restored.posts[0].idempotencyKey, KEY);
    assert.equal(restored.keyCount, 0);
  }
});

test('Сессия при чтении/опросе также уходит в глобальное восстановление без мутации', async () => {
  for (const stage of ['material', 'summary', 'watch']) {
    const error = failure('AUTHENTICATION_REQUIRED', 401);
    const s = setup({ materialReads: stage === 'material' ? [error] : [], summaryReads: stage === 'summary' ? [error] : [summary()] });
    await s.controller.refresh();
    if (stage === 'watch') s.failWatch(error);
    assert.deepEqual(s.access, [error]);
    assert.equal(s.state.material, null);
    assert.equal(s.state.summary, null);
    assert.equal(s.posts.length, 0);
  }
});

test('Retry-After сохраняется при закрытии и не создаёт автоматического POST по таймеру', async () => {
  const record = {};
  const first = setup({ record, generations: [failure('RATE_LIMITED', 429, { retryAfterSeconds: 2 })] });
  await first.controller.refresh();
  await first.controller.generate();
  assert.equal(first.state.retryAt, 3000);
  assert.equal(first.state.canRetry, true);
  await first.controller.generate();
  assert.equal(first.posts.length, 1);
  first.controller.stop();
  const second = setup({ record });
  second.setNow(2999);
  await second.controller.refresh();
  assert.equal(second.calls.length, 0);
  second.setNow(3000);
  assert.equal(second.calls.length, 0);
  await second.controller.generate();
  assert.equal(second.calls.length, 0);
  await second.controller.refresh();
  assert.equal(second.state.canRetry, true);
  assert.equal(second.posts.length, 0);
  await second.controller.generate();
  assert.equal(second.posts[0].idempotencyKey, KEY);
});

test('Поздние HTTP успех/ошибка не меняют приватную запись после scope/record change', async () => {
  for (const stage of ['material', 'summary', 'post']) {
    for (const mode of ['deny', 'replace']) {
      for (const outcome of ['success', 'error']) {
        const pending = deferred();
        const s = setup({
          materialReads: stage === 'material' ? [pending.promise] : [],
          summaryReads: stage === 'summary' ? [pending.promise] : [],
          generations: stage === 'post' ? [pending.promise] : [],
        });
        let running;
        if (stage === 'post') { await s.controller.refresh(); running = s.controller.generate(); }
        else running = s.controller.refresh();
        await tick();
        const draft = s.record.summary[ID];
        const prior = { ...draft, view: { ...draft.view } };
        const count = s.states.length;
        if (mode === 'deny') s.deny();
        else s.record.summary = {};
        if (outcome === 'error') pending.reject(failure('AUTHENTICATION_REQUIRED', 401));
        else pending.resolve(stage === 'material' ? material() : stage === 'summary' ? summary('ready') : { materialId: ID, jobId: JOB });
        await running;
        assert.deepEqual(draft, prior, `${stage}/${mode}/${outcome}`);
        assert.equal(s.states.length, count);
        assert.equal(s.access.length, 0);
        assert.equal(s.watches.length, 0);
        s.controller.stop();
      }
    }
  }
});

test('Остановка не оставляет watcher/поздние callbacks и защищает новую запись аккаунта', async () => {
  const record = {};
  const first = setup({ record, summaryReads: [summary()] });
  await first.controller.refresh();
  first.controller.stop();
  assert.equal(first.watches[0].stopped, true);
  assert.equal(first.watches[0].handlers.signal.aborted, true);
  const second = setup({ record, summaryReads: [summary('ready')] });
  await second.controller.refresh();
  const state = second.state;
  first.update(job('succeeded'));
  first.failWatch(failure('AUTHENTICATION_REQUIRED', 401));
  assert.deepEqual(second.state, state);
  assert.equal(first.access.length, 0);
});

test('Подмена scope внутри onMaterialRead останавливает цепочку до summary/POST', async () => {
  let s;
  s = setup({ onMaterialRead: () => s.deny() });
  await s.controller.refresh();
  assert.equal(s.summaryCalls.length, 0);
  assert.equal(s.posts.length, 0);
  s.controller.stop();
});

test('Неизвестные коды и плохой UUID key дают безопасные сообщения без платного запроса', async () => {
  const badKey = setup({ makeKey: () => 'invalid' });
  await badKey.controller.refresh();
  await badKey.controller.generate();
  assert.equal(badKey.posts.length, 0);
  assert.equal(badKey.state.pending, false);
  for (const code of ['constructor', '__proto__']) {
    const s = setup({ generations: [failure(code, 400)] });
    await s.controller.refresh();
    await s.controller.generate();
    assert.equal(typeof s.state.message, 'string');
    assert.doesNotMatch(s.state.message, /Частные/);
    assert.ok(s.state.message);
  }
});

test('Снимки не дают подменить content/pages и не раскрывают key/контроллеры', async () => {
  const s = setup({ summaryReads: [summary('ready')] });
  await s.controller.refresh();
  const state = s.state;
  state.summary.content = 'Подмена';
  state.summary.sourcePages.push(99);
  assert.equal(s.state.summary.content, '- Тезис (стр. 1)');
  assert.deepEqual(s.state.summary.sourcePages, [1]);
  for (const name of ['key', 'acceptedJobId', 'operation', 'observation']) assert.equal(Object.hasOwn(state, name), false);
});
