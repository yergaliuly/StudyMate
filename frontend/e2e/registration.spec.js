import { test, expect } from '@playwright/test';

const TEST_USER = {
  id: '3f883c0f-ea0b-461d-a119-2f6f3b8e4a60',
  email: 'registration@example.com',
  displayName: 'Тестовый студент',
};

async function respondWithError(route, status, code, fieldErrors = {}) {
  await route.fulfill({
    status,
    json: {
      error: {
        code,
        message: 'Сообщение сервера для теста.',
        fieldErrors,
      },
    },
  });
}

async function fillRegistration(page) {
  await page.getByRole('button', {
    name: 'Зарегистрироваться',
    exact: true,
  }).click();
  await page.getByLabel('Имя', { exact: true }).fill(TEST_USER.displayName);
  await page.getByLabel('Email', { exact: true }).fill(TEST_USER.email);
  await page.getByLabel('Пароль', { exact: true }).fill('Only-for-registration-tests!');
}

async function submitRegistration(page) {
  await page.getByRole('button', {
    name: 'Создать аккаунт',
    exact: true,
  }).click();
}

async function expectRegistrationForm(page) {
  await expect(page.getByRole('heading', {
    level: 1,
    name: 'Создать аккаунт',
    exact: true,
  })).toBeVisible();
  await expect(page.getByText('Аккаунт подключён к серверу', { exact: true }))
    .not.toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/csrf', async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        data: {
          headerName: 'X-CSRF-TOKEN',
          token: 'registration-test-csrf',
        },
      },
    });
  });
  await page.route('**/api/v1/auth/me', async (route) => {
    await respondWithError(route, 401, 'AUTHENTICATION_REQUIRED');
  });
  await page.goto('/');
});

test('Ошибки 422 отображаются у соответствующих полей формы', async ({ page }) => {
  await page.route('**/api/v1/auth/register', async (route) => {
    await respondWithError(route, 422, 'VALIDATION_FAILED', {
      displayName: 'Сервер отклонил имя.',
      email: 'Сервер отклонил email.',
      password: 'Сервер отклонил пароль.',
      unknownField: 'Неизвестное поле не должно появиться в форме.',
    });
  });

  await fillRegistration(page);
  await submitRegistration(page);

  await expect(page.getByRole('status')).toHaveText('Проверь отмеченные поля.');
  await expect(page.getByRole('alert')).toHaveCount(3);

  for (const [label, message] of [
    ['Имя', 'Сервер отклонил имя.'],
    ['Email', 'Сервер отклонил email.'],
    ['Пароль', 'Сервер отклонил пароль.'],
  ]) {
    const field = page.getByLabel(label, { exact: true });
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toHaveAccessibleDescription(new RegExp(message));
    await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
  }

  await expect(page.getByText('Неизвестное поле не должно появиться в форме.', {
    exact: true,
  })).toHaveCount(0);
  await expectRegistrationForm(page);
});

for (const scenario of [
  {
    status: 409,
    code: 'EMAIL_ALREADY_EXISTS',
    expected: 'Этот email уже зарегистрирован. Попробуй войти.',
  },
  {
    status: 403,
    code: 'REGISTRATION_CLOSED',
    expected: 'Регистрация сейчас закрыта.',
  },
  {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
    expected: 'Сервис временно недоступен. Попробуй позже.',
  },
  {
    status: 403,
    code: 'CSRF_INVALID',
    expected: 'Не удалось проверить безопасность формы. Обнови страницу и попробуй снова.',
  },
]) {
  test(`Регистрация показывает понятную ошибку ${scenario.code}`, async ({ page }) => {
    let requests = 0;
    await page.route('**/api/v1/auth/register', async (route) => {
      requests += 1;
      await respondWithError(route, scenario.status, scenario.code);
    });

    await fillRegistration(page);
    await submitRegistration(page);

    await expect(page.getByRole('status')).toHaveText(scenario.expected);
    await expectRegistrationForm(page);
    await expect(page.getByRole('button', {
      name: 'Создать аккаунт',
      exact: true,
    })).toBeEnabled();
    expect(requests).toBe(1);
  });
}

test('Сетевая ошибка не вызывает автоматический повтор регистрации', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/v1/auth/register', async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.abort('failed');
      return;
    }
    await respondWithError(route, 409, 'EMAIL_ALREADY_EXISTS');
  });

  await fillRegistration(page);
  await submitRegistration(page);

  await expect(page.getByRole('status')).toHaveText(
    'Не удалось подтвердить создание аккаунта. Проверь соединение и попробуй войти.',
  );
  await expectRegistrationForm(page);
  expect(requests).toBe(1);

  // Только новое действие пользователя может повторить POST.
  await submitRegistration(page);
  await expect(page.getByRole('status')).toHaveText(
    'Этот email уже зарегистрирован. Попробуй войти.',
  );
  expect(requests).toBe(2);
});

test('Некорректный успешный ответ не считается созданием аккаунта', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/v1/auth/register', async (route) => {
    requests += 1;
    await route.fulfill({ status: 201, json: { data: { id: TEST_USER.id } } });
  });

  await fillRegistration(page);
  await submitRegistration(page);

  await expect(page.getByRole('status')).toHaveText(
    'Не удалось подтвердить создание аккаунта. Проверь соединение и попробуй войти.',
  );
  await expectRegistrationForm(page);
  expect(requests).toBe(1);
});

test('Повторная отправка блокируется, пока регистрация выполняется', async ({ page }) => {
  let releaseResponse;
  const responseAllowed = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  let requests = 0;

  await page.route('**/api/v1/auth/register', async (route) => {
    requests += 1;
    await responseAllowed;
    await route.fulfill({ status: 201, json: { data: TEST_USER } });
  });

  await fillRegistration(page);

  try {
    // Два события в одном цикле проверяют защиту до обновления disabled.
    await page.locator('form').evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const busyButton = page.getByRole('button', {
      name: 'Создаём аккаунт…',
      exact: true,
    });
    await expect(busyButton).toBeDisabled();

    for (const label of ['Имя', 'Email', 'Пароль']) {
      await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
    }
    await expect(page.getByRole('button', { name: 'Войти', exact: true }))
      .toBeDisabled();
    await expect(page.getByRole('button', {
      name: 'Открыть демо-кабинет',
      exact: true,
    })).toBeDisabled();
    await expect.poll(() => requests).toBe(1);
  } finally {
    releaseResponse();
  }

  await expect(page.getByRole('status')).toHaveText('Аккаунт создан. Теперь войдите.');
  expect(requests).toBe(1);
});

test('Ошибка проверки сессии не подменяется гостем или демо-аккаунтом', async ({ page }) => {
  await page.route('**/api/v1/auth/me', async (route) => {
    await route.abort('failed');
  });
  await page.reload();

  await expect(page.getByRole('heading', {
    level: 1,
    name: 'Не удалось подключиться',
    exact: true,
  })).toBeVisible();
  await expect(page.getByRole('button', {
    name: 'Повторить проверку',
    exact: true,
  })).toBeVisible();
  await expect(page.getByLabel('Email', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Демонстрационный кабинет', { exact: true }))
    .not.toBeVisible();
  await expect(page.getByText('Аккаунт подключён к серверу', { exact: true }))
    .not.toBeVisible();
});
