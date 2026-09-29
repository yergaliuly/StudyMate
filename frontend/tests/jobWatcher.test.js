import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';

import { ApiError } from '../src/services/apiClient.js';
import { createJobWatcher } from '../src/services/jobWatcher.js';

const ID = '095f15c2-1f89-4e09-a9ab-b3b281766f57';
const OTHER_ID = '195f15c2-1f89-4e09-a9ab-b3b281766f57';

// Пропускаем микрозадачи без ожидания реального интервала опроса.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();

  return {
    setTimeoutFn(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    size() {
      return timers.size;
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now && timers.delete(id)) {
          timer.callback();
        }
      }
    },
  };
}

function setup(handler = async () => ({ id: ID, status: 'queued' })) {
  const clock = fakeClock();
  const calls = [];
  const updates = [];
  const errors = [];

  const watch = createJobWatcher({
    getById(id, { signal }) {
      calls.push({ id, signal });
      return handler(id, signal, calls.length);
    },
  }, clock);

  return {
    clock, calls, updates, errors, watch,
    start(options = {}) {
      return watch(ID, {
        onUpdate: (job) => updates.push(job),
        onError: (error) => errors.push(error),
        ...options,
      });
    },
  };
}

test('Создание наблюдателя ничего не запускает; неверные настройки отклоняются', () => {
  const state = setup();
  assert.equal(state.calls.length, 0);
  assert.equal(state.clock.size(), 0);
  assert.throws(() => state.watch(ID), TypeError);
  assert.throws(() => state.watch(ID, { onUpdate() {} }), TypeError);
  assert.throws(() => createJobWatcher({}), TypeError);

  for (const intervalMs of [0, 1999, 2000.5, Infinity, 2_147_483_648]) {
    assert.throws(
      () => createJobWatcher({ getById() {} }, { intervalMs }),
      RangeError,
    );
  }
  assert.throws(
    () => createJobWatcher({ getById() {} }, { setTimeoutFn: null }),
    TypeError,
  );
});

test('Опрос проходит queued → running → queued → succeeded с паузами', async () => {
  const statuses = ['queued', 'running', 'queued', 'succeeded'];
  const state = setup(async (id, _signal, count) => ({
    id, status: statuses[count - 1],
  }));

  state.start();
  assert.equal(state.calls.length, 0);
  await flush();
  assert.equal(state.calls.length, 1);

  for (let expected = 2; expected <= 4; expected += 1) {
    state.clock.advance(1999);
    await flush();
    assert.equal(state.calls.length, expected - 1);
    state.clock.advance(1);
    await flush();
    assert.equal(state.calls.length, expected);
  }

  assert.deepEqual(state.updates.map((job) => job.status), statuses);
  assert.ok(state.calls.every((call) => call.id === ID));
  assert.deepEqual(state.errors, []);
  assert.equal(state.clock.size(), 0);
  state.clock.advance(60_000);
  await flush();
  assert.equal(state.calls.length, 4);
});

test('Медленный GET не перекрывается; пауза начинается после ответа', async () => {
  const pending = deferred();
  const state = setup((id, _signal, count) => count === 1
    ? pending.promise
    : Promise.resolve({ id, status: 'succeeded' }));

  state.start();
  await flush();
  state.clock.advance(10_000);
  await flush();
  assert.equal(state.calls.length, 1);
  assert.equal(state.clock.size(), 0);

  pending.resolve({ id: ID, status: 'running' });
  await flush();
  assert.equal(state.clock.size(), 1);
  state.clock.advance(1999);
  await flush();
  assert.equal(state.calls.length, 1);
  state.clock.advance(1);
  await flush();
  assert.equal(state.calls.length, 2);
  assert.equal(state.clock.size(), 0);
});

for (const status of ['succeeded', 'failed', 'cancelled']) {
  test('Состояние ' + status + ' передаётся один раз и завершает опрос', async () => {
    const job = {
      id: ID,
      status,
      error: status === 'failed'
        ? { code: 'JOB_OUTCOME_UNKNOWN', message: 'Нужна проверка результата.' }
        : null,
    };
    const state = setup(async () => job);
    state.start();
    await flush();

    assert.deepEqual(state.updates, [job]);
    assert.deepEqual(state.errors, []);
    assert.equal(state.clock.size(), 0);
    state.clock.advance(60_000);
    await flush();
    assert.equal(state.calls.length, 1);
  });
}

test('stop до первого чтения не отправляет запрос', async () => {
  const state = setup();
  const stop = state.start();
  stop();
  stop();
  await flush();

  assert.equal(state.calls.length, 0);
  assert.equal(state.clock.size(), 0);
  assert.deepEqual(state.updates, []);
  assert.deepEqual(state.errors, []);
});

for (const outcome of ['resolve', 'reject']) {
  test('После stop запоздалый ' + outcome + ' игнорируется', async () => {
    const pending = deferred();
    const parent = new AbortController();
    const state = setup(() => pending.promise);
    const stop = state.start({ signal: parent.signal });
    await flush();

    const requestSignal = state.calls[0].signal;
    assert.notEqual(requestSignal, parent.signal);
    stop();
    stop();
    assert.equal(requestSignal.aborted, true);
    assert.equal(parent.signal.aborted, false);

    if (outcome === 'resolve') pending.resolve({ id: ID, status: 'running' });
    else pending.reject(new Error('Поздняя ошибка'));
    await flush();

    assert.deepEqual(state.updates, []);
    assert.deepEqual(state.errors, []);
    assert.equal(state.clock.size(), 0);
  });
}

