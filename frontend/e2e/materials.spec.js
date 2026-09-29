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