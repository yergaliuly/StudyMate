import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/services/apiClient.js';
import { createJobWatcher } from '../src/services/jobWatcher.js';
import {
  createMaterialDeleteAction,
  getMaterialDeleteState,
} from '../src/services/materialDeleteAction.js';

const ID = '3dfa4d7d-619d-4a97-9f09-a34d236e879b';
const SUBJECT = '6f07410e-98f7-41a3-bfab-cbc387683fc1';
const OTHER = '7f07410e-98f7-41a3-bfab-cbc387683fc1';
const JOB = '095f15c2-1f89-4e09-a9ab-b3b281766f57';
const NEXT_JOB = '195f15c2-1f89-4e09-a9ab-b3b281766f57';
const material = (changes = {}) => ({
  id: ID, subjectId: SUBJECT, title: 'Лекция 1', status: 'stored',
  version: 1, deletionJobId: null, ...changes,
});
const deleting = (changes = {}) => material({ status: 'deleting', deletionJobId: JOB, ...changes });
const job = (status = 'queued', changes = {}) => ({
  id: JOB, type: 'material.delete', status,
  resultId: status === 'succeeded' ? ID : null,
  error: status === 'failed' ? { code: 'JOB_OUTCOME_UNKNOWN', message: 'Секретные детали worker' } : null,
  ...changes,
});
const error = (code, status = 0, extra = {}) => new ApiError('Секретные детали сервера', { code, status, ...extra });
const gone = () => error('MATERIAL_NOT_FOUND', 404);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function setup({ record = {}, reads = [], deletes = [], watch, onRead, onAccepted, onRemoved } = {}) {
  let allowed = true;
  let timestamp = 1000;
  const calls = [];
  const states = [];
  const watches = [];
  const access = [];
  const fresh = [];
  const accepted = [];
  const removed = [];
  async function respond(queue, fallback) {
    const result = queue.length ? queue.shift() : fallback;
    if (result instanceof Error) throw result;
    return await result;
  }
  const action = createMaterialDeleteAction({
    record, materialId: ID, subjectId: SUBJECT,
    canAct: () => allowed,
    onChange: (state) => states.push(state),
    onAccessError: (failure) => access.push(failure),
    onRead: (value) => { fresh.push(value); onRead?.(value); },
    onAccepted: (value) => { accepted.push(value); onAccepted?.(value); },
    onRemoved: (value) => { removed.push(value); onRemoved?.(value); },
    now: () => timestamp,
    api: {
      async getById(id, options) {
        calls.push({ method: 'GET', id, ...options });
        return await respond(reads, material());
      },
      async remove(id, options) {
        calls.push({ method: 'DELETE', id, ...options });
        return await respond(deletes, { materialId: ID, jobId: JOB });
      },
    },
    watch: watch ?? ((id, handlers) => {
      const observation = { id, handlers, stopped: false };
      watches.push(observation);
      return () => { observation.stopped = true; };
    }),
  });
  return {
    action, record, calls, states, watches, access, fresh, accepted, removed,
    get state() { return getMaterialDeleteState(record, ID); },
    get deletes() { return calls.filter((call) => call.method === 'DELETE'); },
    get reads() { return calls.filter((call) => call.method === 'GET'); },
    deny() { allowed = false; },
    setNow(value) { timestamp = value; },
    update(value, index = watches.length - 1) { watches[index].handlers.onUpdate(value); },
    failWatch(value, index = watches.length - 1) { watches[index].handlers.onError(value); },
  };
}

test('Создание не делает запросов; stored/uploading требуют свежего чтения и явного удаления', async () => {
  for (const status of ['stored', 'uploading']) {
    const s = setup({ reads: [material({ status })] });
    await s.action.remove();
    assert.equal(s.calls.length, 0);
    await s.action.open();
    assert.equal(s.state.phase, 'confirm');
    assert.equal(s.state.material.status, status);
    assert.equal(s.fresh.length, 1);
    assert.equal(s.deletes.length, 0);
    await s.action.remove();
    assert.equal(s.deletes.length, 1);
    assert.equal(s.deletes[0].id, ID);
    assert.deepEqual(Object.keys(s.deletes[0]).sort(), ['id', 'method', 'signal']);
    assert.equal(s.state.phase, 'watching');
    assert.deepEqual(s.accepted, [{ materialId: ID, jobId: JOB }]);
    assert.equal(s.removed.length, 0);
    assert.equal(s.watches[0].id, JOB);
  }
});