test('stop между запросами удаляет таймер, включая таймер с ID 0', async () => {
  const state = setup();
  const stop = state.start();
  await flush();
  assert.equal(state.clock.size(), 1);

  stop();
  assert.equal(state.clock.size(), 0);
  state.clock.advance(60_000);
  await flush();
  assert.equal(state.calls.length, 1);
});

test('Уже отменённый внешний signal не запускает чтение', async () => {
  const parent = new AbortController();
  parent.abort();
  const state = setup();
  state.start({ signal: parent.signal });
  await flush();

  assert.equal(state.calls.length, 0);
  assert.equal(state.clock.size(), 0);
  assert.deepEqual(state.errors, []);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('Внешняя отмена прерывает текущий GET и скрывает поздний ответ', async () => {
  const pending = deferred();
  const parent = new AbortController();
  const state = setup(() => pending.promise);
  state.start({ signal: parent.signal });
  await flush();

  parent.abort();
  assert.equal(state.calls[0].signal.aborted, true);
  pending.resolve({ id: ID, status: 'succeeded' });
  await flush();

  assert.deepEqual(state.updates, []);
  assert.deepEqual(state.errors, []);
  assert.equal(state.clock.size(), 0);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

for (const [code, status] of [
  ['NETWORK_ERROR', 0],
  ['SERVICE_UNAVAILABLE', 503],
  ['AUTHENTICATION_REQUIRED', 401],
  ['JOB_NOT_FOUND', 404],
  ['INVALID_RESPONSE', 200],
  ['REQUEST_CANCELLED', 0],
]) {
  test(code + ' передаётся без подмены и автоматического повтора', async () => {
    const failure = new ApiError('Ошибка чтения.', {
      code, status, retryAfterSeconds: 5,
    });
    const state = setup(async () => { throw failure; });
    state.start();
    await flush();

    assert.equal(state.errors.length, 1);
    assert.equal(state.errors[0], failure);
    assert.equal(state.errors[0].retryAfterSeconds, 5);
    assert.deepEqual(state.updates, []);
    assert.equal(state.clock.size(), 0);
    state.clock.advance(60_000);
    await flush();
    assert.equal(state.calls.length, 1);
  });
}

test('Синхронная ошибка API сообщается после получения функции stop', async () => {
  const failure = new TypeError('Некорректный ID');
  const state = setup(() => { throw failure; });
  let stop;

  stop = state.start({
    onError(error) {
      assert.equal(typeof stop, 'function');
      state.errors.push(error);
      stop();
    },
  });
  await flush();

  assert.deepEqual(state.errors, [failure]);
  assert.equal(state.calls.length, 1);
  assert.equal(state.clock.size(), 0);
});

for (const action of ['stop', 'abort']) {
  test(action + ' внутри onUpdate предотвращает следующий запрос', async () => {
    const parent = new AbortController();
    const state = setup();
    let stop;

    stop = state.start({
      signal: parent.signal,
      onUpdate(job) {
        state.updates.push(job);
        if (action === 'stop') stop();
        else parent.abort();
      },
    });
    await flush();

    assert.equal(state.updates.length, 1);
    assert.equal(state.clock.size(), 0);
    state.clock.advance(60_000);
    await flush();
    assert.equal(state.calls.length, 1);
  });
}

test('Ошибка onUpdate прекращает наблюдение и передаётся в onError', async () => {
  for (const status of ['queued', 'succeeded']) {
    const failure = new Error('Ошибка обработчика интерфейса');
    const state = setup(async () => ({ id: ID, status }));
    state.start({ onUpdate() { throw failure; } });
    await flush();

    assert.deepEqual(state.errors, [failure]);
    assert.equal(state.calls.length, 1);
    assert.equal(state.clock.size(), 0);
  }
});

test('Два наблюдателя независимы: остановка первого не затрагивает второй', async () => {
  const state = setup(async (id) => ({ id, status: 'running' }));
  const secondUpdates = [];
  const stopFirst = state.start();
  const stopSecond = state.watch(OTHER_ID, {
    onUpdate: (job) => secondUpdates.push(job),
    onError: assert.fail,
  });
  await flush();
  assert.equal(state.clock.size(), 2);

  stopFirst();
  assert.equal(state.calls[0].signal.aborted, true);
  assert.equal(state.calls[1].signal.aborted, false);
  assert.equal(state.clock.size(), 1);

  state.clock.advance(2000);
  await flush();
  assert.deepEqual(state.calls.map((call) => call.id), [ID, OTHER_ID, OTHER_ID]);
  assert.equal(state.updates.length, 1);
  assert.equal(secondUpdates.length, 2);

  stopSecond();
  assert.equal(state.clock.size(), 0);
});

test('Завершение и ошибка удаляют подписку на внешний abort', async () => {
  for (const fail of [false, true]) {
    const parent = new AbortController();
    const state = setup(async () => {
      if (fail) throw new Error('Ошибка API');
      return { id: ID, status: 'succeeded' };
    });

    state.start({ signal: parent.signal });
    assert.equal(getEventListeners(parent.signal, 'abort').length, 1);
    await flush();
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
    assert.equal(state.clock.size(), 0);
  }
});