import { test, expect } from '@playwright/test';

// Вымышленные данные и HTTP-mocks: настоящий backend и R2 не используются.
const MIB = 1024 * 1024;

const USER = {
  id: '1164903f-7ba3-40d8-8c79-b9009361b950',
  email: 'materials@example.com',
  displayName: 'Студент Материалов',
};

const OTHER_USER = {
  id: '3264903f-7ba3-40d8-8c79-b9009361b951',
  email: 'other-materials@example.com',
  displayName: 'Другой Студент',
};

const SUBJECT = {
  id: 'c6f924b2-b4b0-4926-8d28-a7409a3f2710',
  title: 'Математический анализ',
  description: 'Описание предмета с сервера',
  icon: 'book',
  tone: 'blue',
  lectureCount: 0,
  progressPercent: null,
  version: 1,
  createdAt: '2026-09-28T12:00:00Z',
};

const OTHER_SUBJECT = {
  ...SUBJECT,
  id: 'd6f924b2-b4b0-4926-8d28-a7409a3f2711',
  title: 'Общая физика',
};

const USAGE = {
  usedBytes: 25 * MIB,
  reservedBytes: 10 * MIB,
  limitBytes: 500 * MIB,
  maxUploadBytes: 25 * MIB,
};

const states = new WeakMap();

function material(number, subjectId = SUBJECT.id, overrides = {}) {
  return {
    id: 'f73de5ee-311e-45cb-b7e2-' + String(number).padStart(12, '0'),
    subjectId,
    title: 'Материал ' + number,
    fileName: 'lecture-' + number + '.pdf',
    contentType: 'application/pdf',
    sizeBytes: MIB,
    status: 'stored',
    processingStatus: 'not_started',
    version: 1,
    createdAt: '2026-09-28T12:00:00Z',
    updatedAt: '2026-09-28T12:00:00Z',
    deletionJobId: null,
    processingJobId: null,
    pageCount: null,
    textCharacters: null,
    processingError: null,
    ...overrides,
  };
}

async function fail(route, status, code, fieldErrors = {}, headers = {}) {
  await route.fulfill({
    status,
    headers,
    json: {
      error: {
        code,
        message: 'Внутренние подробности сервера.',
        fieldErrors,
      },
    },
  });
}

