import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/services/apiClient.js';
import { createSummaryEditAction, getSummaryEditState } from '../src/services/summaryEditAction.js';

const ID = '3dfa4d7d-619d-4a97-9f09-a34d236e879b';
const SUBJECT = '6f07410e-98f7-41a3-bfab-cbc387683fc1';
const OTHER = '7f07410e-98f7-41a3-bfab-cbc387683fc1';
const material = (changes = {}) => ({ id: ID, subjectId: SUBJECT, status: 'stored', ...changes });
const summary = (changes = {}) => ({ materialId: ID, status: 'ready', version: 1,
  content: 'Исходный конспект\nВторая строка', origin: 'ai', model: 'fixture',
  sourcePages: [1], inputTokens: 1, outputTokens: 1, ...changes });
const edited = (changes = {}) => summary({ version: 2, origin: 'user', model: null,
  sourcePages: [], inputTokens: null, outputTokens: null, ...changes });
const error = (code, status = 0, extra = {}) => new ApiError('Сырые внутренние данные', { code, status, ...extra });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function setup({ record = {}, materialReads = [], reads = [], writes = [], onRead, onSaved, onChange } = {}) {
  let allowed = true;
  let writable = true;
  let timestamp = 1000;
  let currentSummary = summary();
  const calls = [], states = [], fresh = [], saved = [], access = [];
  const reply = async (queue, fallback) => {
    const value = queue.length ? queue.shift() : fallback;
    if (value instanceof Error) throw value;
    return await value;
  };
  const action = createSummaryEditAction({
    record, materialId: ID, subjectId: SUBJECT,
    canAct: () => allowed, canWrite: () => writable,
    onChange: (state) => { states.push(state); onChange?.(state); },
    onRead: (value) => { fresh.push(value); onRead?.(value); },
    onSaved: (value) => { saved.push(value); onSaved?.(value); },
    onAccessError: (value) => access.push(value),
    now: () => timestamp,
    materials: { async getById(id, options) {
      calls.push({ method: 'material', id, ...options });
      return await reply(materialReads, material());
    } },
    api: {
      async getByMaterial(id, options) {
        calls.push({ method: 'GET', id, ...options });
        return await reply(reads, currentSummary);
      },
      async update(id, values, options) {
        calls.push({ method: 'PATCH', id, values, ...options });
        const value = await reply(writes, edited({ content: values.content.trim(), version: options.version + 1 }));
        currentSummary = value;
        return value;
      },
    },
  });
  return { action, record, calls, states, fresh, saved, access,
    get state() { return getSummaryEditState(record, ID); },
    get patches() { return calls.filter((call) => call.method === 'PATCH'); },
    deny() { allowed = false; }, write(value) { writable = value; }, setNow(value) { timestamp = value; },
  };
}

test('Open читает владельца/хранение и свежий конспект; save передаёт точный текст и версию', async () => {
  const s = setup({ reads: [summary({ version: 7 })] });
  assert.equal(s.calls.length, 0);
  await s.action.save();
  assert.equal(s.calls.length, 0);
  await s.action.open();
  assert.deepEqual(s.calls.map((call) => call.method), ['material', 'GET']);
  assert.equal(s.state.baseVersion, 7);
  assert.equal(s.fresh.length, 1);
  const content = '  Правка\r\n\tТочный текст 😀\n ';
  s.action.changeContent(content);
  await s.action.save();
  assert.deepEqual(s.patches[0].values, { content });
  assert.equal(s.patches[0].version, 7);
  assert.equal(s.patches[0].signal.aborted, false);
  assert.equal(s.saved[0].content, content.trim());
  assert.equal(s.saved[0].version, 8);
  assert.equal(s.state.open, false);
  assert.equal(s.state.content, '');
  await s.action.open();
  assert.equal(s.state.content, content.trim());
});

test('Сохранённый конспект можно править при ready, failed и cancelled', async () => {
  for (const status of ['ready', 'failed', 'cancelled']) {
    const s = setup({ reads: [summary({ status })], writes: [edited({ status })] });
    await s.action.open();
    await s.action.save();
    assert.equal(s.saved[0].status, status);
  }
});