test('Повторные клики не перекрывают GET или DELETE', async () => {
  const reading = deferred();
  const writing = deferred();
  const s = setup({ reads: [reading.promise], deletes: [writing.promise] });
  const opened = s.action.open();
  await s.action.open();
  await s.action.review();
  await s.action.remove();
  assert.equal(s.calls.length, 1);
  reading.resolve(material());
  await opened;
  const removed = s.action.remove();
  await s.action.remove();
  await s.action.open();
  await s.action.review();
  assert.equal(s.calls.length, 2);
  assert.equal(s.state.pending, true);
  writing.resolve({ materialId: ID, jobId: JOB });
  await removed;
  assert.equal(s.state.pending, false);
});

test('Существующее deleting восстанавливает наблюдение без DELETE; review останавливает прежнее', async () => {
  const s = setup({ reads: [deleting(), deleting()] });
  await s.action.open();
  assert.equal(s.watches.length, 1);
  await s.action.remove();
  s.update(job('running'));
  assert.equal(s.state.jobStatus, 'running');
  await s.action.review();
  assert.equal(s.watches[0].stopped, true);
  assert.equal(s.watches[0].handlers.signal.aborted, true);
  assert.equal(s.watches.length, 2);
  s.update(job('failed'), 0);
  assert.equal(s.state.phase, 'watching');
  assert.equal(s.deletes.length, 0);
});

test('202/queued/running не освобождают материал; успех требует отдельного GET404', async () => {
  const verifying = deferred();
  const s = setup({ reads: [material(), verifying.promise] });
  await s.action.open();
  await s.action.remove();
  for (const status of ['queued', 'running']) {
    s.update(job(status));
    assert.equal(s.state.phase, 'watching');
    assert.equal(s.state.jobStatus, status);
    assert.equal(s.removed.length, 0);
    assert.equal(s.reads.length, 1);
  }
  s.update(job('succeeded'));
  assert.equal(s.watches[0].stopped, true);
  assert.equal(s.watches[0].handlers.signal.aborted, true);
  assert.equal(s.reads.length, 2);
  assert.equal(s.reads[1].signal.aborted, false);
  assert.notEqual(s.reads[1].signal, s.watches[0].handlers.signal);
  assert.equal(s.removed.length, 0);
  verifying.reject(gone());
  await tick();
  assert.equal(s.state.phase, 'done');
  assert.equal(s.state.material, null);
  assert.deepEqual(s.removed, [ID]);
  s.update(job('succeeded'));
  await s.action.remove();
  await s.action.review();
  assert.deepEqual(s.removed, [ID]);
  assert.equal(s.deletes.length, 1);
});

test('Настоящий watcher отменяет terminal HTTP-сигнал до callback, но проверка удаления получает новый', async () => {
  let pollingSignal;
  const watch = createJobWatcher({
    async getById(id, { signal }) {
      assert.equal(id, JOB);
      pollingSignal = signal;
      return job('succeeded');
    },
  });
  const s = setup({ reads: [deleting(), gone()], watch });
  await s.action.open();
  await tick();
  assert.equal(pollingSignal.aborted, true);
  assert.equal(s.reads[1].signal.aborted, false);
  assert.notEqual(pollingSignal, s.reads[1].signal);
  assert.deepEqual(s.removed, [ID]);
  assert.equal(s.state.phase, 'done');
});

test('failed/cancelled разрешают один явный повтор DELETE и наблюдение нового job', async () => {
  for (const status of ['failed', 'cancelled']) {
    const retry = deferred();
    const s = setup({ reads: [deleting()], deletes: [retry.promise] });
    await s.action.open();
    s.update(job(status));
    assert.equal(s.watches[0].stopped, true);
    assert.equal(s.state.phase, 'failed');
    assert.equal(s.state.jobStatus, status);
    assert.doesNotMatch(s.state.message, /Секретные/);
    assert.equal(s.deletes.length, 0);
    const retrying = s.action.remove();
    await s.action.remove();
    assert.equal(s.deletes.length, 1);
    retry.resolve({ materialId: ID, jobId: NEXT_JOB });
    await retrying;
    assert.equal(s.watches.at(-1).id, NEXT_JOB);
    s.update(job('succeeded'), 0);
    assert.equal(s.state.phase, 'watching');
    assert.equal(s.removed.length, 0);
  }
});

