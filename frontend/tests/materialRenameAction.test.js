import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/services/apiClient.js';
import {
  createMaterialRenameAction,
  getMaterialRenameState,
} from '../src/services/materialRenameAction.js';

const ID = '3dfa4d7d-619d-4a97-9f09-a34d236e879b';
const SUBJECT = '6f07410e-98f7-41a3-bfab-cbc387683fc1';
const OTHER = '7f07410e-98f7-41a3-bfab-cbc387683fc1';
const material = (changes = {}) => ({
  id: ID, subjectId: SUBJECT, title: 'Лекция 1', version: 1,
  status: 'stored', ...changes,
});
const error = (code, status = 0, extra = {}) => new ApiError('Сырые данные сервера', {
  code, status, ...extra,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function setup({ record = {}, reads = [], writes = [], onSaved, onRead } = {}) {
  let allowed = true;
  let timestamp = 1000;
  let currentMaterial = material();
  const calls = [];
  const states = [];
  const saved = [];
  const access = [];
  const fresh = [];
  const respond = async (queue, fallback) => {
    const response = queue.length ? queue.shift() : fallback;
    if (response instanceof Error) throw response;
    return await response;
  };
  const action = createMaterialRenameAction({
    record,
    materialId: ID,
    subjectId: SUBJECT,
    canAct: () => allowed,
    onChange: (state) => states.push(state),
    onSaved: (value) => { saved.push(value); onSaved?.(value); },
    onRead: (value) => { fresh.push(value); onRead?.(value); },
    onAccessError: (value) => access.push(value),
    now: () => timestamp,
    api: {
      async getById(id, options) {
        calls.push({ method: 'GET', id, ...options });
        return await respond(reads, currentMaterial);
      },
      async rename(id, values, options) {
        calls.push({ method: 'PATCH', id, values, ...options });
        const response = await respond(writes, material({
          title: values.title, version: options.version + 1,
        }));
        currentMaterial = response;
        return response;
      },
    },
  });
  return {
    action, record, calls, states, saved, access, fresh,
    get state() { return getMaterialRenameState(record, ID); },
    get patches() { return calls.filter((call) => call.method === 'PATCH'); },
    deny() { allowed = false; },
    setNow(value) { timestamp = value; },
  };
}

test('Открытие читает свежую версию; сохранение отправляет только нормализованное название и version', async () => {
  const s = setup({ reads: [material({ version: 7 })] });
  assert.equal(s.calls.length, 0);
  await s.action.save();
  assert.equal(s.calls.length, 0);
  await s.action.open();
  assert.equal(s.state.title, 'Лекция 1');
  assert.equal(s.state.baseVersion, 7);
  assert.equal(s.saved.length, 0);

  s.action.changeTitle('  Новая\n\tлекция\u00a0  1  ');
  await s.action.save();
  assert.equal(s.patches.length, 1);
  assert.equal(s.patches[0].id, ID);
  assert.deepEqual(s.patches[0].values, { title: 'Новая лекция 1' });
  assert.equal(s.patches[0].version, 7);
  assert.equal(s.saved[0].version, 8);
  assert.equal(s.state.open, false);
  assert.equal(s.state.pending, false);
  assert.equal(s.state.title, '');
  assert.equal(s.state.baseVersion, null);

  await s.action.open();
  assert.equal(s.state.title, 'Новая лекция 1');
  assert.equal(s.state.baseVersion, 8);
});

test('Чтение и PATCH блокируют двойные действия и изменение уже отправленного черновика', async () => {
  const read = deferred();
  const write = deferred();
  const s = setup({ reads: [read.promise], writes: [write.promise] });
  const opening = s.action.open();
  await s.action.open();
  await s.action.review();
  await s.action.save();
  s.action.changeTitle('Не применять');
  assert.equal(s.calls.length, 1);
  assert.equal(s.state.title, '');
  read.resolve(material());
  await opening;

  s.action.changeTitle('Черновик');
  const saving = s.action.save();
  s.action.changeTitle('Не применять');
  s.action.close();
  await s.action.save();
  await s.action.review();
  await s.action.open();
  assert.equal(s.patches.length, 1);
  assert.equal(s.state.title, 'Черновик');
  assert.equal(s.state.open, true);
  write.resolve(material({ title: 'Черновик', version: 2 }));
  await saving;
  assert.equal(s.saved.length, 1);
});

test('Проверка названия учитывает нормализацию, UTF-16, управляющие символы и пары суррогатов', async () => {
  for (const title of ['', ' \t\n ', 'a'.repeat(161), '😀'.repeat(81), 'a\u0000b', '\u007f', '\ud800', '\udc00']) {
    const s = setup();
    await s.action.open();
    s.action.changeTitle(title);
    await s.action.save();
    assert.equal(s.patches.length, 0, JSON.stringify(title));
    assert.equal(s.state.title, title);
    assert.ok(s.state.fieldError);
  }
  for (const title of ['a', 'a'.repeat(160), '😀'.repeat(80)]) {
    const s = setup();
    await s.action.open();
    s.action.changeTitle(title);
    await s.action.save();
    assert.equal(s.patches[0].values.title, title);
    assert.equal(s.saved.length, 1);
  }
});

test('Конфликт требует свежего GET, отдельного выбора и отдельного сохранения', async () => {
  for (const useServer of [true, false]) {
    const s = setup({
      reads: [material(), material({ title: 'На сервере', version: 3, privateData: 'hidden' })],
      writes: [error('MATERIAL_VERSION_CONFLICT', 409)],
    });
    await s.action.open();
    s.action.changeTitle('Мой черновик');
    await s.action.save();
    assert.equal(s.state.gate, 'conflict');
    assert.equal(s.state.title, 'Мой черновик');
    assert.equal(s.state.baseVersion, null);
    s.action.chooseVersion(false);
    await s.action.save();
    assert.equal(s.patches.length, 1);

    await s.action.review();
    assert.equal(s.saved.length, 0);
    assert.equal(s.state.gate, 'review');
    assert.equal(s.state.latest.title, 'На сервере');
    assert.equal(Object.hasOwn(s.state.latest, 'privateData'), false);
    assert.equal(s.state.baseVersion, null);
    await s.action.save();
    assert.equal(s.patches.length, 1);
    s.action.chooseVersion(useServer);
    assert.equal(s.patches.length, 1);
    assert.equal(s.state.baseVersion, 3);
    assert.equal(s.state.gate, '');
    await s.action.save();
    assert.equal(s.patches[1].version, 3);
    assert.equal(s.patches[1].values.title, useServer ? 'На сервере' : 'Мой черновик');
  }
});

test('Потерянный/некорректный ответ и серверный сбой запрещают повтор PATCH до сверки', async () => {
  for (const failure of [
    error('NETWORK_ERROR'), error('REQUEST_CANCELLED'), error('INTERNAL_ERROR', 500),
    error('SERVICE_UNAVAILABLE', 503), error('INVALID_RESPONSE', 200),
    error('INVALID_RESPONSE', 422),
  ]) {
    const s = setup({ writes: [failure], reads: [material(), material({ title: 'Черновик', version: 2 })] });
    await s.action.open();
    s.action.changeTitle('Черновик');
    await s.action.save();
    assert.equal(s.state.gate, 'uncertain', failure.code);
    assert.equal(s.state.baseVersion, null);
    await s.action.save();
    s.action.chooseVersion(false);
    assert.equal(s.patches.length, 1);
    await s.action.review();
    assert.equal(s.state.title, 'Черновик');
    assert.equal(s.state.gate, 'review');
    assert.equal(s.saved.length, 0);
    assert.equal(s.patches.length, 1);
  }
});

test('Скрытие сохраняет черновик; повторное открытие проверяет версию заново', async () => {
  for (const version of [1, 2]) {
    const record = {};
    const first = setup({ record });
    await first.action.open();
    first.action.changeTitle('Несохранённое');
    first.action.close();
    first.action.stop();
    assert.equal(first.state.open, false);
    assert.equal(first.state.title, 'Несохранённое');

    const second = setup({ record, reads: [material({ title: 'Сервер', version })] });
    await second.action.open();
    assert.equal(second.state.title, 'Несохранённое');
    assert.equal(second.state.gate, version === 1 ? '' : 'review');
    assert.equal(second.state.baseVersion, version === 1 ? 1 : null);
    assert.equal(second.patches.length, 0);
  }
});

test('Скрытая форма прерывает GET; старый ответ не подменяет новое чтение', async () => {
  const pending = deferred();
  const s = setup({ reads: [pending.promise, material({ title: 'Свежий', version: 5 })] });
  const first = s.action.open();
  s.action.close();
  assert.equal(s.calls[0].signal.aborted, true);
  assert.equal(s.state.open, false);
  await s.action.open();
  const state = s.state;
  pending.resolve(material({ title: 'Старый' }));
  await first;
  assert.deepEqual(s.state, state);
  assert.equal(s.state.title, 'Свежий');
});

test('Прерывание PATCH сохраняет неизвестный исход для следующего открытия', async () => {
  const record = {};
  const pending = deferred();
  const first = setup({ record, writes: [pending.promise] });
  await first.action.open();
  first.action.changeTitle('Черновик');
  const saving = first.action.save();
  first.deny();
  first.action.stop();
  assert.equal(first.patches[0].signal.aborted, true);
  assert.equal(first.state.pending, false);
  assert.equal(first.state.gate, 'uncertain');
  assert.equal(first.state.title, 'Черновик');
  const second = setup({ record, reads: [material({ title: 'Черновик', version: 2 })] });
  await second.action.open();
  assert.equal(second.state.gate, 'review');
  const state = second.state;
  pending.resolve(material({ title: 'Черновик', version: 2 }));
  await saving;
  assert.equal(first.saved.length, 0);
  assert.deepEqual(second.state, state);
});

test('После подтверждённого сохранения синхронный stop родителя не создаёт неизвестный исход', async () => {
  let s;
  s = setup({ onSaved: () => s.action.stop() });
  await s.action.open();
  s.action.changeTitle('Готово');
  await s.action.save();
  assert.equal(s.saved.length, 1);
  assert.equal(s.state.gate, '');
  assert.equal(s.state.pending, false);
  assert.equal(s.state.message, 'Название сохранено.');
});

test('Потеря актуальности и замена записи подавляют поздний успех и ошибку без частных записей', async () => {
  for (const phase of ['read', 'write']) {
    for (const mode of ['deny', 'replace']) {
      for (const outcome of ['success', 'error']) {
        const pending = deferred();
        const s = setup({
          reads: phase === 'read' ? [pending.promise] : [],
          writes: phase === 'write' ? [pending.promise] : [],
        });
        let running;
        if (phase === 'read') running = s.action.open();
        else {
          await s.action.open();
          s.action.changeTitle('Черновик');
          running = s.action.save();
        }
        const draft = s.record.rename[ID];
        const state = { ...draft };
        if (mode === 'deny') s.deny();
        else s.record.rename = {};
        const stateCount = s.states.length;
        if (outcome === 'success') pending.resolve(material({ title: 'Черновик', version: 2 }));
        else pending.reject(error('AUTHENTICATION_REQUIRED', 401));
        await running;
        assert.deepEqual(draft, state, `${phase}/${mode}/${outcome}`);
        assert.equal(s.states.length, stateCount);
        assert.equal(s.saved.length, 0);
        assert.equal(s.access.length, 0);
        s.action.stop();
      }
    }
  }
});

test('Восстановление доступа сохраняет черновик и требует нового чтения без автосохранения', async () => {
  for (const failure of [error('AUTHENTICATION_REQUIRED', 401), error('CSRF_INVALID', 403), error('CSRF_NOT_INITIALIZED')]) {
    const record = {};
    const first = setup({ record, writes: [failure] });
    await first.action.open();
    first.action.changeTitle('Черновик');
    await first.action.save();
    assert.deepEqual(first.access, [failure]);
    assert.equal(first.state.pending, false);
    assert.equal(first.state.title, 'Черновик');
    assert.equal(first.state.baseVersion, null);
    const second = setup({ record });
    await second.action.save();
    assert.equal(second.calls.length, 0);
    await second.action.open();
    assert.equal(second.state.title, 'Черновик');
    assert.equal(second.patches.length, 0);
    await second.action.save();
    assert.equal(second.saved.length, 1);
  }
});

test('Ошибка доступа во время первого GET не оставляет чтение заблокированным', async () => {
  const record = {};
  const s = setup({ record, reads: [error('AUTHENTICATION_REQUIRED', 401)] });
  await s.action.open();
  assert.equal(s.access.length, 1);
  assert.equal(s.state.reading, false);
  assert.equal(s.state.baseVersion, null);
  const restored = setup({ record });
  await restored.action.open();
  assert.equal(restored.state.baseVersion, 1);
});

test('Retry-After переживает закрытие панели и ограничивает только явные запросы', async () => {
  const record = {};
  const first = setup({ record, writes: [error('RATE_LIMITED', 429, { retryAfterSeconds: 2 })] });
  await first.action.open();
  first.action.changeTitle('Черновик');
  await first.action.save();
  assert.equal(first.state.retryAt, 3000);
  await first.action.save();
  assert.equal(first.patches.length, 1);
  first.action.close();
  first.action.stop();
  const second = setup({ record });
  second.setNow(2999);
  await second.action.open();
  assert.equal(second.calls.length, 0);
  assert.equal(second.state.title, 'Черновик');
  assert.equal(second.state.baseVersion, null);
  second.setNow(3000);
  assert.equal(second.calls.length, 0);
  await second.action.review();
  assert.equal(second.calls.length, 1);
  await second.action.save();
  assert.equal(second.saved.length, 1);
});

test('Сбой повторного чтения удаляет прежнюю сравнительную версию и не разрешает устаревший выбор', async () => {
  for (const failure of [error('VALIDATION_FAILED', 422), error('INTERNAL_ERROR', 500)]) {
    const s = setup({
      reads: [material(), material({ title: 'Сервер', version: 2 }), failure, material({ version: 3 })],
      writes: [error('MATERIAL_VERSION_CONFLICT', 409)],
    });
    await s.action.open();
    s.action.changeTitle('Черновик');
    await s.action.save();
    await s.action.review();
    assert.equal(s.state.latest.version, 2);
    await s.action.review();
    assert.equal(s.state.latest, null);
    assert.equal(s.state.baseVersion, null);
    assert.equal(s.state.reading, false);
    s.action.chooseVersion(false);
    await s.action.save();
    assert.equal(s.patches.length, 1);
    await s.action.review();
    assert.equal(s.state.latest.version, 3);
    assert.equal(s.state.title, 'Черновик');
  }
});

test('Недоступный материал сохраняет черновик и позволяет только повторную проверку', async () => {
  for (const response of [error('MATERIAL_NOT_FOUND', 404), error('MATERIAL_NOT_AVAILABLE', 409), material({ status: 'deleting' }), material({ status: 'uploading' })]) {
    const s = setup({ reads: [material(), response, material()] });
    await s.action.open();
    s.action.changeTitle('Черновик');
    await s.action.review();
    assert.equal(s.state.unavailable, true);
    assert.equal(s.state.title, 'Черновик');
    assert.equal(s.state.baseVersion, null);
    await s.action.save();
    assert.equal(s.patches.length, 0);
    await s.action.review();
    assert.equal(s.state.unavailable, false);
    assert.equal(s.state.baseVersion, 1);
  }
});

test('404 и недоступность после PATCH не стирают введённое название', async () => {
  for (const failure of [error('MATERIAL_NOT_FOUND', 404), error('MATERIAL_NOT_AVAILABLE', 409)]) {
    const s = setup({ writes: [failure] });
    await s.action.open();
    s.action.changeTitle('Черновик');
    await s.action.save();
    assert.equal(s.state.unavailable, true);
    assert.equal(s.state.title, 'Черновик');
    assert.equal(s.state.baseVersion, null);
    await s.action.save();
    assert.equal(s.patches.length, 1);
  }
});

test('Ошибки поля и неизвестные коды дают безопасный текст и сохраняют ввод', async () => {
  for (const failure of [
    error('VALIDATION_FAILED', 422, { fieldErrors: { title: 'Это название недопустимо.' } }),
    error('VALIDATION_FAILED', 422, { fieldErrors: { version: 'Сырые данные сервера' } }),
    error('constructor', 400), error('__proto__', 400),
  ]) {
    const s = setup({ writes: [failure] });
    await s.action.open();
    s.action.changeTitle('Черновик');
    await s.action.save();
    assert.equal(s.state.title, 'Черновик');
    assert.equal(s.state.baseVersion, 1);
    assert.equal(s.state.pending, false);
    assert.equal(typeof s.state.message, 'string');
    assert.ok(s.state.message);
    assert.doesNotMatch(s.state.message + s.state.fieldError, /Сырые данные/);
    assert.equal(Boolean(s.state.fieldError), Object.hasOwn(failure.fieldErrors, 'title'));
    if (s.state.fieldError) assert.equal(s.state.fieldError, 'Это название недопустимо.');
  }
});

test('Свежие чтения уведомляют onRead, но смена актуальности внутри callback прекращает публикацию', async () => {
  const s = setup();
  await s.action.open();
  assert.deepEqual(s.fresh, [material()]);
  assert.equal(s.saved.length, 0);
  let changed;
  changed = setup({ onRead: () => changed.deny() });
  await changed.action.open();
  assert.equal(changed.fresh.length, 1);
  assert.equal(changed.state.baseVersion, null);
  assert.equal(changed.state.title, '');
  changed.action.stop();
});

test('Чужие UUID или предметы в GET/PATCH не попадают в состояние и onSaved', async () => {
  for (const changes of [{ id: OTHER }, { subjectId: OTHER }, { version: 0 }, { title: '\ud800' }]) {
    const s = setup({ reads: [material({ ...changes, privateData: 'hidden' })] });
    await s.action.open();
    assert.equal(s.state.baseVersion, null);
    assert.equal(s.state.title, '');
    assert.equal(s.state.latest, null);
    assert.equal(s.saved.length, 0);
    assert.equal(s.state.reading, false);
  }
  for (const changes of [{ id: OTHER }, { subjectId: OTHER }, { version: 3 }, { title: 'Другое' }, { status: 'deleting' }]) {
    const s = setup({ writes: [material({ title: 'Черновик', version: 2, ...changes })] });
    await s.action.open();
    s.action.changeTitle('Черновик');
    await s.action.save();
    assert.equal(s.state.gate, 'uncertain');
    assert.equal(s.state.title, 'Черновик');
    assert.equal(s.saved.length, 0);
  }
});

test('Снимки не дают изменить сохранённый черновик и сравнительный материал', async () => {
  const s = setup({
    reads: [material(), material({ version: 2 })],
    writes: [error('MATERIAL_VERSION_CONFLICT', 409)],
  });
  await s.action.open();
  await s.action.save();
  await s.action.review();
  const state = s.state;
  state.title = 'Подмена';
  state.latest.version = 99;
  assert.equal(s.state.title, 'Лекция 1');
  assert.equal(s.state.latest.version, 2);
  assert.equal(Object.hasOwn(state, 'operation'), false);
});
