import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/services/apiClient.js';
import {
  canProcessMaterial,
  createMaterialProcessingAction,
  getMaterialProcessingState,
  reconcileMaterialProcessing,
} from '../src/services/materialProcessingAction.js';

const ID = '3dfa4d7d-619d-4a97-9f09-a34d236e879b';
const OTHER = '7f07410e-98f7-41a3-bfab-cbc387683fc1';
const KEY1 = '095f15c2-1f89-4e09-a9ab-b3b281766f57';
const KEY2 = '195f15c2-1f89-4e09-a9ab-b3b281766f57';

// API подменён. Полные серверные DTO проверяются в materialApi.test.js.
function material(processingStatus = 'not_started', code = 'JOB_PROCESSING_FAILED') {
  return {
    id: ID,
    status: 'stored',
    processingStatus,
    processingError: processingStatus === 'failed' ? { code } : null,
  };
}

function failure(code, status = 0, retryAfterSeconds = null) {
  return new ApiError('Ошибка запроса.', {
    code,
    status,
    retryAfterSeconds,
  });
}

function deferred() {
  let resolve;
  let reject;

  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });

  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup({
  record = {},
  currentMaterial = material(),
  results = [],
  keys = [KEY1, KEY2],
} = {}) {
  let allowed = true;
  let timestamp = 1000;
  let refreshes = 0;

  const calls = [];
  const states = [];
  const access = [];

  const action = createMaterialProcessingAction({
    record,
    materialId: ID,
    canAct: () => allowed,
    getMaterial: () => currentMaterial,
    onChange: (state) => states.push(state),
    onRefresh: () => {
      refreshes += 1;
    },
    onAccessError: (error) => access.push(error),
    makeKey: () => keys.shift(),
    now: () => timestamp,
    api: {
      async process(id, options) {
        calls.push({ id, options });

        const result = results.length
          ? results.shift()
          : { materialId: id, jobId: OTHER };

        if (result instanceof Error) throw result;
        return await result;
      },
    },
  });

  return {
    action,
    record,
    calls,
    states,
    access,
    get state() {
      return getMaterialProcessingState(record, ID);
    },
    get refreshes() {
      return refreshes;
    },
    setMaterial(value) {
      currentMaterial = value;
    },
    setNow(value) {
      timestamp = value;
    },
    deny() {
      allowed = false;
    },
  };
}

test('Новый запуск разрешён только подходящим состояниям и ошибкам', () => {
  assert.equal(canProcessMaterial(material()), true);
  assert.equal(canProcessMaterial(material('cancelled')), true);

  for (const code of [
    'PDF_TIMEOUT',
    'PDF_RESOURCE_LIMIT',
    'PDF_WORKER_FAILED',
    'JOB_TEMPORARY_FAILURE',
    'JOB_PROCESSING_FAILED',
    'JOB_ATTEMPTS_EXHAUSTED',
    'JOB_LEASE_EXPIRED',
    'JOB_OUTCOME_UNKNOWN',
  ]) {
    assert.equal(canProcessMaterial(material('failed', code)), true, code);
  }

  for (const code of [
    'PDF_INVALID',
    'PDF_ENCRYPTED',
    'PDF_NO_TEXT',
    'PDF_TOO_MANY_PAGES',
    'PDF_TEXT_LIMIT',
    'PDF_ORIGINAL_MISMATCH',
  ]) {
    assert.equal(canProcessMaterial(material('failed', code)), false, code);
  }

  for (const status of ['queued', 'running', 'ready']) {
    assert.equal(canProcessMaterial(material(status)), false);
  }

  assert.equal(
    canProcessMaterial({ ...material(), status: 'deleting' }),
    false,
  );
});

test('Создание ничего не отправляет; неподходящий материал не получает ключ', async () => {
  for (const currentMaterial of [
    material('running'),
    material('failed', 'PDF_INVALID'),
    { ...material(), id: OTHER },
    { ...material(), status: 'uploading' },
  ]) {
    const s = setup({ currentMaterial });

    assert.equal(s.calls.length, 0);
    await s.action.run();

    assert.equal(s.calls.length, 0);
    assert.equal(s.state.hasAttempt, false);

    s.action.stop();
  }
});

test('Двойное нажатие отправляет один POST с прежними UUID, ключом и signal', async () => {
  const pending = deferred();
  const s = setup({ results: [pending.promise] });

  const first = s.action.run();
  await s.action.run();

  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].id, ID);
  assert.equal(s.calls[0].options.idempotencyKey, KEY1);
  assert.equal(s.calls[0].options.signal.aborted, false);
  assert.equal(s.state.pending, true);

  pending.resolve({ materialId: ID, jobId: OTHER });
  await first;

  assert.equal(s.refreshes, 1);
  assert.equal(s.state.awaitingRead, true);

  s.action.stop();
});

