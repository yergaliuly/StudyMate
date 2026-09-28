import test from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '../src/services/apiClient.js';
import { createSessionFlow } from '../src/services/sessionFlow.js';

// Вымышленные данные; пароль используется только в тестах.
const USER = {
  id: '0b7393dd-d32b-4314-b43e-4637821ccdb9',
  email: 'student@example.com',
  displayName: 'Айдана',
};
const FORM = { email: ' student@example.com ', password: ' Example-only-password! ' };

function failure(code, status = 0) {
  return new ApiError('Тестовая ошибка.', { code, status });
}

function errorIs(code) {
  return (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, code);
    return true;
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((success, fail) => {
    resolve = success;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(overrides = {}) {
  const calls = [];
  const handlers = {
    refreshCsrf: async () => undefined,
    getCurrentUser: async () => USER,
    login: async () => ({ ...USER, displayName: 'Ответ POST не является проверкой сессии' }),
    logout: async () => undefined,
    ...overrides,
  };
  const api = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [
    name,
    async (...args) => {
      calls.push({ name, args });
      return handler(...args);
    },
  ]));
  return { flow: createSessionFlow(api), calls, names: () => calls.map(({ name }) => name) };
}

test('Создание сценария не отправляет запросы; начальная проверка получает CSRF перед /me', async () => {
  const csrf = deferred();
  const entered = deferred();
  const signal = new AbortController().signal;
  const { flow, calls, names } = setup({
    refreshCsrf: () => {
      entered.resolve();
      return csrf.promise;
    },
  });
  assert.deepEqual(names(), []);

  const pending = flow.readSession({ signal });
  await entered.promise;
  assert.deepEqual(names(), ['refreshCsrf']);
  csrf.resolve();
  assert.equal(await pending, USER);
  assert.deepEqual(names(), ['refreshCsrf', 'getCurrentUser']);
  for (const call of calls) assert.equal(call.args[0].signal, signal);
});

test('Гостем считается только null от адаптера /me, ошибка проверки не превращается в гостя', async () => {
  const guest = setup({ getCurrentUser: async () => null });
  assert.equal(await guest.flow.readSession(), null);

  const unavailable = failure('SERVICE_UNAVAILABLE', 503);
  const broken = setup({ getCurrentUser: async () => { throw unavailable; } });
  await assert.rejects(broken.flow.readSession(), (error) => error === unavailable);
  assert.deepEqual(broken.names(), ['refreshCsrf', 'getCurrentUser']);
});

test('Вход ждёт единственный POST, затем свежий CSRF и /me; возвращает пользователя из /me', async () => {
  const login = deferred();
  const entered = deferred();
  const signal = new AbortController().signal;
  const { flow, calls, names } = setup({
    login: () => {
      entered.resolve();
      return login.promise;
    },
  });
  const pending = flow.signIn(FORM, { signal });
  await entered.promise;
  assert.deepEqual(names(), ['login']);
  assert.equal(calls[0].args[0], FORM);
  assert.equal(calls[0].args[1].signal, signal);

  login.resolve({ ...USER, displayName: 'Не использовать этот ответ' });
  assert.equal(await pending, USER);
  assert.deepEqual(names(), ['login', 'refreshCsrf', 'getCurrentUser']);
  assert.equal(calls[1].args[0].signal, signal);
  assert.equal(calls[2].args[0].signal, signal);
});

test('Успешный POST входа без подтверждения /me не считается входом', async () => {
  const { flow, names } = setup({ getCurrentUser: async () => null });
  assert.equal(await flow.signIn(FORM), null);
  assert.deepEqual(names(), ['login', 'refreshCsrf', 'getCurrentUser']);
});

for (const [code, status] of [
  ['NETWORK_ERROR', 0],
  ['INVALID_RESPONSE', 200],
  ['SERVICE_UNAVAILABLE', 503],
]) {
  for (const user of [USER, null]) {
    test(`Неоднозначный вход ${code}: /me подтверждает ${user ? 'аккаунт' : 'гостя'}, POST не повторяется`, async () => {
      const { flow, names } = setup({
        login: async () => { throw failure(code, status); },
        getCurrentUser: async () => user,
      });
      assert.equal(await flow.signIn(FORM), user);
      assert.deepEqual(names(), ['login', 'refreshCsrf', 'getCurrentUser']);
    });
  }
}

for (const [code, status] of [
  ['INVALID_CREDENTIALS', 401],
  ['VALIDATION_FAILED', 422],
  ['CSRF_INVALID', 403],
]) {
  test(`Однозначный отказ входа ${code} возвращается форме без новых запросов`, async () => {
    const original = failure(code, status);
    const { flow, names } = setup({ login: async () => { throw original; } });
    await assert.rejects(flow.signIn(FORM), (error) => error === original);
    assert.deepEqual(names(), ['login']);
  });
}

for (const operation of ['signIn', 'signOut']) {
  for (const failedRead of ['refreshCsrf', 'getCurrentUser']) {
    test(`${operation}: ошибка ${failedRead} после POST даёт SESSION_CHECK_FAILED, не гостя`, async () => {
      const { flow, names } = setup({
        [failedRead]: async () => { throw failure('NETWORK_ERROR'); },
      });
      const pending = operation === 'signIn' ? flow.signIn(FORM) : flow.signOut();
      await assert.rejects(pending, errorIs('SESSION_CHECK_FAILED'));
      const expected = [operation === 'signIn' ? 'login' : 'logout', 'refreshCsrf'];
      if (failedRead === 'getCurrentUser') expected.push('getCurrentUser');
      assert.deepEqual(names(), expected);
    });
  }
}

test('Выход выполняет один POST с signal, затем CSRF и /me, подтверждающий гостя', async () => {
  const signal = new AbortController().signal;
  const { flow, calls, names } = setup({ getCurrentUser: async () => null });
  assert.equal(await flow.signOut({ signal }), null);
  assert.deepEqual(names(), ['logout', 'refreshCsrf', 'getCurrentUser']);
  for (const call of calls) assert.deepEqual(call.args, [{ signal }]);
});

for (const [code, status] of [
  ['NETWORK_ERROR', 0],
  ['CSRF_INVALID', 403],
  ['SERVICE_UNAVAILABLE', 503],
]) {
  for (const user of [USER, null]) {
    test(`Ошибка выхода ${code}: свежий /me определяет ${user ? 'активную' : 'завершённую'} сессию`, async () => {
      const { flow, names } = setup({
        logout: async () => { throw failure(code, status); },
        getCurrentUser: async () => user,
      });
      assert.equal(await flow.signOut(), user);
      assert.deepEqual(names(), ['logout', 'refreshCsrf', 'getCurrentUser']);
    });
  }
}

test('Даже успешный POST выхода не скрывает аккаунт, если /me подтверждает активную сессию', async () => {
  const { flow, names } = setup();
  assert.equal(await flow.signOut(), USER);
  assert.deepEqual(names(), ['logout', 'refreshCsrf', 'getCurrentUser']);
});

for (const operation of ['readSession', 'signIn', 'signOut']) {
  test(`${operation}: отмена до начала не отправляет запросов`, async () => {
    const controller = new AbortController();
    controller.abort();
    const { flow, names } = setup();
    const options = { signal: controller.signal };
    const pending = operation === 'signIn' ? flow.signIn(FORM, options) : flow[operation](options);
    await assert.rejects(pending, errorIs('REQUEST_CANCELLED'));
    assert.deepEqual(names(), []);
  });
}

for (const operation of ['readSession', 'signIn', 'signOut']) {
  const post = operation === 'signIn' ? 'login' : operation === 'signOut' ? 'logout' : null;
  const steps = [...(post ? [post] : []), 'refreshCsrf', 'getCurrentUser'];

  for (const pausedStep of steps) {
    test(`${operation}: поздний ответ ${pausedStep} после отмены не подтверждает сессию`, async () => {
      const entered = deferred();
      const response = deferred();
      const controller = new AbortController();
      const { flow, names } = setup({
        // Адаптер намеренно игнорирует abort, чтобы проверить защиту от позднего ответа.
        [pausedStep]: () => {
          entered.resolve();
          return response.promise;
        },
      });
      const options = { signal: controller.signal };
      const pending = operation === 'signIn' ? flow.signIn(FORM, options) : flow[operation](options);
      await entered.promise;
      controller.abort();
      response.resolve(USER);
      await assert.rejects(pending, errorIs('REQUEST_CANCELLED'));
      assert.deepEqual(names(), steps.slice(0, steps.indexOf(pausedStep) + 1));
    });
  }
}

for (const operation of ['signIn', 'signOut']) {
  test(`${operation}: ошибка отменённого POST не запускает восстановление сессии`, async () => {
    const post = operation === 'signIn' ? 'login' : 'logout';
    const entered = deferred();
    const response = deferred();
    const controller = new AbortController();
    const { flow, names } = setup({
      [post]: () => {
        entered.resolve();
        return response.promise;
      },
    });
    const options = { signal: controller.signal };
    const pending = operation === 'signIn' ? flow.signIn(FORM, options) : flow.signOut(options);
    await entered.promise;
    controller.abort();
    response.reject(failure('NETWORK_ERROR'));
    await assert.rejects(pending, errorIs('REQUEST_CANCELLED'));
    assert.deepEqual(names(), [post]);
  });
}
