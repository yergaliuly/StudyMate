import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ApiError,
  createApiClient,
} from '../src/services/apiClient.js';

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

function csrfResponse(token = 'test-token') {
  return jsonResponse({
    data: {
      headerName: 'X-CSRF-TOKEN',
      token,
    },
  });
}

function setup(...responses) {
  const calls = [];

  const client = createApiClient({
    baseUrl: '/api/v1',

    fetchImpl: async (url, options) => {
      calls.push({ url, options });

      const next = responses.shift();

      if (typeof next === 'function') {
        return next(url, options);
      }

      if (!next) {
        throw new Error('Незапланированный запрос в тесте.');
      }

      return next;
    },
  });

  return { client, calls };
}

function errorIs(code, status) {
  return (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, code);

    if (status !== undefined) {
      assert.equal(error.status, status);
    }

    return true;
  };
}

test('GET: data, meta, query и cookie', async () => {
  const meta = {
    page: 1,
    pageSize: 20,
    total: 0,
  };

  const { client, calls } = setup(
    jsonResponse({ data: [], meta }),
  );

  const result = await client.request('/subjects', {
    query: {
      q: 'SQL & базы',
      page: 1,
      pageSize: 20,
    },
  });

  assert.deepEqual(result, {
    data: [],
    meta,
    status: 200,
  });

  const url = new URL(
    calls[0].url,
    'https://example.test',
  );

  assert.equal(url.pathname, '/api/v1/subjects');
  assert.equal(url.searchParams.get('q'), 'SQL & базы');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.cache, 'no-store');

  assert.equal(
    calls[0].options.headers.has('X-CSRF-TOKEN'),
    false,
  );
});

test('Изменяющие запросы без CSRF не отправляются', async () => {
  const { client, calls } = setup();

  for (const method of ['POST', 'PATCH', 'DELETE']) {
    await assert.rejects(
      client.request('/subjects', { method }),
      errorIs('CSRF_NOT_INITIALIZED'),
    );
  }

  assert.equal(calls.length, 0);
});

test('POST: JSON, CSRF и прежний Idempotency-Key', async () => {
  const { client, calls } = setup(
    csrfResponse(),
    jsonResponse({ data: { id: 'test-id' } }, 201),
  );

  await client.refreshCsrf();

  const key = '773b6d14-d350-4c27-8db8-b3b1fdb5d159';

  const body = {
    title: 'Физика',
    description: '',
    icon: 'book',
    tone: 'blue',
  };

  const result = await client.request('/subjects', {
    method: 'POST',
    body,
    idempotencyKey: key,
  });

  const options = calls[1].options;

  assert.equal(result.status, 201);
  assert.equal(
    options.headers.get('X-CSRF-TOKEN'),
    'test-token',
  );
  assert.equal(
    options.headers.get('Idempotency-Key'),
    key,
  );
  assert.equal(
    options.headers.get('Content-Type'),
    'application/json',
  );
  assert.deepEqual(JSON.parse(options.body), body);
});

test('FormData отправляется без ручного Content-Type', async () => {
  const { client, calls } = setup(
    csrfResponse(),
    jsonResponse({ data: {} }, 202),
  );

  await client.refreshCsrf();

  const form = new FormData();

  form.append(
    'file',
    new Blob(['%PDF-test']),
    'lecture.pdf',
  );

  await client.request('/materials', {
    method: 'POST',
    body: form,
  });

  assert.equal(calls[1].options.body, form);
  assert.equal(
    calls[1].options.headers.has('Content-Type'),
    false,
  );
  assert.equal(
    calls[1].options.headers.get('X-CSRF-TOKEN'),
    'test-token',
  );
});

test('204: тело ответа не читается, logout без body', async () => {
  const empty = new Response(null, { status: 204 });

  empty.text = () => {
    throw new Error('Тело 204 читать нельзя.');
  };

  const { client, calls } = setup(
    csrfResponse(),
    empty,
  );

  await client.refreshCsrf();

  const result = await client.request('/auth/logout', {
    method: 'POST',
  });

  assert.deepEqual(result, {
    data: null,
    meta: null,
    status: 204,
  });

  assert.equal(calls[1].options.body, undefined);
});

test('422: сохраняются код и ошибки полей', async () => {
  const { client } = setup(
    csrfResponse(),
    jsonResponse({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Проверь поля.',
        fieldErrors: {
          title: 'Слишком короткое название.',
        },
      },
    }, 422),
  );

  await client.refreshCsrf();

  await assert.rejects(
    client.request('/subjects', { method: 'POST' }),
    (error) => {
      errorIs('VALIDATION_FAILED', 422)(error);

      assert.equal(
        error.fieldErrors.title,
        'Слишком короткое название.',
      );

      return true;
    },
  );
});

