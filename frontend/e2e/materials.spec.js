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

async function fail(route, status, code) {
  await route.fulfill({
    status,
    json: {
      error: {
        code,
        message: 'Внутренние подробности сервера.',
        fieldErrors: {},
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
    textGets: [],
    jobGets: [],
    starts: [],
    uploads: [],
    onMaterial: null,
    onText: null,
    onJob: null,
    onProcess: null,
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
    const match = /^\/materials\/([^/]+)(?:\/(pages|process))?$/.exec(path);

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

test('Текст: свежий GET, пустая страница, безопасный вывод и пагинация', async ({ page }) => {
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

  await page.setViewportSize({ width: 390, height: 844 });

  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
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