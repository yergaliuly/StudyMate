import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiClient, ApiError } from '../src/services/apiClient.js';
import { createJobApi, isTerminalJobStatus } from '../src/services/jobApi.js';

const ID = '095f15c2-1f89-4e09-a9ab-b3b281766f57';
const OTHER_ID = '195f15c2-1f89-4e09-a9ab-b3b281766f57';
const TIME = '2026-09-29T10:00:00.123456789Z';

function job(status = 'queued', changes = {}) {
  return {
    id: ID,
    type: 'test.example',
    status,
    attemptCount: ['queued', 'cancelled'].includes(status) ? 0 : 1,
    maxAttempts: 3,
    createdAt: TIME,
    updatedAt: TIME,
    nextAttemptAt: status === 'queued' ? TIME : null,
    finishedAt: ['succeeded', 'failed', 'cancelled'].includes(status) ? TIME : null,
    resultId: null,
    error: status === 'failed'
      ? { code: 'JOB_PROCESSING_FAILED', message: 'Не удалось выполнить задание.' }
      : null,
    ...changes,
  };
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

  return { api: createJobApi(client), calls };
}

function errorIs(code, status) {
  return (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

test('Создание адаптера не отправляет запросов', () => {
  assert.equal(setup().calls.length, 0);
});

test('GET передаёт cookie и signal, не требует CSRF и принимает регистр UUID', async () => {
  const { api, calls } = setup(json({ data: job() }));
  const controller = new AbortController();

  const result = await api.getById(ID.toUpperCase(), {
    signal: controller.signal,
  });

  assert.deepEqual(result, job());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/jobs/' + ID.toUpperCase());

  const options = calls[0].options;
  assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'include');
  assert.equal(options.mode, 'same-origin');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.body, undefined);
  assert.equal(options.signal, controller.signal);
  assert.equal(options.headers.has('X-CSRF-TOKEN'), false);
  assert.equal(options.headers.has('Idempotency-Key'), false);
});

for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled']) {
  test('Чтение состояния ' + status + ' возвращает данные задания', async () => {
    const data = job(status);
    const { api } = setup(json({ data }));
    assert.deepEqual(await api.getById(ID), data);
  });
}

test('Успех без resultId и с resultId, очередь после повтора допустимы', async () => {
  for (const data of [
    job('succeeded'),
    job('succeeded', { resultId: OTHER_ID }),
    job('queued', { attemptCount: 2 }),
  ]) {
    const { api } = setup(json({ data }));
    assert.deepEqual(await api.getById(ID), data);
  }
});

test('Только succeeded, failed и cancelled считаются завершёнными', () => {
  for (const status of ['succeeded', 'failed', 'cancelled']) {
    assert.equal(isTerminalJobStatus(status), true);
  }
  for (const status of ['queued', 'running', 'unknown', undefined]) {
    assert.equal(isTerminalJobStatus(status), false);
  }
});

test('Все публичные ошибки failed читаются с HTTP 200', async () => {
  for (const code of [
    'JOB_TEMPORARY_FAILURE',
    'JOB_PROCESSING_FAILED',
    'JOB_ATTEMPTS_EXHAUSTED',
    'JOB_LEASE_EXPIRED',
    'JOB_OUTCOME_UNKNOWN',
  ]) {
    const data = job('failed', {
      error: { code, message: 'Безопасное сообщение задания.' },
    });
    const { api } = setup(json({ data }));
    assert.deepEqual(await api.getById(ID), data);
  }
});

test('Возвращаются только публичные поля задания и его ошибки', async () => {
  const data = job('failed');
  const { api } = setup(json({
    data: {
      ...data,
      ownerId: OTHER_ID,
      payload: { private: 'Внутренние данные' },
      leaseToken: 'internal-token',
      error: { ...data.error, internal: 'Внутреннее исключение' },
    },
  }));

  assert.deepEqual(await api.getById(ID), data);
});

