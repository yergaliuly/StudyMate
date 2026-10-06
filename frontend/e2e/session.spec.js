import { test, expect } from '@playwright/test';

// Вымышленные данные: серверная сессия в этих тестах целиком заменена маршрутами.
const SESSION_USER = {
  id: '4ea493e4-99f3-419b-9808-96c104f8b6b7',
  email: 'session@example.com',
  displayName: 'Серверный Студент',
};
const PASSWORD = '  Only-for-session-tests!  ';
const CONNECTED = 'Аккаунт подключён к серверу';

async function errorResponse(route, status, code, fieldErrors = {}, headers = {}) {
  await route.fulfill({
    status,
    headers,
    json: {
      error: {
        code,
        message: 'Служебный текст сервера не должен заменять сообщение формы.',
        fieldErrors,
      },
    },
  });
}

async function mockSession(page, { authenticated = false } = {}) {
  const state = {
    authenticated,
    events: [],
    mutations: [],
    csrf: '',
    csrfCount: 0,
    onLogin: null,
    onLogout: null,
    onMe: null,
    onCsrf: null,
  };

  await page.route('**/api/v1/subjects?*', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    await route.fulfill({
      status: 200,
      json: {
        data: [],
        meta: {
          page: Number(params.get('page')),
          pageSize: Number(params.get('pageSize')),
          total: 0,
        },
      },
    });
  });

  await page.route('**/api/v1/auth/*', async (route) => {
    const request = route.request();
    const action = new URL(request.url()).pathname.split('/').at(-1);
    state.events.push(`${request.method()} ${action}`);

    if (request.method() === 'POST') {
      state.mutations.push({
        action,
        body: request.postData(),
        csrf: request.headers()['x-csrf-token'],
      });
    }

    if (action === 'csrf') {
      if (state.onCsrf) {
        await state.onCsrf(route);
        return;
      }
      state.csrf = `session-test-csrf-${++state.csrfCount}`;
      await route.fulfill({
        status: 200,
        json: { data: { headerName: 'X-CSRF-TOKEN', token: state.csrf } },
      });
      return;
    }

    if (action === 'me') {
      if (state.onMe) {
        await state.onMe(route);
      } else if (state.authenticated) {
        await route.fulfill({ status: 200, json: { data: SESSION_USER } });
      } else {
        await errorResponse(route, 401, 'AUTHENTICATION_REQUIRED');
      }
      return;
    }

    if (action === 'login') {
      if (state.onLogin) {
        await state.onLogin(route);
      } else {
        state.authenticated = true;
        await route.fulfill({ status: 200, json: { data: SESSION_USER } });
      }
      return;
    }

    if (action === 'logout') {
      if (state.onLogout) {
        await state.onLogout(route);
      } else {
        state.authenticated = false;
        await route.fulfill({ status: 204, body: '' });
      }
      return;
    }

    await errorResponse(route, 404, 'TEST_UNEXPECTED_REQUEST');
  });

  await page.goto('/');
  if (authenticated) {
    await expectAccount(page);
  } else {
    await expectLogin(page);
  }
  return state;
}

async function expectLogin(page) {
  await expect(page.getByRole('heading', {
    name: 'С возвращением!', exact: true,
  })).toBeVisible();
  await expect(page.getByText(CONNECTED, { exact: true })).not.toBeVisible();
}

async function expectAccount(page) {
  await expect(page.getByText(CONNECTED, { exact: true })).toBeVisible();
  await expect(page.getByText(SESSION_USER.displayName, { exact: true }).first())
    .toBeVisible();
  await expect(page.getByText(SESSION_USER.email, { exact: true }).first())
    .toBeVisible();
  await expect(page.getByRole('button', {
    name: 'Выйти из аккаунта', exact: true,
  })).toBeVisible();
}

async function fillLogin(page) {
  await page.getByLabel('Email', { exact: true }).fill(`  ${SESSION_USER.email}  `);
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
}

async function submitLogin(page) {
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
}

async function expectLoginDraft(page) {
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(SESSION_USER.email);
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveValue(PASSWORD);
}

