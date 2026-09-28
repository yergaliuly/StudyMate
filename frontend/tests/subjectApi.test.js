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
  version: 1,
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
  assert.equal(result.subjects[0].version, 1);
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
    version: 1,
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
    version: 900,
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
  assert.equal(result.version, 1);
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
    json({ data: { ...SUBJECT, version: 2 } }),
    new Response(null, { status: 204 }),
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

  await api.update(ID, { title: SUBJECT.title }, { version: 1, signal });
  await api.remove(ID, { signal });

  for (const call of calls.slice(1)) {
    assert.equal(call.options.signal, signal);
  }

  controller.abort();

  for (const request of [
    () => api.list({ signal }),
    () => api.getById(ID, { signal }),
    () => api.create(FORM, { idempotencyKey: KEY, signal }),
    () => api.update(ID, { title: SUBJECT.title }, { version: 1, signal }),
    () => api.remove(ID, { signal }),
  ]) {
    await assert.rejects(request(), errorIs('REQUEST_CANCELLED'));
  }

  assert.equal(calls.length, 6);
});

test('Старый сохранённый ответ создания без version остаётся доступен', async () => {
  const legacySubject = { ...SUBJECT };
  delete legacySubject.version;

  const { api, client, calls } = setup(
    csrf(),
    json({ data: legacySubject }, 201),
  );

  await client.refreshCsrf();
  const result = await api.create(FORM, { idempotencyKey: KEY });

  assert.equal(result.id, ID);
  assert.equal(result.title, SUBJECT.title);
  assert.equal(result.version, undefined);
  assert.equal(calls.length, 2);
});