test('После 202 новая попытка требует свежего материала и отдельного нажатия', async () => {
  const s = setup({ currentMaterial: material('failed') });

  await s.action.run();
  await s.action.run();

  assert.equal(s.calls.length, 1);
  assert.equal(s.state.hasAttempt, true);
  assert.equal(s.state.awaitingRead, true);

  reconcileMaterialProcessing(s.record, material('failed'));
  await s.action.run();

  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].options.idempotencyKey, KEY2);

  s.action.stop();
});

test('После потери ответа и повторного открытия сохраняется прежний ключ', async () => {
  const s = setup({ results: [failure('NETWORK_ERROR')] });

  await s.action.run();
  assert.equal(s.state.uncertain, true);
  s.action.stop();

  const reopened = setup({ record: s.record, keys: [KEY2] });
  await reopened.action.run();

  assert.equal(reopened.calls[0].options.idempotencyKey, KEY1);
  assert.equal(reopened.state.awaitingRead, true);

  reopened.action.stop();
});

test('Закрытие отменяет signal; поздний ответ не меняет новый выполняющийся запрос', async () => {
  const oldResponse = deferred();
  const s = setup({ results: [oldResponse.promise] });

  const oldRequest = s.action.run();
  s.action.stop();

  assert.equal(s.calls[0].options.signal.aborted, true);
  assert.equal(s.state.pending, false);
  assert.equal(s.state.uncertain, true);

  const newResponse = deferred();
  const reopened = setup({
    record: s.record,
    results: [newResponse.promise],
  });
  const newRequest = reopened.action.run();

  oldResponse.resolve({ materialId: ID, jobId: OTHER });
  await oldRequest;
  s.action.stop();

  assert.equal(reopened.state.pending, true);
  assert.equal(s.refreshes, 0);

  newResponse.resolve({ materialId: ID, jobId: OTHER });
  await newRequest;

  assert.equal(reopened.refreshes, 1);
  reopened.action.stop();
});

test('Потеря активности подавляет поздние обновления и запрос обновления материала', async () => {
  const response = deferred();
  const s = setup({ results: [response.promise] });

  const pending = s.action.run();
  const count = s.states.length;
  s.deny();

  response.resolve({ materialId: ID, jobId: OTHER });
  await pending;

  assert.equal(s.states.length, count);
  assert.equal(s.refreshes, 0);
  s.action.stop();

  const other = setup();
  assert.equal(other.state.hasAttempt, false);
  other.action.stop();
});

test('Попытка не переносится в другую запись или другой материал', async () => {
  const s = setup({ results: [failure('NETWORK_ERROR')] });

  await s.action.run();
  s.action.stop();

  const other = setup({ record: {}, keys: [KEY2] });
  await other.action.run();

  assert.equal(other.calls[0].options.idempotencyKey, KEY2);
  assert.equal(
    getMaterialProcessingState(s.record, OTHER).hasAttempt,
    false,
  );

  other.action.stop();
});

test('401 и CSRF вызывают восстановление доступа и сохраняют ключ', async () => {
  for (const error of [
    failure('AUTHENTICATION_REQUIRED', 401),
    failure('CSRF_INVALID', 403),
    failure('CSRF_NOT_INITIALIZED'),
  ]) {
    const s = setup({ results: [error] });
    await s.action.run();

    assert.equal(s.state.hasAttempt, true);
    assert.equal(s.state.pending, false);
    assert.equal(s.state.uncertain, false);
    assert.deepEqual(s.access, [error]);

    s.action.stop();

    const reopened = setup({ record: s.record });
    await reopened.action.run();

    assert.equal(reopened.calls[0].options.idempotencyKey, KEY1);
    reopened.action.stop();
  }
});

test('Retry-After сохраняется после открытия, истечение срока не отправляет POST', async () => {
  const s = setup({ results: [failure('RATE_LIMITED', 429, 3)] });

  await s.action.run();
  s.action.stop();

  const reopened = setup({ record: s.record });

  reopened.setNow(3999);
  await reopened.action.run();
  assert.equal(reopened.calls.length, 0);

  reopened.setNow(4000);
  await tick();
  assert.equal(reopened.calls.length, 0);

  await reopened.action.run();

  assert.equal(reopened.calls.length, 1);
  assert.equal(reopened.calls[0].options.idempotencyKey, KEY1);

  reopened.action.stop();
});

