import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createApiClient,
  ApiError,
} from '../src/services/apiClient.js';

import { createSubjectApi } from '../src/services/subjectApi.js';

const ID = '63e340c8-c145-4d0b-a648-464547a5fc01';
const KEY = '773b6d14-d350-4c27-8db8-b3b1fdb5d159';

const SUBJECT = {
  id: ID,
  title: 'Базы данных',
  description: 'SQL, таблицы и связи',
  icon: 'database',
  tone: 'blue',
  lectureCount: 0,
  progressPercent: null,
  createdAt: '2026-09-27T10:00:00Z',
};

const FORM = Object.freeze({
  title: '  Базы\t данных  ',
  description: '  SQL, таблицы и связи  ',
  icon: 'database',
  tone: 'blue',
});

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

function csrf() {
  return json({
    data: {
      headerName: 'X-CSRF-TOKEN',
      token: 'test-token',
    },
  });
}

function failure(status, code, fieldErrors = {}, headers = {}) {
  return json({
    error: {
      code,
      message: 'Тестовая ошибка.',
      fieldErrors,
    },
  }, status, headers);
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
    api: createSubjectApi(client),
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

test('Создание адаптера ничего не отправляет', () => {
  const { calls } = setup();

  assert.equal(calls.length, 0);
});

test('Список: поиск передаётся серверу, meta сохраняется', async () => {
  const meta = {
    page: 2,
    pageSize: 10,
    total: 25,
  };

  const { api, calls } = setup(
    json({ data: [SUBJECT], meta }),
  );

  const result = await api.list({
    q: '  SQL %_  ',
    page: 2,
    pageSize: 10,
  });

  const url = new URL(calls[0].url, 'https://example.test');

  assert.equal(url.pathname, '/api/v1/subjects');
  assert.equal(url.searchParams.get('q'), 'SQL %_');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('pageSize'), '10');
  assert.deepEqual(result.meta, meta);
  assert.equal(result.subjects.length, 1);
  assert.equal(calls[0].options.body, undefined);

  assert.equal(
    calls[0].options.headers.has('X-CSRF-TOKEN'),
    false,
  );
});

test('Список по умолчанию: первая страница, 20 элементов, без q', async () => {
  const { api, calls } = setup(json({
    data: [],
    meta: { page: 1, pageSize: 20, total: 0 },
  }));

  await api.list();

  const url = new URL(calls[0].url, 'https://example.test');

  assert.equal(url.searchParams.get('page'), '1');
  assert.equal(url.searchParams.get('pageSize'), '20');
  assert.equal(url.searchParams.has('q'), false);
});

test('Пустой результат не уничтожает total страницы за концом списка', async () => {
  for (const total of [0, 7]) {
    const meta = {
      page: 4,
      pageSize: 20,
      total,
    };

    const { api } = setup(json({ data: [], meta }));

    assert.deepEqual(
      await api.list({ page: 4 }),
      { subjects: [], meta },
    );
  }
});

test('Предмет: UUID сервера, lectureCount → lectures, null не становится нулём', async () => {
  const { api, calls } = setup(
    json({ data: { ...SUBJECT, lectureCount: 3 } }),
  );

  const result = await api.getById(ID);

  assert.deepEqual(result, {
    id: ID,
    title: SUBJECT.title,
    description: SUBJECT.description,
    icon: 'database',
    tone: 'blue',
    lectures: 3,
    progress: null,
    createdAt: SUBJECT.createdAt,
  });

  assert.equal(calls[0].url, `/api/v1/subjects/${ID}`);
  assert.equal(calls[0].options.method, 'GET');

  assert.equal(
    calls[0].options.headers.has('Idempotency-Key'),
    false,
  );
});