async function listResponse(route, data, total = data.length) {
  const params = new URL(route.request().url()).searchParams;

  await route.fulfill({
    status: 200,
    json: {
      data,
      meta: {
        page: Number(params.get('page')),
        pageSize: Number(params.get('pageSize')),
        total,
      },
    },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function account(page) {
  return page.locator('#account-main-content');
}

function materials(page) {
  return page.getByRole('region', {
    name: 'Файлы предмета',
    exact: true,
  });
}

function quota(page) {
  return page.getByRole('region', {
    name: 'Хранилище аккаунта',
    exact: true,
  });
}

async function mockMaterials(page, options = {}) {
  const state = {
    user: USER,
    loginUser: USER,
    subjects: [SUBJECT, OTHER_SUBJECT],
    files: [material(1)],
    usage: { ...USAGE },
    lists: [],
    subjectGets: [],
    usageGets: 0,
    csrfCount: 0,
    writes: [],
    unexpected: [],
    pageErrors: [],
    onList: null,
    onUsage: null,
    onSubject: null,
    ...options,
  };

  states.set(page, state);
  page.on('pageerror', (error) => state.pageErrors.push(error.message));

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice('/api/v1'.length);
    const method = request.method();

    if (method !== 'GET') {
      state.writes.push(method + ' ' + path);
    }

    if (method === 'GET' && path === '/auth/csrf') {
      await route.fulfill({
        status: 200,
        json: {
          data: {
            headerName: 'X-CSRF-TOKEN',
            token: 'materials-csrf-' + ++state.csrfCount,
          },
        },
      });
      return;
    }

    if (method === 'GET' && path === '/auth/me') {
      if (state.user) {
        await route.fulfill({
          status: 200,
          json: { data: state.user },
        });
      } else {
        await fail(route, 401, 'AUTHENTICATION_REQUIRED');
      }
      return;
    }

    if (method === 'POST' && path === '/auth/login') {
      state.user = state.loginUser;
      await route.fulfill({
        status: 200,
        json: { data: state.user },
      });
      return;
    }

    if (method === 'POST' && path === '/auth/logout') {
      state.user = null;
      await route.fulfill({ status: 204, body: '' });
      return;
    }

    if (method === 'GET' && path === '/subjects') {
      await listResponse(route, state.subjects);
      return;
    }

    if (method === 'GET' && path.startsWith('/subjects/')) {
      const id = path.slice('/subjects/'.length);
      state.subjectGets.push(id);

      if (state.onSubject) {
        await state.onSubject(route, id);
      } else {
        const item = state.subjects.find((value) => value.id === id);

        if (item) {
          await route.fulfill({
            status: 200,
            json: { data: item },
          });
        } else {
          await fail(route, 404, 'SUBJECT_NOT_FOUND');
        }
      }
      return;
    }

    if (method === 'GET' && path === '/storage/usage') {
      state.usageGets += 1;

      if (state.onUsage) {
        await state.onUsage(route);
      } else {
        await route.fulfill({
          status: 200,
          json: { data: state.usage },
        });
      }
      return;
    }

    if (method === 'GET' && path === '/materials') {
      const params = url.searchParams;
      state.lists.push(Object.fromEntries(params));

      if (state.onList) {
        await state.onList(route, params);
      } else {
        const q = (params.get('q') || '').toLocaleLowerCase('ru');

        const matches = state.files.filter((item) =>
          item.subjectId === params.get('subjectId')
          && item.title.toLocaleLowerCase('ru').includes(q));

        const size = Number(params.get('pageSize'));
        const offset = (Number(params.get('page')) - 1) * size;

        await listResponse(
          route,
          matches.slice(offset, offset + size),
          matches.length,
        );
      }
      return;
    }

    state.unexpected.push(method + ' ' + path);
    await fail(route, 500, 'UNEXPECTED_TEST_REQUEST');
  });

  await page.goto('/');

  await expect(account(page).getByRole('heading', {
    name: SUBJECT.title,
    exact: true,
  })).toBeVisible();

  return state;
}

test.afterEach(async ({ page }) => {
  const state = states.get(page);

  expect(
    state?.unexpected ?? [],
    'Неожиданные API-запросы',
  ).toEqual([]);

  expect(
    state?.pageErrors ?? [],
    'Ошибки JavaScript в браузере',
  ).toEqual([]);
});

async function openSubject(page, subject = SUBJECT) {
  await account(page).getByRole('button', {
    name: 'Открыть предмет «' + subject.title + '»',
    exact: true,
  }).click();

  const dialog = page.getByRole('dialog', {
    name: 'Предмет',
    exact: true,
  });

  await expect(dialog.getByRole('button', {
    name: 'Материалы предмета',
    exact: true,
  })).toBeEnabled();

  return dialog;
}

async function enterMaterials(page, dialog) {
  await dialog.getByRole('button', {
    name: 'Материалы предмета',
    exact: true,
  }).click();

  await expect(materials(page)).toBeVisible();
}

async function openMaterials(page, subject = SUBJECT) {
  await enterMaterials(page, await openSubject(page, subject));
}

test('Свежий предмет, три состояния файлов и квота с учётом резерва', async ({ page }) => {
  const state = await mockMaterials(page, {
    files: [
      material(1),
      material(2, SUBJECT.id, { status: 'uploading' }),
      material(3, SUBJECT.id, {
        status: 'deleting',
        deletionJobId: '12345678-1234-4234-8234-123456789012',
      }),
    ],
  });

  const dialog = await openSubject(page);

  state.onSubject = (route) => route.fulfill({
    status: 200,
    json: {
      data: {
        ...SUBJECT,
        title: 'Свежая версия предмета',
        version: 2,
      },
    },
  });

  await enterMaterials(page, dialog);

  await expect(materials(page).getByRole('heading', {
    name: 'Свежая версия предмета',
    exact: true,
  })).toBeVisible();

  await expect(materials(page).locator('.account-material-card')).toHaveCount(3);

  for (const text of [
    'Сохранён',
    'Сохранение не завершено',
    'Удаление не завершено',
  ]) {
    await expect(materials(page).getByText(text, { exact: true })).toBeVisible();
  }

  await expect(quota(page).getByRole('meter'))
    .toHaveAttribute('aria-valuenow', String(35 * MIB));

  await expect(quota(page).getByRole('meter'))
    .toHaveAttribute('aria-valuemax', String(500 * MIB));

  await expect(
    quota(page).locator('dl > div').filter({ hasText: 'Доступно' }).locator('dd'),
  ).toHaveText('465 МиБ');

  await expect(materials(page).getByRole('progressbar')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  expect(state.subjectGets).toHaveLength(2);
  expect(state.lists).toEqual([
    { subjectId: SUBJECT.id, page: '1', pageSize: '20' },
  ]);
  expect(state.writes).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  const saved = await page.evaluate(() => JSON.stringify({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));

  for (const value of [USER.email, SUBJECT.id, 'lecture-1.pdf']) {
    expect(saved).not.toContain(value);
  }
});

test('Пустой список и поиск различаются; поиск сохраняется отдельно для каждого предмета', async ({ page }) => {
  const state = await mockMaterials(page, { files: [] });
  await openMaterials(page);

  await expect(materials(page).getByText(
    'Пока нет материалов',
    { exact: true },
  )).toBeVisible();

  await materials(page).getByLabel('Поиск материалов').fill('  Неизвестный  ');

  await expect(materials(page).getByText(
    'Ничего не найдено',
    { exact: true },
  )).toBeVisible();

  expect(state.lists.at(-1).q).toBe('Неизвестный');

  await materials(page).getByRole('button', {
    name: 'Назад к предметам',
    exact: true,
  }).click();

  await openMaterials(page, OTHER_SUBJECT);

  await expect(materials(page).getByLabel('Поиск материалов')).toHaveValue('');

  await expect(materials(page).getByText(
    'Пока нет материалов',
    { exact: true },
  )).toBeVisible();

  expect(state.lists.at(-1).subjectId).toBe(OTHER_SUBJECT.id);

  await materials(page).getByRole('button', {
    name: 'Назад к предметам',
    exact: true,
  }).click();

  await openMaterials(page);

  await expect(materials(page).getByLabel('Поиск материалов'))
    .toHaveValue('  Неизвестный  ');

  await expect(materials(page).getByText(
    'Ничего не найдено',
    { exact: true },
  )).toBeVisible();
});

test('Пагинация использует total; новый поиск сбрасывает страницу и игнорирует старый ответ', async ({ page }) => {
  const state = await mockMaterials(page, {
    files: Array.from({ length: 21 }, (_, index) => material(index + 1)),
  });

  await openMaterials(page);
  await expect(materials(page).locator('.account-material-card')).toHaveCount(20);

  await materials(page).getByRole('button', {
    name: 'Следующая страница',
    exact: true,
  }).click();

  await expect(materials(page).getByRole('heading', {
    name: 'Материал 21',
    exact: true,
  })).toBeVisible();

  await expect(materials(page).getByRole('button', {
    name: 'Следующая страница',
    exact: true,
  })).toBeDisabled();

  expect(state.lists.at(-1).page).toBe('2');

  const late = deferred();
  let responded = false;

  state.onList = async (route, params) => {
    if (params.get('q') === 'Старый') {
      await late.promise;

      await listResponse(route, [
        material(30, SUBJECT.id, { title: 'Запоздалый файл' }),
      ]);

      responded = true;
    } else {
      await listResponse(route, [
        material(31, SUBJECT.id, { title: 'Актуальный файл' }),
      ]);
    }
  };

  try {
    await materials(page).getByLabel('Поиск материалов').fill('Старый');
    await expect.poll(() => state.lists.at(-1)?.q).toBe('Старый');
    expect(state.lists.at(-1).page).toBe('1');

    await materials(page).getByLabel('Поиск материалов').fill('Новый');

    await expect(materials(page).getByRole('heading', {
      name: 'Актуальный файл',
      exact: true,
    })).toBeVisible();
  } finally {
    late.resolve();
  }

  await expect.poll(() => responded).toBe(true);
  await expect(materials(page)).not.toContainText('Запоздалый файл');

  expect(state.lists.at(-1)).toEqual({
    subjectId: SUBJECT.id,
    q: 'Новый',
    page: '1',
    pageSize: '20',
  });
});

test('Ошибка списка не выглядит пустым результатом; повтор выполняется вручную', async ({ page }) => {
  await page.clock.install();

  const state = await mockMaterials(page, {
    onList: (route) => fail(route, 503, 'SERVICE_UNAVAILABLE'),
  });

  await openMaterials(page);

  await expect(materials(page).getByRole('alert'))
    .toContainText('Не удалось получить актуальный список');

  await expect(quota(page).getByRole('meter')).toBeVisible();

  await expect(materials(page).getByText(
    'Пока нет материалов',
    { exact: true },
  )).toHaveCount(0);

  await expect(materials(page))
    .not.toContainText('Внутренние подробности сервера.');

  await page.clock.runFor(3_000);
  expect(state.lists).toHaveLength(1);

  state.onList = null;

  await materials(page).getByRole('button', {
    name: 'Повторить загрузку материалов',
    exact: true,
  }).click();

  await expect(materials(page).getByRole('heading', {
    name: 'Материал 1',
    exact: true,
  })).toBeVisible();

  expect(state.lists).toHaveLength(2);
  expect(state.writes).toEqual([]);
});

test('Ошибка квоты скрывает прежние числа, сохраняя список; квота обновляется отдельно', async ({ page }) => {
  const state = await mockMaterials(page);
  await openMaterials(page);

  await expect(quota(page).getByRole('meter')).toBeVisible();

  await expect(materials(page).getByRole('heading', {
    name: 'Материал 1',
    exact: true,
  })).toBeVisible();

  const lists = state.lists.length;
  state.onUsage = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');

  await quota(page).getByRole('button', {
    name: 'Обновить сведения о хранилище',
    exact: true,
  }).click();

  await expect(quota(page).getByRole('alert')).toBeVisible();
  await expect(quota(page).getByRole('meter')).toHaveCount(0);
  await expect(quota(page).locator('dd')).toHaveCount(0);

  await expect(materials(page).getByRole('heading', {
    name: 'Материал 1',
    exact: true,
  })).toBeVisible();

  state.onUsage = null;
  state.usage = {
    ...USAGE,
    usedBytes: 30 * MIB,
    reservedBytes: 0,
  };

  await quota(page).getByRole('button', {
    name: 'Обновить сведения о хранилище',
    exact: true,
  }).click();

  await expect(quota(page).getByRole('meter'))
    .toHaveAttribute('aria-valuenow', String(30 * MIB));

  expect(state.usageGets).toBe(3);
  expect(state.lists).toHaveLength(lists);
});

test('Ошибка свежего GET предмета не подменяется данными из окна; повтор восстанавливает страницу', async ({ page }) => {
  const state = await mockMaterials(page);
  const dialog = await openSubject(page);

  state.onSubject = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');

  await enterMaterials(page, dialog);

  await expect(materials(page).getByRole('alert'))
    .toHaveText('Не удалось загрузить предмет.');

  await expect(materials(page).getByRole('heading', {
    name: SUBJECT.title,
    exact: true,
  })).toHaveCount(0);

  await expect(quota(page)).toHaveCount(0);

  state.onSubject = null;

  await materials(page).getByRole('button', {
    name: 'Повторить загрузку предмета',
    exact: true,
  }).click();

  await expect(materials(page).getByRole('heading', {
    name: SUBJECT.title,
    exact: true,
  })).toBeVisible();

  await expect(quota(page).getByRole('meter')).toBeVisible();
  expect(state.subjectGets).toHaveLength(3);
});

for (const source of ['subject', 'list']) {
  test('Предмет удалён: 404 из ' + source + ' скрывает материалы и квоту', async ({ page }) => {
    const state = await mockMaterials(page);
    const dialog = await openSubject(page);

    if (source === 'subject') {
      state.onSubject = (route) => fail(route, 404, 'SUBJECT_NOT_FOUND');
    } else {
      state.onList = (route) => fail(route, 404, 'SUBJECT_NOT_FOUND');
    }

    await enterMaterials(page, dialog);

    await expect(materials(page).getByRole('heading', {
      name: 'Предмет недоступен',
      exact: true,
    })).toBeVisible();

    await expect(quota(page)).toHaveCount(0);
    await expect(materials(page).locator('.account-material-card')).toHaveCount(0);

    await materials(page).getByRole('button', {
      name: 'Назад к предметам',
      exact: true,
    }).click();

    await expect(account(page).getByRole('heading', {
      name: 'Предметы аккаунта',
      exact: true,
    })).toBeVisible();
  });
}

test('Исчезнувшая страница корректируется один раз, без бесконечных GET', async ({ page }) => {
  await page.clock.install();

  const state = await mockMaterials(page, {
    files: Array.from({ length: 41 }, (_, index) => material(index + 1)),
  });

  await openMaterials(page);

  const next = materials(page).getByRole('button', {
    name: 'Следующая страница',
    exact: true,
  });

  await next.click();

  await expect(materials(page).getByRole('heading', {
    name: 'Материал 21',
    exact: true,
  })).toBeVisible();

  await next.click();

  await expect(materials(page).getByRole('heading', {
    name: 'Материал 41',
    exact: true,
  })).toBeVisible();

  const before = state.lists.length;

  state.onList = (route, params) => listResponse(
    route,
    [],
    params.get('page') === '3' ? 40 : 20,
  );

  await materials(page).getByRole('button', {
    name: 'Обновить список',
    exact: true,
  }).click();

  await expect(materials(page).getByRole('alert'))
    .toContainText('Не удалось получить актуальный список');

  await page.clock.runFor(3_000);

  expect(
    state.lists.slice(before).map((item) => item.page),
  ).toEqual(['3', '2']);

  state.onList = null;
  state.files = [];

  await materials(page).getByRole('button', {
    name: 'Повторить загрузку материалов',
    exact: true,
  }).click();

  await expect(materials(page).getByText(
    'Пока нет материалов',
    { exact: true },
  )).toBeVisible();
});

test('Поздние список и квота первого предмета не меняют страницу второго', async ({ page }) => {
  const gate = deferred();
  let responded = 0;

  const state = await mockMaterials(page, {
    files: [
      material(2, OTHER_SUBJECT.id, { title: 'Файл второго предмета' }),
    ],

    onList: async (route, params) => {
      if (params.get('subjectId') === SUBJECT.id) {
        await gate.promise;

        await listResponse(route, [
          material(1, SUBJECT.id, { title: 'Поздний частный файл' }),
        ]);

        responded += 1;
      } else {
        await listResponse(route, [
          material(2, OTHER_SUBJECT.id, { title: 'Файл второго предмета' }),
        ]);
      }
    },

    onUsage: async (route) => {
      await gate.promise;
      await route.fulfill({
        status: 200,
        json: { data: USAGE },
      });
      responded += 1;
    },
  });

  await openMaterials(page);

  try {
    await expect.poll(() => state.lists.length).toBe(1);
    await expect.poll(() => state.usageGets).toBe(1);

    await materials(page).getByRole('button', {
      name: 'Назад к предметам',
      exact: true,
    }).click();

    state.onUsage = null;
    state.usage = {
      ...USAGE,
      usedBytes: MIB,
      reservedBytes: 0,
    };

    await openMaterials(page, OTHER_SUBJECT);

    await expect(materials(page).getByRole('heading', {
      name: 'Файл второго предмета',
      exact: true,
    })).toBeVisible();

    await expect(quota(page).getByRole('meter'))
      .toHaveAttribute('aria-valuenow', String(MIB));
  } finally {
    gate.resolve();
  }

  await expect.poll(() => responded).toBe(2);
  await expect(materials(page)).not.toContainText('Поздний частный файл');

  await expect(quota(page).getByRole('meter'))
    .toHaveAttribute('aria-valuenow', String(MIB));
});

test('Восстановление той же сессии сохраняет предмет и поисковый запрос', async ({ page }) => {
  const state = await mockMaterials(page);
  await openMaterials(page);

  await expect(materials(page).getByRole('heading', {
    name: 'Материал 1',
    exact: true,
  })).toBeVisible();

  const csrfCount = state.csrfCount;

  state.onList = async (route) => {
    state.onList = null;
    await fail(route, 401, 'AUTHENTICATION_REQUIRED');
  };

  await materials(page).getByLabel('Поиск материалов').fill('Личный поиск');

  await expect.poll(() => state.csrfCount).toBeGreaterThan(csrfCount);

  await expect(materials(page).getByLabel('Поиск материалов'))
    .toHaveValue('Личный поиск');

  await expect(materials(page).getByText(
    'Ничего не найдено',
    { exact: true },
  )).toBeVisible();

  await expect(quota(page).getByRole('meter')).toBeVisible();

  expect(state.lists.at(-1).subjectId).toBe(SUBJECT.id);
  expect(state.lists.at(-1).q).toBe('Личный поиск');
  expect(state.writes).toEqual([]);
});

test('После истечения сессии другой аккаунт не получает прежний поиск и страницу', async ({ page }) => {
  const state = await mockMaterials(page);
  await openMaterials(page);

  await expect(materials(page).getByRole('heading', {
    name: 'Материал 1',
    exact: true,
  })).toBeVisible();

  state.onList = async (route) => {
    state.user = null;
    await fail(route, 401, 'AUTHENTICATION_REQUIRED');
  };

  await materials(page).getByLabel('Поиск материалов')
    .fill('Частный поиск первого');

  await expect(page.getByRole('heading', {
    name: 'С возвращением!',
    exact: true,
  })).toBeVisible();

  state.onList = null;
  state.loginUser = OTHER_USER;
  state.subjects = [OTHER_SUBJECT];
  state.files = [];

  await page.getByLabel('Email', { exact: true }).fill(OTHER_USER.email);
  await page.getByLabel('Пароль', { exact: true }).fill('Only-for-material-tests!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();

  await expect(account(page).getByText(
    OTHER_USER.email,
    { exact: true },
  )).toBeVisible();

  await expect(materials(page)).toHaveCount(0);
  await openMaterials(page, OTHER_SUBJECT);

  await expect(materials(page).getByLabel('Поиск материалов')).toHaveValue('');

  await expect(materials(page).getByText(
    'Пока нет материалов',
    { exact: true },
  )).toBeVisible();

  await expect(account(page)).not.toContainText('Частный поиск первого');
  expect(state.writes).toEqual(['POST /auth/login']);
});

test('Поздний ответ после выхода не возвращает материалы в интерфейс', async ({ page }) => {
  const gate = deferred();
  let responded = false;

  const state = await mockMaterials(page, {
    onList: async (route) => {
      await gate.promise;

      await listResponse(route, [
        material(1, SUBJECT.id, { title: 'Файл после выхода' }),
      ]);

      responded = true;
    },
  });

  await openMaterials(page);

  try {
    await expect.poll(() => state.lists.length).toBe(1);

    await account(page).getByRole('button', {
      name: 'Выйти из аккаунта',
      exact: true,
    }).click();

    await expect(page.getByRole('heading', {
      name: 'С возвращением!',
      exact: true,
    })).toBeVisible();
  } finally {
    gate.resolve();
  }

  await expect.poll(() => responded).toBe(true);
  await expect(materials(page)).toHaveCount(0);

  await expect(page.getByText(
    'Файл после выхода',
    { exact: true },
  )).toHaveCount(0);

  expect(state.writes).toEqual(['POST /auth/logout']);
});

// Проверки обработки PDF: только HTTP-mocks, без настоящего backend/R2.
const PROCESS_JOB_1 = '84971941-cc75-4e13-9e67-000000000001';
const PROCESS_JOB_2 = '84971941-cc75-4e13-9e67-000000000002';
const PROCESS_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const PDF_TEXT_PAGES = [
  'Первая строка\n<img src=x onerror="window.pdfTextExecuted=true">',
  '',
  'Текст третьей страницы.',
  'Текст четвёртой страницы.',
  'Текст пятой страницы.',
  'Последняя, шестая страница.',
].map((text, index) => ({ pageNumber: index + 1, text }));

const PROCESS_TEST_FILE = {
  name: 'processing-test.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.7\nBrowser test fixture, not a real PDF.\n%%EOF\n'),
};

function processingFile(number = 1, status = 'ready', overrides = {}) {
  return material(number, SUBJECT.id, {
    processingStatus: status,
    processingJobId: status === 'not_started' ? null : PROCESS_JOB_1,
    pageCount: status === 'ready' ? PDF_TEXT_PAGES.length : null,
    textCharacters: status === 'ready'
      ? PDF_TEXT_PAGES.reduce((sum, page) => sum + page.text.length, 0)
      : null,
    processingError: status === 'failed'
      ? { code: 'PDF_TIMEOUT', message: 'Служебные подробности обработки.' }
      : null,
    ...overrides,
  });
}

function processingJob(id, status, materialId = material(1).id) {
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(status);

  return {
    id,
    type: 'material.extract_text',
    status,
    attemptCount: status === 'queued' ? 0 : 1,
    maxAttempts: 3,
    createdAt: '2026-09-30T12:00:00Z',
    updatedAt: '2026-09-30T12:00:01Z',
    nextAttemptAt: status === 'queued' ? '2026-09-30T12:00:01Z' : null,
    finishedAt: terminal ? '2026-09-30T12:00:01Z' : null,
    resultId: status === 'succeeded' ? materialId : null,
    error: status === 'failed'
      ? { code: 'PDF_TIMEOUT', message: 'Обработка превысила время.' }
      : null,
  };
}

function processingPanel(page) {
  return page.getByRole('region', {
    name: 'Текст материала',
    exact: true,
  });
}

function uploadPanel(page) {
  return page.getByRole('region', {
    name: 'Загрузить PDF',
    exact: true,
  });
}

function processingReply(route, data, status = 200) {
  return route.fulfill({ status, json: { data } });
}

function acceptProcessing(route, id, jobId = PROCESS_JOB_1) {
  return processingReply(route, { materialId: id, jobId }, 202);
}

async function mockProcessing(page, options = {}) {
  const state = await mockMaterials(page, {
    files: [processingFile(1, 'not_started')],
    materialGets: [],
    downloadGets: [],
    textGets: [],
    jobGets: [],
    starts: [],
    renames: [],
    deletes: [],
    uploads: [],
    onMaterial: null,
    onDownload: null,
    onText: null,
    onJob: null,
    onProcess: null,
    onRename: null,
    onDelete: null,
    onUpload: null,
    ...options,
  });

  // Этот маршрут установлен позже базового и обрабатывает новые endpoints.
  // Остальные запросы передаёт существующему mockMaterials.
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice('/api/v1'.length);
    const method = request.method();
    const match = /^\/materials\/([^/]+)(?:\/(pages|process|download))?$/.exec(path);

    if (method === 'DELETE' && match && !match[2]) {
      const id = match[1];
      state.writes.push(method + ' ' + path);
      state.deletes.push({ id, body: request.postData(), headers: request.headers() });

      if (state.onDelete) {
        await state.onDelete(route, id);
      } else {
        const item = state.files.find((value) => value.id === id);
        if (!item) await fail(route, 404, 'MATERIAL_NOT_FOUND');
        else {
          state.files = state.files.map((value) => value.id === id
            ? { ...value, status: 'deleting', deletionJobId: DELETE_JOB_1 }
            : value);
          await processingReply(route, { materialId: id, jobId: DELETE_JOB_1 }, 202);
        }
      }
      return;
    }

    if (method === 'PATCH' && match && !match[2]) {
      const id = match[1];
      state.writes.push(method + ' ' + path);
      state.renames.push({
        id,
        body: request.postDataJSON(),
        headers: request.headers(),
      });

      if (state.onRename) {
        await state.onRename(route, id);
      } else {
        const item = state.files.find((value) => value.id === id);
        const { title, version } = request.postDataJSON();

        if (!item) await fail(route, 404, 'MATERIAL_NOT_FOUND');
        else if (item.status !== 'stored') await fail(route, 409, 'MATERIAL_NOT_AVAILABLE');
        else if (item.version !== version) await fail(route, 409, 'MATERIAL_VERSION_CONFLICT');
        else {
          const renamed = { ...item, title, version: version + 1 };
          state.files = state.files.map((value) => value.id === id ? renamed : value);
          await processingReply(route, renamed);
        }
      }
      return;
    }

    if (method === 'GET' && match && !match[2]) {
      const id = match[1];
      state.materialGets.push(id);

      if (state.onMaterial) {
        await state.onMaterial(route, id);
      } else {
        const item = state.files.find((value) => value.id === id);

        if (item) await processingReply(route, item);
        else await fail(route, 404, 'MATERIAL_NOT_FOUND');
      }
      return;
    }

    if (method === 'GET' && match?.[2] === 'download') {
      const id = match[1];
      state.downloadGets.push(id);

      if (state.onDownload) {
        await state.onDownload(route, id);
      } else {
        await processingReply(route, originalDownload(state.downloadGets.length));
      }
      return;
    }

    if (method === 'GET' && match?.[2] === 'pages') {
      const id = match[1];
      const params = url.searchParams;
      state.textGets.push({ id, ...Object.fromEntries(params) });

      if (state.onText) {
        await state.onText(route, id);
      } else {
        const size = Number(params.get('pageSize'));
        const offset = (Number(params.get('page')) - 1) * size;

        await listResponse(
          route,
          PDF_TEXT_PAGES.slice(offset, offset + size),
          PDF_TEXT_PAGES.length,
        );
      }
      return;
    }

    if (method === 'GET' && path.startsWith('/jobs/')) {
      const id = path.slice('/jobs/'.length);
      state.jobGets.push(id);

      if (state.onJob) {
        await state.onJob(route, id);
      } else {
        state.unexpected.push(method + ' ' + path);
        await fail(route, 500, 'UNEXPECTED_TEST_REQUEST');
      }
      return;
    }

    if (method === 'POST' && match?.[2] === 'process') {
      state.writes.push(method + ' ' + path);
      state.starts.push({
        id: match[1],
        key: request.headers()['idempotency-key'],
        headers: request.headers(),
        body: request.postData(),
      });

      if (state.onProcess) {
        await state.onProcess(route, match[1]);
      } else {
        state.unexpected.push(method + ' ' + path);
        await fail(route, 500, 'UNEXPECTED_TEST_REQUEST');
      }
      return;
    }

    if (method === 'POST' && path === '/materials') {
      state.writes.push(method + ' ' + path);
      state.uploads.push({
        key: request.headers()['idempotency-key'],
        headers: request.headers(),
        body: request.postData(),
      });

      if (state.onUpload) {
        await state.onUpload(route);
      } else {
        state.unexpected.push(method + ' ' + path);
        await fail(route, 500, 'UNEXPECTED_TEST_REQUEST');
      }
      return;
    }

    await route.fallback();
  });

  return state;
}

async function openProcessing(page, item = material(1)) {
  await materials(page).getByRole('button', {
    name: 'Открыть обработку и текст «' + item.title + '»',
    exact: true,
  }).click();

  await expect(processingPanel(page)).toBeVisible();
}

async function closeProcessing(page) {
  await processingPanel(page).getByRole('button', {
    name: 'Закрыть текст',
    exact: true,
  }).click();

  await expect(processingPanel(page)).toHaveCount(0);
}

async function expectFirstTextPage(page) {
  await expect(processingPanel(page).getByRole('heading', {
    name: 'Страница PDF 1',
    exact: true,
  })).toBeVisible();
}

async function uploadProcessingFile(page) {
  await uploadPanel(page).getByLabel('PDF-файл', { exact: true })
    .setInputFiles(PROCESS_TEST_FILE);

  await uploadPanel(page).getByRole('button', {
    name: 'Загрузить PDF',
    exact: true,
  }).click();
}

test('Текст: свежий GET, пустая страница, безопасный вывод и пагинация', async ({ page }, testInfo) => {
  const state = await mockProcessing(page);
  state.onMaterial = (route) => processingReply(route, processingFile());

  await openMaterials(page);
  await openProcessing(page);
  await expectFirstTextPage(page);

  const panel = processingPanel(page);

  await expect(panel.locator('.material-text-page')).toHaveCount(5);
  expect(await panel.locator('pre').first().textContent())
    .toBe(PDF_TEXT_PAGES[0].text);

  await expect(panel.getByText(
    'На этой странице нет извлечённого текста.',
    { exact: true },
  )).toBeVisible();

  await expect(panel.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.pdfTextExecuted)).toBeUndefined();

  await panel.getByRole('button', {
    name: 'Вперёд по тексту',
    exact: true,
  }).click();

  await expect(panel.getByRole('heading', {
    name: 'Страница PDF 6',
    exact: true,
  })).toBeVisible();

  await expect(panel.locator('.material-text-page')).toHaveCount(1);

  await expect(panel.getByRole('button', {
    name: 'Вперёд по тексту',
    exact: true,
  })).toBeDisabled();

  await panel.getByRole('button', {
    name: 'Назад по тексту',
    exact: true,
  }).click();

  await expectFirstTextPage(page);

  expect(state.textGets.map((value) => value.page)).toEqual(['1', '2', '1']);
  expect(state.textGets.every((value) => value.pageSize === '5')).toBe(true);
  expect(state.writes).toEqual([]);

  await page.screenshot({
    path: testInfo.outputPath('material-text-desktop.png'),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });

  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);

  await page.screenshot({
    path: testInfo.outputPath('material-text-mobile.png'),
    fullPage: true,
  });
});