test('Текст проверяется по исходным UTF-16 символам, без нормализации черновика', async () => {
  for (const content of ['', ' \t\n', 'x'.repeat(100_001), '😀'.repeat(50_001), 'a\u0000b', '\ud800', 'a\u001fb']) {
    const s = setup();
    await s.action.open();
    s.action.changeContent(content);
    await s.action.save();
    assert.equal(s.patches.length, 0);
    assert.equal(s.state.content, content);
    assert.ok(s.state.fieldError);
  }
  const s = setup();
  await s.action.open();
  const content = '😀'.repeat(50_000);
  s.action.changeContent(content);
  await s.action.save();
  assert.equal(s.patches[0].values.content, content);
});

test('Двойные open/save не дублируют GET/PATCH, отправленный черновик заблокирован', async () => {
  const read = deferred(), write = deferred();
  const s = setup({ materialReads: [read.promise], writes: [write.promise] });
  const opening = s.action.open();
  await s.action.open(); await s.action.review(); await s.action.save();
  assert.equal(s.calls.length, 1);
  read.resolve(material()); await opening;
  s.action.changeContent('Черновик');
  const saving = s.action.save();
  await s.action.save(); await s.action.open(); await s.action.review();
  s.action.changeContent('Нельзя менять'); s.action.close();
  assert.equal(s.patches.length, 1);
  assert.equal(s.state.content, 'Черновик');
  assert.equal(s.state.open, true);
  write.resolve(edited({ content: 'Черновик' })); await saving;
  assert.equal(s.saved.length, 1);
});

test('Конфликт сохраняет черновик и требует GET, выбора версии и отдельного save', async () => {
  for (const useServer of [false, true]) {
    const s = setup({ reads: [summary(), summary({ version: 4, content: 'Серверный текст' })],
      writes: [error('SUMMARY_VERSION_CONFLICT', 409)] });
    await s.action.open(); s.action.changeContent('Мой черновик'); await s.action.save();
    assert.equal(s.state.gate, 'conflict'); assert.equal(s.state.baseVersion, null);
    await s.action.save(); assert.equal(s.patches.length, 1);
    await s.action.review();
    assert.equal(s.state.gate, 'review'); assert.equal(s.state.content, 'Мой черновик');
    assert.deepEqual(s.state.latest, { content: 'Серверный текст', version: 4 });
    s.action.chooseVersion(useServer);
    assert.equal(s.patches.length, 1);
    assert.equal(s.state.baseVersion, 4);
    await s.action.save();
    assert.equal(s.patches[1].version, 4);
    assert.equal(s.patches[1].values.content, useServer ? 'Серверный текст' : 'Мой черновик');
  }
});

test('Закрытие и повторное открытие сохраняют черновик, новая версия требует сравнения', async () => {
  const s = setup({ reads: [summary(), summary({ version: 3, content: 'Новая генерация' })] });
  await s.action.open(); s.action.changeContent('Локальная правка'); s.action.close();
  assert.equal(s.state.open, false); assert.equal(s.state.baseVersion, null);
  await s.action.open();
  assert.equal(s.state.content, 'Локальная правка'); assert.equal(s.state.gate, 'review');
  assert.equal(s.patches.length, 0);
});

test('Неизвестный исход блокирует PATCH до свежего GET и выбора, даже при прежней version', async () => {
  for (const failure of [error('NETWORK_ERROR'), error('SERVICE_UNAVAILABLE', 503),
    error('INVALID_RESPONSE', 200), error('REQUEST_CANCELLED')]) {
    const s = setup({ writes: [failure] });
    await s.action.open(); s.action.changeContent('Черновик'); await s.action.save();
    assert.equal(s.state.gate, 'uncertain'); assert.equal(s.state.baseVersion, null);
    await s.action.save(); assert.equal(s.patches.length, 1);
    await s.action.review();
    assert.equal(s.state.gate, 'review'); assert.equal(s.state.latest.version, 1);
    await s.action.save(); assert.equal(s.patches.length, 1);
    s.action.chooseVersion(false); await s.action.save();
    assert.equal(s.patches.length, 2);
    assert.equal(s.patches[1].values.content, 'Черновик');
  }
});

