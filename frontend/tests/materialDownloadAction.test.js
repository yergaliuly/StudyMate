import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/services/apiClient.js';
import { createMaterialDownloadAction } from '../src/services/materialDownloadAction.js';

// Вымышленные ссылки и подмена API: backend и R2 не используются.
const ID = '3dfa4d7d-619d-4a97-9f09-a34d236e879b';
const OTHER_ID = '7f07410e-98f7-41a3-bfab-cbc387683fc1';
const LINK = {
  url: 'https://example.com/material.pdf?signature=a%2Bb%2Fc',
  expiresAt: '1970-01-01T00:01:00Z',
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function failure(code, status = 0, retryAfterSeconds = null) {
  return new ApiError('Сырые подробности сервера', {
    code, status, retryAfterSeconds,
  });
}

function setup(reply = async () => LINK) {
  let allowed = true;
  let timestamp = 1000;
  const calls = [];
  const downloads = [];
  const states = [];
  const access = [];
  const material = { id: ID, status: 'stored', processingStatus: 'not_started' };

  const action = createMaterialDownloadAction({
    materialId: ID,
    canAct: (id) => allowed && id === ID,
    getMaterial: () => material,
    onDownload: (url) => downloads.push(url),
    onChange: (state) => states.push(state),
    onAccessError: (error) => access.push(error),
    now: () => timestamp,
    api: {
      async getDownload(id, options) {
        calls.push({ id, ...options });
        return await reply();
      },
    },
  });

  return {
    action, calls, downloads, states, access, material,
    deny() { allowed = false; },
    setNow(value) { timestamp = value; },
  };
}

test('Создание и недоступный материал не отправляют запросов', async () => {
  for (const mode of ['uploading', 'deleting', 'other', 'access', 'stopped']) {
    const s = setup();
    assert.equal(s.calls.length, 0);

    if (['uploading', 'deleting'].includes(mode)) s.material.status = mode;
    if (mode === 'other') s.material.id = OTHER_ID;
    if (mode === 'access') s.deny();
    if (mode === 'stopped') s.action.stop();

    await s.action.run();
    assert.equal(s.calls.length, 0, mode);
    assert.deepEqual(s.downloads, [], mode);
  }
});

test('Сохранённый оригинал доступен независимо от состояния обработки текста', async () => {
  for (const status of ['not_started', 'queued', 'running', 'ready', 'failed', 'cancelled']) {
    const s = setup();
    s.material.processingStatus = status;
    await s.action.run();
    assert.deepEqual(s.downloads, [LINK.url], status);
  }
});

test('Двойной клик даёт один GET; следующий клик получает новую исходную ссылку', async () => {
  const response = deferred();
  const nextLink = { ...LINK, url: LINK.url + '&attempt=2' };
  let attempt = 0;
  const s = setup(() => ++attempt === 1 ? response.promise : nextLink);

  const first = s.action.run();
  await s.action.run();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].id, ID);
  assert.equal(s.states.at(-1).pending, true);

  response.resolve(LINK);
  await first;
  assert.deepEqual(s.downloads, [LINK.url]);
  assert.equal(s.states.at(-1).pending, false);

  await s.action.run();
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.downloads, [LINK.url, nextLink.url]);
  assert.ok(s.states.every((state) => !Object.hasOwn(state, 'url')));
  assert.ok(!JSON.stringify(s.states).includes('signature='));
});

test('Закрытие или потеря доступа подавляют поздний успех и ошибку сессии', async () => {
  for (const mode of ['close', 'access']) {
    for (const outcome of ['success', 'error']) {
      const response = deferred();
      const s = setup(() => response.promise);
      const pending = s.action.run();

      if (mode === 'close') s.action.stop();
      else s.deny();

      const stateCount = s.states.length;
      if (outcome === 'success') response.resolve(LINK);
      else response.reject(failure('AUTHENTICATION_REQUIRED', 401));
      await pending;

      assert.deepEqual(s.downloads, []);
      assert.deepEqual(s.access, []);
      assert.equal(s.states.length, stateCount);
      if (mode === 'close') assert.equal(s.calls[0].signal.aborted, true);
    }
  }
});