test('Текст: выполнение задания завершается свежим GET и чтением страниц', async ({ page }) => {
  await page.clock.install();

  const state = await mockProcessing(page, {
    files: [processingFile(1, 'queued')],
  });

  state.onJob = async (route, id) => {
    if (state.jobGets.length === 1) {
      await processingReply(route, processingJob(id, 'running'));
    } else {
      state.files = [processingFile()];
      await processingReply(route, processingJob(id, 'succeeded'));
    }
  };

  await openMaterials(page);
  await openProcessing(page);

  await expect(processingPanel(page).getByText(
    'Извлекаем текст',
    { exact: true },
  )).toBeVisible();

  await page.clock.runFor(2100);
  await expectFirstTextPage(page);

  expect(state.materialGets).toHaveLength(2);
  expect(state.jobGets).toEqual([PROCESS_JOB_1, PROCESS_JOB_1]);

  await page.clock.runFor(6000);

  expect(state.jobGets).toHaveLength(2);
  expect(state.writes).toEqual([]);
});

test('Текст: закрытие панели останавливает опрос, открытие читает материал заново', async ({ page }) => {
  await page.clock.install();

  const state = await mockProcessing(page, {
    files: [processingFile(1, 'queued')],
  });

  state.onJob = (route, id) =>
    processingReply(route, processingJob(id, 'running'));

  await openMaterials(page);
  await openProcessing(page);

  await expect(processingPanel(page).getByText(
    'Извлекаем текст',
    { exact: true },
  )).toBeVisible();

  await closeProcessing(page);
  await page.clock.runFor(6000);

  expect(state.jobGets).toHaveLength(1);
  await expect(processingPanel(page)).toHaveCount(0);

  await openProcessing(page);
  await expect.poll(() => state.jobGets.length).toBe(2);

  expect(state.materialGets).toHaveLength(2);

  await closeProcessing(page);
  expect(state.writes).toEqual([]);
});

test('Текст: ошибка опроса ждёт ручного обновления материала', async ({ page }) => {
  await page.clock.install();

  const state = await mockProcessing(page, {
    files: [processingFile(1, 'queued')],
  });

  state.onJob = async (route, id) => {
    if (state.jobGets.length === 1) {
      await fail(route, 503, 'SERVICE_UNAVAILABLE');
    } else {
      state.files = [processingFile()];
      await processingReply(route, processingJob(id, 'succeeded'));
    }
  };

  await openMaterials(page);
  await openProcessing(page);

  await expect(processingPanel(page))
    .toContainText('Проверка состояния остановлена');

  await page.clock.runFor(5000);
  expect(state.jobGets).toHaveLength(1);

  await processingPanel(page).getByRole('button', {
    name: 'Обновить материал',
    exact: true,
  }).click();

  await expectFirstTextPage(page);

  expect(state.jobGets).toHaveLength(2);
  expect(state.writes).toEqual([]);
});

test('Загрузка PDF автоматически открывает текст и наблюдает уже созданное задание', async ({ page }) => {
  const state = await mockProcessing(page, { files: [] });

  const fileFields = {
    fileName: PROCESS_TEST_FILE.name,
    sizeBytes: PROCESS_TEST_FILE.buffer.length,
  };

  state.onUpload = async (route) => {
    state.files = [processingFile(1, 'queued', fileFields)];
    state.usage = {
      ...USAGE,
      usedBytes: USAGE.usedBytes + PROCESS_TEST_FILE.buffer.length,
    };

    await processingReply(route, state.files[0], 201);
  };

  state.onJob = async (route, id) => {
    state.files = [processingFile(1, 'ready', fileFields)];
    await processingReply(route, processingJob(id, 'succeeded'));
  };

  await openMaterials(page);
  await uploadProcessingFile(page);
  await expectFirstTextPage(page);

  await expect(quota(page).getByRole('meter')).toHaveAttribute(
    'aria-valuenow',
    String(USAGE.usedBytes + USAGE.reservedBytes + PROCESS_TEST_FILE.buffer.length),
  );

  expect(state.uploads).toHaveLength(1);
  expect(state.uploads[0].key).toMatch(PROCESS_UUID);
  expect(state.uploads[0].headers['x-csrf-token'])
    .toBe('materials-csrf-' + state.csrfCount);
  expect(state.uploads[0].headers['content-type'])
    .toContain('multipart/form-data');
  expect(state.uploads[0].body).toContain('name="subjectId"');
  expect(state.uploads[0].body).toContain(SUBJECT.id);

  expect(state.jobGets).toEqual([PROCESS_JOB_1]);
  expect(state.starts).toHaveLength(0);
  expect(state.usageGets).toBeGreaterThanOrEqual(2);
  expect(state.writes).toEqual(['POST /materials']);
});

