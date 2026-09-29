import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiClient, ApiError } from '../src/services/apiClient.js';
import { createStorageApi } from '../src/services/storageApi.js';

function usage(changes = {}) {
  return {
    usedBytes: 1048576,
    reservedBytes: 2097152,
    limitBytes: 524288000,
    maxUploadBytes: 26214400,
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

  return { api: createStorageApi(client), calls };
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
  const { api, calls } = setup();
  assert.equal(typeof api.usage, 'function');
  assert.equal(calls.length, 0);
});

test('Квота: один GET с cookie и signal, без CSRF, тела и ключа', async () => {
  const { api, calls } = setup(json({ data: usage() }));
  const controller = new AbortController();

  assert.deepEqual(await api.usage({ signal: controller.signal }), usage());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/storage/usage');

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

test('Пустая квота, резерв и полностью занятое место различаются', async () => {
  for (const data of [
    usage({ usedBytes: 0, reservedBytes: 0 }),
    usage({ usedBytes: 0, reservedBytes: 524288000 }),
    usage({ usedBytes: 524288000, reservedBytes: 0 }),
    usage({ usedBytes: 500000000, reservedBytes: 24288000 }),
  ]) {
    const { api } = setup(json({ data }));
    assert.deepEqual(await api.usage(), data);
  }
});

test('Лимиты берутся с сервера, безопасные целые сохраняются точно', async () => {
  for (const data of [
    usage({
      usedBytes: 40,
      reservedBytes: 60,
      limitBytes: 100,
      maxUploadBytes: 100,
    }),
    usage({
      usedBytes: Number.MAX_SAFE_INTEGER - 1,
      reservedBytes: 1,
      limitBytes: Number.MAX_SAFE_INTEGER,
      maxUploadBytes: 1,
    }),
  ]) {
    const { api } = setup(json({ data }));
    assert.deepEqual(await api.usage(), data);
  }
});

test('Адаптер возвращает только четыре публичных поля квоты', async () => {
  const { api } = setup(json({
    data: {
      ...usage(),
      ownerId: 'internal-owner',
      bucket: 'internal-bucket',
    },
  }));

  assert.deepEqual(await api.usage(), usage());
});

test('Неверные и отсутствующие числовые поля не превращаются в нули', async () => {
  for (const field of [
    'usedBytes',
    'reservedBytes',
    'limitBytes',
    'maxUploadBytes',
  ]) {
    for (const value of [
      undefined,
      null,
      '1',
      true,
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const { api } = setup(json({ data: usage({ [field]: value }) }));

      await assert.rejects(
        () => api.usage(),
        errorIs('INVALID_RESPONSE', 200),
        field + ': ' + String(value),
      );
    }
  }

  for (const field of ['limitBytes', 'maxUploadBytes']) {
    const { api } = setup(json({ data: usage({ [field]: 0 }) }));
    await assert.rejects(() => api.usage(), errorIs('INVALID_RESPONSE', 200));
  }
});

test('Противоречивые счётчики и лимиты отклоняются', async () => {
  for (const data of [
    usage({ usedBytes: 524288001, reservedBytes: 0 }),
    usage({ usedBytes: 524288000, reservedBytes: 1 }),
    usage({ usedBytes: 0, reservedBytes: 524288001 }),
    usage({ maxUploadBytes: 524288001 }),
    usage({
      usedBytes: Number.MAX_SAFE_INTEGER,
      reservedBytes: 1,
      limitBytes: Number.MAX_SAFE_INTEGER,
      maxUploadBytes: 1,
    }),
  ]) {
    const { api } = setup(json({ data }));
    await assert.rejects(() => api.usage(), errorIs('INVALID_RESPONSE', 200));
  }
});

test('HTML, неверная оболочка, форма данных и успешный статус отклоняются', async () => {
  for (const response of [
    new Response('<html>Ошибка прокси</html>', { status: 200 }),
    json({ result: usage() }),
    json({ data: null }),
    json({ data: [] }),
    json({ data: 'quota' }),
    json({ data: usage() }, 201),
    new Response(null, { status: 204 }),
  ]) {
    const { api, calls } = setup(response);
    await assert.rejects(() => api.usage(), errorIs('INVALID_RESPONSE'));
    assert.equal(calls.length, 1);
  }
});

for (const [status, code] of [
  [401, 'AUTHENTICATION_REQUIRED'],
  [429, 'RATE_LIMITED'],
  [503, 'SERVICE_UNAVAILABLE'],
]) {
  test('HTTP ' + status + ' сохраняется без подмены квоты и повтора', async () => {
    const headers = status === 401 ? {} : { 'Retry-After': '3' };

    const { api, calls } = setup(json({
      error: {
        code,
        message: 'Не удалось получить квоту.',
        fieldErrors: {},
      },
    }, status, headers));

    await assert.rejects(() => api.usage(), (error) => {
      errorIs(code, status)(error);
      assert.equal(error.message, 'Не удалось получить квоту.');
      assert.equal(error.retryAfterSeconds, status === 401 ? null : 3);
      return true;
    });

    assert.equal(calls.length, 1);
  });
}

test('Сетевая ошибка не вызывает повтор и не возвращает пустую квоту', async () => {
  const { api, calls } = setup(() => {
    throw new TypeError('Соединение потеряно');
  });

  await assert.rejects(() => api.usage(), errorIs('NETWORK_ERROR'));
  assert.equal(calls.length, 1);
});

test('Отменённый заранее запрос не отправляется', async () => {
  const controller = new AbortController();
  controller.abort();
  const { api, calls } = setup();

  await assert.rejects(
    () => api.usage({ signal: controller.signal }),
    errorIs('REQUEST_CANCELLED'),
  );

  assert.equal(calls.length, 0);
});

test('Отмена во время GET прекращает чтение без повторного запроса', async () => {
  const controller = new AbortController();

  const { api, calls } = setup((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new DOMException('Запрос отменён', 'AbortError'));
    }, { once: true });
  }));

  const pending = api.usage({ signal: controller.signal });
  controller.abort();

  await assert.rejects(pending, errorIs('REQUEST_CANCELLED'));
  assert.equal(calls.length, 1);
});

test('Явное обновление квоты получает новые значения без локального кеша', async () => {
  const before = usage();
  const after = usage({ usedBytes: 3145728, reservedBytes: 0 });
  const { api, calls } = setup(json({ data: before }), json({ data: after }));

  assert.deepEqual(await api.usage(), before);
  assert.deepEqual(await api.usage(), after);
  assert.equal(calls.length, 2);
});