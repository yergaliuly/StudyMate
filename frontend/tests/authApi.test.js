import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createApiClient,
  ApiError,
} from '../src/services/apiClient.js';

import { createAuthApi } from '../src/services/authApi.js';

// Только вымышленные данные.
// Не используй этот пароль в настоящих аккаунтах.
const USER = {
  id: '0b7393dd-d32b-4314-b43e-4637821ccdb9',
  email: 'student@example.com',
  displayName: 'Айдана',
};

const FORM = {
  email: '  student@example.com  ',
  password: '  Example-only-password-2026!  ',
  displayName: '  Айдана  ',
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function csrf(token = 'test-csrf') {
  return json({
    data: {
      headerName: 'X-CSRF-TOKEN',
      token,
    },
  });
}

function failure(status, code, fieldErrors = {}) {
  return json({
    error: {
      code,
      message: 'Тестовая ошибка.',
      fieldErrors,
    },
  }, status);
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

  return {
    auth: createAuthApi(client),
    client,
    calls,
  };
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

test('Создание authApi ничего не отправляет', () => {
  const { calls } = setup();

  assert.equal(calls.length, 0);
});

test('GET /auth/me возвращает только публичные поля User', async () => {
  const { auth, calls } = setup(
    json({
      data: {
        ...USER,
        extraField: 'ignored',
      },
    }),
  );

  assert.deepEqual(await auth.getCurrentUser(), USER);
  assert.equal(calls[0].url, '/api/v1/auth/me');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
});

test('Только 401 AUTHENTICATION_REQUIRED означает гостя', async () => {
  const { auth } = setup(
    failure(401, 'AUTHENTICATION_REQUIRED'),
    failure(401, 'INVALID_CREDENTIALS'),
  );

  assert.equal(await auth.getCurrentUser(), null);

  await assert.rejects(
    auth.getCurrentUser(),
    errorIs('INVALID_CREDENTIALS', 401),
  );
});

test('Ошибка сервера не подменяется гостем или demoUser', async () => {
  const { auth } = setup(
    failure(503, 'SERVICE_UNAVAILABLE'),
  );

  await assert.rejects(
    auth.getCurrentUser(),
    errorIs('SERVICE_UNAVAILABLE', 503),
  );
});

test('Некорректный User и неожиданный статус отклоняются', async () => {
  for (const response of [
    json({ data: null }),
    json({ data: { id: 'test-id' } }),
    json({ data: USER }, 201),
  ]) {
    const { auth } = setup(response);

    await assert.rejects(
      auth.getCurrentUser(),
      errorIs('INVALID_RESPONSE'),
    );
  }
});

test('Регистрация: нужные поля, trim, неизменённый пароль, без автовхода', async () => {
  const { auth, calls } = setup(
    csrf(),
    json({ data: USER }, 201),
  );

  await auth.refreshCsrf();

  const created = await auth.register({
    ...FORM,
    ownerId: 'do-not-send',
  });

  assert.deepEqual(created, USER);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/api/v1/auth/csrf');
  assert.equal(calls[1].url, '/api/v1/auth/register');
  assert.equal(calls[1].options.method, 'POST');

  assert.deepEqual(JSON.parse(calls[1].options.body), {
    email: USER.email,
    password: FORM.password,
    displayName: USER.displayName,
  });

  assert.equal(
    calls[1].options.headers.get('X-CSRF-TOKEN'),
    'test-csrf',
  );

  assert.equal(
    calls[1].options.headers.has('Idempotency-Key'),
    false,
  );
});

test('Занятый email сохраняет fieldErrors.email', async () => {
  const { auth } = setup(
    csrf(),

    failure(409, 'EMAIL_ALREADY_EXISTS', {
      email: 'Email занят.',
    }),
  );

  await auth.refreshCsrf();

  await assert.rejects(auth.register(FORM), (error) => {
    errorIs('EMAIL_ALREADY_EXISTS', 409)(error);
    assert.equal(error.fieldErrors.email, 'Email занят.');

    return true;
  });
});

test('Закрытая регистрация возвращает REGISTRATION_CLOSED', async () => {
  const { auth } = setup(
    csrf(),
    failure(403, 'REGISTRATION_CLOSED'),
  );

  await auth.refreshCsrf();

  await assert.rejects(
    auth.register(FORM),
    errorIs('REGISTRATION_CLOSED', 403),
  );
});

test('Регистрация не повторяется после потери ответа', async () => {
  const { auth, calls } = setup(csrf(), () => {
    throw new TypeError('Failed to fetch');
  });

  await auth.refreshCsrf();

  await assert.rejects(
    auth.register(FORM),
    errorIs('NETWORK_ERROR'),
  );

  assert.equal(calls.length, 2);
});

test('Вход: только email/password; старый CSRF забывается', async () => {
  const { auth, client, calls } = setup(
    csrf(),
    json({ data: USER }),
  );

  await auth.refreshCsrf();

  assert.deepEqual(await auth.login(FORM), USER);

  assert.deepEqual(JSON.parse(calls[1].options.body), {
    email: USER.email,
    password: FORM.password,
  });

  assert.equal(calls[1].url, '/api/v1/auth/login');

  assert.equal(
    calls[1].options.headers.has('Idempotency-Key'),
    false,
  );

  await assert.rejects(
    client.request('/subjects', { method: 'POST' }),
    errorIs('CSRF_NOT_INITIALIZED'),
  );

  assert.equal(calls.length, 2);
});

test('Неверные учётные данные не считаются успешным входом', async () => {
  const { auth } = setup(
    csrf(),
    failure(401, 'INVALID_CREDENTIALS'),
  );

  await auth.refreshCsrf();

  await assert.rejects(
    auth.login(FORM),
    errorIs('INVALID_CREDENTIALS', 401),
  );
});

test('Выход: POST без тела, 204, старый CSRF забывается', async () => {
  const { auth, client, calls } = setup(
    csrf(),
    new Response(null, { status: 204 }),
  );

  await auth.refreshCsrf();

  assert.equal(await auth.logout(), undefined);
  assert.equal(calls[1].url, '/api/v1/auth/logout');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.body, undefined);

  await assert.rejects(
    client.request('/subjects', { method: 'POST' }),
    errorIs('CSRF_NOT_INITIALIZED'),
  );
});

test('Ошибка выхода не превращается в подтверждённый выход', async () => {
  const { auth, calls } = setup(
    csrf(),
    failure(503, 'SERVICE_UNAVAILABLE'),
  );

  await auth.refreshCsrf();

  await assert.rejects(
    auth.logout(),
    errorIs('SERVICE_UNAVAILABLE', 503),
  );

  assert.equal(calls.length, 2);
});

test('Без CSRF изменяющий запрос не отправляется', async () => {
  const { auth, calls } = setup();

  for (const operation of [
    () => auth.register(FORM),
    () => auth.login(FORM),
    () => auth.logout(),
  ]) {
    await assert.rejects(
      operation(),
      errorIs('CSRF_NOT_INITIALIZED'),
    );
  }

  assert.equal(calls.length, 0);
});

test('Неверный тип поля не отправляется на сервер', async () => {
  const { auth, calls } = setup();

  await assert.rejects(
    auth.register({
      ...FORM,
      password: 123,
    }),
    TypeError,
  );

  assert.equal(calls.length, 0);
});

test('AbortSignal передаётся; отменённый вход не повторяется', async () => {
  const controller = new AbortController();

  const { auth, calls } = setup(csrf(), (url, options) => {
    assert.equal(options.signal, controller.signal);

    controller.abort();

    throw new DOMException('Aborted', 'AbortError');
  });

  await auth.refreshCsrf();

  await assert.rejects(
    auth.login(FORM, {
      signal: controller.signal,
    }),
    errorIs('REQUEST_CANCELLED'),
  );

  assert.equal(calls.length, 2);
});

test('Новый CSRF получается явно после входа и выхода', async () => {
  const { auth, calls } = setup(
    csrf('before-login'),
    json({ data: USER }),
    csrf('after-login'),
    json({ data: USER }),
    new Response(null, { status: 204 }),
    csrf('after-logout'),
  );

  await auth.refreshCsrf();
  await auth.login(FORM);
  await auth.refreshCsrf();

  assert.deepEqual(await auth.getCurrentUser(), USER);

  await auth.logout();
  await auth.refreshCsrf();

  assert.equal(calls.length, 6);

  assert.equal(
    calls[1].options.headers.get('X-CSRF-TOKEN'),
    'before-login',
  );

  assert.equal(
    calls[4].options.headers.get('X-CSRF-TOKEN'),
    'after-login',
  );
});

test('Сбой нового CSRF не маскирует уже успешный ответ входа', async () => {
  const { auth, calls } = setup(
    csrf(),
    json({ data: USER }),
    failure(503, 'SERVICE_UNAVAILABLE'),
  );

  await auth.refreshCsrf();

  assert.deepEqual(await auth.login(FORM), USER);

  await assert.rejects(
    auth.refreshCsrf(),
    errorIs('SERVICE_UNAVAILABLE', 503),
  );

  assert.equal(calls.length, 3);
});