test('Список и GET требуют положительную безопасную целую version', async () => {
  for (const version of [undefined, null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    const data = { ...SUBJECT, version };

    const single = setup(json({ data }));
    await assert.rejects(single.api.getById(ID), errorIs('INVALID_RESPONSE', 200));

    const list = setup(json({
      data: [data],
      meta: { page: 1, pageSize: 20, total: 1 },
    }));
    await assert.rejects(list.api.list(), errorIs('INVALID_RESPONSE', 200));
  }

  const { api } = setup(json({
    data: { ...SUBJECT, version: Number.MAX_SAFE_INTEGER },
  }));
  assert.equal((await api.getById(ID)).version, Number.MAX_SAFE_INTEGER);
});

test('Создание отклоняет переданную сервером некорректную version', async () => {
  for (const version of [null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    const { api, client, calls } = setup(
      csrf(),
      json({ data: { ...SUBJECT, version } }, 201),
    );
    await client.refreshCsrf();

    await assert.rejects(
      api.create(FORM, { idempotencyKey: KEY }),
      errorIs('INVALID_RESPONSE', 201),
    );
    assert.equal(calls.length, 2);
  }
});

test('PATCH нормализует поля формы, передаёт CSRF и ожидаемую version без ключа', async () => {
  const { api, client, calls } = setup(
    csrf(),
    json({ data: { ...SUBJECT, version: 8 } }),
  );
  await client.refreshCsrf();

  const values = Object.freeze({
    ...FORM,
    version: 999,
    id: KEY,
    ownerId: 'private',
    userId: 'private',
    lectureCount: 99,
    progressPercent: 65,
    createdAt: 'private',
    unknown: 'private',
  });
  const result = await api.update(ID, values, { version: 7 });
  const { url, options } = calls[1];

  assert.equal(url, `/api/v1/subjects/${ID}`);
  assert.equal(options.method, 'PATCH');
  assert.equal(options.headers.get('X-CSRF-TOKEN'), 'test-token');
  assert.equal(options.headers.has('Idempotency-Key'), false);
  assert.deepEqual(JSON.parse(options.body), {
    version: 7,
    title: SUBJECT.title,
    description: SUBJECT.description,
    icon: 'database',
    tone: 'blue',
  });
  assert.equal(result.version, 8);
  assert.equal(result.lectures, 0);
  assert.equal(result.progress, null);
  assert.equal(values.title, FORM.title);
  assert.equal(values.version, 999);
});

test('Частичный PATCH сохраняет отсутствующие поля и позволяет очистить описание', async () => {
  const inherited = Object.assign(Object.create({ title: 'Не отправлять', tone: 'green' }), {
    description: ' \t ',
  });

  for (const [values, body] of [
    [{ title: '  Новый\n предмет  ' }, { version: 1, title: 'Новый предмет' }],
    [inherited, { version: 1, description: '' }],
    [{ icon: 'code' }, { version: 1, icon: 'code' }],
    [{ tone: 'green' }, { version: 1, tone: 'green' }],
  ]) {
    const { api, client, calls } = setup(
      csrf(),
      json({ data: { ...SUBJECT, version: 2 } }),
    );
    await client.refreshCsrf();
    await api.update(ID, values, { version: 1 });
    assert.deepEqual(JSON.parse(calls[1].options.body), body);
  }
});

test('Неверные UUID, version и поля PATCH отклоняются до запроса', async () => {
  const { api, calls } = setup();

  for (const id of [null, '../auth/me', '', 123]) {
    await assert.rejects(api.update(id, { title: 'Новое' }, { version: 1 }), TypeError);
    await assert.rejects(api.remove(id), TypeError);
  }

  for (const version of [undefined, null, 0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(api.update(ID, { title: 'Новое' }, { version }), RangeError);
  }

  for (const values of [undefined, null, [], 'title', 12]) {
    await assert.rejects(api.update(ID, values, { version: 1 }), TypeError);
  }

  for (const values of [{}, { version: 1 }, { ownerId: KEY }, Object.create({ title: 'Новое' })]) {
    await assert.rejects(api.update(ID, values, { version: 1 }), RangeError);
  }

  for (const field of ['title', 'description', 'icon', 'tone']) {
    for (const value of [undefined, null, 1, {}, []]) {
      await assert.rejects(api.update(ID, { [field]: value }, { version: 1 }), TypeError);
    }
  }

  assert.equal(calls.length, 0);
});

test('PATCH и DELETE без CSRF не отправляются', async () => {
  const { api, calls } = setup();

  await assert.rejects(
    api.update(ID, { title: 'Новое' }, { version: 1 }),
    errorIs('CSRF_NOT_INITIALIZED'),
  );
  await assert.rejects(api.remove(ID), errorIs('CSRF_NOT_INITIALIZED'));
  assert.equal(calls.length, 0);
});

test('PATCH принимает только полный предмет с тем же UUID и следующей version', async () => {
  for (const [data, status] of [
    [{ ...SUBJECT, version: 2 }, 201],
    [{ ...SUBJECT, version: 2, id: KEY }, 200],
    [{ ...SUBJECT, version: undefined }, 200],
    [{ ...SUBJECT, version: 0 }, 200],
    [{ ...SUBJECT, version: 1 }, 200],
    [{ ...SUBJECT, version: 3 }, 200],
    [{ ...SUBJECT, version: '2' }, 200],
    [{ id: ID, version: 2 }, 200],
    [{ ...SUBJECT, version: 2, lectureCount: -1 }, 200],
    [null, 200],
  ]) {
    const { api, client, calls } = setup(csrf(), json({ data }, status));
    await client.refreshCsrf();
    await assert.rejects(
      api.update(ID, { title: 'Новое' }, { version: 1 }),
      errorIs('INVALID_RESPONSE', status),
    );
    assert.equal(calls.length, 2);
  }
});

test('DELETE отправляет CSRF без тела, version и ключа; принимает только 204', async () => {
  const { api, client, calls } = setup(csrf(), new Response(null, { status: 204 }));
  await client.refreshCsrf();

  assert.equal(await api.remove(ID), undefined);
  const { url, options } = calls[1];
  assert.equal(url, `/api/v1/subjects/${ID}`);
  assert.equal(options.method, 'DELETE');
  assert.equal(options.body, undefined);
  assert.equal(options.headers.get('X-CSRF-TOKEN'), 'test-token');
  assert.equal(options.headers.has('Idempotency-Key'), false);
  assert.equal(options.headers.has('Content-Type'), false);

  for (const status of [200, 201]) {
    const unexpected = setup(csrf(), json({ data: SUBJECT }, status));
    await unexpected.client.refreshCsrf();
    await assert.rejects(unexpected.api.remove(ID), errorIs('INVALID_RESPONSE', status));
    assert.equal(unexpected.calls.length, 2);
  }
});

test('Ошибки PATCH и DELETE сохраняют код, статус и ошибки полей без повторов', async () => {
  for (const [method, status, code, fieldErrors] of [
    ['update', 401, 'AUTHENTICATION_REQUIRED', {}],
    ['update', 403, 'CSRF_INVALID', {}],
    ['update', 404, 'SUBJECT_NOT_FOUND', {}],
    ['update', 409, 'SUBJECT_VERSION_CONFLICT', {}],
    ['update', 409, 'SUBJECT_TITLE_EXISTS', { title: 'Название занято.' }],
    ['update', 422, 'VALIDATION_FAILED', { title: 'Проверь название.', icon: 'Проверь значок.' }],
    ['update', 503, 'SERVICE_UNAVAILABLE', {}],
    ['remove', 401, 'AUTHENTICATION_REQUIRED', {}],
    ['remove', 403, 'CSRF_INVALID', {}],
    ['remove', 404, 'SUBJECT_NOT_FOUND', {}],
    ['remove', 409, 'SUBJECT_NOT_EMPTY', {}],
    ['remove', 503, 'SERVICE_UNAVAILABLE', {}],
  ]) {
    const { api, client, calls } = setup(csrf(), failure(status, code, fieldErrors));
    await client.refreshCsrf();
    const request = method === 'update'
      ? api.update(ID, { title: 'Новое' }, { version: 1 })
      : api.remove(ID);

    await assert.rejects(request, (error) => {
      errorIs(code, status)(error);
      assert.deepEqual(error.fieldErrors, fieldErrors);
      return true;
    });
    assert.equal(calls.length, 2);
  }
});

test('Неоднозначный сетевой результат PATCH и DELETE не вызывает повтор или GET', async () => {
  for (const method of ['update', 'remove']) {
    const { api, client, calls } = setup(csrf(), () => {
      throw new TypeError('Failed to fetch');
    });
    await client.refreshCsrf();
    const request = method === 'update'
      ? api.update(ID, { description: '' }, { version: 1 })
      : api.remove(ID);

    await assert.rejects(request, errorIs('NETWORK_ERROR'));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.method, method === 'update' ? 'PATCH' : 'DELETE');
  }
});