test('Неверный UUID отклоняется до HTTP-запроса', async () => {
  const { api, calls } = setup();
  for (const id of [
    '', null, undefined, '095f15c2', '../auth/me',
    'https://example.com/' + ID, ID + '?extra=1',
  ]) {
    await assert.rejects(() => api.getById(id), TypeError);
  }
  assert.equal(calls.length, 0);
});

test('Неверные поля и несогласованные состояния ответа отклоняются', async () => {
  const invalid = [
    job('queued', { id: OTHER_ID }),
    job('queued', { type: '' }),
    job('queued', { status: 'unknown' }),
    job('queued', { attemptCount: -1 }),
    job('queued', { attemptCount: 0.5 }),
    job('queued', { attemptCount: 4 }),
    job('queued', { maxAttempts: 0 }),
    job('queued', { maxAttempts: '3' }),
    job('queued', { createdAt: 'не дата' }),
    job('queued', { updatedAt: null }),
    job('queued', { nextAttemptAt: null }),
    job('queued', { finishedAt: TIME }),
    job('queued', { resultId: OTHER_ID }),
    job('queued', { resultId: undefined }),
    job('running', { nextAttemptAt: TIME }),
    job('running', { error: { code: 'JOB_PROCESSING_FAILED', message: 'Ошибка' } }),
    job('succeeded', { finishedAt: null }),
    job('succeeded', { resultId: 'не UUID' }),
    job('failed', { error: null }),
    job('failed', { error: { code: 'INTERNAL', message: 'Подробности' } }),
    job('failed', { error: { code: 'JOB_PROCESSING_FAILED', message: '' } }),
    null,
    [],
  ];

  for (const data of invalid) {
    const { api } = setup(json({ data }));
    await assert.rejects(
      () => api.getById(ID),
      errorIs('INVALID_RESPONSE', 200),
      JSON.stringify(data),
    );
  }
});

test('HTML, неверная оболочка и неожиданный успешный статус отклоняются', async () => {
  for (const response of [
    new Response('<html>Ошибка прокси</html>', { status: 200 }),
    json({ result: job() }),
    json({ data: job() }, 201),
    new Response(null, { status: 204 }),
  ]) {
    const { api, calls } = setup(response);
    await assert.rejects(() => api.getById(ID), errorIs('INVALID_RESPONSE'));
    assert.equal(calls.length, 1);
  }
});

for (const [status, code] of [
  [401, 'AUTHENTICATION_REQUIRED'],
  [404, 'JOB_NOT_FOUND'],
  [503, 'SERVICE_UNAVAILABLE'],
]) {
  test('HTTP ' + status + ' сохраняется без подмены задания и повтора', async () => {
    const { api, calls } = setup(json({
      error: { code, message: 'Ошибка запроса.', fieldErrors: {} },
    }, status, status === 503 ? { 'Retry-After': '3' } : {}));

    await assert.rejects(() => api.getById(ID), (error) => {
      errorIs(code, status)(error);
      if (status === 503) assert.equal(error.retryAfterSeconds, 3);
      return true;
    });
    assert.equal(calls.length, 1);
  });
}

test('Сетевая ошибка не вызывает автоматический повтор', async () => {
  const { api, calls } = setup(() => {
    throw new TypeError('Соединение потеряно');
  });

  await assert.rejects(() => api.getById(ID), errorIs('NETWORK_ERROR'));
  assert.equal(calls.length, 1);
});

test('Отменённый заранее запрос не отправляется', async () => {
  const controller = new AbortController();
  controller.abort();
  const { api, calls } = setup();

  await assert.rejects(
    () => api.getById(ID, { signal: controller.signal }),
    errorIs('REQUEST_CANCELLED'),
  );
  assert.equal(calls.length, 0);
});

test('Отмена во время GET прекращает чтение без новых запросов', async () => {
  const controller = new AbortController();
  const { api, calls } = setup((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new DOMException('Запрос отменён', 'AbortError'));
    }, { once: true });
  }));

  const pending = api.getById(ID, { signal: controller.signal });
  controller.abort();

  await assert.rejects(pending, errorIs('REQUEST_CANCELLED'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
});