test('Неизвестный исход блокирует DELETE до явной сверки; сама сверка ничего не удаляет', async () => {
  for (const failure of [
    error('NETWORK_ERROR'), error('REQUEST_CANCELLED'), error('SERVICE_UNAVAILABLE', 503),
    error('INTERNAL_ERROR', 500), error('INVALID_RESPONSE', 200), error('INVALID_RESPONSE', 422),
  ]) {
    const s = setup({ deletes: [failure] });
    await s.action.open();
    await s.action.remove();
    assert.equal(s.state.phase, 'uncertain', failure.code);
    assert.equal(s.state.pending, false);
    await s.action.remove();
    assert.equal(s.deletes.length, 1);
    assert.equal(s.removed.length, 0);
    await s.action.review();
    assert.equal(s.state.phase, 'confirm');
    assert.equal(s.deletes.length, 1);
    await s.action.remove();
    assert.equal(s.deletes.length, 2);
  }
});

test('Сверка неизвестного удаления восстанавливает deleting или подтверждает 404', async () => {
  for (const result of [deleting(), gone()]) {
    const s = setup({ reads: [material(), result], deletes: [error('NETWORK_ERROR')] });
    await s.action.open();
    await s.action.remove();
    await s.action.review();
    assert.equal(s.deletes.length, 1);
    assert.equal(s.state.phase, result instanceof Error ? 'done' : 'watching');
    assert.equal(s.removed.length, result instanceof Error ? 1 : 0);
  }
});

test('succeeded с ещё существующим материалом не создаёт цикл опроса и не сообщает об удалении', async () => {
  for (const existing of [deleting(), material()]) {
    const s = setup({ reads: [deleting(), existing, deleting(), gone()] });
    await s.action.open();
    s.update(job('succeeded'));
    await tick();
    assert.equal(s.state.phase, 'paused');
    assert.equal(s.watches.length, 1);
    assert.equal(s.removed.length, 0);
    await s.action.remove();
    assert.equal(s.deletes.length, 0);
    await s.action.review();
    assert.equal(s.state.phase, 'paused');
    assert.equal(s.watches.length, 1);
    await s.action.review();
    assert.equal(s.state.phase, 'done');
    assert.deepEqual(s.removed, [ID]);
  }
});

test('Ошибки наблюдения, включая JOB404, только останавливают опрос', async () => {
  for (const failure of [error('JOB_NOT_FOUND', 404), error('NETWORK_ERROR'), error('INTERNAL_ERROR', 500), error('constructor', 400)]) {
    const s = setup({ reads: [deleting()] });
    await s.action.open();
    s.failWatch(failure);
    assert.equal(s.state.phase, 'paused');
    assert.equal(s.watches[0].stopped, true);
    assert.equal(s.removed.length, 0);
    assert.equal(typeof s.state.message, 'string');
    assert.doesNotMatch(s.state.message, /Секретные/);
    await s.action.remove();
    assert.equal(s.deletes.length, 0);
  }
});

test('404 материала подтверждает отсутствие только с MATERIAL_NOT_FOUND', async () => {
  for (const stage of ['read', 'remove']) {
    for (const code of ['MATERIAL_NOT_FOUND', 'NOT_FOUND']) {
      const s = setup({
        reads: stage === 'read' ? [error(code, 404)] : [],
        deletes: stage === 'remove' ? [error(code, 404)] : [],
      });
      await s.action.open();
      if (stage === 'remove') await s.action.remove();
      assert.equal(s.state.phase, code === 'MATERIAL_NOT_FOUND' ? 'done' : 'error');
      assert.equal(s.removed.length, code === 'MATERIAL_NOT_FOUND' ? 1 : 0);
    }
  }
});

test('Сессия/CSRF прерывают работу; восстановление требует свежего GET без авто-DELETE', async () => {
  for (const stage of ['read', 'remove', 'watch']) {
    for (const failure of [error('AUTHENTICATION_REQUIRED', 401), error('CSRF_INVALID', 403), error('CSRF_NOT_INITIALIZED')]) {
      const record = {};
      const first = setup({
        record,
        reads: stage === 'read' ? [failure] : stage === 'watch' ? [deleting()] : [],
        deletes: stage === 'remove' ? [failure] : [],
      });
      await first.action.open();
      if (stage === 'remove') await first.action.remove();
      if (stage === 'watch') first.failWatch(failure);
      assert.deepEqual(first.access, [failure]);
      assert.equal(first.state.pending, false);
      assert.equal(first.state.reading, false);
      assert.equal(first.removed.length, 0);
      const restored = setup({ record });
      await restored.action.remove();
      assert.equal(restored.calls.length, 0);
      await restored.action.open();
      assert.equal(restored.state.phase, 'confirm');
      assert.equal(restored.deletes.length, 0);
    }
  }
});