test('Создание: только поля формы, CSRF и переданный ключ', async () => {
  const { api, client, calls } = setup(
    csrf(),
    json({ data: SUBJECT }, 201),
  );

  await client.refreshCsrf();

  const result = await api.create({
    ...FORM,
    id: 'local-id',
    ownerId: 'do-not-send',
    userId: 'do-not-send',
    lectures: 99,
    progress: 65,
    lectureCount: 99,
    progressPercent: 65,
    createdAt: 'do-not-send',
  }, {
    idempotencyKey: KEY,
  });

  const options = calls[1].options;

  assert.equal(calls[1].url, '/api/v1/subjects');
  assert.equal(options.method, 'POST');

  assert.equal(
    options.headers.get('X-CSRF-TOKEN'),
    'test-token',
  );

  assert.equal(
    options.headers.get('Idempotency-Key'),
    KEY,
  );

  assert.deepEqual(JSON.parse(options.body), {
    title: SUBJECT.title,
    description: SUBJECT.description,
    icon: 'database',
    tone: 'blue',
  });

  assert.equal(result.id, ID);
  assert.equal(result.lectures, 0);
  assert.equal(result.progress, null);

  // Исходный объект формы не изменился.
  assert.equal(FORM.title, '  Базы\t данных  ');
});

test('Отсутствующее description отправляется пустой строкой', async () => {
  const { api, client, calls } = setup(
    csrf(),
    json({ data: { ...SUBJECT, description: '' } }, 201),
  );

  await client.refreshCsrf();

  await api.create({
    title: 'Базы данных',
    icon: 'book',
    tone: 'blue',
  }, {
    idempotencyKey: KEY,
  });

  assert.equal(
    JSON.parse(calls[1].options.body).description,
    '',
  );
});

test('Неверные параметры списка отклоняются до запроса', async () => {
  const { api, calls } = setup();

  for (const options of [
    { page: 0 },
    { page: 1.5 },
    { pageSize: 101 },
    { pageSize: 0 },
    { q: 'a'.repeat(161) },
  ]) {
    await assert.rejects(api.list(options), RangeError);
  }

  await assert.rejects(api.list({ q: null }), TypeError);

  assert.equal(calls.length, 0);
});

test('Неверный UUID и отсутствующий ключ не создают запрос', async () => {
  const { api, calls } = setup();

  await assert.rejects(
    api.getById('../auth/me'),
    TypeError,
  );

  await assert.rejects(
    api.create(FORM),
    TypeError,
  );

  await assert.rejects(
    api.create(FORM, { idempotencyKey: 'bad-key' }),
    TypeError,
  );

  assert.equal(calls.length, 0);
});

test('Неподходящие типы формы не отправляются', async () => {
  const { api, calls } = setup();

  for (const values of [
    { ...FORM, title: 123 },
    { ...FORM, description: null },
  ]) {
    await assert.rejects(
      api.create(values, { idempotencyKey: KEY }),
      TypeError,
    );
  }

  assert.equal(calls.length, 0);
});

test('Без CSRF создание не отправляется', async () => {
  const { api, calls } = setup();

  await assert.rejects(
    api.create(FORM, { idempotencyKey: KEY }),
    errorIs('CSRF_NOT_INITIALIZED'),
  );

  assert.equal(calls.length, 0);
});

test('422 сохраняет ошибки полей', async () => {
  const { api, client } = setup(
    csrf(),

    failure(422, 'VALIDATION_FAILED', {
      title: 'Проверь название.',
    }),
  );

  await client.refreshCsrf();

  await assert.rejects(
    api.create(FORM, { idempotencyKey: KEY }),
    (error) => {
      errorIs('VALIDATION_FAILED', 422)(error);

      assert.equal(
        error.fieldErrors.title,
        'Проверь название.',
      );

      return true;
    },
  );
});

test('Конфликты названия и ключа не скрываются', async () => {
  for (const code of [
    'SUBJECT_TITLE_EXISTS',
    'IDEMPOTENCY_KEY_REUSED',
  ]) {
    const { api, client, calls } = setup(
      csrf(),
      failure(409, code),
    );

    await client.refreshCsrf();

    await assert.rejects(
      api.create(FORM, { idempotencyKey: KEY }),
      errorIs(code, 409),
    );

    assert.equal(calls.length, 2);
  }
});

test('401 и 503 списка не подменяются пустым списком или mocks', async () => {
  for (const [status, code] of [
    [401, 'AUTHENTICATION_REQUIRED'],
    [503, 'SERVICE_UNAVAILABLE'],
  ]) {
    const { api } = setup(failure(status, code));

    await assert.rejects(
      api.list(),
      errorIs(code, status),
    );
  }
});