test('Начавшееся удаление или смена материала не позволяют открыть готовую ссылку', async () => {
  for (const mode of ['deleting', 'other']) {
    const response = deferred();
    const s = setup(() => response.promise);
    const pending = s.action.run();

    if (mode === 'deleting') s.material.status = 'deleting';
    else s.material.id = OTHER_ID;

    response.resolve(LINK);
    await pending;
    assert.deepEqual(s.downloads, []);
    assert.equal(s.states.at(-1).pending, false);
    assert.ok(s.states.at(-1).message);
  }
});

test('Истёкшая к получению ответа ссылка требует нового явного запроса', async () => {
  const response = deferred();
  let attempt = 0;
  const s = setup(() => ++attempt === 1
    ? response.promise
    : { ...LINK, expiresAt: '1970-01-01T00:02:00Z' });

  const pending = s.action.run();
  s.setNow(60_000);
  response.resolve(LINK);
  await pending;

  assert.deepEqual(s.downloads, []);
  assert.match(s.states.at(-1).message, /истекла/);
  assert.equal(s.calls.length, 1);

  await s.action.run();
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.downloads, [LINK.url]);
});

test('Retry-After блокирует ранний повтор; истечение ожидания само не делает GET', async () => {
  let attempt = 0;
  const s = setup(async () => {
    if (++attempt === 1) throw failure('RATE_LIMITED', 429, 2);
    return LINK;
  });

  await s.action.run();
  assert.equal(s.states.at(-1).retryAt, 3000);
  s.setNow(2999);
  await s.action.run();
  assert.equal(s.calls.length, 1);

  s.setNow(3000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.calls.length, 1);
  await s.action.run();
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.downloads, [LINK.url]);
});

test('Сеть и серверные ошибки сохраняют безопасное сообщение и разрешают явный повтор', async () => {
  for (const [status, code] of [
    [0, 'NETWORK_ERROR'],
    [503, 'STORAGE_UNAVAILABLE'],
    [404, 'MATERIAL_NOT_FOUND'],
    [409, 'MATERIAL_NOT_AVAILABLE'],
    [200, 'INVALID_RESPONSE'],
    [500, 'constructor'],
    [500, '__proto__'],
  ]) {
    let attempt = 0;
    const s = setup(async () => {
      if (++attempt === 1) throw failure(code, status);
      return LINK;
    });

    await s.action.run();
    assert.equal(s.calls.length, 1, code);
    assert.deepEqual(s.downloads, [], code);
    assert.deepEqual(s.access, [], code);
    assert.equal(s.states.at(-1).pending, false, code);
    assert.equal(typeof s.states.at(-1).message, 'string', code);
    assert.ok(s.states.at(-1).message, code);
    assert.doesNotMatch(s.states.at(-1).message, /Сырые подробности/);

    await s.action.run();
    assert.equal(s.calls.length, 2, code);
    assert.deepEqual(s.downloads, [LINK.url], code);
  }
});

test('401 и CSRF передаются на восстановление без повтора запроса', async () => {
  for (const [status, code] of [
    [401, 'AUTHENTICATION_REQUIRED'],
    [403, 'CSRF_INVALID'],
    [0, 'CSRF_NOT_INITIALIZED'],
  ]) {
    const error = failure(code, status);
    const s = setup(async () => { throw error; });

    await s.action.run();
    assert.deepEqual(s.access, [error], code);
    assert.deepEqual(s.downloads, [], code);
    assert.equal(s.states.at(-1).pending, false, code);
    assert.doesNotMatch(s.states.at(-1).message, /Сырые подробности/);

    await s.action.run();
    assert.equal(s.calls.length, 1, code);
  }
});
