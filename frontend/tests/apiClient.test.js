import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ApiError,
  createApiClient,
} from '../src/services/apiClient.js';
import { createAuthApi } from '../src/services/authApi.js';

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));
const observe = (promise) => promise.then(
  () => ({ ok: true }),
  (error) => ({ ok: false, error }),
);

function csrfNetwork(context) {
  const calls = [];
  const jar = { cookie: null, token: null };
  context.after(() => {
    for (const call of calls) call.respondError?.(jsonResponse({ error: { code: 'TEST_FINISHED' } }, 503));
  });
  const client = createApiClient({
    fetchImpl: (url, options) => {
      const call = { url, options, cookieAtStart: jar.cookie };
      calls.push(call);
      if (url === '/api/v1/auth/csrf') {
        const response = deferred();
        call.respond = (token, cookie = 'session-' + token, body) => {
          const reply = csrfResponse(token);
          if (body) reply.text = () => body;
          response.resolve({ response: reply, cookie, token });
        };
        call.respondError = (value) => response.resolve({ response: value });
        call.reject = response.reject;
        // Model Set-Cookie at response receipt, independently of the caller's lifetime.
        return response.promise.then((packet) => {
          if (packet.cookie !== undefined) {
            jar.cookie = packet.cookie;
            jar.token = packet.token;
          }
          return packet.response;
        });
      }
      if (options.method === 'POST' && url === '/api/v1/subjects') {
        const matchesSession = jar.cookie && options.headers.get('X-CSRF-TOKEN') === jar.token;
        return Promise.resolve(matchesSession
          ? jsonResponse({ data: { accepted: true } }, 201)
          : jsonResponse({ error: { code: 'CSRF_INVALID' } }, 403));
      }
      throw new Error('Незапланированный запрос в csrfNetwork.');
    },
  });
  return { client, calls, jar, get gets() { return calls.filter((call) => call.url === '/api/v1/auth/csrf'); } };
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

test('CSRF: параллельные читатели разделяют один GET и получают токен той же cookie-сессии', async (context) => {
  const network = csrfNetwork(context);
  const first = observe(network.client.refreshCsrf());
  const second = observe(network.client.refreshCsrf());
  await turn();
  assert.equal(network.gets.length, 1);
  network.gets[0].respond('shared-token', 'shared-cookie');
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
  await network.client.request('/subjects', { method: 'POST' });
  assert.equal(network.calls.at(-1).cookieAtStart, 'shared-cookie');
  assert.equal(network.calls.at(-1).options.headers.get('X-CSRF-TOKEN'), 'shared-token');
});

test('CSRF: abort одного читателя отклоняет его сразу и не отменяет общий transport', async (context) => {
  const network = csrfNetwork(context);
  const owner = new AbortController();
  const first = observe(network.client.refreshCsrf({ signal: owner.signal }));
  const second = observe(network.client.refreshCsrf());
  owner.abort();
  const aborted = await Promise.race([first, turn().then(() => ({ pending: true }))]);
  assert.equal(aborted.pending, undefined, 'Отмена читателя не должна ждать HTTP-ответа.');
  errorIs('REQUEST_CANCELLED')(aborted.error);
  assert.equal(network.gets.length, 1);
  assert.notEqual(network.gets[0].options.signal?.aborted, true);
  network.gets[0].respond('survivor');
  assert.deepEqual(await second, { ok: true });
  await network.client.request('/subjects', { method: 'POST' });
});

test('CSRF: StrictMode cleanup и remount используют тот же незавершённый GET', async (context) => {
  const network = csrfNetwork(context);
  const mount = new AbortController();
  const first = observe(network.client.refreshCsrf({ signal: mount.signal }));
  mount.abort();
  const nextMount = observe(network.client.refreshCsrf());
  await turn();
  assert.equal(network.gets.length, 1);
  assert.notEqual(network.gets[0].options.signal?.aborted, true);
  network.gets[0].respond('remounted', 'one-anonymous-session');
  errorIs('REQUEST_CANCELLED')((await first).error);
  assert.deepEqual(await nextMount, { ok: true });
  assert.equal(network.jar.cookie, 'one-anonymous-session');
});

test('CSRF: уже отменённый signal не делает GET и не очищает готовый токен', async (context) => {
  const network = csrfNetwork(context);
  const initialized = network.client.refreshCsrf();
  network.gets[0].respond('usable');
  await initialized;
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(network.client.refreshCsrf({ signal: cancelled.signal }), errorIs('REQUEST_CANCELLED'));
  assert.equal(network.gets.length, 1);
  await network.client.request('/subjects', { method: 'POST' });
  assert.equal(network.calls.at(-1).options.headers.get('X-CSRF-TOKEN'), 'usable');
});

test('CSRF: новое поколение ждёт старый Set-Cookie и body, затем получает совместимые cookie и токен', async (context) => {
  const network = csrfNetwork(context);
  const oldBody = deferred();
  context.after(() => oldBody.resolve('{}'));
  const old = observe(network.client.refreshCsrf());
  network.client.clearCsrf();
  const fresh = observe(network.client.refreshCsrf());
  const sharedFresh = observe(network.client.refreshCsrf());
  await turn();
  assert.equal(network.gets.length, 1, 'Новый GET не должен обгонять старый ответ с Set-Cookie.');
  network.gets[0].respond('old-token', 'old-cookie', oldBody.promise);
  await turn();
  assert.equal(network.jar.cookie, 'old-cookie');
  assert.equal(network.gets.length, 1, 'Получение headers ещё не завершает drain тела старого GET.');
  oldBody.resolve(JSON.stringify({ data: { headerName: 'X-CSRF-TOKEN', token: 'old-token' } }));
  await turn();
  errorIs('CSRF_REFRESH_SUPERSEDED')((await old).error);
  assert.equal(network.gets.length, 2);
  assert.equal(network.gets[1].cookieAtStart, 'old-cookie');
  const lateFresh = observe(network.client.refreshCsrf());
  await turn();
  assert.equal(network.gets.length, 2, 'Finally старого flight не должен удалить текущий общий GET.');
  network.gets[1].respond('fresh-token', 'fresh-cookie');
  assert.deepEqual(await Promise.all([fresh, sharedFresh, lateFresh]), [{ ok: true }, { ok: true }, { ok: true }]);
  await network.client.request('/subjects', { method: 'POST' });
  assert.equal(network.jar.cookie, 'fresh-cookie');
  assert.equal(network.calls.at(-1).options.headers.get('X-CSRF-TOKEN'), 'fresh-token');
});

test('CSRF: повторный clear отменяет ожидавшее поколение и не отправляет его устаревший GET', async (context) => {
  const network = csrfNetwork(context);
  const original = observe(network.client.refreshCsrf());
  network.client.clearCsrf();
  const skipped = observe(network.client.refreshCsrf());
  network.client.clearCsrf();
  const latest = observe(network.client.refreshCsrf());
  await turn();
  assert.equal(network.gets.length, 1);
  network.gets[0].respond('old');
  await turn();
  errorIs('CSRF_REFRESH_SUPERSEDED')((await original).error);
  errorIs('CSRF_REFRESH_SUPERSEDED')((await skipped).error);
  assert.equal(network.gets.length, 2, 'После drain нужен только GET последнего поколения.');
  network.gets[1].respond('latest');
  assert.deepEqual(await latest, { ok: true });
  await network.client.request('/subjects', { method: 'POST' });
});

test('CSRF: поздний сетевой отказ оставленного transport освобождает очередь нового поколения', async (context) => {
  const network = csrfNetwork(context);
  const owner = new AbortController();
  const abandoned = observe(network.client.refreshCsrf({ signal: owner.signal }));
  owner.abort();
  const cancelled = await Promise.race([abandoned, turn().then(() => ({ pending: true }))]);
  assert.equal(cancelled.pending, undefined);
  errorIs('REQUEST_CANCELLED')(cancelled.error);
  network.client.clearCsrf();
  const fresh = observe(network.client.refreshCsrf());
  await turn();
  assert.equal(network.gets.length, 1);
  assert.notEqual(network.gets[0].options.signal?.aborted, true);
  network.gets[0].reject(new TypeError('Late network failure after caller unmounted'));
  await turn();
  assert.equal(network.gets.length, 2);
  network.gets[1].respond('fresh-after-failure', 'new-cookie');
  assert.deepEqual(await fresh, { ok: true });
  await network.client.request('/subjects', { method: 'POST' });
  await turn();
  assert.equal(network.gets.length, 2, 'Отказ оставленного GET не должен запускать его повтор.');
  assert.equal(network.calls.at(-1).cookieAtStart, 'new-cookie');
});

test('CSRF: общая ошибка не вызывает autoretry; новый ручной вызов получает свежий GET', async (context) => {
  for (const code of ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE', 'INVALID_RESPONSE']) {
    const network = csrfNetwork(context);
    const first = observe(network.client.refreshCsrf());
    const second = observe(network.client.refreshCsrf());
    await turn();
    assert.equal(network.gets.length, 1);
    if (code === 'NETWORK_ERROR') network.gets[0].reject(new TypeError('Failed to fetch'));
    else if (code === 'SERVICE_UNAVAILABLE') network.gets[0].respondError(jsonResponse({ error: { code } }, 503));
    else network.gets[0].respondError(csrfResponse(''));
    const outcomes = await Promise.all([first, second]);
    outcomes.forEach((outcome) => errorIs(code)(outcome.error));
    await turn();
    assert.equal(network.gets.length, 1);
    await assert.rejects(network.client.request('/subjects', { method: 'POST' }), errorIs('CSRF_NOT_INITIALIZED'));
    const retry = observe(network.client.refreshCsrf());
    await turn();
    assert.equal(network.gets.length, 2);
    network.gets[1].respond('recovered');
    assert.deepEqual(await retry, { ok: true });
    await network.client.request('/subjects', { method: 'POST' });
  }
});

test('CSRF: поздний 403 прежнего запроса не сбрасывает токен нового поколения', async () => {
  const rejectedPost = deferred();
  const { client, calls } = setup(
    csrfResponse('old'), () => rejectedPost.promise, csrfResponse('fresh'), jsonResponse({ data: {} }, 201),
  );
  await client.refreshCsrf();
  const oldPost = observe(client.request('/subjects', { method: 'POST' }));
  client.clearCsrf();
  await client.refreshCsrf();
  rejectedPost.resolve(jsonResponse({ error: { code: 'CSRF_INVALID' } }, 403));
  errorIs('CSRF_INVALID', 403)((await oldPost).error);
  await client.request('/subjects', { method: 'POST' });
  assert.equal(calls.at(-1).options.headers.get('X-CSRF-TOKEN'), 'fresh');
  assert.equal(calls.length, 4);
});

test('CSRF: login/logout инвалидируют готовый токен; каждый новый контекст требует свежий GET', async () => {
  const user = { id: 'test-user', email: 'csrf@example.com', displayName: 'Тест' };
  const { client, calls } = setup(
    csrfResponse('anonymous'), jsonResponse({ data: user }), csrfResponse('signed-in'),
    new Response(null, { status: 204 }), csrfResponse('signed-out'), jsonResponse({ data: {} }, 201),
  );
  const auth = createAuthApi(client);
  await auth.refreshCsrf();
  await auth.login({ email: user.email, password: 'test-only-password' });
  await assert.rejects(client.request('/subjects', { method: 'POST' }), errorIs('CSRF_NOT_INITIALIZED'));
  await auth.refreshCsrf();
  await auth.logout();
  await assert.rejects(client.request('/subjects', { method: 'POST' }), errorIs('CSRF_NOT_INITIALIZED'));
  await auth.refreshCsrf();
  await client.request('/subjects', { method: 'POST' });
  assert.deepEqual(calls.map((call) => call.options.method + ' ' + call.url), [
    'GET /api/v1/auth/csrf', 'POST /api/v1/auth/login', 'GET /api/v1/auth/csrf',
    'POST /api/v1/auth/logout', 'GET /api/v1/auth/csrf', 'POST /api/v1/subjects',
  ]);
  assert.equal(calls[1].options.headers.get('X-CSRF-TOKEN'), 'anonymous');
  assert.equal(calls[3].options.headers.get('X-CSRF-TOKEN'), 'signed-in');
  assert.equal(calls[5].options.headers.get('X-CSRF-TOKEN'), 'signed-out');
});