test('404 предмета передаётся вызывающему коду', async () => {
  const { api } = setup(
    failure(404, 'SUBJECT_NOT_FOUND'),
  );

  await assert.rejects(
    api.getById(ID),
    errorIs('SUBJECT_NOT_FOUND', 404),
  );
});

test('Некорректные данные и метаданные отклоняются', async () => {
  for (const data of [
    null,
    { ...SUBJECT, lectureCount: -1 },
    { ...SUBJECT, progressPercent: 0 },
    { ...SUBJECT, createdAt: 'yesterday' },
    { ...SUBJECT, id: KEY },
  ]) {
    const { api } = setup(json({ data }));

    await assert.rejects(
      api.getById(ID),
      errorIs('INVALID_RESPONSE', 200),
    );
  }

  for (const payload of [
    { data: [] },

    {
      data: [],
      meta: { page: 1, pageSize: 20, total: -1 },
    },

    {
      data: [],
      meta: { page: 2, pageSize: 20, total: 0 },
    },
  ]) {
    const { api } = setup(json(payload));

    await assert.rejects(
      api.list(),
      errorIs('INVALID_RESPONSE', 200),
    );
  }
});

test('Неожиданный успешный статус не принимается за создание', async () => {
  const { api, client } = setup(
    csrf(),
    json({ data: SUBJECT }, 200),
  );

  await client.refreshCsrf();

  await assert.rejects(
    api.create(FORM, { idempotencyKey: KEY }),
    errorIs('INVALID_RESPONSE', 200),
  );
});

test('После сетевого сбоя только явный повтор с прежним ключом', async () => {
  const { api, client, calls } = setup(
    csrf(),

    () => {
      throw new TypeError('Failed to fetch');
    },

    json({ data: SUBJECT }, 201),
  );

  await client.refreshCsrf();

  await assert.rejects(
    api.create(FORM, { idempotencyKey: KEY }),
    errorIs('NETWORK_ERROR'),
  );

  // Автоматического повтора не было.
  assert.equal(calls.length, 2);

  const result = await api.create(
    FORM,
    { idempotencyKey: KEY },
  );

  assert.equal(result.id, ID);
  assert.equal(calls.length, 3);

  assert.equal(
    calls[1].options.body,
    calls[2].options.body,
  );

  assert.equal(
    calls[1].options.headers.get('Idempotency-Key'),
    KEY,
  );

  assert.equal(
    calls[2].options.headers.get('Idempotency-Key'),
    KEY,
  );
});

test('REQUEST_IN_PROGRESS возвращает Retry-After без автоматического повтора', async () => {
  const { api, client, calls } = setup(
    csrf(),

    failure(
      409,
      'REQUEST_IN_PROGRESS',
      {},
      { 'Retry-After': '3' },
    ),
  );

  await client.refreshCsrf();

  await assert.rejects(
    api.create(FORM, { idempotencyKey: KEY }),
    (error) => {
      errorIs('REQUEST_IN_PROGRESS', 409)(error);
      assert.equal(error.retryAfterSeconds, 3);

      return true;
    },
  );

  assert.equal(calls.length, 2);
});

test('AbortSignal передаётся всеми методами', async () => {
  const { api, client, calls } = setup(
    csrf(),

    json({
      data: [],
      meta: { page: 1, pageSize: 20, total: 0 },
    }),

    json({ data: SUBJECT }),
    json({ data: SUBJECT }, 201),
  );

  const controller = new AbortController();
  const { signal } = controller;

  await client.refreshCsrf();

  await api.list({ signal });
  await api.getById(ID, { signal });

  await api.create(FORM, {
    signal,
    idempotencyKey: KEY,
  });

  for (const call of calls.slice(1)) {
    assert.equal(call.options.signal, signal);
  }

  controller.abort();

  await assert.rejects(
    api.list({ signal }),
    errorIs('REQUEST_CANCELLED'),
  );

  assert.equal(calls.length, 4);
});