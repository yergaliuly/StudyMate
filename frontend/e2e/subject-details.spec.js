import { test, expect } from '@playwright/test';

// Изолированные HTTP-mocks: в тестах нет настоящих аккаунтов и сессионных cookie.
const USER = {
  id: '12d2c880-7adc-405b-837a-e4472124d161',
  email: 'subject-details@example.com',
  displayName: 'Студент Предметов',
};
const OTHER_USER = {
  id: 'e6a8f8d4-69ee-4c94-87a3-facdbb52ac23',
  email: 'other-details@example.com',
  displayName: 'Другой Студент',
};
const SUBJECT = {
  id: 'c6f924b2-b4b0-4926-8d28-a7409a3f2710',
  title: 'Предмет из списка',
  description: 'Исходное описание',
  icon: 'book',
  tone: 'blue',
  lectureCount: 0,
  progressPercent: null,
  version: 1,
  createdAt: '2026-09-28T12:00:00Z',
};
const unexpectedByPage = new WeakMap();

async function fail(route, status, code, fieldErrors = {}) {
  await route.fulfill({
    status,
    json: { error: { code, message: 'Служебные подробности сервера.', fieldErrors } },
  });
}

async function mockDetails(page, options = {}) {
  const state = {
    user: USER,
    current: { ...SUBJECT },
    listSubjects: [{ ...SUBJECT }],
    csrf: '',
    csrfCount: 0,
    events: [],
    gets: [],
    patches: [],
    deletes: [],
    lists: 0,
    onGet: null,
    onPatch: null,
    onDelete: null,
    unexpected: [],
    ...options,
  };
  unexpectedByPage.set(page, state.unexpected);

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname.slice('/api/v1'.length);
    state.events.push(`${method} ${path}`);
    if (method === 'GET' && path === '/auth/csrf') {
      state.csrf = `details-csrf-${++state.csrfCount}`;
      await route.fulfill({ status: 200, json: { data: { headerName: 'X-CSRF-TOKEN', token: state.csrf } } });
      return;
    }
    if (method === 'GET' && path === '/auth/me') {
      if (state.user) await route.fulfill({ status: 200, json: { data: state.user } });
      else await fail(route, 401, 'AUTHENTICATION_REQUIRED');
      return;
    }
    if (method === 'POST' && path === '/auth/login') {
      state.user ??= USER;
      await route.fulfill({ status: 200, json: { data: state.user } });
      return;
    }
    if (method === 'POST' && path === '/auth/logout') {
      state.user = null;
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (method === 'GET' && path === '/subjects') {
      state.lists += 1;
      await route.fulfill({
        status: 200,
        json: {
          data: state.listSubjects,
          meta: { page: Number(url.searchParams.get('page')), pageSize: Number(url.searchParams.get('pageSize')), total: state.listSubjects.length },
        },
      });
      return;
    }
    if (path === `/subjects/${SUBJECT.id}`) {
      if (method === 'GET') {
        state.gets.push(request.url());
        if (state.onGet) await state.onGet(route);
        else if (state.current) await route.fulfill({ status: 200, json: { data: state.current } });
        else await fail(route, 404, 'SUBJECT_NOT_FOUND');
        return;
      }
      if (method === 'PATCH') {
        state.patches.push({ body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'], key: request.headers()['idempotency-key'] });
        if (state.onPatch) await state.onPatch(route);
        else {
          const body = request.postDataJSON();
          if (body.version !== state.current?.version) await fail(route, 409, 'SUBJECT_VERSION_CONFLICT');
          else {
            state.current = { ...state.current, ...body, version: body.version + 1 };
            state.listSubjects = [state.current];
            await route.fulfill({ status: 200, json: { data: state.current } });
          }
        }
        return;
      }
      if (method === 'DELETE') {
        state.deletes.push({ body: request.postData(), csrf: request.headers()['x-csrf-token'], key: request.headers()['idempotency-key'] });
        if (state.onDelete) await state.onDelete(route);
        else {
          state.current = null;
          state.listSubjects = [];
          await route.fulfill({ status: 204, body: '' });
        }
        return;
      }
    }
    state.unexpected.push(`${method} ${path}`);
    await fail(route, 500, 'UNEXPECTED_TEST_REQUEST');
  });

  await page.goto('/');
  await expect(account(page).getByRole('heading', { name: SUBJECT.title, exact: true })).toBeVisible();
  return state;
}

test.afterEach(async ({ page }) => {
  expect(unexpectedByPage.get(page) ?? [], 'Неожиданные API-запросы').toEqual([]);
});

function account(page) { return page.locator('#account-main-content'); }
function dialog(page, name) { return page.getByRole('dialog', { name, exact: true }); }

async function openView(page) {
  await account(page).getByRole('button', { name: `Открыть предмет «${SUBJECT.title}»`, exact: true }).click();
  const view = dialog(page, 'Предмет');
  await expect(view).toBeVisible();
  return view;
}

async function openAction(page, action) {
  await account(page).getByRole('button', { name: `Действия с предметом «${SUBJECT.title}»`, exact: true }).click();
  await account(page).getByRole('button', { name: action, exact: true }).click();
  const modal = dialog(page, action === 'Редактировать' ? 'Редактировать предмет' : 'Удалить предмет?');
  await expect(modal).toBeVisible();
  return modal;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('Просмотр загружает свежий GET, не рисует прогресс null и возвращает фокус в список', async ({ page }) => {
  const title = 'Дифференциальные уравнения и математическое моделирование';
  const state = await mockDetails(page, { current: { ...SUBJECT, title, description: 'Актуальное описание из GET', version: 7 } });
  await page.setViewportSize({ width: 390, height: 844 });
  const view = await openView(page);
  await expect(view.getByRole('heading', { level: 3, name: title, exact: true })).toBeVisible();
  await expect(view.getByText('Актуальное описание из GET', { exact: true })).toBeVisible();
  await expect(view.getByRole('progressbar')).toHaveCount(0);
  await expect(view).not.toContainText('0%');
  expect(state.gets).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await expect(view).not.toBeVisible();
  await expect(account(page).getByRole('button', { name: 'Добавить предмет', exact: true })).toBeFocused();
});

test('Прямое редактирование использует свежую version, один PATCH и обновляет карточки через GET списка', async ({ page }) => {
  const state = await mockDetails(page, { current: { ...SUBJECT, title: 'Название из GET', version: 7 } });
  const edit = await openAction(page, 'Редактировать');
  await expect(edit.getByLabel('Название предмета')).toHaveValue('Название из GET');
  expect(state.gets).toHaveLength(1);
  await edit.getByLabel('Название предмета').fill('  Новый   предмет  ');
  await edit.getByLabel('Описание', { exact: true }).fill('  Новое описание  ');
  await edit.getByLabel('Иконка карточки', { exact: true }).selectOption('code');
  await edit.getByLabel('Зелёный', { exact: true }).check();
  const pending = deferred();
  state.onPatch = async (route) => {
    await pending.promise;
    const response = { ...state.current, ...route.request().postDataJSON(), version: 8 };
    state.current = response;
    state.listSubjects = [{ ...response, title: 'Более новая карточка', version: 9 }];
    await route.fulfill({ status: 200, json: { data: response } });
  };
  const listCount = state.lists;
  try {
    await edit.locator('form').evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await expect.poll(() => state.patches.length).toBe(1);
    await expect(edit.getByRole('button', { name: 'Сохраняем…', exact: true })).toBeDisabled();
    await expect(edit.getByLabel('Название предмета')).toBeDisabled();
    await expect(edit.getByRole('button', { name: 'Отмена', exact: true })).toBeDisabled();
  } finally {
    pending.resolve();
  }
  const view = dialog(page, 'Предмет');
  await expect(view.getByText('Изменения сохранены.', { exact: true })).toBeVisible();
  expect(state.patches).toHaveLength(1);
  expect(state.patches[0]).toEqual({
    body: { version: 7, title: 'Новый предмет', description: 'Новое описание', icon: 'code', tone: 'green' },
    csrf: state.csrf,
    key: undefined,
  });
  await expect.poll(() => state.lists).toBeGreaterThan(listCount);
  await view.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(account(page).getByRole('heading', { name: 'Более новая карточка', exact: true })).toBeVisible();
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const value of ['Новый предмет', 'Новое описание', SUBJECT.id, state.csrf]) expect(storage).not.toContain(value);
});

for (const [status, code] of [[422, 'VALIDATION_FAILED'], [409, 'SUBJECT_TITLE_EXISTS']]) {
  test(`PATCH ${code} сохраняет черновик и показывает только известные ошибки полей`, async ({ page }) => {
    const state = await mockDetails(page);
    state.onPatch = (route) => fail(route, status, code, { title: 'Название занято.', privateField: 'Не показывать это.' });
    const edit = await openAction(page, 'Редактировать');
    await edit.getByLabel('Название предмета').fill('Мой черновик');
    await edit.getByLabel('Описание', { exact: true }).fill('Оставить описание');
    await edit.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
    await expect(edit.getByText('Название занято.', { exact: true })).toBeVisible();
    await expect(edit.getByLabel('Название предмета')).toHaveValue('Мой черновик');
    await expect(edit.getByLabel('Описание', { exact: true })).toHaveValue('Оставить описание');
    await expect(edit.getByLabel('Название предмета')).toBeFocused();
    await expect(edit.getByRole('button', { name: 'Сохранить изменения', exact: true })).toBeEnabled();
    await expect(edit).not.toContainText('Не показывать это.');
    expect(state.patches).toHaveLength(1);
  });
}

test('Конфликт version сохраняет черновик; повторный PATCH требует загрузки и явного выбора новой версии', async ({ page }) => {
  const state = await mockDetails(page, { current: { ...SUBJECT, version: 7 } });
  const edit = await openAction(page, 'Редактировать');
  await edit.getByLabel('Название предмета').fill('Мой вариант после конфликта');
  state.onPatch = async (route) => {
    state.current = { ...SUBJECT, title: 'Изменено другим запросом', description: 'Новая серверная версия', version: 8 };
    await fail(route, 409, 'SUBJECT_VERSION_CONFLICT');
  };
  await edit.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(edit.getByRole('button', { name: 'Загрузить актуальную версию', exact: true })).toBeVisible();
  await expect(edit.getByLabel('Название предмета')).toHaveValue('Мой вариант после конфликта');
  await expect(edit.getByRole('button', { name: 'Сохранить изменения', exact: true })).toBeDisabled();
  expect(state.gets).toHaveLength(1);
  expect(state.patches).toHaveLength(1);
  await edit.getByRole('button', { name: 'Загрузить актуальную версию', exact: true }).click();
  await expect(edit.getByText('Изменено другим запросом', { exact: true })).toBeVisible();
  await expect(edit.getByLabel('Название предмета')).toHaveValue('Мой вариант после конфликта');
  expect(state.gets).toHaveLength(2);
  await edit.getByRole('button', { name: 'Продолжить с моим черновиком', exact: true }).click();
  await expect(edit.getByRole('button', { name: 'Сохранить изменения', exact: true })).toBeEnabled();
  expect(state.patches).toHaveLength(1);
  state.onPatch = null;
  await edit.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(dialog(page, 'Предмет').getByText('Изменения сохранены.', { exact: true })).toBeVisible();
  expect(state.patches).toHaveLength(2);
  expect(state.patches[1].body.version).toBe(8);
  expect(state.patches[1].body.title).toBe('Мой вариант после конфликта');
});

test('Потерянный ответ PATCH проверяется вручную через GET; принятие версии сервера не повторяет изменение', async ({ page }) => {
  await page.clock.install();
  const state = await mockDetails(page);
  state.onPatch = async (route) => {
    state.current = { ...SUBJECT, ...route.request().postDataJSON(), version: 2 };
    state.listSubjects = [state.current];
    await route.abort('failed');
  };
  const edit = await openAction(page, 'Редактировать');
  await edit.getByLabel('Название предмета').fill('Сохранено без ответа');
  await edit.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(edit.getByRole('button', { name: 'Проверить результат', exact: true })).toBeVisible();
  await expect(edit.getByRole('button', { name: 'Сохранить изменения', exact: true })).toBeDisabled();
  await page.clock.runFor(2_000);
  expect(state.gets).toHaveLength(1);
  expect(state.patches).toHaveLength(1);
  await edit.getByRole('button', { name: 'Проверить результат', exact: true }).click();
  await expect(edit.getByRole('button', { name: 'Использовать версию сервера', exact: true })).toBeVisible();
  await edit.getByRole('button', { name: 'Использовать версию сервера', exact: true }).click();
  expect(state.gets).toHaveLength(2);
  expect(state.patches).toHaveLength(1);
  await expect(edit.getByLabel('Название предмета')).toHaveValue('Сохранено без ответа');
  await expect(edit.getByRole('button', { name: 'Сохранить изменения', exact: true })).toBeEnabled();
  await edit.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(edit).not.toBeVisible();
  expect(state.patches).toHaveLength(1);
});

test('Ошибка GET не подменяется карточкой из списка, повтор с 404 показывает недоступность', async ({ page }) => {
  const state = await mockDetails(page);
  state.onGet = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');
  const view = await openView(page);
  await expect(view.getByRole('button', { name: 'Повторить загрузку', exact: true })).toBeVisible();
  await expect(view.getByRole('heading', { level: 3, name: SUBJECT.title, exact: true })).toHaveCount(0);
  await expect(view).not.toContainText('Служебные подробности сервера.');
  state.onGet = (route) => fail(route, 404, 'SUBJECT_NOT_FOUND');
  state.listSubjects = [];
  await view.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Предмет недоступен', exact: true })).toBeVisible();
  expect(state.gets).toHaveLength(2);
  expect(state.patches).toHaveLength(0);
  expect(state.deletes).toHaveLength(0);
});

test('Удаление требует подтверждения, блокирует повторный клик и убирает карточку только после 204', async ({ page }) => {
  const state = await mockDetails(page);
  let remove = await openAction(page, 'Удалить');
  await remove.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(remove).not.toBeVisible();
  expect(state.deletes).toHaveLength(0);
  remove = await openAction(page, 'Удалить');
  const pending = deferred();
  state.onDelete = async (route) => {
    await pending.promise;
    state.current = null;
    state.listSubjects = [];
    await route.fulfill({ status: 204, body: '' });
  };
  try {
    await remove.getByRole('button', { name: 'Удалить предмет', exact: true }).evaluate((button) => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect.poll(() => state.deletes.length).toBe(1);
    await expect(remove.getByRole('button', { name: 'Удаляем…', exact: true })).toBeDisabled();
    await expect(remove.getByRole('button', { name: 'Отмена', exact: true })).toBeDisabled();
    await expect(account(page).locator('.subject-card')).toHaveCount(1);
  } finally {
    pending.resolve();
  }
  await expect(remove).not.toBeVisible();
  await expect(account(page).getByText('Пока нет предметов', { exact: true })).toBeVisible();
  expect(state.gets.length).toBeGreaterThanOrEqual(2);
  expect(state.deletes).toEqual([{ body: null, csrf: state.csrf, key: undefined }]);
});

test('SUBJECT_NOT_EMPTY оставляет предмет даже при lectureCount равном нулю', async ({ page }) => {
  const state = await mockDetails(page);
  state.onDelete = (route) => fail(route, 409, 'SUBJECT_NOT_EMPTY');
  const remove = await openAction(page, 'Удалить');
  await remove.getByRole('button', { name: 'Удалить предмет', exact: true }).click();
  await expect(remove.getByText('Предмет нельзя удалить:', { exact: false })).toBeVisible();
  await expect(remove).not.toContainText('Служебные подробности сервера.');
  await expect(account(page).locator('.subject-card')).toHaveCount(1);
  await remove.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(account(page).getByRole('heading', { name: SUBJECT.title, exact: true })).toBeVisible();
  expect(state.deletes).toHaveLength(1);
});

for (const stillExists of [false, true]) {
  test(`Неоднозначный DELETE: ручной GET возвращает ${stillExists ? '200 и требует нового подтверждения' : '404 без повторного удаления'}`, async ({ page }) => {
    await page.clock.install();
    const state = await mockDetails(page);
    state.onDelete = async (route) => {
      if (!stillExists) { state.current = null; state.listSubjects = []; }
      await route.abort('failed');
    };
    const remove = await openAction(page, 'Удалить');
    await remove.getByRole('button', { name: 'Удалить предмет', exact: true }).click();
    await expect(remove.getByRole('button', { name: 'Проверить результат', exact: true })).toBeVisible();
    await page.clock.runFor(2_000);
    expect(state.gets).toHaveLength(1);
    expect(state.deletes).toHaveLength(1);
    await remove.getByRole('button', { name: 'Проверить результат', exact: true }).click();
    if (stillExists) {
      const view = dialog(page, 'Предмет');
      await expect(view.getByRole('heading', { level: 3, name: SUBJECT.title, exact: true })).toBeVisible();
      expect(state.deletes).toHaveLength(1);
      await view.getByRole('button', { name: 'Удалить предмет', exact: true }).click();
      await expect(dialog(page, 'Удалить предмет?')).toBeVisible();
      expect(state.deletes).toHaveLength(1);
    } else {
      const unavailable = page.getByRole('dialog');
      await expect(unavailable.getByRole('heading', { name: 'Предмет недоступен', exact: true })).toBeVisible();
      await expect(unavailable).not.toContainText('Предмет удалён');
      await unavailable.getByRole('button', { name: 'Закрыть окно', exact: true }).click();
      await expect(account(page).getByText('Пока нет предметов', { exact: true })).toBeVisible();
    }
    expect(state.gets.length).toBeGreaterThanOrEqual(2);
    expect(state.deletes).toHaveLength(1);
  });
}

test('CSRF отказ PATCH восстанавливает сессию и черновик того же пользователя без автоматического сохранения', async ({ page }) => {
  const state = await mockDetails(page);
  state.onPatch = (route) => fail(route, 403, 'CSRF_INVALID');
  const edit = await openAction(page, 'Редактировать');
  await edit.getByLabel('Название предмета').fill('Черновик после CSRF');
  await edit.getByLabel('Описание', { exact: true }).fill('Не потерять мои изменения');
  const oldCsrf = state.csrf;
  const csrfCount = state.csrfCount;
  await edit.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect.poll(() => state.csrfCount).toBeGreaterThan(csrfCount);
  await expect.poll(() => state.gets.length).toBe(2);
  await expect(edit).toBeVisible();
  await expect(edit.getByLabel('Название предмета')).toHaveValue('Черновик после CSRF');
  await expect(edit.getByLabel('Описание', { exact: true })).toHaveValue('Не потерять мои изменения');
  expect(state.csrf).not.toBe(oldCsrf);
  expect(state.patches).toHaveLength(1);
});

test('После 401 другой аккаунт не получает прежний предмет или черновик редактирования', async ({ page }) => {
  const state = await mockDetails(page);
  state.onPatch = async (route) => {
    state.user = null;
    await fail(route, 401, 'AUTHENTICATION_REQUIRED');
  };
  const edit = await openAction(page, 'Редактировать');
  await edit.getByLabel('Название предмета').fill('Частный черновик первого');
  await edit.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'С возвращением!', exact: true })).toBeVisible();
  state.user = OTHER_USER;
  state.listSubjects = [];
  state.current = null;
  await page.getByLabel('Email', { exact: true }).fill(OTHER_USER.email);
  await page.getByLabel('Пароль', { exact: true }).fill('Only-for-detail-tests!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(account(page).getByText(OTHER_USER.email, { exact: true })).toBeVisible();
  await expect(account(page).getByText('Пока нет предметов', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(account(page)).not.toContainText('Частный черновик первого');
  expect(state.patches).toHaveLength(1);
});

test('Поздний GET закрытого предмета после выхода не возвращает частные данные', async ({ page }) => {
  const state = await mockDetails(page);
  const pending = deferred();
  let responded = false;
  state.onGet = async (route) => {
    await pending.promise;
    await route.fulfill({ status: 200, json: { data: { ...SUBJECT, title: 'Поздний частный предмет' } } });
    responded = true;
  };
  const view = await openView(page);
  await expect.poll(() => state.gets.length).toBe(1);
  try {
    await view.getByRole('button', { name: 'Закрыть окно', exact: true }).click();
    await account(page).getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'С возвращением!', exact: true })).toBeVisible();
  } finally { pending.resolve(); }
  await expect.poll(() => responded).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Поздний частный предмет', { exact: true })).toHaveCount(0);
});

test('Поздний PATCH после глобального выхода не восстанавливает предмет и успешное сообщение', async ({ page }) => {
  const state = await mockDetails(page);
  const pending = deferred();
  let responded = false;
  state.onPatch = async (route) => {
    await pending.promise;
    await route.fulfill({ status: 200, json: { data: { ...SUBJECT, ...route.request().postDataJSON(), version: 2 } } });
    responded = true;
  };
  const edit = await openAction(page, 'Редактировать');
  await edit.getByLabel('Название предмета').fill('Поздно сохранённый черновик');
  await edit.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  try {
    // Инициируем общий выход, пока modal блокирует обычное взаимодействие с фоном.
    // Проверяется отмена уже отправленной операции при смене состояния аккаунта.
    await account(page).locator('button').filter({ hasText: 'Выйти из аккаунта' }).evaluate((button) => button.click());
    await expect(page.getByRole('heading', { name: 'С возвращением!', exact: true })).toBeVisible();
  } finally { pending.resolve(); }
  await expect.poll(() => responded).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Изменения сохранены.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Поздно сохранённый черновик', { exact: true })).toHaveCount(0);
  expect(state.patches).toHaveLength(1);
});
