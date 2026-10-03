import { test, expect } from '@playwright/test';

// Это cookie-backed fixture, а не проверка настоящего Java/PostgreSQL backend.
// Set-Cookie проходит через Chromium; ни cookie, ни CSRF header не подставляются в POST тестом.
const COOKIE = 'STUDYMATE_SESSION';
const USER = { id: '64baf542-5cf6-450b-bc68-30f36ee960e5', email: 'csrf-dev@example.com', displayName: 'CSRF Студент' };
const PASSWORD = 'Only-for-StrictMode-tests!';
const states = new WeakMap();

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const cookieHeader = (id) => `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`;
function cookieValue(header = '') {
  return header.split(';').map((part) => part.trim()).find((part) => part.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
}
function errorReply(route, status, code) {
  return route.fulfill({ status, json: { error: { code, message: 'Служебные подробности mock-сервера.', fieldErrors: {} } } });
}
function dataReply(route, data, status = 200, sessionId = null) {
  return route.fulfill({ status, headers: sessionId ? { 'Set-Cookie': cookieHeader(sessionId) } : {}, json: { data } });
}
async function mockCookieSession(page, { gate = null, failBootstrap = false } = {}) {
  const state = { sessions: new Map(), csrfGets: [], posts: [], meGets: [], invalid: [], unexpected: [], pageErrors: [], nextSession: 1, failBootstrap };
  states.set(page, state);
  page.on('pageerror', (error) => state.pageErrors.push(error.message));
  await page.addInitScript(() => {
    const nativeFetch = window.fetch;
    window.__csrfFetchCalls = [];
    window.fetch = function (...args) {
      const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href);
      if (url.pathname === '/api/v1/auth/csrf') window.__csrfFetchCalls.push(url.pathname);
      return Reflect.apply(nativeFetch, this, args);
    };
  });
  function createSession(authenticated) {
    const id = 'fixture-session-' + state.nextSession++;
    const value = { id, token: 'fixture-csrf-' + id, authenticated };
    state.sessions.set(id, value);
    return value;
  }
  // Даже неожиданный /api маршрут получает mock-ошибку и никогда не достигает proxy:8080.
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const headers = await request.allHeaders();
    const path = new URL(request.url()).pathname.slice('/api/v1'.length);
    const method = request.method();
    const incomingId = cookieValue(headers.cookie);
    const session = state.sessions.get(incomingId);
    if (method === 'GET' && path === '/auth/csrf') {
      const next = session ?? createSession(false);
      state.csrfGets.push({ incomingId: incomingId ?? null, id: next.id, token: next.token });
      if (gate) await gate.promise;
      if (state.failBootstrap) await errorReply(route, 503, 'SERVICE_UNAVAILABLE');
      else await dataReply(route, { headerName: 'X-CSRF-TOKEN', token: next.token }, 200, next.id);
      return;
    }
    if (method === 'GET' && path === '/auth/me') {
      state.meGets.push(incomingId);
      if (session?.authenticated) await dataReply(route, USER);
      else await errorReply(route, 401, 'AUTHENTICATION_REQUIRED');
      return;
    }
    if (method === 'POST') {
      const token = headers['x-csrf-token'];
      state.posts.push({ path, id: incomingId ?? null, token, body: request.postData() });
      if (!session || token !== session.token) {
        state.invalid.push({ path, cookie: incomingId ?? null, header: token ?? null });
        await errorReply(route, 403, 'CSRF_INVALID');
        return;
      }
      if (path === '/auth/register') { await dataReply(route, USER, 201); return; }
      if (path === '/auth/login') {
        state.sessions.delete(session.id);
        const rotated = createSession(true);
        await dataReply(route, USER, 200, rotated.id);
        return;
      }
      if (path === '/auth/logout') {
        state.sessions.delete(session.id);
        const rotated = createSession(false);
        await route.fulfill({ status: 204, headers: { 'Set-Cookie': cookieHeader(rotated.id) }, body: '' });
        return;
      }
    }
    if (method === 'GET' && path === '/subjects' && session?.authenticated) {
      const query = new URL(request.url()).searchParams;
      await route.fulfill({ status: 200, json: { data: [], meta: { page: Number(query.get('page')), pageSize: Number(query.get('pageSize')), total: 0 } } });
      return;
    }
    state.unexpected.push(method + ' ' + path);
    await errorReply(route, 500, 'UNEXPECTED_TEST_REQUEST');
  });
  await page.goto('/');
  // Dev-only Vite client подтверждает, что это не production preview без StrictMode replay.
  await expect(page.locator('script[src="/@vite/client"]')).toHaveCount(1);
  return state;
}
async function expectLogin(page) { await expect(page.getByRole('heading', { name: 'С возвращением!', exact: true })).toBeVisible(); }
async function login(page) {
  await page.getByLabel('Email', { exact: true }).fill(USER.email);
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByText('Аккаунт подключён к серверу', { exact: true })).toBeVisible();
}
async function browserSession(context) {
  const cookie = (await context.cookies()).find((item) => item.name === COOKIE);
  expect(cookie, 'Cookie получена браузером из Set-Cookie').toBeTruthy();
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Lax');
  return cookie.value;
}
const fetchCount = (page) => page.evaluate(() => window.__csrfFetchCalls.length);