test('Повтор загрузки сохраняет ключ и наблюдает актуальное задание из GET', async ({ page }) => {
  await page.clock.install();
  const state = await mockProcessing(page, { files: [] });

  const fileFields = {
    fileName: PROCESS_TEST_FILE.name,
    sizeBytes: PROCESS_TEST_FILE.buffer.length,
  };

  state.onUpload = async (route) => {
    state.files = [processingFile(1, 'queued', {
      ...fileFields,
      processingJobId: PROCESS_JOB_2,
    })];

    if (state.uploads.length === 1) {
      await route.abort('failed');
    } else {
      await processingReply(
        route,
        processingFile(1, 'queued', fileFields),
        201,
      );
    }
  };

  state.onJob = (route, id) =>
    processingReply(route, processingJob(id, 'running'));

  await openMaterials(page);
  await uploadProcessingFile(page);

  const retry = uploadPanel(page).getByRole('button', {
    name: 'Повторить загрузку',
    exact: true,
  });

  await expect(retry).toBeEnabled();
  await page.clock.runFor(3000);

  expect(state.uploads).toHaveLength(1);

  await retry.click();

  await expect(processingPanel(page).getByText(
    'Извлекаем текст',
    { exact: true },
  )).toBeVisible();

  expect(state.uploads).toHaveLength(2);
  expect(state.uploads[1].key).toBe(state.uploads[0].key);
  expect(state.jobGets).toEqual([PROCESS_JOB_2]);
  expect(state.starts).toHaveLength(0);

  await closeProcessing(page);
});

test('Ручной запуск блокирует двойной клик и передаёт CSRF и ключ без тела', async ({ page }) => {
  await page.clock.install();

  const gate = deferred();
  const state = await mockProcessing(page);

  state.onProcess = async (route, id) => {
    await gate.promise;
    state.files = [processingFile(1, 'queued')];
    await acceptProcessing(route, id);
  };

  state.onJob = async (route, id) => {
    state.files = [processingFile()];
    await processingReply(route, processingJob(id, 'succeeded'));
  };

  await openMaterials(page);
  await openProcessing(page);

  const start = processingPanel(page).getByRole('button', {
    name: 'Извлечь текст',
    exact: true,
  });

  try {
    await expect(start).toBeEnabled();

    await start.evaluate((button) => {
      button.click();
      button.click();
    });

    await expect.poll(() => state.starts.length).toBe(1);

    await expect(processingPanel(page).getByRole('button', {
      name: 'Отправляем запрос…',
      exact: true,
    })).toBeDisabled();

    await page.clock.runFor(3000);

    expect(state.starts).toHaveLength(1);
    expect(state.starts[0].key).toMatch(PROCESS_UUID);
    expect(state.starts[0].headers['x-csrf-token'])
      .toBe('materials-csrf-' + state.csrfCount);
    expect(state.starts[0].headers['content-type']).toBeUndefined();
    expect(state.starts[0].body).toBeNull();
  } finally {
    gate.resolve();
  }

  await expectFirstTextPage(page);
  expect(state.starts).toHaveLength(1);
});

test('Потерянный ответ запуска переживает закрытие и повторяется с прежним ключом', async ({ page }) => {
  await page.clock.install();

  const state = await mockProcessing(page, {
    files: [processingFile(1, 'failed')],
  });

  state.onProcess = async (route, id) => {
    state.files = [processingFile(1, 'failed', {
      processingError: {
        code: 'PDF_NO_TEXT',
        message: 'Нет текста.',
      },
    })];

    if (state.starts.length === 1) await route.abort('failed');
    else await acceptProcessing(route, id);
  };

  await openMaterials(page);
  await openProcessing(page);

  await processingPanel(page).getByRole('button', {
    name: 'Повторить обработку',
    exact: true,
  }).click();

  await expect(processingPanel(page)).toContainText('Ответ не подтверждён');

  await closeProcessing(page);
  await openProcessing(page);

  const retry = processingPanel(page).getByRole('button', {
    name: 'Повторить запрос запуска',
    exact: true,
  });

  await expect(retry).toBeEnabled();
  await page.clock.runFor(3000);

  expect(state.starts).toHaveLength(1);

  await retry.click();

  await expect(processingPanel(page)).toContainText('В PDF нет текстового слоя');
  await expect(processingPanel(page))
    .toContainText('Повтор обработки этого файла не устранит причину ошибки');
  await expect(retry).toHaveCount(0);

  expect(state.starts).toHaveLength(2);
  expect(state.starts[1].key).toBe(state.starts[0].key);

  await expect(processingPanel(page).getByRole('button', {
    name: 'Повторить обработку',
    exact: true,
  })).toHaveCount(0);
});

test('Retry-After блокирует кнопку после открытия и не запускает повтор автоматически', async ({ page }) => {
  await page.clock.install();

  const state = await mockProcessing(page, {
    files: [processingFile(1, 'failed')],
  });

  state.onProcess = async (route, id) => {
    if (state.starts.length === 1) {
      await route.fulfill({
        status: 429,
        headers: { 'Retry-After': '30' },
        json: {
          error: {
            code: 'RATE_LIMITED',
            message: 'Подожди.',
            fieldErrors: {},
          },
        },
      });
    } else {
      state.files = [processingFile()];
      await acceptProcessing(route, id);
    }
  };

  await openMaterials(page);
  await openProcessing(page);

  await processingPanel(page).getByRole('button', {
    name: 'Повторить обработку',
    exact: true,
  }).click();

  await expect(processingPanel(page)).toContainText('Повтор доступен через');

  await closeProcessing(page);
  await openProcessing(page);

  const retry = processingPanel(page).getByRole('button', {
    name: 'Повторить запрос запуска',
    exact: true,
  });

  await expect(retry).toBeDisabled();
  await page.clock.runFor(30_500);
  await expect(retry).toBeEnabled();

  expect(state.starts).toHaveLength(1);

  await retry.click();
  await expectFirstTextPage(page);

  expect(state.starts[1].key).toBe(state.starts[0].key);
});

test('CSRF восстанавливает ту же сессию и оставляет повтор запуска ручным', async ({ page }) => {
  await page.clock.install();

  const state = await mockProcessing(page, {
    files: [processingFile(1, 'failed')],
  });

  state.onProcess = async (route, id) => {
    if (state.starts.length === 1) {
      await fail(route, 403, 'CSRF_INVALID');
    } else {
      state.files = [processingFile()];
      await acceptProcessing(route, id);
    }
  };

  await openMaterials(page);
  await openProcessing(page);

  const csrfBefore = state.csrfCount;

  await processingPanel(page).getByRole('button', {
    name: 'Повторить обработку',
    exact: true,
  }).click();

  await expect.poll(() => state.csrfCount).toBeGreaterThan(csrfBefore);

  const retry = processingPanel(page).getByRole('button', {
    name: 'Повторить запрос запуска',
    exact: true,
  });

  await expect(retry).toBeEnabled();
  await page.clock.runFor(3000);

  expect(state.starts).toHaveLength(1);

  await retry.click();
  await expectFirstTextPage(page);

  expect(state.starts[1].key).toBe(state.starts[0].key);
  expect(state.starts[1].headers['x-csrf-token'])
    .not.toBe(state.starts[0].headers['x-csrf-token']);
});

test('Ошибки PDF показывают безопасный текст и различают возможность повтора', async ({ page }) => {
  const state = await mockProcessing(page, {
    files: [
      processingFile(1, 'failed', {
        processingError: {
          code: 'PDF_ENCRYPTED',
          message: 'Секретный путь сервера.',
        },
      }),
      processingFile(2, 'failed', {
        processingJobId: PROCESS_JOB_2,
      }),
    ],
  });

  await openMaterials(page);
  await openProcessing(page);

  await expect(processingPanel(page)).toContainText('PDF зашифрован');
  await expect(processingPanel(page)).not.toContainText('Секретный путь сервера.');

  await expect(processingPanel(page).getByRole('button', {
    name: 'Повторить обработку',
    exact: true,
  })).toHaveCount(0);

  await closeProcessing(page);
  await openProcessing(page, material(2));

  await expect(processingPanel(page).getByRole('button', {
    name: 'Повторить обработку',
    exact: true,
  })).toBeEnabled();

  expect(state.starts).toHaveLength(0);
});

test('Поздний текст после выхода не возвращается и не попадает в другой аккаунт', async ({ page }) => {
  const gate = deferred();
  let responded = false;
  const privateText = 'PRIVATE_TEXT_AFTER_LOGOUT';

  const state = await mockProcessing(page, {
    files: [processingFile()],
  });

  state.onText = async (route) => {
    await gate.promise;

    const rows = PDF_TEXT_PAGES.slice(0, 5).map((row) => ({
      ...row,
      text: row.pageNumber === 1 ? privateText : row.text,
    }));

    // Ответ намеренно приходит после отмены браузерного запроса.
    await listResponse(route, rows, PDF_TEXT_PAGES.length).catch(() => {});
    responded = true;
  };

  await openMaterials(page);
  await openProcessing(page);

  try {
    await expect.poll(() => state.textGets.length).toBe(1);

    await account(page).getByRole('button', {
      name: 'Выйти из аккаунта',
      exact: true,
    }).click();

    await expect(page.getByRole('heading', {
      name: 'С возвращением!',
      exact: true,
    })).toBeVisible();

    state.loginUser = OTHER_USER;
    state.subjects = [OTHER_SUBJECT];
    state.files = [];
    state.onText = null;

    await page.getByLabel('Email', { exact: true }).fill(OTHER_USER.email);
    await page.getByLabel('Пароль', { exact: true })
      .fill('Only-for-material-tests!');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();

    await expect(account(page).getByText(
      OTHER_USER.email,
      { exact: true },
    )).toBeVisible();

    await openMaterials(page, OTHER_SUBJECT);
  } finally {
    gate.resolve();
  }

  await expect.poll(() => responded).toBe(true);
  await expect(processingPanel(page)).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(privateText);

  await expect(materials(page).getByText(
    'Пока нет материалов',
    { exact: true },
  )).toBeVisible();
});

test('Подтверждённая новая попытка после ошибки получает новый ключ', async ({ page }) => {
  await page.clock.install();

  const state = await mockProcessing(page, {
    files: [processingFile(1, 'failed')],
  });

  state.onProcess = async (route, id) => {
    const jobId = state.starts.length === 1 ? PROCESS_JOB_1 : PROCESS_JOB_2;

    state.files = [processingFile(1, 'failed', {
      processingJobId: jobId,
    })];

    await acceptProcessing(route, id, jobId);
  };

  await openMaterials(page);
  await openProcessing(page);

  const retry = processingPanel(page).getByRole('button', {
    name: 'Повторить обработку',
    exact: true,
  });

  await retry.click();

  await expect.poll(() => state.materialGets.length).toBe(2);
  await expect(retry).toBeEnabled();
  await page.clock.runFor(3000);

  expect(state.starts).toHaveLength(1);

  await retry.click();

  await expect.poll(() => state.materialGets.length).toBe(3);
  await expect(retry).toBeEnabled();

  expect(state.starts).toHaveLength(2);
  expect(state.starts[1].key).not.toBe(state.starts[0].key);
});

for (const code of ['PROCESSING_IN_PROGRESS', 'TEXT_ALREADY_EXTRACTED']) {
  test('Конфликт ' + code + ' обновляет материал без повторного запуска', async ({ page }) => {
    const state = await mockProcessing(page);

    state.onProcess = async (route) => {
      state.files = [processingFile(
        1,
        code === 'TEXT_ALREADY_EXTRACTED' ? 'ready' : 'queued',
      )];

      await fail(route, 409, code);
    };

    state.onJob = async (route, id) => {
      state.files = [processingFile()];
      await processingReply(route, processingJob(id, 'succeeded'));
    };

    await openMaterials(page);
    await openProcessing(page);

    await processingPanel(page).getByRole('button', {
      name: 'Извлечь текст',
      exact: true,
    }).click();

    await expectFirstTextPage(page);
    expect(state.starts).toHaveLength(1);
  });
}

function originalDownload(attempt = 1) {
  return {
    url: 'https://example.com/material.pdf?signature=a%2Bb%2Fc&attempt=' + attempt,
    expiresAt: '2099-01-01T00:00:00Z',
  };
}

function downloadAction(page) {
  return processingPanel(page).getByRole('group', {
    name: 'Скачивание оригинала',
    exact: true,
  });
}

function downloadButton(page) {
  return downloadAction(page).getByRole('button', {
    name: 'Скачать оригинал PDF',
    exact: true,
  });
}

