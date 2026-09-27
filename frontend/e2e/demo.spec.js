import { test, expect } from '@playwright/test';

async function openDemo(page) {
  await page.getByRole('button', {
    name: 'Открыть демо-кабинет',
    exact: true,
  }).click();

  await expect(
    page.getByText('Демонстрационный кабинет', { exact: true }),
  ).toBeVisible();
}

function subjectCard(page, title) {
  return page.getByRole('article').filter({
    has: page.getByRole('heading', {
      name: title,
      exact: true,
    }),
  });
}

async function createSubject(page, title) {
  await page.getByRole('button', {
    name: 'Добавить предмет',
    exact: true,
  }).click();

  const dialog = page.getByRole('dialog', {
    name: 'Новый предмет',
    exact: true,
  });

  await dialog.getByLabel('Название предмета').fill(title);
  await dialog.getByLabel('Описание').fill('Тестовое описание');

  await dialog.getByRole('button', {
    name: 'Создать предмет',
    exact: true,
  }).click();

  await expect(dialog).not.toBeVisible();
  await expect(subjectCard(page, title)).toBeVisible();
}

async function openSubjectAction(page, title, action) {
  const card = subjectCard(page, title);

  await card.getByRole('button', {
    name: `Действия с предметом «${title}»`,
    exact: true,
  }).click();

  await card.getByRole('button', {
    name: action,
    exact: true,
  }).click();
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/csrf', async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        data: {
          headerName: 'X-CSRF-TOKEN',
          token: 'smoke-test-csrf-token',
        },
      },
    });
  });

  await page.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 401,
      json: {
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Войди в аккаунт.',
          fieldErrors: {},
        },
      },
    });
  });

  await page.goto('/');
});