test.afterEach(async ({ page }) => {
  const state = states.get(page);
  expect(state?.unexpected ?? []).toEqual([]);
  expect(state?.pageErrors ?? []).toEqual([]);
  expect(state?.invalid ?? [], 'Первый POST обязан совпадать с реальной cookie-сессией').toEqual([]);
});

test('DEV StrictMode: отложенный bootstrap single-flight, первый login и ротация login/logout', async ({ page, context }) => {
  const gate = deferred();
  const state = await mockCookieSession(page, { gate });
  try {
    await expect.poll(() => state.csrfGets.length).toBeGreaterThan(0);
    await expect(page.getByRole('heading', { name: 'Проверяем сессию…', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Войти', exact: true })).toHaveCount(0);
    expect(state.posts).toHaveLength(0);
  } finally { gate.resolve(); }
  await expectLogin(page);
  const bootstrapFetches = await fetchCount(page);
  const anonymous = await browserSession(context);
  await login(page);
  const authenticated = await browserSession(context);
  expect(authenticated).not.toBe(anonymous);
  expect(state.posts[0]).toMatchObject({ path: '/auth/login', id: anonymous, token: 'fixture-csrf-' + anonymous });
  await page.getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
  await expectLogin(page);
  const afterLogout = await browserSession(context);
  expect(afterLogout).not.toBe(authenticated);
  expect(state.posts[1]).toMatchObject({ path: '/auth/logout', id: authenticated, token: 'fixture-csrf-' + authenticated });
  await login(page);
  expect(state.posts[2]).toMatchObject({ path: '/auth/login', id: afterLogout, token: 'fixture-csrf-' + afterLogout });
  expect(state.posts.map((value) => value.path)).toEqual(['/auth/login', '/auth/logout', '/auth/login']);
  expect(bootstrapFetches, 'Два StrictMode effect consumers делят один native fetch').toBe(1);
  expect(await fetchCount(page)).toBe(4);
  expect(state.csrfGets).toHaveLength(4);
});

test('DEV StrictMode: первый register использует cookie+token, регистрация не ротирует сессию', async ({ page, context }) => {
  const state = await mockCookieSession(page);
  await expectLogin(page);
  const bootstrapFetches = await fetchCount(page);
  const anonymous = await browserSession(context);
  await page.getByRole('button', { name: 'Зарегистрироваться', exact: true }).click();
  await page.getByLabel('Имя', { exact: true }).fill(USER.displayName);
  await page.getByLabel('Email', { exact: true }).fill(USER.email);
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await expectLogin(page);
  expect(await browserSession(context)).toBe(anonymous);
  expect(state.posts[0]).toMatchObject({ path: '/auth/register', id: anonymous, token: 'fixture-csrf-' + anonymous });
  expect(state.posts).toHaveLength(1);
  await login(page);
  expect(state.posts[1]).toMatchObject({ path: '/auth/login', id: anonymous, token: 'fixture-csrf-' + anonymous });
  expect(await browserSession(context)).not.toBe(anonymous);
  expect(bootstrapFetches).toBe(1);
  expect(await fetchCount(page)).toBe(2);
  expect(state.csrfGets).toHaveLength(2);
});

test('DEV StrictMode: общий bootstrap503 завершается безопасной ошибкой, повтор только вручную', async ({ page, context }) => {
  const gate = deferred();
  const state = await mockCookieSession(page, { gate, failBootstrap: true });
  try { await expect.poll(() => state.csrfGets.length).toBeGreaterThan(0); }
  finally { gate.resolve(); }
  await expect(page.getByRole('heading', { name: 'Не удалось подключиться', exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(0);
  expect(state.meGets).toHaveLength(0);
  const failedBootstrapFetches = await fetchCount(page);
  expect((await context.cookies()).some((item) => item.name === COOKIE)).toBe(false);
  state.failBootstrap = false;
  await page.getByRole('button', { name: 'Повторить проверку', exact: true }).click();
  await expectLogin(page);
  const anonymous = await browserSession(context);
  await login(page);
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0]).toMatchObject({ path: '/auth/login', id: anonymous, token: 'fixture-csrf-' + anonymous });
  expect(failedBootstrapFetches).toBe(1);
  expect(await fetchCount(page)).toBe(3);
  expect(state.csrfGets).toHaveLength(3);
});