test('Конфликт выполняющейся или готовой обработки требует свежего состояния без повтора POST', async () => {
  for (const code of [
    'PROCESSING_IN_PROGRESS',
    'TEXT_ALREADY_EXTRACTED',
  ]) {
    const s = setup({ results: [failure(code, 409)] });
    await s.action.run();

    assert.equal(s.refreshes, 1);
    assert.equal(s.state.awaitingRead, true);

    await s.action.run();
    assert.equal(s.calls.length, 1);

    const latest = material(
      code === 'TEXT_ALREADY_EXTRACTED' ? 'ready' : 'running',
    );

    reconcileMaterialProcessing(s.record, latest);
    s.setMaterial(latest);
    await s.action.run();

    assert.equal(s.calls.length, 1);
    s.action.stop();
  }
});

test('Последующий отказ или свежий GET не стирает прежний неизвестный исход', async () => {
  for (const error of [
    failure('CSRF_INVALID', 403),
    failure('PROCESSING_IN_PROGRESS', 409),
    failure('TEXT_ALREADY_EXTRACTED', 409),
    failure('RATE_LIMITED', 429),
  ]) {
    const s = setup({
      results: [failure('NETWORK_ERROR'), error],
    });

    await s.action.run();
    await s.action.run();

    assert.equal(s.state.uncertain, true);
    assert.equal(s.state.hasAttempt, true);

    reconcileMaterialProcessing(s.record, material('ready'));

    assert.equal(s.state.hasAttempt, true);
    s.action.stop();
  }
});

test('Неизвестный исход позволяет повторить прежний запрос даже при ошибке PDF_NO_TEXT', async () => {
  const s = setup({
    results: [failure('INVALID_RESPONSE', 202)],
  });

  await s.action.run();
  s.setMaterial(material('failed', 'PDF_NO_TEXT'));
  await s.action.run();

  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].options.idempotencyKey, KEY1);

  s.action.stop();
});

test('Без свежего GET после 202 новый запуск заблокирован даже после открытия', async () => {
  const s = setup({ currentMaterial: material('failed') });

  await s.action.run();
  s.action.stop();

  const reopened = setup({
    record: s.record,
    currentMaterial: material('failed'),
    keys: [KEY2],
  });

  await reopened.action.run();
  assert.equal(reopened.calls.length, 0);

  reconcileMaterialProcessing(reopened.record, material('failed'));
  await reopened.action.run();

  assert.equal(reopened.calls.length, 1);
  assert.equal(reopened.calls[0].options.idempotencyKey, KEY2);

  reopened.action.stop();
});

test('503 и отмена сохраняют неизвестный исход; 404 запрашивает обновление материала', async () => {
  for (const error of [
    failure('STORAGE_UNAVAILABLE', 503),
    failure('SERVICE_UNAVAILABLE', 503),
    failure('REQUEST_CANCELLED'),
  ]) {
    const s = setup({ results: [error] });
    await s.action.run();

    assert.equal(s.state.uncertain, true);
    assert.equal(s.refreshes, 0);

    s.action.stop();
  }

  const s = setup({
    results: [failure('MATERIAL_NOT_FOUND', 404)],
  });
  await s.action.run();

  assert.equal(s.refreshes, 1);
  assert.equal(s.state.pending, false);

  s.action.stop();
});

test('Сбой генератора ключа не отправляет запрос; stop запрещает дальнейший запуск', async () => {
  const s = setup({ keys: ['bad'] });
  await s.action.run();

  assert.equal(s.calls.length, 0);
  assert.equal(s.state.hasAttempt, false);
  assert.ok(s.state.message);

  s.action.stop();
  await s.action.run();

  assert.equal(s.calls.length, 0);
});

test('Конфликт ключа требует свежего GET и соблюдения Retry-After перед новым запуском', async () => {
  const s = setup({
    results: [failure('IDEMPOTENCY_KEY_REUSED', 409, 2)],
  });
  await s.action.run();

  assert.equal(s.state.awaitingRead, true);
  assert.equal(s.refreshes, 1);

  reconcileMaterialProcessing(s.record, material());
  await s.action.run();

  assert.equal(s.calls.length, 1);

  s.setNow(3000);
  await s.action.run();

  assert.equal(s.calls[1].options.idempotencyKey, KEY2);
  s.action.stop();
});

test('Свежий ready блокирует новый POST ещё до обновления React props', async () => {
  const s = setup({ currentMaterial: material('failed') });
  await s.action.run();

  reconcileMaterialProcessing(s.record, material('ready'));
  await s.action.run();

  assert.equal(s.calls.length, 1);

  reconcileMaterialProcessing(s.record, material('failed'));
  await s.action.run();

  assert.equal(s.calls.length, 2);
  s.action.stop();
});