async function dispatchSubmit(page) {
  await page.locator('form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

async function logout(page) {
  await page.getByRole('button', {
    name: 'Выйти из аккаунта', exact: true,
  }).click();
}

async function expectSessionError(page) {
  await expect(page.getByRole('heading', {
    name: 'Не удалось подключиться', exact: true,
  })).toBeVisible();
  await expect(page.getByRole('button', {
    name: 'Повторить проверку', exact: true,
  })).toBeVisible();
  await expect(page.getByText(CONNECTED, { exact: true })).not.toBeVisible();
  await expect(page.getByText(SESSION_USER.email, { exact: true })).not.toBeVisible();
  await expect(page.getByLabel('Email', { exact: true })).not.toBeVisible();
  await expect(page.getByText('Демонстрационный кабинет', { exact: true }))
    .not.toBeVisible();
}

test('Вход обновляет CSRF, показывает пользователя из me и сохраняет сессию после перезагрузки', async ({ page }) => {
  const state = await mockSession(page);
  expect(state.events).toEqual(['GET csrf', 'GET me']);
  const anonymousCsrf = state.csrf;
  state.events.length = 0;
  state.onLogin = async (route) => {
    state.authenticated = true;
    await route.fulfill({
      status: 200,
      json: { data: { ...SESSION_USER, displayName: 'Имя из ответа login' } },
    });
  };

  await fillLogin(page);
  await submitLogin(page);
  await expectAccount(page);
  await expect(page.locator('#account-main-content .profile-avatar')).toHaveText('СС');

  expect(state.events).toEqual(['POST login', 'GET csrf', 'GET me']);
  expect(state.mutations).toHaveLength(1);
  expect(JSON.parse(state.mutations[0].body)).toEqual({
    email: SESSION_USER.email,
    password: PASSWORD,
  });
  expect(state.mutations[0].csrf).toBe(anonymousCsrf);
  expect(state.csrf).not.toBe(anonymousCsrf);
  await expect(page.getByText('Имя из ответа login', { exact: true })).toHaveCount(0);

  const storage = await page.evaluate(() => JSON.stringify({
    local: { ...localStorage }, session: { ...sessionStorage },
  }));
  for (const privateValue of [SESSION_USER.email, SESSION_USER.id, PASSWORD, state.csrf]) {
    expect(storage).not.toContain(privateValue);
  }

  state.events.length = 0;
  await page.reload();
  await expectAccount(page);
  expect(state.events).toEqual(['GET csrf', 'GET me']);
  expect(state.mutations).toHaveLength(1);
});

test('Неверные данные входа дают одно общее сообщение без подробностей об аккаунте', async ({ page }) => {
  const state = await mockSession(page);
  state.onLogin = async (route) => {
    await errorResponse(route, 401, 'INVALID_CREDENTIALS', {
      email: 'Этот аккаунт существует.',
      password: 'Пароль именно этого аккаунта неверный.',
    });
  };
  state.events.length = 0;

  await fillLogin(page);
  await submitLogin(page);

  await expect(page.getByRole('status')).toHaveText('Неверный email или пароль.');
  await expectLogin(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Этот аккаунт существует.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Пароль именно этого аккаунта неверный.', { exact: true }))
    .toHaveCount(0);
  expect(state.events).toEqual(['POST login']);
  expect(state.mutations).toHaveLength(1);
});

test('429 входа сохраняет ввод, блокирует повтор до Retry-After и не повторяет POST по таймеру', async ({ page }) => {
  await page.clock.install();
  const state = await mockSession(page);
  state.onLogin = (route) => errorResponse(route, 429, 'RATE_LIMITED', {}, { 'Retry-After': '30' });
  state.events.length = 0;
  await fillLogin(page);
  await submitLogin(page);

  const submit = page.getByRole('button', { name: 'Войти', exact: true });
  await expect(submit).toBeDisabled();
  await expectLoginDraft(page);
  await dispatchSubmit(page);
  await page.clock.runFor(1000);
  await expect(submit).toBeDisabled();
  expect(state.events).toEqual(['POST login']);

  state.onLogin = null;
  await page.clock.runFor(30_000);
  await expect(submit).toBeEnabled();
  await expectLoginDraft(page);
  expect(state.events).toEqual(['POST login']);
  await submitLogin(page);
  await expectAccount(page);
  expect(state.mutations.map(({ action }) => action)).toEqual(['login', 'login']);
  expect(state.mutations[1].body).toBe(state.mutations[0].body);
});

test('429 начального me показывает cooldown проверки, не гостя, и повторяет только GET вручную', async ({ page }) => {
  await page.clock.install();
  const state = await mockSession(page, { authenticated: true });
  state.onMe = (route) => errorResponse(route, 429, 'RATE_LIMITED', {}, { 'Retry-After': '30' });
  state.events.length = 0;
  await page.reload();
  await expectSessionError(page);
  const retry = page.getByRole('button', { name: 'Повторить проверку', exact: true });
  await expect(retry).toBeDisabled();
  await retry.evaluate((button) => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.clock.runFor(1000);
  await expect(retry).toBeDisabled();
  expect(state.events).toEqual(['GET csrf', 'GET me']);

  state.onMe = null;
  await page.clock.runFor(30_000);
  await expect(retry).toBeEnabled();
  await expectSessionError(page);
  expect(state.events).toEqual(['GET csrf', 'GET me']);
  await retry.click();
  await expectAccount(page);
  expect(state.events).toEqual(['GET csrf', 'GET me', 'GET csrf', 'GET me']);
  expect(state.mutations).toHaveLength(0);
});

test('CSRF отказ входа проверяет me перед csrf, сохраняет гостевой ввод и ждёт ручного POST', async ({ page }) => {
  await page.clock.install();
  const state = await mockSession(page);
  const oldCsrf = state.csrf;
  state.onLogin = (route) => errorResponse(route, 403, 'CSRF_INVALID');
  state.events.length = 0;
  await fillLogin(page);
  await submitLogin(page);
  await expect.poll(() => state.csrf).not.toBe(oldCsrf);
  await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeEnabled();
  await expectLoginDraft(page);
  await page.clock.runFor(3000);
  expect(state.events).toEqual(['POST login', 'GET me', 'GET csrf']);
  expect(state.mutations).toHaveLength(1);

  const freshCsrf = state.csrf;
  state.onLogin = null;
  await submitLogin(page);
  await expectAccount(page);
  expect(state.mutations.map(({ action }) => action)).toEqual(['login', 'login']);
  expect(state.mutations[1].csrf).toBe(freshCsrf);
  expect(state.mutations[1].csrf).not.toBe(oldCsrf);
  expect(state.mutations[1].body).toBe(state.mutations[0].body);
});

test('CSRF отказ входа при действующей сессии открывает аккаунт только после me и свежего csrf', async ({ page }) => {
  const state = await mockSession(page);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  state.onLogin = async (route) => {
    state.authenticated = true;
    await errorResponse(route, 403, 'CSRF_INVALID');
  };
  state.onCsrf = async (route) => {
    await pending;
    state.csrf = 'active-recovered-csrf';
    await route.fulfill({ status: 200, json: { data: { headerName: 'X-CSRF-TOKEN', token: state.csrf } } });
  };
  state.events.length = 0;
  await fillLogin(page);
  try {
    await submitLogin(page);
    await expect.poll(() => state.events).toEqual(['POST login', 'GET me', 'GET csrf']);
    await expect(page.getByText(CONNECTED, { exact: true })).not.toBeVisible();
    await expectLoginDraft(page);
    await dispatchSubmit(page);
    expect(state.mutations).toHaveLength(1);
  } finally {
    release();
  }
  await expectAccount(page);
  expect(state.events).toEqual(['POST login', 'GET me', 'GET csrf']);
  expect(state.mutations.map(({ action }) => action)).toEqual(['login']);
});

for (const failure of ['me429', 'csrf-network']) {
  test(`Ошибка восстановления CSRF (${failure}) сохраняет форму и разрешает только повтор GET`, async ({ page }) => {
    await page.clock.install();
    const state = await mockSession(page);
    state.onLogin = (route) => errorResponse(route, 403, 'CSRF_INVALID');
    if (failure === 'me429') {
      state.onMe = (route) => errorResponse(route, 429, 'RATE_LIMITED', {}, { 'Retry-After': '30' });
    } else {
      // Даже подтверждённый me не должен открыть аккаунт при неудаче свежего CSRF.
      state.authenticated = true;
      state.onCsrf = (route) => route.abort('failed');
    }
    state.events.length = 0;
    await fillLogin(page);
    await submitLogin(page);
    const retry = page.getByRole('button', { name: 'Повторить проверку формы', exact: true });
    await expect(retry).toBeVisible();
    await expectLoginDraft(page);
    const submit = page.getByRole('button', { name: 'Войти', exact: true });
    await expect(submit).toBeDisabled();
    await expect(page.getByText(CONNECTED, { exact: true })).not.toBeVisible();
    const failedEvents = failure === 'me429' ? ['POST login', 'GET me'] : ['POST login', 'GET me', 'GET csrf'];
    expect(state.events).toEqual(failedEvents);
    await dispatchSubmit(page);
    if (failure === 'me429') {
      await expect(retry).toBeDisabled();
      await retry.evaluate((button) => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await page.clock.runFor(1000);
      await expect(retry).toBeDisabled();
    }
    await page.clock.runFor(30_000);
    await expect(retry).toBeEnabled();
    await expect(submit).toBeDisabled();
    expect(state.events).toEqual(failedEvents);
    expect(state.mutations).toHaveLength(1);

    state.onMe = null;
    state.onCsrf = null;
    await retry.click();
    await expect.poll(() => state.events).toEqual([...failedEvents, 'GET me', 'GET csrf']);
    if (failure === 'csrf-network') {
      await expectAccount(page);
      expect(state.mutations.map(({ action }) => action)).toEqual(['login']);
    } else {
      await expect(submit).toBeEnabled();
      await expectLoginDraft(page);
      expect(state.mutations).toHaveLength(1);
      const freshCsrf = state.csrf;
      state.onLogin = null;
      await submitLogin(page);
      await expectAccount(page);
      expect(state.mutations[1].csrf).toBe(freshCsrf);
    }
  });
}

test('Два события submit отправляют один запрос входа и блокируют форму до ответа', async ({ page }) => {
  const state = await mockSession(page);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  state.onLogin = async (route) => {
    await pending;
    state.authenticated = true;
    await route.fulfill({ status: 200, json: { data: SESSION_USER } });
  };
  await fillLogin(page);

  try {
    await page.locator('form').evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await expect(page.getByRole('button', { name: 'Входим…', exact: true }))
      .toBeDisabled();
    for (const label of ['Email', 'Пароль']) {
      await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
    }
    for (const name of ['Зарегистрироваться', 'Открыть демо-кабинет']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
    }
    await expect.poll(() => state.mutations.length).toBe(1);
  } finally {
    release();
  }

  await expectAccount(page);
  expect(state.mutations).toHaveLength(1);
});

for (const result of ['network', 'malformed']) {
  test(`Неоднозначный вход (${result}) проверяет сессию без повторного POST`, async ({ page }) => {
    const state = await mockSession(page);
    state.onLogin = async (route) => {
      state.authenticated = true;
      if (result === 'network') {
        await route.abort('failed');
      } else {
        await route.fulfill({ status: 200, json: { data: { id: SESSION_USER.id } } });
      }
    };
    state.events.length = 0;

    await fillLogin(page);
    await submitLogin(page);
    await expectAccount(page);

    expect(state.events).toEqual(['POST login', 'GET csrf', 'GET me']);
    expect(state.mutations).toHaveLength(1);
  });
}

test('Неоднозначный вход без сессии предлагает повторить вручную с новым CSRF', async ({ page }) => {
  const state = await mockSession(page);
  state.onLogin = async (route) => { await route.abort('failed'); };
  state.events.length = 0;

  await fillLogin(page);
  await submitLogin(page);
  await expect(page.getByRole('status')).toHaveText(
    'Вход не подтверждён. Проверь данные и попробуй снова.',
  );
  await expectLogin(page);
  expect(state.events).toEqual(['POST login', 'GET csrf', 'GET me']);
  expect(state.mutations).toHaveLength(1);

  const reconciledCsrf = state.csrf;
  state.onLogin = null;
  await fillLogin(page);
  await submitLogin(page);
  await expectAccount(page);
  expect(state.mutations).toHaveLength(2);
  expect(state.mutations[1].csrf).toBe(reconciledCsrf);
});

test('Ошибка проверки после входа скрывает аккаунт, повтор проверки выполняет только GET', async ({ page }) => {
  const state = await mockSession(page);
  state.onLogin = async (route) => {
    state.authenticated = true;
    state.onMe = (meRoute) => errorResponse(meRoute, 503, 'SERVICE_UNAVAILABLE');
    await route.abort('failed');
  };

  await fillLogin(page);
  await submitLogin(page);
  await expectSessionError(page);
  expect(state.mutations).toHaveLength(1);

  state.onMe = null;
  state.events.length = 0;
  await page.getByRole('button', { name: 'Повторить проверку', exact: true }).click();
  await expectAccount(page);

  expect(state.events).toEqual(['GET csrf', 'GET me']);
  expect(state.mutations).toHaveLength(1);
});

test('Выход отправляет POST без тела, обновляет CSRF и остаётся гостем после перезагрузки', async ({ page }) => {
  const state = await mockSession(page, { authenticated: true });
  const accountCsrf = state.csrf;
  state.events.length = 0;

  await logout(page);
  await expectLogin(page);
  await expect(page.getByRole('status')).toHaveText('Вы вышли из аккаунта.');
  expect(state.events).toEqual(['POST logout', 'GET csrf', 'GET me']);
  expect(state.mutations).toEqual([{ action: 'logout', body: null, csrf: accountCsrf }]);
  expect(state.csrf).not.toBe(accountCsrf);
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveValue('');

  const guestCsrf = state.csrf;
  await fillLogin(page);
  await submitLogin(page);
  await expectAccount(page);
  expect(state.mutations[1]).toMatchObject({ action: 'login', csrf: guestCsrf });

  await logout(page);
  await expectLogin(page);
  state.events.length = 0;
  await page.reload();
  await expectLogin(page);
  expect(state.events).toEqual(['GET csrf', 'GET me']);
  expect(state.mutations.filter(({ action }) => action === 'logout')).toHaveLength(2);
});

test('429 выхода не объявляет сессию завершённой: после ожидания проверяется только GET', async ({ page }) => {
  await page.clock.install();
  const state = await mockSession(page, { authenticated: true });
  state.onLogout = (route) => route.fulfill({
    status: 429,
    headers: { 'Retry-After': '30' },
    json: { error: { code: 'RATE_LIMITED', message: 'Test limit' } },
  });
  state.events.length = 0;
  await logout(page);
  const retry = page.getByRole('button', { name: 'Повторить проверку', exact: true });
  await expect(retry).toBeDisabled();
  await expect(page.getByText('Вы вышли из аккаунта.', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Email', { exact: true })).toHaveCount(0);
  await page.clock.runFor(31_000);
  await expect(retry).toBeEnabled();
  expect(state.events).toEqual(['POST logout']);
  await retry.click();
  await expectAccount(page);
  await expect(page.getByText('Выход не подтверждён. Сессия ещё активна. Попробуй выйти снова.', { exact: true })).toBeVisible();
  expect(state.events).toEqual(['POST logout', 'GET csrf', 'GET me']);
  expect(state.mutations).toHaveLength(1);
});

test('Повторный клик во время выхода не отправляет второй POST', async ({ page }) => {
  const state = await mockSession(page, { authenticated: true });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  state.onLogout = async (route) => {
    await pending;
    state.authenticated = false;
    await route.fulfill({ status: 204, body: '' });
  };

  try {
    await page.getByRole('button', {
      name: 'Выйти из аккаунта', exact: true,
    }).evaluate((button) => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect.poll(() => state.mutations.length).toBe(1);
    await expect(page.getByText(SESSION_USER.email, { exact: true })).not.toBeVisible();
  } finally {
    release();
  }

  await expectLogin(page);
  expect(state.mutations).toHaveLength(1);
});

test('Потерянный ответ выхода подтверждается через me без повторного POST', async ({ page }) => {
  const state = await mockSession(page, { authenticated: true });
  state.onLogout = async (route) => {
    state.authenticated = false;
    await route.abort('failed');
  };
  state.events.length = 0;

  await logout(page);
  await expectLogin(page);
  await expect(page.getByRole('status')).toHaveText('Вы вышли из аккаунта.');
  expect(state.events).toEqual(['POST logout', 'GET csrf', 'GET me']);
  expect(state.mutations).toHaveLength(1);
});

test('Если после ошибки выхода сессия активна, аккаунт возвращается с честным сообщением', async ({ page }) => {
  const state = await mockSession(page, { authenticated: true });
  state.onLogout = async (route) => { await route.abort('failed'); };
  state.events.length = 0;

  await logout(page);
  await expectAccount(page);
  await expect(page.getByText(
    'Выход не подтверждён. Сессия ещё активна. Попробуй выйти снова.',
    { exact: true },
  )).toBeVisible();
  await expect(page.getByText('Вы вышли из аккаунта.', { exact: true })).toHaveCount(0);
  expect(state.events).toEqual(['POST logout', 'GET csrf', 'GET me']);
  expect(state.mutations).toHaveLength(1);

  const reconciledCsrf = state.csrf;
  state.onLogout = null;
  await logout(page);
  await expectLogin(page);
  expect(state.mutations).toHaveLength(2);
  expect(state.mutations[1].csrf).toBe(reconciledCsrf);
});

test('Ошибка сервера после выхода не считается гостем, повтор проверки не повторяет выход', async ({ page }) => {
  const state = await mockSession(page, { authenticated: true });
  state.onLogout = async (route) => {
    state.authenticated = false;
    state.onMe = (meRoute) => errorResponse(meRoute, 503, 'SERVICE_UNAVAILABLE');
    await route.abort('failed');
  };

  await logout(page);
  await expectSessionError(page);
  await expect(page.getByText('Вы вышли из аккаунта.', { exact: true })).toHaveCount(0);
  expect(state.mutations).toHaveLength(1);

  state.onMe = null;
  state.events.length = 0;
  await page.getByRole('button', { name: 'Повторить проверку', exact: true }).click();
  await expectLogin(page);
  expect(state.events).toEqual(['GET csrf', 'GET me']);
  expect(state.mutations).toHaveLength(1);
});

test('Предмет из демо остаётся в демо и не появляется в серверном аккаунте', async ({ page }) => {
  const state = await mockSession(page);
  await page.getByRole('button', { name: 'Открыть демо-кабинет', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить предмет', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новый предмет', exact: true });
  await dialog.getByLabel('Название предмета').fill('Только локальный предмет');
  await dialog.getByRole('button', { name: 'Создать предмет', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Открыть форму входа', exact: true }).click();
  await fillLogin(page);
  await submitLogin(page);
  await expectAccount(page);

  await expect(page.getByRole('heading', { name: 'Только локальный предмет', exact: true }))
    .not.toBeVisible();
  await expect(page.getByText('Демонстрационный кабинет', { exact: true }))
    .not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Базы данных', exact: true }))
    .not.toBeVisible();
  await expect(page.locator('#account-main-content')).not.toContainText('65%');
  expect(state.mutations).toHaveLength(1);

  await page.getByRole('button', { name: 'Открыть демо-кабинет', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Только локальный предмет', exact: true }))
    .toBeVisible();
  await expect(page.getByText(CONNECTED, { exact: true })).not.toBeVisible();
});

test('Меню аккаунта работает на узком экране после посещения демо', async ({ page }) => {
  await mockSession(page, { authenticated: true });
  await page.getByRole('button', { name: 'Открыть демо-кабинет', exact: true }).click();
  await page.getByRole('button', { name: 'Вернуться в аккаунт', exact: true }).click();
  await expectAccount(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const account = page.locator('#account-main-content');
  await expect(account.getByText(SESSION_USER.displayName, { exact: true })).toBeVisible();
  await expect(account.getByText(SESSION_USER.email, { exact: true })).toBeVisible();
  const openMenu = page.getByRole('button', { name: 'Открыть меню', exact: true });
  await expect(openMenu).toHaveAttribute('aria-controls', 'account-mobile-navigation');
  await openMenu.click();
  const accountMenu = page.getByRole('dialog', { name: 'Меню StudyMate', exact: true });
  await expect(accountMenu).toHaveAttribute('id', 'account-mobile-navigation');
  await expect(accountMenu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(accountMenu).not.toBeVisible();
  await expect(openMenu).toBeFocused();

  await openMenu.click();
  await accountMenu.getByRole('button', { name: 'Мои предметы', exact: true }).click();
  await expect(accountMenu).not.toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Мои предметы', exact: true }))
    .toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
});