test('Регистрация проверяет поля, создаёт аккаунт и предлагает войти', async ({ page }) => {
  const registerRequests = [];
  let loginRequests = 0;

  await page.route('**/api/v1/auth/register', async (route) => {
    registerRequests.push({
      method: route.request().method(),
      body: route.request().postDataJSON(),
      csrf: route.request().headers()['x-csrf-token'],
    });

    await route.fulfill({
      status: 201,
      json: {
        data: {
          id: 'eeb23f67-0b68-47e7-b865-d6a1d65e70a0',
          email: 'e2e@example.com',
          displayName: 'Тестовый студент',
        },
      },
    });
  });

  await page.route('**/api/v1/auth/login', async (route) => {
    loginRequests += 1;
    await route.abort();
  });
  await page.getByRole('button', {
    name: 'Зарегистрироваться',
    exact: true,
  }).click();

  await page.getByLabel('Имя', { exact: true }).fill(' ');
  await page.getByLabel('Email', { exact: true }).fill('invalid-email');
  await page.getByLabel('Пароль', { exact: true }).fill('12345678901');

  await page.getByRole('button', {
    name: 'Создать аккаунт',
    exact: true,
  }).click();

  await expect(page.getByText(
    'Имя должно содержать от 1 до 60 символов.',
    { exact: true },
  )).toBeVisible();

  await expect(page.getByText(
    'Введи корректный email, например student@example.com.',
    { exact: true },
  )).toBeVisible();

  await expect(page.getByText(
    'Для регистрации нужен пароль длиной от 12 символов.',
    { exact: true },
  )).toBeVisible();

  expect(registerRequests).toHaveLength(0);

  // Только вымышленные данные для проверки интерфейса.
  await page.getByLabel('Имя', { exact: true }).fill('Тестовый студент');
  await page.getByLabel('Email', { exact: true }).fill('e2e@example.com');

  await page.getByLabel('Пароль', { exact: true }).fill(
    '  Only-for-tests-2026!  ',
  );

  await page.getByRole('button', {
    name: 'Создать аккаунт',
    exact: true,
  }).click();

  await expect(page.getByRole('status')).toHaveText(
    'Аккаунт создан. Теперь войдите.',
  );

  await expect(page.getByRole('heading', {
    level: 1,
    name: 'С возвращением!',
    exact: true,
  })).toBeVisible();

  await expect(page.getByLabel('Пароль', { exact: true })).toHaveValue('');
  await expect(page.getByText('Аккаунт подключён к серверу', { exact: true }))
    .not.toBeVisible();

  expect(registerRequests).toEqual([{
    method: 'POST',
    body: {
      displayName: 'Тестовый студент',
      email: 'e2e@example.com',
      password: '  Only-for-tests-2026!  ',
    },
    csrf: 'smoke-test-csrf-token',
  }]);
  expect(loginRequests).toBe(0);

  const browserStorage = await page.evaluate(() => JSON.stringify({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));

  expect(browserStorage).not.toContain('Only-for-tests-2026!');
  expect(browserStorage).not.toContain('smoke-test-csrf-token');
  expect(browserStorage).not.toContain('e2e@example.com');

  await page.reload();
  await expect(page.getByRole('heading', {
    level: 1,
    name: 'С возвращением!',
    exact: true,
  })).toBeVisible();
  expect(loginRequests).toBe(0);
});

test('Показ пароля работает, переключение формы очищает пароль', async ({ page }) => {
  const password = page.getByLabel('Пароль', { exact: true });

  await password.fill('Only-for-tests-2026!');
  await expect(password).toHaveAttribute('type', 'password');

  await page.getByRole('button', {
    name: 'Показать пароль',
    exact: true,
  }).click();

  await expect(password).toHaveAttribute('type', 'text');

  await page.getByRole('button', {
    name: 'Скрыть пароль',
    exact: true,
  }).click();

  await expect(password).toHaveAttribute('type', 'password');

  await page.getByRole('button', {
    name: 'Зарегистрироваться',
    exact: true,
  }).click();

  await expect(password).toHaveValue('');
  await password.fill('Another-test-password!');

  await page.getByRole('button', {
    name: 'Войти',
    exact: true,
  }).click();

  await expect(password).toHaveValue('');
});

test('Демо: создание, защита от дубликата, поиск и сохранение', async ({ page }) => {
  await openDemo(page);
  await createSubject(page, 'Физика E2E');

  await page.getByRole('button', {
    name: 'Добавить предмет',
    exact: true,
  }).click();

  const dialog = page.getByRole('dialog', {
    name: 'Новый предмет',
    exact: true,
  });

  await dialog.getByLabel('Название предмета').fill('  физика e2e  ');

  await dialog.getByRole('button', {
    name: 'Создать предмет',
    exact: true,
  }).click();

  await expect(dialog.getByRole('alert')).toHaveText(
    'Предмет с таким названием уже есть.',
  );

  await dialog.getByRole('button', {
    name: 'Отмена',
    exact: true,
  }).click();

  await page.getByRole('searchbox', {
    name: 'Поиск предметов',
    exact: true,
  }).fill('физика e2e');

  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(subjectCard(page, 'Физика E2E')).toBeVisible();

  await page.reload();
  await openDemo(page);

  await expect(subjectCard(page, 'Физика E2E')).toBeVisible();
});

test('Демо: редактирование и удаление с подтверждением', async ({ page }) => {
  await openDemo(page);
  await createSubject(page, 'Предмет для изменений');

  await openSubjectAction(
    page,
    'Предмет для изменений',
    'Редактировать',
  );

  const form = page.getByRole('dialog', {
    name: 'Редактировать предмет',
    exact: true,
  });

  await expect(form.getByLabel('Название предмета')).toHaveValue(
    'Предмет для изменений',
  );

  await form.getByLabel('Название предмета').fill('Обновлённый предмет');
  await form.getByLabel('Описание').fill('Новое описание');
  await form.getByLabel('Иконка карточки').selectOption('code');
  await form.getByLabel('Зелёный', { exact: true }).check();

  await form.getByRole('button', {
    name: 'Сохранить изменения',
    exact: true,
  }).click();

  await expect(form).not.toBeVisible();

  const updated = subjectCard(page, 'Обновлённый предмет');

  await expect(updated).toBeVisible();
  await expect(updated).toContainText('Новое описание');
  await expect(updated).toHaveClass(/tone-green/);

  await expect(
    subjectCard(page, 'Предмет для изменений'),
  ).toHaveCount(0);

  await openSubjectAction(
    page,
    'Обновлённый предмет',
    'Удалить',
  );

  const confirmation = page.getByRole('dialog', {
    name: 'Удалить предмет?',
    exact: true,
  });

  await confirmation.getByRole('button', {
    name: 'Отмена',
    exact: true,
  }).click();

  await expect(updated).toBeVisible();

  await openSubjectAction(
    page,
    'Обновлённый предмет',
    'Удалить',
  );

  await confirmation.getByRole('button', {
    name: 'Удалить предмет',
    exact: true,
  }).click();

  await expect(confirmation).not.toBeVisible();
  await expect(updated).toHaveCount(0);

  await page.reload();
  await openDemo(page);

  await expect(updated).toHaveCount(0);
});

test('Узкое окно: меню открывается, закрывается и переключает раздел', async ({ page }) => {
  await page.setViewportSize({
    width: 390,
    height: 844,
  });

  await openDemo(page);

  const openMenu = page.getByRole('button', {
    name: 'Открыть меню',
    exact: true,
  });

  const menu = page.getByRole('dialog', {
    name: 'Меню StudyMate',
    exact: true,
  });

  await openMenu.click();
  await expect(menu).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();

  await openMenu.click();

  await menu.getByRole('button', {
    name: 'Мои предметы',
    exact: true,
  }).click();

  await expect(menu).not.toBeVisible();

  await expect(page.getByRole('heading', {
    level: 1,
    name: 'Мои предметы',
    exact: true,
  })).toBeVisible();
});