test('SUMMARY_IN_PROGRESS требует чтения; queued/running не разрешают правку', async () => {
  const s = setup({ writes: [error('SUMMARY_IN_PROGRESS', 409)],
    reads: [summary(), summary({ status: 'running' }), summary({ version: 2 })] });
  await s.action.open(); s.action.changeContent('Черновик'); await s.action.save();
  assert.equal(s.state.baseVersion, null); assert.equal(s.state.unavailable, true);
  await s.action.review();
  assert.equal(s.state.unavailable, true); assert.equal(s.state.content, 'Черновик');
  await s.action.save(); assert.equal(s.patches.length, 1);
  await s.action.review();
  assert.equal(s.state.gate, 'review'); assert.equal(s.state.latest.version, 2);
  assert.equal(s.fresh.length, 3);
});

test('canWrite блокирует open/save и проверяется ещё раз перед фактическим PATCH', async () => {
  let s = setup();
  s.write(false); await s.action.open(); assert.equal(s.calls.length, 0);
  s.write(true); await s.action.open(); s.write(false); await s.action.save();
  assert.equal(s.patches.length, 0);
  s = setup({ onChange: (state) => { if (state.pending) s.write(false); } });
  await s.action.open(); await s.action.save();
  assert.equal(s.patches.length, 0); assert.equal(s.state.pending, false);
  assert.equal(s.state.baseVersion, null);
});

test('onRead может начать обновление родителя; review работает при canWrite=false', async () => {
  let s;
  s = setup({ onRead: () => s.write(false) });
  await s.action.open();
  assert.equal(s.state.baseVersion, 1);
  s.action.changeContent('Черновик');
  await s.action.review();
  assert.equal(s.fresh.length, 2);
  assert.equal(s.state.content, 'Черновик');
  await s.action.save(); assert.equal(s.patches.length, 0);
  s.write(true); await s.action.save(); assert.equal(s.saved.length, 1);
});

test('Остановка PATCH сохраняет uncertain, а новая сессия того же аккаунта только читает', async () => {
  const pending = deferred();
  const s = setup({ writes: [pending.promise] });
  await s.action.open(); s.action.changeContent('Черновик');
  const saving = s.action.save(); s.action.stop();
  assert.equal(s.patches[0].signal.aborted, true);
  assert.equal(s.state.gate, 'uncertain'); assert.equal(s.state.pending, false);
  const count = s.states.length;
  pending.resolve(edited()); await saving;
  assert.equal(s.states.length, count); assert.equal(s.saved.length, 0);
  const resumed = setup({ record: s.record, reads: [edited({ content: 'Сохранено другим запросом' })] });
  await resumed.action.open();
  assert.equal(resumed.state.gate, 'review'); assert.equal(resumed.state.content, 'Черновик');
  assert.equal(resumed.patches.length, 0);
  const another = setup(); await another.action.open();
  assert.equal(another.state.content, summary().content);
});

test('Поздние ответы после закрытия/потери scope/смены записи не публикуются', async () => {
  for (const mode of ['close', 'scope', 'record']) {
    const pending = deferred();
    const s = setup({ reads: [pending.promise] });
    const opening = s.action.open();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    if (mode === 'close') s.action.close();
    else if (mode === 'scope') s.deny();
    else s.record.summaryEdit = {};
    const count = s.states.length;
    pending.resolve(summary()); await opening;
    assert.equal(s.states.length, count); assert.equal(s.fresh.length, 0);
    assert.equal(s.saved.length, 0);
  }
});

test('Неверный материал/предмет, удаление и отсутствие версии не разрешают PATCH', async () => {
  for (const value of [material({ id: OTHER }), material({ subjectId: OTHER }),
    material({ status: 'uploading' }), material({ status: 'deleting' })]) {
    const s = setup({ materialReads: [value] });
    await s.action.open(); await s.action.save();
    assert.equal(s.calls.filter((call) => call.method === 'GET').length, 0);
    assert.equal(s.patches.length, 0);
  }
  for (const value of [summary({ materialId: OTHER }), summary({ status: 'running' }),
    summary({ status: 'queued' }), summary({ status: 'cancelled', version: null, content: null })]) {
    const s = setup({ reads: [value] });
    await s.action.open(); await s.action.save();
    assert.equal(s.state.baseVersion, null); assert.equal(s.patches.length, 0);
  }
});