test('401: возвращается ошибка, а не демонстрационный пользователь', async () => {
  const { client, calls } = setup(
    csrfResponse(),

    jsonResponse({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Войди в аккаунт.',
        fieldErrors: {},
      },
    }, 401),

    jsonResponse({
      data: { id: 'test-user' },
    }),
  );

  await client.refreshCsrf();

  await assert.rejects(
    client.request('/auth/me'),
    errorIs('AUTHENTICATION_REQUIRED', 401),
  );

  // 401 сам по себе не означает, что CSRF
  // анонимной сессии недействителен.
  await client.request('/auth/login', {
    method: 'POST',
    body: {},
  });

  assert.equal(
    calls[2].options.headers.get('X-CSRF-TOKEN'),
    'test-token',
  );
});

test('403 CSRF_INVALID: токен сбрасывается, POST не повторяется', async () => {
  const { client, calls } = setup(
    csrfResponse(),

    jsonResponse({
      error: {
        code: 'CSRF_INVALID',
        message: 'Обнови CSRF.',
        fieldErrors: {},
      },
    }, 403),
  );

  await client.refreshCsrf();

  await assert.rejects(
    client.request('/subjects', { method: 'POST' }),
    errorIs('CSRF_INVALID', 403),
  );

  await assert.rejects(
    client.request('/subjects', { method: 'POST' }),
    errorIs('CSRF_NOT_INITIALIZED'),
  );

  assert.equal(calls.length, 2);
});

test('HTML и неверная оболочка не считаются корректными данными', async () => {
  for (const response of [
    new Response('<html>Страница вместо API</html>'),
    jsonResponse({ unexpected: [] }),
  ]) {
    const { client } = setup(response);

    await assert.rejects(
      client.request('/subjects'),
      errorIs('INVALID_RESPONSE', 200),
    );
  }
});

test('429: Retry-After доступен без автоматического повтора', async () => {
  const { client, calls } = setup(
    jsonResponse({
      error: {
        code: 'RATE_LIMITED',
        message: 'Подожди.',
        fieldErrors: {},
      },
    }, 429, {
      'Retry-After': '30',
    }),
  );

  await assert.rejects(
    client.request('/subjects'),
    (error) => {
      errorIs('RATE_LIMITED', 429)(error);
      assert.equal(error.retryAfterSeconds, 30);
      return true;
    },
  );

  assert.equal(calls.length, 1);
});

test('Сетевая ошибка: запрос не повторяется автоматически', async () => {
  const { client, calls } = setup(() => {
    throw new TypeError('Failed to fetch');
  });

  await assert.rejects(
    client.request('/subjects'),
    errorIs('NETWORK_ERROR', 0),
  );

  assert.equal(calls.length, 1);
});

test('AbortSignal отменяет запрос и передаётся в fetch', async () => {
  const controller = new AbortController();

  const { client, calls } = setup((url, options) => {
    assert.equal(options.signal, controller.signal);

    controller.abort();

    throw new DOMException('Aborted', 'AbortError');
  });

  await assert.rejects(
    client.request('/subjects', {
      signal: controller.signal,
    }),
    errorIs('REQUEST_CANCELLED'),
  );

  await assert.rejects(
    client.request('/subjects', {
      signal: controller.signal,
    }),
    errorIs('REQUEST_CANCELLED'),
  );

  assert.equal(calls.length, 1);
});

test('clearCsrf не позволяет запоздалому ответу вернуть старый токен', async () => {
  let finish;

  const { client, calls } = setup(
    () => new Promise((resolve) => {
      finish = resolve;
    }),
  );

  const pending = client.refreshCsrf();

  client.clearCsrf();
  finish(csrfResponse('old-token'));

  await assert.rejects(
    pending,
    errorIs('CSRF_REFRESH_SUPERSEDED'),
  );

  await assert.rejects(
    client.request('/subjects', { method: 'POST' }),
    errorIs('CSRF_NOT_INITIALIZED'),
  );

  assert.equal(calls.length, 1);
});

test('Внешний URL через этот клиент не отправляется', async () => {
  const { client, calls } = setup();

  await assert.rejects(
    client.request('https://example.test/subjects'),
    TypeError,
  );

  await assert.rejects(
    client.request('/../subjects'),
    TypeError,
  );

  assert.equal(calls.length, 0);
});