test('Закрытие во время DELETE сохраняет uncertain, отменяет сигнал и игнорирует поздний ответ', async () => {
  const record = {};
  const pending = deferred();
  const first = setup({ record, deletes: [pending.promise] });
  await first.action.open();
  const removing = first.action.remove();
  first.deny();
  first.action.stop();
  assert.equal(first.state.phase, 'uncertain');
  assert.equal(first.state.pending, false);
  assert.equal(first.deletes[0].signal.aborted, true);
  const restored = setup({ record, reads: [deleting()] });
  await restored.action.remove();
  assert.equal(restored.calls.length, 0);
  await restored.action.open();
  const state = restored.state;
  pending.resolve({ materialId: ID, jobId: JOB });
  await removing;
  assert.equal(first.accepted.length, 0);
  assert.deepEqual(restored.state, state);
  assert.equal(restored.watches.length, 1);
});

test('Поздние GET/DELETE успехи и ошибки после потери scope не меняют частную запись', async () => {
  for (const stage of ['read', 'remove']) {
    for (const mode of ['deny', 'replace']) {
      for (const outcome of ['success', 'error']) {
        const pending = deferred();
        const s = setup({ reads: stage === 'read' ? [pending.promise] : [], deletes: stage === 'remove' ? [pending.promise] : [] });
        let running;
        if (stage === 'read') running = s.action.open();
        else { await s.action.open(); running = s.action.remove(); }
        const draft = s.record.deletion[ID];
        const prior = { ...draft };
        const count = s.states.length;
        if (mode === 'deny') s.deny();
        else s.record.deletion = {};
        if (outcome === 'error') pending.reject(error('AUTHENTICATION_REQUIRED', 401));
        else pending.resolve(stage === 'read' ? material() : { materialId: ID, jobId: JOB });
        await running;
        assert.deepEqual(draft, prior, `${stage}/${mode}/${outcome}`);
        assert.equal(s.states.length, count);
        assert.equal(s.access.length, 0);
        assert.equal(s.accepted.length, 0);
        assert.equal(s.removed.length, 0);
        s.action.stop();
      }
    }
  }
});

test('Закрытие/выход прекращает watcher; его поздние callbacks не меняют данные', async () => {
  for (const mode of ['stop', 'deny', 'replace']) {
    const s = setup({ reads: [deleting()] });
    await s.action.open();
    if (mode === 'stop') s.action.stop();
    if (mode === 'deny') s.deny();
    if (mode === 'replace') s.record.deletion = {};
    const count = s.states.length;
    s.update(job('succeeded'));
    s.update(job('failed'));
    s.failWatch(error('AUTHENTICATION_REQUIRED', 401));
    assert.equal(s.states.length, count);
    assert.equal(s.access.length, 0);
    assert.equal(s.reads.length, 1);
    assert.equal(s.removed.length, 0);
    s.action.stop();
    assert.equal(s.watches[0].stopped, true);
  }
});

test('Retry-After для 429/REQUEST_IN_PROGRESS сохраняется после закрытия и не запускает запрос по таймеру', async () => {
  for (const failure of [error('RATE_LIMITED', 429, { retryAfterSeconds: 2 }), error('REQUEST_IN_PROGRESS', 409)]) {
    const record = {};
    const first = setup({ record, deletes: [failure] });
    await first.action.open();
    await first.action.remove();
    const retryAt = failure.code === 'RATE_LIMITED' ? 3000 : 2000;
    assert.equal(first.state.phase, 'confirm');
    assert.equal(first.state.retryAt, retryAt);
    await first.action.remove();
    assert.equal(first.deletes.length, 1);
    first.action.stop();
    const restored = setup({ record });
    restored.setNow(retryAt - 1);
    await restored.action.open();
    assert.equal(restored.state.phase, 'paused');
    assert.equal(restored.calls.length, 0);
    restored.setNow(retryAt);
    await restored.action.remove();
    assert.equal(restored.calls.length, 0);
    await restored.action.review();
    assert.equal(restored.state.phase, 'confirm');
    assert.equal(restored.deletes.length, 0);
    await restored.action.remove();
    assert.equal(restored.deletes.length, 1);
  }
});

