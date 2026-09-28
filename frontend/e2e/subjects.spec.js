import { test, expect } from '@playwright/test';

// Все аккаунты, CSRF и предметы вымышлены; настоящий backend этим тестам не нужен.
const USER = {
  id: '1164903f-7ba3-40d8-8c79-b9009361b950',
  email: 'subjects@example.com',
  displayName: 'Студент Предметов',
};
const SECOND_USER = {
  id: '3264903f-7ba3-40d8-8c79-b9009361b951',
  email: 'other-subjects@example.com',
  displayName: 'Другой Студент',
};
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function subject(number, title, overrides = {}) {
  return {
    id: `f73de5ee-311e-45cb-b7e2-${String(number).padStart(12, '0')}`,
    title,
    description: 'Описание с сервера',
    icon: 'book',
    tone: 'blue',
    lectureCount: 0,
    progressPercent: null,
    createdAt: '2026-09-28T12:00:00Z',
    version: 1,
    ...overrides,
  };
}

async function fail(route, status, code, fieldErrors = {}, headers = {}) {
  await route.fulfill({
    status,
    headers,
    json: { error: { code, message: 'Внутренние подробности сервера.', fieldErrors } },
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

async function mockSubjects(page, options = {}) {
  const state = {
    user: USER,
    subjects: [],
    lists: [],
    posts: [],
    csrf: '',
    csrfCount: 0,
    onList: null,
    onCreate: null,
    ...options,
  };

  await page.route('**/api/v1/auth/*', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    if (action === 'csrf') {
      state.csrf = `subjects-csrf-${++state.csrfCount}`;
      await route.fulfill({
        status: 200,
        json: { data: { headerName: 'X-CSRF-TOKEN', token: state.csrf } },
      });
    } else if (action === 'me') {
      if (state.user) await route.fulfill({ status: 200, json: { data: state.user } });
      else await fail(route, 401, 'AUTHENTICATION_REQUIRED');
    } else if (action === 'logout') {
      state.user = null;
      await route.fulfill({ status: 204, body: '' });
    } else if (action === 'login') {
      state.user ??= USER;
      await route.fulfill({ status: 200, json: { data: state.user } });
    } else {
      await fail(route, 404, 'UNEXPECTED_TEST_REQUEST');
    }
  });

  await page.route(/\/api\/v1\/subjects(?:\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      const params = new URL(request.url()).searchParams;
      state.lists.push(Object.fromEntries(params));
      if (state.onList) await state.onList(route, params);
      else {
        const query = (params.get('q') || '').toLocaleLowerCase('ru');
        const matches = state.subjects.filter((item) =>
          `${item.title} ${item.description}`.toLocaleLowerCase('ru').includes(query));
        const offset = (Number(params.get('page')) - 1) * Number(params.get('pageSize'));
        await listResponse(route, matches.slice(offset, offset + Number(params.get('pageSize'))), matches.length);
      }
    } else if (request.method() === 'POST') {
      state.posts.push({
        body: request.postDataJSON(),
        raw: request.postData(),
        key: request.headers()['idempotency-key'],
        csrf: request.headers()['x-csrf-token'],
      });
      if (state.onCreate) await state.onCreate(route);
      else {
        const created = subject(state.subjects.length + 1, '', request.postDataJSON());
        state.subjects.unshift(created);
        await route.fulfill({ status: 201, json: { data: created } });
      }
    } else {
      await fail(route, 405, 'UNEXPECTED_TEST_REQUEST');
    }
  });

  await page.goto('/');
  await expect(page.locator('#account-main-content')).toBeVisible();
  return state;
}

function account(page) {
  return page.locator('#account-main-content');
}

async function openCreate(page, title = 'Серверный предмет') {
  await account(page).getByRole('button', { name: 'Добавить предмет', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новый предмет', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Название предмета').fill(title);
  return dialog;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('Список показывает серверные предметы без демо-данных и выдуманного прогресса', async ({ page }) => {
  const title = 'Математический анализ и дифференциальные уравнения';
  const state = await mockSubjects(page, { subjects: [subject(1, title)] });
  await expect(account(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
  expect(state.lists[0]).toEqual({ page: '1', pageSize: '20' });
  await expect(account(page).getByRole('heading', { name: 'Базы данных', exact: true })).toHaveCount(0);
  await expect(account(page).getByRole('progressbar')).toHaveCount(0);
  await expect(account(page)).not.toContainText('0%');
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const value of [USER.id, USER.email, state.csrf, title]) {
    expect(storage).not.toContain(value);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('Пустой список, отсутствие совпадений и ошибка сервера различаются; повтор выполняет GET', async ({ page }) => {
  const state = await mockSubjects(page);
  await expect(account(page).getByText('Пока нет предметов', { exact: true })).toBeVisible();
  await account(page).getByLabel('Поиск предметов', { exact: true }).fill('Несуществующий');
  await expect(account(page).getByText('Ничего не найдено', { exact: true })).toBeVisible();
  state.onList = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');
  await account(page).getByLabel('Поиск предметов', { exact: true }).fill('Ошибка');
  await expect(account(page).getByRole('alert')).toBeVisible();
  await expect(account(page).getByText('Пока нет предметов', { exact: true })).not.toBeVisible();
  await expect(account(page).getByText('Ничего не найдено', { exact: true })).not.toBeVisible();
  await expect(account(page)).not.toContainText('Внутренние подробности сервера.');
  state.onList = (route) => listResponse(route, [subject(2, 'Восстановленный список')]);
  await account(page).getByRole('button', { name: 'Обновить список', exact: true }).click();
  await expect(account(page).getByRole('heading', { name: 'Восстановленный список', exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(0);
});

test('Пагинация использует total сервера; новый поиск сбрасывает страницу и игнорирует поздний ответ', async ({ page }) => {
  const subjects = Array.from({ length: 21 }, (_, index) => subject(index + 1, `Предмет ${index + 1}`));
  const state = await mockSubjects(page, { subjects });
  const next = account(page).getByRole('button', { name: 'Следующая страница', exact: true });
  const previous = account(page).getByRole('button', { name: 'Предыдущая страница', exact: true });
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(account(page).getByRole('heading', { name: 'Предмет 21', exact: true })).toBeVisible();
  await expect(next).toBeDisabled();
  await expect(previous).toBeEnabled();
  expect(state.lists.at(-1)).toEqual({ page: '2', pageSize: '20' });

  const late = deferred();
  let lateResponded = false;
  state.onList = async (route, params) => {
    if (params.get('q') === 'Старый') {
      await late.promise;
      await listResponse(route, [subject(30, 'Запоздалый предмет')]);
      lateResponded = true;
    } else await listResponse(route, [subject(31, 'Актуальный предмет')]);
  };
  try {
    await account(page).getByLabel('Поиск предметов', { exact: true }).fill('Старый');
    await expect.poll(() => state.lists.at(-1)?.q).toBe('Старый');
    expect(state.lists.at(-1).page).toBe('1');
    await account(page).getByLabel('Поиск предметов', { exact: true }).fill('Новый');
    await expect(account(page).getByRole('heading', { name: 'Предмет 21', exact: true })).not.toBeVisible();
    await expect(account(page).getByRole('heading', { name: 'Актуальный предмет', exact: true })).toBeVisible();
  } finally {
    late.resolve();
  }
  await expect.poll(() => lateResponded).toBe(true);
  await expect(account(page).getByRole('heading', { name: 'Запоздалый предмет', exact: true })).not.toBeVisible();
  expect(state.lists.at(-1)).toEqual({ q: 'Новый', page: '1', pageSize: '20' });
});

test('Создание блокирует повторный submit, нормализует поля и обновляет список через GET', async ({ page }) => {
  const state = await mockSubjects(page);
  const pending = deferred();
  state.onCreate = async (route) => {
    await pending.promise;
    // POST может быть историческим ответом idempotency: карточку берём из нового GET.
    state.subjects = [subject(8, 'Актуальное название', { version: 3 })];
    await route.fulfill({ status: 201, json: { data: subject(8, 'Старое название') } });
  };
  const dialog = await openCreate(page, '  Высшая   математика  ');
  await dialog.getByLabel('Описание').fill('  Только в аккаунте  ');
  await dialog.getByLabel('Иконка карточки', { exact: true }).selectOption('code');
  await dialog.getByLabel('Зелёный', { exact: true }).check();
  const csrf = state.csrf;
  try {
    await dialog.locator('form').evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await expect(dialog.getByRole('button', { name: 'Создаём предмет…', exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Название предмета')).toBeDisabled();
    await expect.poll(() => state.posts.length).toBe(1);
  } finally {
    pending.resolve();
  }
  await expect(dialog).not.toBeVisible();
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0].body).toEqual({ title: 'Высшая математика', description: 'Только в аккаунте', icon: 'code', tone: 'green' });
  expect(state.posts[0].key).toMatch(UUID);
  expect(state.posts[0].csrf).toBe(csrf);
  await expect(account(page).getByRole('heading', { name: 'Актуальное название', exact: true })).toBeVisible();
  await expect(account(page).getByRole('heading', { name: 'Старое название', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(account(page).getByRole('heading', { name: 'Актуальное название', exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(1);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const value of ['Высшая математика', 'Актуальное название', 'Только в аккаунте', state.posts[0].key]) expect(storage).not.toContain(value);
});

for (const [status, code] of [[422, 'VALIDATION_FAILED'], [409, 'SUBJECT_TITLE_EXISTS']]) {
  test(`Создание ${code}: серверная ошибка поля сохраняет введённые данные`, async ({ page }) => {
    const state = await mockSubjects(page);
    state.onCreate = (route) => fail(route, status, code, { title: 'Название уже используется.', internalField: 'Не показывать это поле.' });
    const dialog = await openCreate(page, 'Сохранить название');
    await dialog.getByLabel('Описание').fill('Сохранить описание');
    await dialog.getByRole('button', { name: 'Создать предмет', exact: true }).click();
    await expect(dialog.getByText('Название уже используется.', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Название предмета')).toHaveValue('Сохранить название');
    await expect(dialog.getByLabel('Описание')).toHaveValue('Сохранить описание');
    await expect(dialog.getByLabel('Название предмета')).toBeFocused();
    await expect(dialog).not.toContainText('Не показывать это поле.');
    expect(state.posts).toHaveLength(1);
  });
}

test('Потерянный ответ создания повторяется только вручную с прежними ключом и телом после закрытия формы', async ({ page }) => {
  await page.clock.install();
  const state = await mockSubjects(page);
  state.onCreate = (route) => route.abort('failed');
  let dialog = await openCreate(page, 'Не потерять создание');
  await dialog.getByRole('button', { name: 'Создать предмет', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Повторить создание', exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('Название предмета')).toBeDisabled();
  await page.clock.runFor(3_000);
  expect(state.posts).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Закрыть окно', exact: true }).click();
  await account(page).getByRole('button', { name: 'Добавить предмет', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Новый предмет', exact: true });
  await expect(dialog.getByLabel('Название предмета')).toHaveValue('Не потерять создание');
  state.onCreate = null;
  await dialog.getByRole('button', { name: 'Повторить создание', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1].key).toBe(state.posts[0].key);
  expect(state.posts[1].raw).toBe(state.posts[0].raw);
});

test('После неоднозначного создания изменить данные можно явно; новое тело получает новый ключ', async ({ page }) => {
  const state = await mockSubjects(page);
  state.onCreate = (route) => route.abort('failed');
  const dialog = await openCreate(page, 'Первый вариант');
  await dialog.getByRole('button', { name: 'Создать предмет', exact: true }).click();
  await expect(dialog.getByLabel('Название предмета')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Изменить данные', exact: true }).click();
  await expect(dialog.getByLabel('Название предмета')).toBeEnabled();
  await dialog.getByLabel('Название предмета').fill('Второй вариант');
  state.onCreate = null;
  await dialog.getByRole('button', { name: 'Создать предмет', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1].key).toMatch(UUID);
  expect(state.posts[1].key).not.toBe(state.posts[0].key);
  expect(state.posts[1].body.title).toBe('Второй вариант');
});

test('REQUEST_IN_PROGRESS соблюдает Retry-After и не повторяет POST автоматически', async ({ page }) => {
  await page.clock.install();
  const state = await mockSubjects(page);
  state.onCreate = (route) => fail(route, 409, 'REQUEST_IN_PROGRESS', {}, { 'Retry-After': '5' });
  const dialog = await openCreate(page);
  await dialog.getByRole('button', { name: 'Создать предмет', exact: true }).click();
  const retry = dialog.getByRole('button', { name: 'Повторить создание', exact: true });
  await expect(retry).toBeDisabled();
  await page.clock.runFor(6_000);
  await expect(retry).toBeEnabled();
  expect(state.posts).toHaveLength(1);
  state.onCreate = null;
  await retry.click();
  await expect(dialog).not.toBeVisible();
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1].key).toBe(state.posts[0].key);
});

test('Ошибка CSRF обновляет сессию того же пользователя и сохраняет черновик без повторного POST', async ({ page }) => {
  const state = await mockSubjects(page);
  state.onCreate = (route) => fail(route, 403, 'CSRF_INVALID');
  const dialog = await openCreate(page, 'Черновик после CSRF');
  await dialog.getByLabel('Описание').fill('Описание не теряется');
  const previousCsrf = state.csrf;
  const previousCsrfCount = state.csrfCount;
  await dialog.getByRole('button', { name: 'Создать предмет', exact: true }).click();
  await expect.poll(() => state.csrfCount).toBeGreaterThan(previousCsrfCount);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Название предмета')).toHaveValue('Черновик после CSRF');
  await expect(dialog.getByLabel('Описание')).toHaveValue('Описание не теряется');
  expect(state.posts).toHaveLength(1);
  expect(state.csrf).not.toBe(previousCsrf);
  state.onCreate = null;
  await dialog.getByRole('button', { name: 'Создать предмет', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1].key).toBe(state.posts[0].key);
  expect(state.posts[1].raw).toBe(state.posts[0].raw);
  expect(state.posts[1].csrf).toBe(state.csrf);
  expect(state.posts[1].csrf).not.toBe(previousCsrf);
});

test('Истёкшая сессия скрывает предметы; другой аккаунт не получает прежний черновик', async ({ page }) => {
  const state = await mockSubjects(page, { subjects: [subject(11, 'Личный предмет первого')] });
  await expect(account(page).getByRole('heading', { name: 'Личный предмет первого', exact: true })).toBeVisible();
  state.onCreate = async (route) => {
    state.user = null;
    await fail(route, 401, 'AUTHENTICATION_REQUIRED');
  };
  const dialog = await openCreate(page, 'Черновик первого аккаунта');
  await dialog.getByRole('button', { name: 'Создать предмет', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'С возвращением!', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Личный предмет первого', exact: true })).toHaveCount(0);
  expect(state.posts).toHaveLength(1);
  state.user = SECOND_USER;
  state.subjects = [];
  await page.getByLabel('Email', { exact: true }).fill(SECOND_USER.email);
  await page.getByLabel('Пароль', { exact: true }).fill('Only-for-subject-tests!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(account(page).getByText(SECOND_USER.email, { exact: true })).toBeVisible();
  await expect(account(page).getByText('Пока нет предметов', { exact: true })).toBeVisible();
  await expect(dialog).not.toBeVisible();
  await account(page).getByRole('button', { name: 'Добавить предмет', exact: true }).click();
  await expect(dialog.getByLabel('Название предмета')).toHaveValue('');
  expect(state.posts).toHaveLength(1);
});

test('Запоздавший список после выхода не возвращает данные прежнего аккаунта', async ({ page }) => {
  const pending = deferred();
  let responded = false;
  const state = await mockSubjects(page, {
    onList: async (route) => {
      await pending.promise;
      await listResponse(route, [subject(10, 'Секретный старый предмет')]);
      responded = true;
    },
  });
  await expect.poll(() => state.lists.length).toBeGreaterThan(0);
  try {
    await account(page).getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'С возвращением!', exact: true })).toBeVisible();
  } finally {
    pending.resolve();
  }
  await expect.poll(() => responded).toBe(true);
  await expect(page.getByRole('heading', { name: 'Секретный старый предмет', exact: true })).toHaveCount(0);
  state.onList = null;
  state.user = SECOND_USER;
  await page.getByLabel('Email', { exact: true }).fill(SECOND_USER.email);
  await page.getByLabel('Пароль', { exact: true }).fill('Only-for-subject-tests!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(account(page).getByText(SECOND_USER.email, { exact: true })).toBeVisible();
  await expect(account(page).getByText('Пока нет предметов', { exact: true })).toBeVisible();
  await expect(account(page)).not.toContainText('Секретный старый предмет');
});