test('404/409 unavailable сохраняют черновик и требуют повторного чтения', async () => {
  for (const failure of [error('SUMMARY_NOT_FOUND', 404), error('MATERIAL_NOT_FOUND', 404),
    error('MATERIAL_NOT_AVAILABLE', 409)]) {
    const s = setup({ writes: [failure] });
    await s.action.open(); s.action.changeContent('Черновик'); await s.action.save();
    assert.equal(s.state.content, 'Черновик'); assert.equal(s.state.baseVersion, null);
    assert.equal(s.state.unavailable, true);
    await s.action.save(); assert.equal(s.patches.length, 1);
  }
});

test('422 показывает только fieldErrors.content, другие сырые ошибки не выводятся', async () => {
  for (const fields of [{ content: 'Исправь текст.' }, { version: 'Внутренняя версия' }, {}]) {
    const s = setup({ writes: [error('VALIDATION_FAILED', 422, { fieldErrors: fields })] });
    await s.action.open(); s.action.changeContent('Черновик'); await s.action.save();
    assert.equal(s.state.fieldError, fields.content ?? '');
    assert.equal(s.state.content, 'Черновик'); assert.equal(s.state.baseVersion, 1);
    assert.doesNotMatch(s.state.message, /Сырые|Внутренняя/);
  }
});

test('Retry-After сохраняется при закрытии и не отправляет запрос после истечения', async () => {
  const s = setup({ writes: [error('RATE_LIMITED', 429, { retryAfterSeconds: 2 })] });
  await s.action.open(); await s.action.save();
  assert.equal(s.state.retryAt, 3000);
  s.action.close(); await s.action.open();
  assert.equal(s.state.baseVersion, null);
  const count = s.calls.length;
  s.setNow(2999); await s.action.review(); await s.action.save(); assert.equal(s.calls.length, count);
  s.setNow(3000); await Promise.resolve(); assert.equal(s.calls.length, count);
  await s.action.review(); assert.equal(s.state.baseVersion, 1);
  assert.equal(s.patches.length, 1);
});

test('401/CSRF передаются в существующее восстановление, без автоматического PATCH', async () => {
  for (const failure of [error('AUTHENTICATION_REQUIRED', 401), error('CSRF_INVALID', 403), error('CSRF_NOT_INITIALIZED')]) {
    const s = setup({ writes: [failure] });
    await s.action.open(); s.action.changeContent('Черновик'); await s.action.save();
    assert.deepEqual(s.access, [failure]); assert.equal(s.state.content, 'Черновик');
    assert.equal(s.state.baseVersion, null); assert.equal(s.state.gate, '');
    await s.action.save(); assert.equal(s.patches.length, 1);
  }
});

test('Неправильный ответ PATCH не объявляется сохранением и требует проверки', async () => {
  for (const value of [edited({ materialId: OTHER }), edited({ version: 1 }),
    summary({ version: 2 }), edited({ status: 'running' }), edited({ sourcePages: [1] })]) {
    const s = setup({ writes: [value] });
    await s.action.open(); s.action.changeContent('Черновик'); await s.action.save();
    assert.equal(s.saved.length, 0); assert.equal(s.state.gate, 'uncertain');
    assert.equal(s.state.content, 'Черновик'); assert.equal(s.state.baseVersion, null);
  }
});

test('Уведомление onRead может закрыть scope; onSaved может остановить без uncertain', async () => {
  let s = setup({ onRead: () => s.deny() });
  await s.action.open(); assert.equal(s.patches.length, 0);
  assert.equal(s.states.at(-1).baseVersion, null);
  s = setup({ onSaved: () => s.action.stop() });
  await s.action.open(); await s.action.save();
  assert.equal(s.saved.length, 1); assert.equal(s.state.gate, '');
  assert.equal(s.state.pending, false);
});