test('Ограничение на опрос задания запрещает review до Retry-After', async () => {
  const s = setup({ reads: [deleting(), deleting()] });
  await s.action.open();
  s.failWatch(error('RATE_LIMITED', 429, { retryAfterSeconds: 2 }));
  await s.action.review();
  assert.equal(s.reads.length, 1);
  s.setNow(3000);
  assert.equal(s.watches.length, 1);
  await s.action.review();
  assert.equal(s.watches.length, 2);
});

test('Чужой материал или некорректный 202 не попадает в подтверждение/наблюдение', async () => {
  for (const changes of [{ id: OTHER }, { subjectId: OTHER }, { status: 'deleted' }, { status: 'deleting', deletionJobId: null }]) {
    const s = setup({ reads: [material(changes)] });
    await s.action.open();
    assert.equal(s.state.phase, 'error');
    assert.equal(s.state.material, null);
    assert.equal(s.fresh.length, 0);
    await s.action.remove();
    assert.equal(s.deletes.length, 0);
  }
  for (const result of [{ materialId: OTHER, jobId: JOB }, { materialId: ID, jobId: 'broken' }, null]) {
    const s = setup({ deletes: [result] });
    await s.action.open();
    await s.action.remove();
    assert.equal(s.state.phase, 'uncertain');
    assert.equal(s.accepted.length, 0);
    assert.equal(s.watches.length, 0);
    await s.action.remove();
    assert.equal(s.deletes.length, 1);
  }
});

test('Неверный job id/type/status/resultId останавливает опрос без подтверждения удаления', async () => {
  for (const value of [
    job('running', { id: NEXT_JOB }), job('running', { type: 'material.extract_text' }),
    job('unknown'), job('running', { resultId: ID }), job('succeeded', { resultId: OTHER }),
    job('succeeded', { resultId: null }),
  ]) {
    const s = setup({ reads: [deleting()] });
    await s.action.open();
    s.update(value);
    assert.equal(s.state.phase, 'paused');
    assert.equal(s.watches[0].stopped, true);
    assert.equal(s.removed.length, 0);
    assert.equal(s.reads.length, 1);
  }
});

test('Проверка после succeeded не принимает другой subject и не считает временный сбой удалением', async () => {
  for (const result of [material({ subjectId: OTHER }), error('SERVICE_UNAVAILABLE', 503)]) {
    const s = setup({ reads: [deleting(), result, gone()] });
    await s.action.open();
    s.update(job('succeeded'));
    await tick();
    assert.equal(s.state.phase, 'error');
    assert.equal(s.removed.length, 0);
    assert.equal(s.deletes.length, 0);
    await s.action.review();
    assert.equal(s.state.phase, 'done');
  }
});

test('Колбэки родителя могут завершить scope без старого watcher или ложного uncertain', async () => {
  let reading;
  reading = setup({ reads: [deleting()], onRead: () => reading.deny() });
  await reading.action.open();
  assert.equal(reading.watches.length, 0);
  reading.action.stop();
  let accepted;
  accepted = setup({ onAccepted: () => accepted.action.stop() });
  await accepted.action.open();
  await accepted.action.remove();
  assert.equal(accepted.accepted.length, 1);
  assert.equal(accepted.state.pending, false);
  assert.notEqual(accepted.state.phase, 'uncertain');
  assert.equal(accepted.watches.length, 0);
  let removed;
  removed = setup({ reads: [gone()], onRemoved: () => removed.action.stop() });
  await removed.action.open();
  assert.equal(removed.state.phase, 'done');
  assert.deepEqual(removed.removed, [ID]);
});

test('Синхронный watcher terminal также запускает независимую проверку и останавливается', async () => {
  let stopped = 0;
  const s = setup({
    reads: [deleting(), gone()],
    watch(id, handlers) {
      handlers.onUpdate(job('succeeded'));
      return () => { stopped += 1; };
    },
  });
  await s.action.open();
  await tick();
  assert.equal(stopped, 1);
  assert.equal(s.state.phase, 'done');
  assert.equal(s.reads[1].signal.aborted, false);
});

test('Снимок не раскрывает технические блокировки и не позволяет подменить материал', async () => {
  const s = setup({ reads: [material({ processingError: { code: 'PDF_INVALID' } })] });
  await s.action.open();
  const state = s.state;
  state.material.title = 'Подмена';
  state.material.processingError.code = 'Подмена';
  assert.equal(s.state.material.title, 'Лекция 1');
  assert.equal(s.state.material.processingError.code, 'PDF_INVALID');
  assert.deepEqual(Object.keys(state).sort(), ['jobStatus', 'material', 'message', 'pending', 'phase', 'reading', 'retryAt']);
});