async function observeOriginalDownloads(page) {
  const requests = [];
  const downloads = [];
  const popups = [];

  page.on('download', (download) => downloads.push(download));
  page.on('popup', (popup) => popups.push(popup));

  // Имитируем Content-Disposition R2. Браузер сам получает attachment;
  // приложение не должно читать PDF через fetch или открывать новый popup.
  await page.route('https://example.com/material.pdf?*', async (route) => {
    const request = route.request();
    requests.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
    });

    await route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      headers: { 'Content-Disposition': 'attachment; filename="material.pdf"' },
      body: PROCESS_TEST_FILE.buffer,
    });
  });

  return { requests, downloads, popups };
}

test('Скачивание: один запрос при двойном клике, настоящий download и свежая ссылка при повторе', async ({ page }, testInfo) => {
  const original = await observeOriginalDownloads(page);
  const gate = deferred();
  const state = await mockProcessing(page);

  state.onDownload = async (route) => {
    await gate.promise;
    await processingReply(route, originalDownload(state.downloadGets.length));
  };

  await openMaterials(page);
  await openProcessing(page);
  await expect(downloadButton(page)).toBeEnabled();
  expect(state.downloadGets).toEqual([]);

  const appUrl = page.url();
  const downloaded = page.waitForEvent('download');

  try {
    await downloadButton(page).evaluate((button) => {
      button.click();
      button.click();
    });

    await expect.poll(() => state.downloadGets.length).toBe(1);
    await expect(downloadAction(page).getByRole('button', {
      name: 'Готовим скачивание…',
      exact: true,
    })).toBeDisabled();
  } finally {
    gate.resolve();
  }

  const first = await downloaded;
  expect(first.url()).toBe(originalDownload(1).url);
  expect(first.suggestedFilename()).toBe('material.pdf');
  expect(await first.failure()).toBeNull();
  await expect(downloadButton(page)).toBeEnabled();

  state.onDownload = null;
  const repeated = page.waitForEvent('download');
  await downloadButton(page).click();
  const second = await repeated;

  expect(second.url()).toBe(originalDownload(2).url);
  expect(second.suggestedFilename()).toBe('material.pdf');
  expect(await second.failure()).toBeNull();
  expect(state.downloadGets).toEqual([material(1).id, material(1).id]);
  expect(state.writes).toEqual([]);
  expect(original.requests).toEqual([1, 2].map((attempt) => ({
    url: originalDownload(attempt).url,
    method: 'GET',
    resourceType: 'document',
  })));
  expect(original.popups).toEqual([]);
  expect(page.url()).toBe(appUrl);

  const saved = await page.evaluate(() => JSON.stringify({
    local: { ...localStorage },
    session: { ...sessionStorage },
    html: document.body.innerHTML,
  }));
  expect(saved).not.toContain('signature=');

  await page.screenshot({
    path: testInfo.outputPath('material-download-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(downloadButton(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath('material-download-mobile.png'),
    fullPage: true,
  });
});

test('Скачивание: истёкшая ссылка и Retry-After требуют явного повтора', async ({ page }) => {
  const time = new Date('2026-10-02T06:00:00Z');
  await page.clock.install({ time });
  const original = await observeOriginalDownloads(page);
  const state = await mockProcessing(page);

  state.onDownload = async (route) => {
    if (state.downloadGets.length === 1) {
      await processingReply(route, {
        ...originalDownload(),
        expiresAt: time.toISOString(),
      });
    } else if (state.downloadGets.length === 2) {
      await route.fulfill({
        status: 429,
        headers: { 'Retry-After': '30' },
        json: {
          error: {
            code: 'RATE_LIMITED',
            message: 'Внутренние подробности сервера.',
            fieldErrors: {},
          },
        },
      });
    } else {
      await processingReply(route, originalDownload(state.downloadGets.length));
    }
  };

  await openMaterials(page);
  await openProcessing(page);
  await downloadButton(page).click();
  await expect(downloadAction(page)).toContainText('Ссылка уже истекла');
  await expect(downloadButton(page)).toBeEnabled();
  expect(original.requests).toEqual([]);

  await page.clock.runFor(3000);
  expect(state.downloadGets).toHaveLength(1);
  await downloadButton(page).click();
  await expect(downloadAction(page)).toContainText('Слишком много запросов');
  await expect(downloadButton(page)).toBeDisabled();
  await expect(downloadAction(page)).not.toContainText('Внутренние подробности');

  await page.clock.runFor(10_000);
  await expect(downloadButton(page)).toBeDisabled();
  expect(state.downloadGets).toHaveLength(2);
  await page.clock.runFor(20_500);
  await expect(downloadButton(page)).toBeEnabled();
  expect(state.downloadGets).toHaveLength(2);
  expect(original.requests).toEqual([]);

  const downloaded = page.waitForEvent('download');
  await downloadButton(page).click();
  expect((await downloaded).url()).toBe(originalDownload(3).url);
  expect(state.downloadGets).toHaveLength(3);
});

test('Скачивание: ошибки API и сети показывают безопасный текст без автоматических повторов', async ({ page }) => {
  await page.clock.install();
  const original = await observeOriginalDownloads(page);
  const state = await mockProcessing(page);
  await openMaterials(page);
  await openProcessing(page);

  const errors = [
    [404, 'MATERIAL_NOT_FOUND', 'Материал больше недоступен. Обнови список.'],
    [409, 'MATERIAL_NOT_AVAILABLE', 'Состояние материала изменилось. Обнови материал.'],
    [503, 'STORAGE_UNAVAILABLE', 'Хранилище сейчас недоступно. Попробуй позже.'],
    [503, 'SERVICE_UNAVAILABLE', 'Сервис сейчас недоступен. Попробуй позже.'],
    [0, 'NETWORK_ERROR', 'Не удалось получить ссылку. Попробуй ещё раз.'],
  ];

  for (const [index, [status, code, message]] of errors.entries()) {
    state.onDownload = (route) => status
      ? fail(route, status, code)
      : route.abort('failed');

    await downloadButton(page).click();
    await expect(downloadAction(page).getByRole('alert')).toHaveText(message);
    await expect(downloadButton(page)).toBeEnabled();
    await expect(processingPanel(page)).not.toContainText('Внутренние подробности');
    await page.clock.runFor(3000);
    expect(state.downloadGets).toHaveLength(index + 1);
  }

  expect(original.requests).toEqual([]);
  expect(original.downloads).toEqual([]);
  expect(state.writes).toEqual([]);
});

test('Скачивание: восстановление 401 и CSRF сохраняет ручной повтор', async ({ page }) => {
  await page.clock.install();
  const original = await observeOriginalDownloads(page);
  const state = await mockProcessing(page);
  await openMaterials(page);
  await openProcessing(page);

  for (const [status, code] of [
    [401, 'AUTHENTICATION_REQUIRED'],
    [403, 'CSRF_INVALID'],
  ]) {
    const before = state.downloadGets.length;
    const csrfBefore = state.csrfCount;
    state.onDownload = (route) => fail(route, status, code);
    await downloadButton(page).click();
    await expect.poll(() => state.csrfCount).toBeGreaterThan(csrfBefore);
    await expect(downloadButton(page)).toBeEnabled();
    await page.clock.runFor(3000);
    expect(state.downloadGets).toHaveLength(before + 1);
    expect(original.downloads).toHaveLength(before / 2);

    state.onDownload = null;
    const downloaded = page.waitForEvent('download');
    await downloadButton(page).click();
    expect((await downloaded).url()).toBe(originalDownload(before + 2).url);
  }

  expect(original.downloads).toHaveLength(2);
  expect(state.downloadGets).toHaveLength(4);
  expect(state.writes).toEqual([]);
});

test('Скачивание: закрытие, смена материала и новое состояние подавляют позднюю ссылку', async ({ page }) => {
  await page.clock.install();
  const original = await observeOriginalDownloads(page);
  const state = await mockProcessing(page, {
    files: [processingFile(1, 'not_started'), processingFile(2, 'not_started')],
  });
  await openMaterials(page);

  for (const [index, action] of ['close', 'switch', 'refresh'].entries()) {
    const gate = deferred();
    let responded = false;
    state.onDownload = async (route) => {
      await gate.promise;
      // Запоздалый серверный ответ намеренно разрешён после AbortController.
      await processingReply(route, originalDownload(index + 1)).catch(() => {});
      responded = true;
    };
    await openProcessing(page);
    await downloadButton(page).click();

    try {
      await expect.poll(() => state.downloadGets.length).toBe(index + 1);
      if (action === 'close') {
        await closeProcessing(page);
      } else if (action === 'switch') {
        await openProcessing(page, material(2));
        await expect(processingPanel(page).locator('.material-text-title'))
          .toHaveText(material(2).title);
      } else {
        state.onMaterial = (route) => processingReply(route, processingFile(
          1,
          'not_started',
          { status: 'deleting', deletionJobId: PROCESS_JOB_2 },
        ));
        await processingPanel(page).getByRole('button', {
          name: 'Обновить материал',
          exact: true,
        }).click();
        await expect(processingPanel(page)).toContainText('Материал удаляется');
        await expect(downloadAction(page)).toHaveCount(0);
      }
    } finally {
      gate.resolve();
    }

    await expect.poll(() => responded).toBe(true);
    await page.clock.runFor(3000);
    expect(original.requests).toEqual([]);
    expect(original.downloads).toEqual([]);
    if (action !== 'close') await closeProcessing(page);
  }

  expect(state.downloadGets).toEqual(Array(3).fill(material(1).id));
});

test('Скачивание: свежий GET скрывает действие для uploading и deleting', async ({ page }) => {
  const original = await observeOriginalDownloads(page);
  const state = await mockProcessing(page);
  state.onMaterial = (route) => processingReply(route, processingFile(
    1,
    'not_started',
    { status: 'uploading' },
  ));

  await openMaterials(page);
  await openProcessing(page);
  await expect(processingPanel(page)).toContainText('Сохранение файла ещё не завершено');
  await expect(downloadAction(page)).toHaveCount(0);

  state.onMaterial = (route) => processingReply(route, processingFile(
    1,
    'not_started',
    { status: 'deleting', deletionJobId: PROCESS_JOB_2 },
  ));
  await processingPanel(page).getByRole('button', {
    name: 'Обновить материал',
    exact: true,
  }).click();
  await expect(processingPanel(page)).toContainText('Материал удаляется');
  await expect(downloadAction(page)).toHaveCount(0);
  expect(state.downloadGets).toEqual([]);
  expect(original.requests).toEqual([]);
});

test('Скачивание: поздняя ссылка после выхода не попадает в другой аккаунт', async ({ page }) => {
  await page.clock.install();
  const original = await observeOriginalDownloads(page);
  const gate = deferred();
  let responded = false;
  const state = await mockProcessing(page);
  state.onDownload = async (route) => {
    await gate.promise;
    await processingReply(route, originalDownload()).catch(() => {});
    responded = true;
  };

  await openMaterials(page);
  await openProcessing(page);
  await downloadButton(page).click();

  try {
    await expect.poll(() => state.downloadGets.length).toBe(1);
    await account(page).getByRole('button', {
      name: 'Выйти из аккаунта',
      exact: true,
    }).click();
    await expect(page.getByRole('heading', {
      name: 'С возвращением!',
      exact: true,
    })).toBeVisible();

    state.loginUser = OTHER_USER;
    state.subjects = [OTHER_SUBJECT];
    state.files = [];
    await page.getByLabel('Email', { exact: true }).fill(OTHER_USER.email);
    await page.getByLabel('Пароль', { exact: true }).fill('Only-for-material-tests!');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(account(page).getByText(OTHER_USER.email, { exact: true })).toBeVisible();
    await openMaterials(page, OTHER_SUBJECT);
  } finally {
    gate.resolve();
  }

  await expect.poll(() => responded).toBe(true);
  await page.clock.runFor(3000);
  await expect(processingPanel(page)).toHaveCount(0);
  await expect(materials(page).getByText('Пока нет материалов', { exact: true }))
    .toBeVisible();
  expect(original.requests).toEqual([]);
  expect(original.downloads).toEqual([]);
  expect(state.downloadGets).toHaveLength(1);
});

function renameAction(page) {
  return processingPanel(page).getByRole('group', {
    name: 'Переименование материала',
    exact: true,
  });
}

function renameForm(page) {
  return renameAction(page).getByRole('form', {
    name: 'Переименование материала',
    exact: true,
  });
}

function renameInput(page) {
  return renameForm(page).getByLabel('Название материала', { exact: true });
}

function saveRename(page) {
  return renameForm(page).getByRole('button', {
    name: 'Сохранить название',
    exact: true,
  });
}

async function startRename(page) {
  await renameAction(page).getByRole('button', {
    name: 'Переименовать материал',
    exact: true,
  }).click();
  await expect(renameInput(page)).toBeEnabled();
}

async function expectRenameChoice(page, title, draft) {
  await expect(renameAction(page).getByText('На сервере', { exact: true })).toBeVisible();
  await expect(renameAction(page).getByText('Твой черновик', { exact: true })).toBeVisible();
  await expect(renameAction(page)).toContainText(title);
  await expect(renameInput(page)).toHaveValue(draft);
  await expect(renameAction(page).getByRole('button', {
    name: 'Использовать версию сервера',
    exact: true,
  })).toBeEnabled();
  await expect(renameAction(page).getByRole('button', {
    name: 'Использовать версию сервера',
    exact: true,
  })).toBeFocused();
  await expect(renameAction(page).getByRole('button', {
    name: 'Продолжить с моим черновиком',
    exact: true,
  })).toBeEnabled();
  await expect(saveRename(page)).toBeDisabled();
}

async function chooseRenameDraft(page) {
  await renameAction(page).getByRole('button', {
    name: 'Продолжить с моим черновиком',
    exact: true,
  }).click();
}

async function loginMaterialUser(page, user) {
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Пароль', { exact: true }).fill('Only-for-material-tests!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(account(page).getByText(user.email, { exact: true })).toBeVisible();
}

test('Переименование: свежая version, нормализация и один PATCH при двойном событии', async ({ page }, testInfo) => {
  const readGate = deferred();
  const writeGate = deferred();
  const state = await mockProcessing(page);
  await openMaterials(page);
  await openProcessing(page);
  await expect(renameAction(page)).toBeVisible();

  const fresh = processingFile(1, 'not_started', { title: 'Название перед правкой', version: 4 });
  state.files = [fresh];
  state.onMaterial = async (route) => {
    await readGate.promise;
    await processingReply(route, fresh);
  };

  try {
    await renameAction(page).getByRole('button', {
      name: 'Переименовать материал', exact: true,
    }).click();
    await expect.poll(() => state.materialGets.length).toBe(2);
    await expect(saveRename(page)).toBeDisabled();
    expect(state.renames).toHaveLength(0);
  } finally {
    readGate.resolve();
  }

  await expect(renameInput(page)).toBeEnabled();
  await expect(renameInput(page)).toHaveValue(fresh.title);
  await renameInput(page).fill('  Новое   название   материала  ');
  await page.screenshot({ path: testInfo.outputPath('material-rename-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(saveRename(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('material-rename-mobile.png'), fullPage: true });

  state.onMaterial = null;
  state.onRename = async (route, id) => {
    await writeGate.promise;
    const { title, version } = route.request().postDataJSON();
    state.files = [{ ...fresh, id, title, version: version + 1 }];
    await processingReply(route, state.files[0]);
  };

  try {
    await renameForm(page).evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await expect.poll(() => state.renames.length).toBe(1);
    await expect(renameInput(page)).toBeDisabled();
    await expect(materials(page).locator('.account-material-card').getByRole('heading', {
      name: fresh.title, exact: true,
    })).toBeVisible();
  } finally {
    writeGate.resolve();
  }

  await expect(renameForm(page)).toHaveCount(0);
  await expect(processingPanel(page).locator('.material-text-title')).toHaveText('Новое название материала');
  await expect(materials(page).locator('.account-material-card').getByRole('heading', {
    name: 'Новое название материала', exact: true,
  })).toBeVisible();
  await expect(processingPanel(page).getByRole('heading', {
    name: 'Текст материала', exact: true,
  })).toBeFocused();
  expect(state.renames[0].body).toEqual({ title: 'Новое название материала', version: 4 });
  expect(state.renames[0].id).toBe(material(1).id);
  expect(state.renames[0].headers['x-csrf-token']).toBeTruthy();
  expect(state.renames[0].headers['idempotency-key']).toBeUndefined();
  expect(state.writes).toEqual(['PATCH /materials/' + material(1).id]);
});

test('Переименование: валидация и 422 сохраняют ввод и обозначают ошибку поля', async ({ page }) => {
  const state = await mockProcessing(page);
  await openMaterials(page);
  await openProcessing(page);
  await startRename(page);

  for (const title of ['   ', 'А'.repeat(161)]) {
    await renameInput(page).fill(title);
    await saveRename(page).click();
    await expect(renameInput(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(renameInput(page)).toHaveValue(title);
    expect(state.renames).toHaveLength(0);
  }

  const draft = 'Черновик с ошибкой сервера';
  state.onRename = (route) => fail(route, 422, 'VALIDATION_FAILED', {
    title: 'Название уже используется.',
  });
  await renameInput(page).fill(draft);
  await saveRename(page).click();
  await expect(renameInput(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(renameInput(page)).toHaveValue(draft);
  await expect(renameAction(page)).toContainText('Название уже используется.');
  await expect(renameAction(page)).not.toContainText('Внутренние подробности сервера.');
  expect(state.renames).toHaveLength(1);

  state.onRename = null;
  await renameInput(page).fill('Исправленное название');
  await saveRename(page).click();
  await expect(renameForm(page)).toHaveCount(0);
  expect(state.renames).toHaveLength(2);
  expect(state.renames[1].body).toEqual({ title: 'Исправленное название', version: 1 });
});

test('Переименование: конфликт требует свежего GET и явного выбора перед повторным PATCH', async ({ page }, testInfo) => {
  const state = await mockProcessing(page);
  await openMaterials(page);
  await openProcessing(page);
  await startRename(page);
  const draft = 'Моя правка материала';
  await renameInput(page).fill(draft);
  state.files = [processingFile(1, 'not_started', { title: 'Правка из другой вкладки', version: 7 })];
  await saveRename(page).click();
  await expect(renameAction(page).getByRole('alert')).toBeVisible();
  await expect(renameInput(page)).toHaveValue(draft);
  await expect(saveRename(page)).toBeDisabled();
  expect(state.materialGets).toHaveLength(2);
  expect(state.renames).toHaveLength(1);

  // Неудачное чтение не разрешает повтор со старой version.
  state.onMaterial = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');
  const refresh = renameAction(page).getByRole('button', {
    name: 'Загрузить актуальную версию', exact: true,
  });
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(saveRename(page)).toBeDisabled();
  await expect(renameAction(page).getByRole('button', {
    name: 'Продолжить с моим черновиком', exact: true,
  })).toHaveCount(0);
  await expect(renameInput(page)).toHaveValue(draft);
  expect(state.renames).toHaveLength(1);

  state.onMaterial = null;
  await refresh.click();
  await expectRenameChoice(page, state.files[0].title, draft);
  await expect(renameAction(page)).not.toContainText('Внутренние подробности сервера.');
  await page.screenshot({ path: testInfo.outputPath('material-rename-conflict-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('material-rename-conflict-mobile.png'), fullPage: true });

  await chooseRenameDraft(page);
  await expect(saveRename(page)).toBeEnabled();
  expect(state.renames).toHaveLength(1);
  await saveRename(page).click();
  await expect(renameForm(page)).toHaveCount(0);
  expect(state.renames[1].body).toEqual({ title: draft, version: 7 });
});

test('Переименование: принятие версии сервера не отправляет PATCH', async ({ page }) => {
  const state = await mockProcessing(page);
  await openMaterials(page);
  await openProcessing(page);
  await startRename(page);
  await renameInput(page).fill('Отменённый черновик');
  state.files = [processingFile(1, 'not_started', { title: 'Победившая версия сервера', version: 2 })];
  await saveRename(page).click();
  await renameAction(page).getByRole('button', {
    name: 'Загрузить актуальную версию', exact: true,
  }).click();
  await expectRenameChoice(page, state.files[0].title, 'Отменённый черновик');
  await renameAction(page).getByRole('button', {
    name: 'Использовать версию сервера', exact: true,
  }).click();
  expect(state.renames).toHaveLength(1);
  // Принятие серверной версии завершает сравнение, но само не является записью.
  await expect(renameAction(page).getByRole('button', {
    name: 'Продолжить с моим черновиком', exact: true,
  })).toHaveCount(0);
  await expect(renameInput(page)).toHaveValue('Победившая версия сервера');
});

for (const failure of ['network', '503']) {
  test('Переименование: неизвестный результат ' + failure + ' проверяется GET без повторной записи', async ({ page }) => {
    await page.clock.install();
    const state = await mockProcessing(page);
    await openMaterials(page);
    await openProcessing(page);
    await startRename(page);
    const draft = 'Сохранено, но ответ потерялся';
    await renameInput(page).fill(draft);
    state.onRename = async (route) => {
      state.files = [processingFile(1, 'not_started', { title: draft, version: 2 })];
      if (failure === 'network') await route.abort('failed');
      else await fail(route, 503, 'SERVICE_UNAVAILABLE');
    };
    await saveRename(page).click();
    const check = renameAction(page).getByRole('button', {
      name: 'Проверить результат', exact: true,
    });
    await expect(check).toBeEnabled();
    await expect(saveRename(page)).toBeDisabled();
    await page.clock.runFor(3000);
    expect(state.renames).toHaveLength(1);
    expect(state.materialGets).toHaveLength(2);

    await check.click();
    await expectRenameChoice(page, draft, draft);
    await renameAction(page).getByRole('button', {
      name: 'Использовать версию сервера', exact: true,
    }).click();
    await page.clock.runFor(3000);
    expect(state.renames).toHaveLength(1);
    await expect(renameInput(page)).toHaveValue(draft);
  });
}

test('Переименование: Retry-After переживает закрытие панели и не запускает PATCH автоматически', async ({ page }) => {
  await page.clock.install();
  const state = await mockProcessing(page);
  await openMaterials(page);
  await openProcessing(page);
  await startRename(page);
  const draft = 'Черновик после ограничения';
  await renameInput(page).fill(draft);
  state.onRename = (route) => fail(route, 429, 'RATE_LIMITED', {}, { 'Retry-After': '30' });
  await saveRename(page).click();
  await expect(saveRename(page)).toBeDisabled();
  await closeProcessing(page);
  await openProcessing(page);
  await expect(renameInput(page)).toHaveValue(draft);
  await expect(renameInput(page)).toBeDisabled();
  await expect(saveRename(page)).toBeDisabled();
  const refresh = renameAction(page).getByRole('button', {
    name: 'Загрузить актуальную версию', exact: true,
  });
  await expect(refresh).toBeDisabled();
  await page.clock.runFor(10_000);
  await expect(saveRename(page)).toBeDisabled();
  expect(state.renames).toHaveLength(1);
  await page.clock.runFor(20_500);
  await expect(refresh).toBeEnabled();
  await expect(saveRename(page)).toBeDisabled();
  await refresh.click();
  await expect(saveRename(page)).toBeEnabled();
  expect(state.renames).toHaveLength(1);
  state.onRename = null;
  await saveRename(page).click();
  await expect(renameForm(page)).toHaveCount(0);
  expect(state.renames[1].body).toEqual({ title: draft, version: 1 });
});

test('Переименование: восстановление 401 и CSRF сохраняет черновик без повторной записи', async ({ page }) => {
  await page.clock.install();
  const state = await mockProcessing(page);
  await openMaterials(page);
  await openProcessing(page);

  for (const [status, code] of [[401, 'AUTHENTICATION_REQUIRED'], [403, 'CSRF_INVALID']]) {
    await startRename(page);
    const draft = 'Черновик после ' + code;
    await renameInput(page).fill(draft);
    const before = state.renames.length;
    const csrfBefore = state.csrfCount;
    state.onRename = (route) => fail(route, status, code);
    await saveRename(page).click();
    await expect.poll(() => state.csrfCount).toBeGreaterThan(csrfBefore);
    await expect(renameInput(page)).toHaveValue(draft);
    await expect(saveRename(page)).toBeEnabled();
    await page.clock.runFor(3000);
    expect(state.renames).toHaveLength(before + 1);
    state.onRename = null;
    await saveRename(page).click();
    await expect(renameForm(page)).toHaveCount(0);
    expect(state.renames).toHaveLength(before + 2);
    expect(state.renames[before + 1].headers['x-csrf-token'])
      .not.toBe(state.renames[before].headers['x-csrf-token']);
  }
});

test('Переименование: отмена ожидания и смена материала не применяют поздний ответ', async ({ page }) => {
  const state = await mockProcessing(page, {
    files: [processingFile(1, 'not_started'), processingFile(2, 'not_started')],
  });
  await openMaterials(page);

  for (const [index, action] of ['close', 'switch'].entries()) {
    const gate = deferred();
    let responded = false;
    await openProcessing(page);
    if (index === 0) await startRename(page);
    else {
      await expectRenameChoice(page, material(1).title, 'Поздняя правка 0');
      await chooseRenameDraft(page);
    }
    await renameInput(page).fill('Поздняя правка ' + index);
    state.onRename = async (route) => {
      await gate.promise;
      await processingReply(route, processingFile(1, 'not_started', {
        title: 'Поздняя правка ' + index, version: 2,
      })).catch(() => {});
      responded = true;
    };
    await saveRename(page).click();
    try {
      await expect.poll(() => state.renames.length).toBe(index + 1);
      if (action === 'close') await closeProcessing(page);
      else await openProcessing(page, material(2));
    } finally {
      gate.resolve();
    }
    await expect.poll(() => responded).toBe(true);
    if (action === 'close') await expect(processingPanel(page)).toHaveCount(0);
    else {
      await expect(processingPanel(page).locator('.material-text-title')).toHaveText(material(2).title);
      await expect(renameForm(page)).toHaveCount(0);
      await closeProcessing(page);
    }
    await expect(materials(page).locator('.account-material-card').getByRole('heading', {
      name: material(1).title, exact: true,
    })).toBeVisible();
  }

  await openProcessing(page);
  await expectRenameChoice(page, material(1).title, 'Поздняя правка 1');
  expect(state.renames).toHaveLength(2);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain('Поздняя правка');
});

test('Переименование: другой аккаунт не получает черновик после истечения сессии', async ({ page }) => {
  const state = await mockProcessing(page);
  await openMaterials(page);
  await openProcessing(page);
  await startRename(page);
  await renameInput(page).fill('Частный черновик первого аккаунта');
  state.onRename = async (route) => {
    state.user = null;
    await fail(route, 401, 'AUTHENTICATION_REQUIRED');
  };
  await saveRename(page).click();
  await expect(page.getByRole('heading', { name: 'С возвращением!', exact: true })).toBeVisible();
  state.loginUser = OTHER_USER;
  state.subjects = [OTHER_SUBJECT];
  state.files = [material(2, OTHER_SUBJECT.id)];
  state.onRename = null;
  await loginMaterialUser(page, OTHER_USER);
  await openMaterials(page, OTHER_SUBJECT);
  await openProcessing(page, material(2, OTHER_SUBJECT.id));
  await expect(renameForm(page)).toHaveCount(0);
  await startRename(page);
  await expect(renameInput(page)).toHaveValue(material(2).title);
  await expect(page.locator('body')).not.toContainText('Частный черновик первого аккаунта');
  expect(state.renames).toHaveLength(1);
});

test('Переименование: поздний PATCH после выхода не попадает в другой аккаунт', async ({ page }) => {
  const gate = deferred();
  let responded = false;
  const state = await mockProcessing(page);
  await openMaterials(page);
  await openProcessing(page);
  await startRename(page);
  await renameInput(page).fill('Частное новое название');
  state.onRename = async (route) => {
    await gate.promise;
    await processingReply(route, processingFile(1, 'not_started', {
      title: 'Частное новое название', version: 2,
    })).catch(() => {});
    responded = true;
  };
  await saveRename(page).click();
  try {
    await expect.poll(() => state.renames.length).toBe(1);
    await account(page).getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'С возвращением!', exact: true })).toBeVisible();
    state.loginUser = OTHER_USER;
    state.subjects = [OTHER_SUBJECT];
    state.files = [];
    await loginMaterialUser(page, OTHER_USER);
    await openMaterials(page, OTHER_SUBJECT);
  } finally {
    gate.resolve();
  }
  await expect.poll(() => responded).toBe(true);
  await expect(processingPanel(page)).toHaveCount(0);
  await expect(materials(page).getByText('Пока нет материалов', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Частное новое название');
  expect(state.renames).toHaveLength(1);
});

test('Переименование: статус stored проверяется при открытии панели и повторно перед правкой', async ({ page }) => {
  const state = await mockProcessing(page);
  await openMaterials(page);

  for (const [index, status] of ['uploading', 'deleting'].entries()) {
    state.files = [processingFile(1, 'not_started', {
      status,
      deletionJobId: status === 'deleting' ? PROCESS_JOB_2 : null,
    })];
    if (index === 0) await openProcessing(page);
    else await processingPanel(page).getByRole('button', {
      name: 'Обновить материал', exact: true,
    }).click();
    await expect(processingPanel(page)).toContainText(status === 'uploading'
      ? 'Сохранение файла ещё не завершено' : 'Материал удаляется');
    await expect(renameAction(page)).toHaveCount(0);
  }

  state.files = [processingFile(1, 'not_started')];
  await processingPanel(page).getByRole('button', {
    name: 'Обновить материал', exact: true,
  }).click();
  await expect(renameAction(page)).toBeVisible();
  state.files = [processingFile(1, 'not_started', { status: 'deleting', deletionJobId: PROCESS_JOB_2 })];
  await renameAction(page).getByRole('button', {
    name: 'Переименовать материал', exact: true,
  }).click();
  await expect(renameAction(page).getByRole('alert')).toBeVisible();
  await expect(saveRename(page)).toBeDisabled();
  expect(state.renames).toHaveLength(0);
});

const DELETE_JOB_1 = 'cd4fba11-4a95-48c4-bcab-000000000001';
const DELETE_JOB_2 = 'cd4fba11-4a95-48c4-bcab-000000000002';
const DELETE_WARNING = 'Материал и связанные конспекты, тесты и история попыток будут удалены';
const DELETE_COMPLETE = 'Материал удалён.';

function deletionJob(id, status, materialId = material(1).id) {
  return {
    ...processingJob(id, status, materialId),
    type: 'material.delete',
    error: status === 'failed'
      ? { code: 'JOB_ATTEMPTS_EXHAUSTED', message: 'Внутренние подробности очистки.' }
      : null,
  };
}

function deletingFile(jobId = DELETE_JOB_1, overrides = {}) {
  return processingFile(1, 'not_started', {
    status: 'deleting', deletionJobId: jobId, ...overrides,
  });
}

function deleteDialog(page) {
  return page.getByRole('dialog', { name: 'Удаление материала', exact: true });
}

function confirmDelete(page) {
  return deleteDialog(page).getByRole('button', { name: 'Удалить материал', exact: true });
}

function checkDeletion(page) {
  return deleteDialog(page).getByRole('button', { name: 'Проверить состояние', exact: true });
}

async function openDeletion(page, item = material(1)) {
  await materials(page).getByRole('button', {
    name: (item.status === 'deleting' ? 'Проверить удаление «' : 'Удалить материал «') + item.title + '»',
    exact: true,
  }).click();
  await expect(deleteDialog(page)).toBeVisible();
}

async function closeDeletion(page) {
  await deleteDialog(page).getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(deleteDialog(page)).toHaveCount(0);
}

test('Удаление: свежий материал, обязательное предупреждение и отмена до DELETE', async ({ page }, testInfo) => {
  const gate = deferred();
  const state = await mockProcessing(page);
  await openMaterials(page);
  await openProcessing(page);
  await expect(downloadButton(page)).toBeEnabled();

  const fresh = processingFile(1, 'not_started', {
    title: 'Актуальное название перед удалением', version: 4,
  });
  state.files = [fresh];
  state.onMaterial = async (route) => {
    await gate.promise;
    await processingReply(route, fresh);
  };

  try {
    await openDeletion(page);
    await expect(processingPanel(page)).toHaveCount(0);
    await expect(deleteDialog(page).getByRole('button', { name: 'Закрыть', exact: true })).toBeFocused();
    await expect.poll(() => state.materialGets.length).toBe(2);
    await expect(confirmDelete(page)).toHaveCount(0);
    expect(state.deletes).toHaveLength(0);
  } finally {
    gate.resolve();
  }
  await expect(confirmDelete(page)).toBeEnabled();
  await expect(deleteDialog(page)).toContainText(fresh.title);
  await expect(deleteDialog(page).getByRole('button', { name: 'Отмена', exact: true })).toBeFocused();
  await expect(deleteDialog(page)).toContainText(DELETE_WARNING);
  await page.screenshot({ path: testInfo.outputPath('material-delete-confirm-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(confirmDelete(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const confirmBounds = await deleteDialog(page).boundingBox();
  expect(confirmBounds.x).toBeGreaterThanOrEqual(0);
  expect(confirmBounds.x + confirmBounds.width).toBeLessThanOrEqual(390);
  expect(confirmBounds.y).toBeGreaterThanOrEqual(0);
  expect(confirmBounds.y + confirmBounds.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: testInfo.outputPath('material-delete-confirm-mobile.png') });
  await deleteDialog(page).getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(deleteDialog(page)).toHaveCount(0);
  await expect(materials(page).getByRole('button', {
    name: 'Удалить материал «' + fresh.title + '»', exact: true,
  })).toBeFocused();
  expect(state.deletes).toHaveLength(0);

  // Неоконченная загрузка тоже удаляется только после отдельного подтверждения.
  state.onMaterial = null;
  state.files = [{ ...fresh, status: 'uploading' }];
  await openDeletion(page, fresh);
  await expect(confirmDelete(page)).toBeEnabled();
  await expect(deleteDialog(page)).toContainText(DELETE_WARNING);
  await deleteDialog(page).getByRole('button', { name: 'Отмена', exact: true }).click();
  state.onMaterial = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');
  await openDeletion(page, fresh);
  await expect(checkDeletion(page)).toBeEnabled();
  await expect(confirmDelete(page)).toHaveCount(0);
  await expect(deleteDialog(page)).not.toContainText('Внутренние подробности сервера.');
  state.onMaterial = null;
  await checkDeletion(page).click();
  await expect(confirmDelete(page)).toBeEnabled();
  await deleteDialog(page).getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(state.writes).toEqual([]);
});

test('Удаление: один DELETE, опрос задания и квота только после подтверждённого 404', async ({ page }, testInfo) => {
  await page.clock.install();
  const deleteGate = deferred();
  const verifyGate = deferred();
  let verifying = false;
  const state = await mockProcessing(page);
  state.onDelete = async (route, id) => {
    await deleteGate.promise;
    state.files = [deletingFile()];
    await processingReply(route, { materialId: id, jobId: DELETE_JOB_1 }, 202);
  };
  state.onJob = async (route, id) => {
    const status = ['queued', 'running', 'succeeded'][state.jobGets.length - 1];
    if (status === 'succeeded') state.files = [];
    await processingReply(route, deletionJob(id, status));
  };
  state.onMaterial = async (route) => {
    if (state.files.length) await processingReply(route, state.files[0]);
    else {
      verifying = true;
      await verifyGate.promise;
      state.usage = { ...USAGE, usedBytes: 24 * MIB };
      await fail(route, 404, 'MATERIAL_NOT_FOUND');
    }
  };

  await openMaterials(page);
  await openDeletion(page);
  await expect(confirmDelete(page)).toBeEnabled();
  const usageBefore = state.usageGets;
  const subjectsBefore = state.subjectGets.length;
  try {
    await confirmDelete(page).evaluate((button) => { button.click(); button.click(); });
    await expect.poll(() => state.deletes.length).toBe(1);
    await expect(deleteDialog(page).getByRole('button', {
      name: 'Отправляем запрос…', exact: true,
    })).toBeDisabled();
  } finally {
    deleteGate.resolve();
  }

  try {
    await expect.poll(() => state.jobGets.length).toBe(1);
    await expect(deleteDialog(page)).toContainText('Удаление выполняется');
    await expect(deleteDialog(page)).toContainText('Пока очистка не завершена, материал занимает место в хранилище.');
    await expect(quota(page).getByRole('meter')).toHaveAttribute('aria-valuenow', String(35 * MIB));
    await page.clock.runFor(2100);
    await expect.poll(() => state.jobGets.length).toBe(2);
    await expect(deleteDialog(page)).toContainText('Очищаем файл и связанные данные…');
    await page.screenshot({ path: testInfo.outputPath('material-delete-watching-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const watchingBounds = await deleteDialog(page).boundingBox();
    expect(watchingBounds.x).toBeGreaterThanOrEqual(0);
    expect(watchingBounds.x + watchingBounds.width).toBeLessThanOrEqual(390);
    expect(watchingBounds.y).toBeGreaterThanOrEqual(0);
    expect(watchingBounds.y + watchingBounds.height).toBeLessThanOrEqual(844);
    await page.screenshot({ path: testInfo.outputPath('material-delete-watching-mobile.png') });
    await page.clock.runFor(2100);
    await expect.poll(() => verifying).toBe(true);
    await expect(deleteDialog(page)).not.toContainText(DELETE_COMPLETE);
    await expect(quota(page).getByRole('meter')).toHaveAttribute('aria-valuenow', String(35 * MIB));
    expect(state.usageGets).toBe(usageBefore);
  } finally {
    verifyGate.resolve();
  }

  await expect(deleteDialog(page)).toContainText(DELETE_COMPLETE);
  await expect(materials(page).getByText('Пока нет материалов', { exact: true })).toBeVisible();
  await expect(quota(page).getByRole('meter')).toHaveAttribute('aria-valuenow', String(34 * MIB));
  expect(state.subjectGets.length).toBeGreaterThan(subjectsBefore);
  expect(state.usageGets).toBeGreaterThan(usageBefore);
  expect(state.deletes).toHaveLength(1);
  expect(state.deletes[0].id).toBe(material(1).id);
  expect(state.deletes[0].body).toBeNull();
  expect(state.deletes[0].headers['x-csrf-token']).toBeTruthy();
  expect(state.deletes[0].headers['idempotency-key']).toBeUndefined();
  expect(state.deletes[0].headers['content-type']).toBeUndefined();
  await page.clock.runFor(10_000);
  expect(state.jobGets).toEqual(Array(3).fill(DELETE_JOB_1));
  await closeDeletion(page);
  await page.clock.runFor(20);
  await expect(materials(page).getByLabel('Поиск материалов', { exact: true })).toBeFocused();
});

test('Удаление: существующее deleting возобновляет наблюдение; закрытие прекращает опрос', async ({ page }) => {
  await page.clock.install();
  const item = deletingFile();
  const state = await mockProcessing(page, { files: [item] });
  state.onJob = (route, id) => processingReply(route, deletionJob(id, 'running'));
  await openMaterials(page);
  await openDeletion(page, item);
  await expect.poll(() => state.jobGets.length).toBe(1);
  await expect(deleteDialog(page)).toContainText('Удаление выполняется');
  await expect(confirmDelete(page)).toHaveCount(0);
  expect(state.deletes).toHaveLength(0);
  await closeDeletion(page);
  const reads = state.materialGets.length;
  await page.clock.runFor(10_000);
  expect(state.jobGets).toHaveLength(1);
  await openDeletion(page, item);
  await expect.poll(() => state.jobGets.length).toBe(2);
  expect(state.materialGets.length).toBeGreaterThan(reads);
  expect(state.jobGets).toEqual([DELETE_JOB_1, DELETE_JOB_1]);
  expect(state.deletes).toHaveLength(0);
  await closeDeletion(page);
});

for (const terminal of ['failed', 'cancelled']) {
  test('Удаление: ' + terminal + ' сохраняет квоту и требует явного повтора DELETE', async ({ page }) => {
    await page.clock.install();
    const item = deletingFile();
    const state = await mockProcessing(page, { files: [item] });
    state.onJob = async (route, id) => {
      if (id === DELETE_JOB_1) await processingReply(route, deletionJob(id, terminal));
      else {
        state.files = [];
        state.usage = { ...USAGE, usedBytes: 24 * MIB };
        await processingReply(route, deletionJob(id, 'succeeded'));
      }
    };
    state.onDelete = async (route, id) => {
      state.files = [deletingFile(DELETE_JOB_2)];
      await processingReply(route, { materialId: id, jobId: DELETE_JOB_2 }, 202);
    };
    await openMaterials(page);
    await openDeletion(page, item);
    const retry = deleteDialog(page).getByRole('button', { name: 'Повторить удаление', exact: true });
    await expect(retry).toBeEnabled();
    await expect(deleteDialog(page)).not.toContainText('Внутренние подробности очистки.');
    await expect(quota(page).getByRole('meter')).toHaveAttribute('aria-valuenow', String(35 * MIB));
    await expect(deleteDialog(page)).toContainText(DELETE_WARNING);
    await page.clock.runFor(10_000);
    expect(state.deletes).toHaveLength(0);
    expect(state.jobGets).toEqual([DELETE_JOB_1]);
    await retry.click();
    await expect(deleteDialog(page)).toContainText(DELETE_COMPLETE);
    await expect(materials(page).getByText('Пока нет материалов', { exact: true })).toBeVisible();
    expect(state.deletes).toHaveLength(1);
    expect(state.jobGets).toEqual([DELETE_JOB_1, DELETE_JOB_2]);
  });
}

test('Удаление: потерянный ответ принятого запроса восстанавливается через GET без второго DELETE', async ({ page }) => {
  await page.clock.install();
  const state = await mockProcessing(page);
  state.onDelete = async (route) => {
    state.files = [deletingFile()];
    await route.abort('failed');
  };
  state.onJob = async (route, id) => {
    state.files = [];
    await processingReply(route, deletionJob(id, 'succeeded'));
  };
  await openMaterials(page);
  await openDeletion(page);
  await confirmDelete(page).click();
  await expect(checkDeletion(page)).toBeEnabled();
  await expect(confirmDelete(page)).toHaveCount(0);
  await page.clock.runFor(10_000);
  expect(state.deletes).toHaveLength(1);
  expect(state.jobGets).toHaveLength(0);
  await checkDeletion(page).click();
  await expect(deleteDialog(page)).toContainText(DELETE_COMPLETE);
  expect(state.deletes).toHaveLength(1);
  expect(state.jobGets).toEqual([DELETE_JOB_1]);
});

test('Удаление: неизвестный результат при still stored требует нового подтверждения после GET', async ({ page }) => {
  await page.clock.install();
  const state = await mockProcessing(page);
  state.onDelete = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');
  state.onJob = (route, id) => processingReply(route, deletionJob(id, 'queued'));
  await openMaterials(page);
  await openDeletion(page);
  await confirmDelete(page).click();
  await expect(checkDeletion(page)).toBeEnabled();
  await expect(deleteDialog(page)).not.toContainText('Внутренние подробности сервера.');
  await page.clock.runFor(5000);
  expect(state.deletes).toHaveLength(1);
  const reads = state.materialGets.length;
  await checkDeletion(page).click();
  await expect(confirmDelete(page)).toBeEnabled();
  expect(state.materialGets.length).toBeGreaterThan(reads);
  expect(state.deletes).toHaveLength(1);
  state.onDelete = null;
  await confirmDelete(page).click();
  await expect(deleteDialog(page)).toContainText('Удаление выполняется');
  expect(state.deletes).toHaveLength(2);
  await closeDeletion(page);
});

test('Удаление: ошибка опроса и Retry-After требуют ручной проверки состояния', async ({ page }) => {
  await page.clock.install();
  const item = deletingFile();
  const state = await mockProcessing(page, { files: [item] });
  state.onJob = (route) => fail(route, 429, 'RATE_LIMITED', {}, { 'Retry-After': '30' });
  await openMaterials(page);
  await openDeletion(page, item);
  await expect(checkDeletion(page)).toBeDisabled();
  await expect(deleteDialog(page)).not.toContainText('Внутренние подробности сервера.');
  await page.clock.runFor(10_000);
  await expect(checkDeletion(page)).toBeDisabled();
  expect(state.jobGets).toHaveLength(1);
  await closeDeletion(page);
  await openDeletion(page, item);
  await expect(checkDeletion(page)).toBeDisabled();
  await page.clock.runFor(20_500);
  await expect(checkDeletion(page)).toBeEnabled();
  expect(state.jobGets).toHaveLength(1);
  state.onJob = async (route, id) => {
    state.files = [];
    await processingReply(route, deletionJob(id, 'succeeded'));
  };
  await checkDeletion(page).click();
  await expect(deleteDialog(page)).toContainText(DELETE_COMPLETE);
  expect(state.jobGets).toEqual([DELETE_JOB_1, DELETE_JOB_1]);
  expect(state.deletes).toHaveLength(0);
});

test('Удаление: succeeded без GET 404 не объявляет очистку завершённой', async ({ page }) => {
  await page.clock.install();
  const item = deletingFile();
  const state = await mockProcessing(page, { files: [item] });
  state.onJob = (route, id) => processingReply(route, deletionJob(id, 'succeeded'));
  await openMaterials(page);
  const usageBefore = state.usageGets;
  await openDeletion(page, item);
  await expect(checkDeletion(page)).toBeEnabled();
  await expect(deleteDialog(page)).not.toContainText(DELETE_COMPLETE);
  await expect(quota(page).getByRole('meter')).toHaveAttribute('aria-valuenow', String(35 * MIB));
  const materialReads = state.materialGets.length;
  await page.clock.runFor(10_000);
  expect(state.jobGets).toHaveLength(1);
  expect(state.materialGets).toHaveLength(materialReads);
  expect(state.usageGets).toBe(usageBefore);
  state.files = [];
  await checkDeletion(page).click();
  await expect(deleteDialog(page)).toContainText(DELETE_COMPLETE);
  expect(state.deletes).toHaveLength(0);
});

test('Удаление: восстановление 401 и CSRF не повторяет DELETE без подтверждения', async ({ page }) => {
  await page.clock.install();
  const state = await mockProcessing(page);
  await openMaterials(page);
  for (const [status, code] of [[401, 'AUTHENTICATION_REQUIRED'], [403, 'CSRF_INVALID']]) {
    await openDeletion(page);
    const before = state.deletes.length;
    const csrfBefore = state.csrfCount;
    state.onDelete = (route) => fail(route, status, code);
    await confirmDelete(page).click();
    await expect.poll(() => state.csrfCount).toBeGreaterThan(csrfBefore);
    await expect(confirmDelete(page)).toBeEnabled();
    await page.clock.runFor(3000);
    expect(state.deletes).toHaveLength(before + 1);
    await deleteDialog(page).getByRole('button', { name: 'Отмена', exact: true }).click();
  }
  expect(state.jobGets).toHaveLength(0);
  expect(state.deletes[1].headers['x-csrf-token']).not.toBe(state.deletes[0].headers['x-csrf-token']);
});

test('Удаление: закрытие во время DELETE подавляет поздний ответ; повторное открытие восстанавливает job', async ({ page }) => {
  await page.clock.install();
  const gate = deferred();
  let responded = false;
  const state = await mockProcessing(page);
  state.onDelete = async (route, id) => {
    await gate.promise;
    state.files = [deletingFile()];
    await processingReply(route, { materialId: id, jobId: DELETE_JOB_1 }, 202).catch(() => {});
    responded = true;
  };
  state.onJob = (route, id) => processingReply(route, deletionJob(id, 'running'));
  await openMaterials(page);
  await openDeletion(page);
  await confirmDelete(page).click();
  try {
    await expect.poll(() => state.deletes.length).toBe(1);
    await closeDeletion(page);
  } finally {
    gate.resolve();
  }
  await expect.poll(() => responded).toBe(true);
  await page.clock.runFor(5000);
  expect(state.jobGets).toHaveLength(0);
  await expect(deleteDialog(page)).toHaveCount(0);
  // Карточка ещё stored: поздний ответ не меняет закрытый интерфейс.
  await openDeletion(page);
  await expect(deleteDialog(page)).toContainText('Удаление выполняется');
  await expect.poll(() => state.jobGets.length).toBe(1);
  expect(state.deletes).toHaveLength(1);
  await closeDeletion(page);
});

test('Удаление: другой аккаунт не получает незавершённое подтверждение после истечения сессии', async ({ page }) => {
  const state = await mockProcessing(page);
  state.onDelete = async (route) => {
    state.user = null;
    await fail(route, 401, 'AUTHENTICATION_REQUIRED');
  };
  await openMaterials(page);
  await openDeletion(page);
  await confirmDelete(page).click();
  await expect(page.getByRole('heading', { name: 'С возвращением!', exact: true })).toBeVisible();
  state.loginUser = OTHER_USER;
  state.subjects = [OTHER_SUBJECT];
  state.files = [material(2, OTHER_SUBJECT.id)];
  state.onDelete = null;
  await loginMaterialUser(page, OTHER_USER);
  await openMaterials(page, OTHER_SUBJECT);
  await expect(deleteDialog(page)).toHaveCount(0);
  await openDeletion(page, material(2, OTHER_SUBJECT.id));
  await expect(confirmDelete(page)).toBeEnabled();
  await expect(deleteDialog(page)).toContainText(material(2).title);
  await expect(deleteDialog(page)).not.toContainText(material(1).title);
  expect(state.deletes).toHaveLength(1);
});

test('Удаление: поздний job после закрытия и выхода не меняет другой аккаунт', async ({ page }) => {
  await page.clock.install();
  const gate = deferred();
  let responded = false;
  const item = deletingFile();
  const state = await mockProcessing(page, { files: [item] });
  state.onJob = async (route, id) => {
    await gate.promise;
    await processingReply(route, deletionJob(id, 'succeeded')).catch(() => {});
    responded = true;
  };
  await openMaterials(page);
  await openDeletion(page, item);
  try {
    await expect.poll(() => state.jobGets.length).toBe(1);
    await closeDeletion(page);
    await account(page).getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'С возвращением!', exact: true })).toBeVisible();
    state.loginUser = OTHER_USER;
    state.subjects = [OTHER_SUBJECT];
    state.files = [];
    state.usage = { ...USAGE, usedBytes: MIB, reservedBytes: 0 };
    await loginMaterialUser(page, OTHER_USER);
    await openMaterials(page, OTHER_SUBJECT);
  } finally {
    gate.resolve();
  }
  await expect.poll(() => responded).toBe(true);
  const reads = state.materialGets.length;
  await page.clock.runFor(5000);
  await expect(deleteDialog(page)).toHaveCount(0);
  await expect(materials(page).getByText('Пока нет материалов', { exact: true })).toBeVisible();
  await expect(quota(page).getByRole('meter')).toHaveAttribute('aria-valuenow', String(MIB));
  expect(state.materialGets).toHaveLength(reads);
  expect(state.deletes).toHaveLength(0);
});
