import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/services/apiClient.js';
import { createAttemptHistoryController, getAttemptHistoryState } from '../src/services/attemptHistoryController.js';

const uuid = (number) => number.toString(16).padStart(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MATERIAL = uuid(1);
const SUBJECT = uuid(2);
const OTHER = uuid(3);
const questions = () => Array.from({ length: 10 }, (_, index) => ({
  id: uuid(100 + index), position: index + 1, text: 'Вопрос ' + (index + 1),
  options: Array.from({ length: 4 }, (_, option) => ({ id: uuid(1000 + index * 4 + option), position: option + 1, text: 'Ответ ' + (option + 1) })),
}));
const info = (index = 1, changes = {}) => ({
  id: uuid(10000 + index), quizId: uuid(20000 + index), materialId: MATERIAL, quizVersion: index,
  status: 'in_progress', questionCount: 10, startedAt: '2026-10-03T00:00:00Z',
  completedAt: null, correctCount: null, scorePercent: null, ...changes,
});
const completedInfo = (index = 1, changes = {}) => info(index, {
  status: 'completed', completedAt: '2026-10-03T00:01:00Z', correctCount: 0, scorePercent: 0, ...changes,
});
const detail = (row = info(), changes = {}) => ({
  ...row, questions: questions(),
  review: row.status === 'completed' ? questions().map((question) => ({
    questionId: question.id, selectedOptionId: null, correctOptionId: question.options[0].id,
    isCorrect: false, explanation: 'Разбор', sourcePages: [1, 3],
  })) : null, ...changes,
});
const material = (id = MATERIAL, changes = {}) => ({ id, subjectId: SUBJECT, title: 'Лекция ' + id.slice(0, 8), status: 'stored', ...changes });
const page = (rows = [], pageNumber = 1, total = rows.length) => ({ attempts: rows, meta: { page: pageNumber, pageSize: 20, total } });
const failure = (code, status = 0, extra = {}) => new ApiError('Сырые сведения сервера', { code, status, ...extra });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function setup({ record = {}, lists = [], details = [], materials = [], rows = [], onChange, onAccessRestored } = {}) {
  let allowed = true;
  let timestamp = 1000;
  const calls = [];
  const states = [];
  const access = [];
  let restored = 0;
  async function respond(queue, fallback) {
    const value = queue.length ? queue.shift() : fallback;
    if (value instanceof Error) throw value;
    return await value;
  }
  const controller = createAttemptHistoryController({
    record, canAct: () => allowed, now: () => timestamp,
    onChange: (state) => { states.push(state); onChange?.(state); },
    onAccessError: (error) => access.push(error),
    onAccessRestored: () => { restored += 1; onAccessRestored?.(); },
    api: {
      async list(options) {
        calls.push({ kind: 'list', ...options });
        const filtered = rows.filter((row) => (!options.status || row.status === options.status)
          && (!options.materialId || row.materialId.toLowerCase() === options.materialId.toLowerCase())
          && (!options.quizId || row.quizId.toLowerCase() === options.quizId.toLowerCase()));
        return await respond(lists, page(filtered.slice((options.page - 1) * 20, options.page * 20), options.page, filtered.length));
      },
      async getById(id, options) {
        calls.push({ kind: 'detail', id, ...options });
        return await respond(details, detail(rows.find((row) => row.id.toLowerCase() === id.toLowerCase()) ?? info()));
      },
    },
    materials: { async getById(id, options) { calls.push({ kind: 'material', id, ...options }); return await respond(materials, material(id)); } },
  });
  return {
    controller, record, calls, states, access,
    get state() { return getAttemptHistoryState(record); },
    get lists() { return calls.filter((call) => call.kind === 'list'); },
    get detailCalls() { return calls.filter((call) => call.kind === 'detail'); },
    get materialCalls() { return calls.filter((call) => call.kind === 'material'); },
    get restored() { return restored; },
    deny() { allowed = false; }, setNow(value) { timestamp = value; },
  };
}

test('Пустая история отличается от ошибки и не делает дополнительных GET/POST', async () => {
  const s = setup();
  assert.equal(s.calls.length, 0);
  await s.controller.refresh();
  assert.equal(s.state.phase, 'ready');
  assert.deepEqual(s.state.attempts, []);
  assert.equal(s.state.meta.total, 0);
  assert.equal(s.state.listStale, false);
  assert.equal(s.state.namesLoading, false);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(Object.keys(s.lists[0]).sort(), ['kind', 'page', 'pageSize', 'signal']);
  const failed = setup({ lists: [failure('NETWORK_ERROR')] });
  await failed.controller.refresh();
  assert.equal(failed.state.phase, 'error');
  assert.equal(failed.state.listStale, true);
  assert.doesNotMatch(failed.state.message, /Сырые/);
});

test('Названия приходят постепенно, уникальные material GET ограничены четырьмя одновременно', async () => {
  const waits = Array.from({ length: 5 }, deferred);
  const rows = Array.from({ length: 6 }, (_, index) => info(index + 1, { materialId: uuid(index === 5 ? 10 : 10 + index) }));
  const s = setup({ rows, materials: waits.map((wait) => wait.promise) });
  const refreshing = s.controller.refresh();
  await tick();
  assert.equal(s.materialCalls.length, 4);
  assert.equal(s.state.reading, false);
  assert.equal(s.state.namesLoading, true);
  waits[0].resolve(material(uuid(10), { title: 'Название первого' }));
  await tick();
  assert.equal(s.materialCalls.length, 5);
  assert.equal(s.state.attempts[0].materialTitle, 'Название первого');
  assert.equal(s.state.attempts[5].materialTitle, 'Название первого');
  waits.slice(1).forEach((wait, index) => wait.resolve(material(uuid(11 + index))));
  await refreshing;
  assert.equal(s.materialCalls.length, 5);
  assert.equal(s.state.namesLoading, false);
  assert.equal(s.state.namesError, false);
  assert.ok(s.state.attempts.every((row) => row.materialStatus === 'ready'));
});

test('Ошибка названия даёт fallback и ручной refresh; 404/409 отмечает материал недоступным', async () => {
  const s = setup({ rows: [info()], materials: [failure('NETWORK_ERROR')] });
  await s.controller.refresh();
  assert.equal(s.state.phase, 'ready');
  assert.equal(s.state.namesError, true);
  assert.equal(s.state.attempts[0].materialTitle, 'Материал');
  assert.equal(s.state.attempts[0].materialStatus, 'error');
  await s.controller.refresh();
  assert.equal(s.state.attempts[0].materialStatus, 'ready');
  for (const response of [failure('MATERIAL_NOT_FOUND', 404), failure('MATERIAL_NOT_AVAILABLE', 409), material(MATERIAL, { status: 'deleting' })]) {
    const unavailable = setup({ rows: [info()], materials: [response] });
    await unavailable.controller.refresh();
    assert.equal(unavailable.state.attempts[0].materialStatus, 'unavailable');
    await unavailable.controller.openAttempt(info().id);
    assert.equal(unavailable.detailCalls.length, 0);
    assert.equal(unavailable.state.detail, null);
    assert.equal(unavailable.state.detailPhase, 'unavailable');
  }
});

test('Некорректная metadata не подменяет название материалом с другим ID', async () => {
  const s = setup({ rows: [info()], materials: [material(OTHER, { title: 'Чужое название' })] });
  await s.controller.refresh();
  assert.equal(s.state.attempts[0].materialTitle, 'Материал');
  assert.equal(s.state.attempts[0].materialStatus, 'error');
});

test('Фильтры очищают прежние строки и selection; late list не возвращает старый scope', async () => {
  const pending = deferred();
  const s = setup({ lists: [pending.promise], rows: [completedInfo()] });
  const first = s.controller.refresh();
  await s.controller.setFilters({ status: 'completed', materialId: MATERIAL.toUpperCase() });
  assert.equal(s.lists[0].signal.aborted, true);
  assert.deepEqual(s.state.filters, { status: 'completed', materialId: MATERIAL });
  assert.equal(s.state.attempts[0].status, 'completed');
  const state = s.state;
  pending.resolve(page([info(2)]));
  await first;
  assert.deepEqual(s.state, state);
  await s.controller.openAttempt(completedInfo().id);
  await s.controller.setFilters({ status: 'in_progress' });
  assert.equal(s.state.selectedAttemptId, null);
  assert.equal(s.state.detail, null);
  assert.deepEqual(s.state.attempts, []);
});

test('Late title после filter/page change не меняет новые строки и не вызывает auth handler', async () => {
  for (const kind of ['filter', 'page']) {
    const pending = deferred();
    const rows = Array.from({ length: 21 }, (_, index) => info(index + 1));
    const s = setup({ rows, materials: [pending.promise] });
    const first = s.controller.refresh();
    await tick();
    if (kind === 'filter') await s.controller.setFilters({ status: 'completed' });
    else await s.controller.changePage(2);
    const state = s.state;
    const count = s.states.length;
    pending.reject(failure('AUTHENTICATION_REQUIRED', 401));
    await first;
    assert.deepEqual(s.state, state);
    assert.equal(s.states.length, count);
    assert.equal(s.access.length, 0);
  }
});

test('Пагинация 21 строки, сохранение страницы и однократный clamp без циклов', async () => {
  const record = {};
  const rows = Array.from({ length: 21 }, (_, index) => info(index + 1));
  const first = setup({ record, rows });
  await first.controller.refresh();
  assert.equal(first.state.attempts.length, 20);
  await first.controller.changePage(99);
  assert.deepEqual(first.lists.slice(-2).map((call) => call.page), [99, 2]);
  assert.equal(first.state.attempts.length, 1);
  first.controller.stop();
  assert.deepEqual(first.state.attempts, []);
  const restored = setup({ record, rows });
  await restored.controller.refresh();
  assert.equal(restored.lists[0].page, 2);
  const invalid = setup({ lists: [page([], 99, 21), page([], 2, 0)] });
  await invalid.controller.changePage(99);
  assert.equal(invalid.lists.length, 2);
  assert.equal(invalid.state.phase, 'error');
});

test('Неуспешный refresh сохраняет прежние строки с stale, фильтр снимает их сразу даже в cooldown', async () => {
  const s = setup({ rows: [info()], lists: [page([info()]), failure('RATE_LIMITED', 429, { retryAfterSeconds: 2 })] });
  await s.controller.refresh();
  const rows = s.state.attempts;
  await s.controller.refresh();
  assert.deepEqual(s.state.attempts, rows);
  assert.equal(s.state.listStale, true);
  assert.equal(s.state.retryAt, 3000);
  await s.controller.setFilters({ status: 'completed' });
  assert.deepEqual(s.state.attempts, []);
  assert.equal(s.lists.length, 2);
  s.setNow(3000);
  assert.equal(s.lists.length, 2);
  await s.controller.refresh();
  assert.equal(s.lists.length, 3);
});

test('Открытие detail проверяет material и создаёт quiz DTO из Attempt без GET quiz/POST', async () => {
  const row = info();
  const s = setup({ rows: [row], details: [detail(completedInfo())] });
  await s.controller.refresh();
  await s.controller.openAttempt(row.id);
  assert.equal(s.state.detailPhase, 'ready');
  assert.equal(s.state.detail.attempt.status, 'completed');
  assert.equal(s.state.detail.material.subjectId, SUBJECT);
  assert.deepEqual(s.state.detail.quiz, { id: row.quizId, materialId: MATERIAL, version: row.quizVersion, questionCount: 10, questions: questions() });
  assert.deepEqual(s.calls.map((call) => call.kind), ['list', 'material', 'detail', 'material']);
  assert.equal(s.restored, 2);
});

test('Detail чужого quiz/material/version/id и регрессия completed не раскрывают DTO', async () => {
  for (const changes of [{ id: OTHER }, { quizId: OTHER }, { materialId: OTHER }, { quizVersion: 999 }, { startedAt: '2026-10-04T00:00:00Z' }]) {
    const s = setup({ rows: [info()], details: [detail(info(), changes)] });
    await s.controller.refresh();
    await s.controller.openAttempt(info().id);
    assert.equal(s.state.detail, null);
    assert.equal(s.state.detailPhase, 'error');
    assert.equal(s.materialCalls.length, 1);
  }
  const regressed = setup({ rows: [completedInfo()], details: [detail(info())] });
  await regressed.controller.refresh();
  await regressed.controller.openAttempt(info().id);
  assert.equal(regressed.state.detail, null);
});

test('Параллельный list completed не позволяет позднему detail in_progress вернуть устаревшую форму', async () => {
  const pending = deferred();
  const s = setup({ rows: [info()], details: [pending.promise], lists: [page([info()]), page([completedInfo()])] });
  await s.controller.refresh();
  const opening = s.controller.openAttempt(info().id);
  await s.controller.refresh({ preserveDetail: true });
  pending.resolve(detail(info()));
  await opening;
  assert.equal(s.state.detail, null);
  assert.equal(s.state.detailPhase, 'error');
  assert.equal(s.state.attempts[0].status, 'completed');
});

test('Detail GETmaterial mismatched/deleting/404 не публикует questions или review', async () => {
  for (const response of [material(OTHER), material(MATERIAL, { status: 'deleting' }), failure('MATERIAL_NOT_FOUND', 404)]) {
    const s = setup({ rows: [completedInfo()], materials: [material(), response] });
    await s.controller.refresh();
    await s.controller.openAttempt(info().id);
    assert.equal(s.state.detail, null);
    assert.ok(['error', 'unavailable'].includes(s.state.detailPhase));
  }
});

test('Смена выбора/close отменяет предыдущий detail и подавляет поздние данные', async () => {
  for (const close of [false, true]) {
    const pending = deferred();
    const s = setup({ rows: [info(1), info(2)], details: [pending.promise, detail(info(2))] });
    await s.controller.refresh();
    const first = s.controller.openAttempt(info(1).id);
    if (close) s.controller.closeAttempt();
    else await s.controller.openAttempt(info(2).id);
    assert.equal(s.detailCalls[0].signal.aborted, true);
    const state = s.state;
    pending.resolve(detail(info(1)));
    await first;
    assert.deepEqual(s.state, state);
    assert.equal(s.state.selectedAttemptId, close ? null : info(2).id);
  }
});

test('Ошибка повторного detail GET сразу скрывает прежде показанный разбор', async () => {
  const pending = deferred();
  const s = setup({ rows: [completedInfo()], details: [detail(completedInfo()), pending.promise] });
  await s.controller.refresh();
  await s.controller.openAttempt(info().id);
  const reading = s.controller.openAttempt(info().id);
  assert.equal(s.state.detail, null);
  pending.reject(failure('ATTEMPT_NOT_FOUND', 404));
  await reading;
  assert.equal(s.state.detail, null);
  assert.equal(s.state.detailPhase, 'unavailable');
});

test('preserveDetail обновляет только список после submit, не перечитывает detail и не заменяет открытый child', async () => {
  const s = setup({ rows: [info()], lists: [page([info()]), page([completedInfo()])] });
  await s.controller.refresh();
  await s.controller.openAttempt(info().id);
  const child = s.state.detail;
  await s.controller.refresh({ preserveDetail: true });
  assert.deepEqual(s.state.detail, child);
  assert.equal(s.state.detailPhase, 'ready');
  assert.equal(s.state.attempts[0].status, 'completed');
  assert.equal(s.detailCalls.length, 1);
});

test('preserveDetail refresh во время загрузки названий не теряет запрос обновления результата', async () => {
  const pending = deferred();
  const s = setup({ rows: [info()], materials: [pending.promise], lists: [page([info()]), page([completedInfo()])] });
  const first = s.controller.refresh();
  await tick();
  await s.controller.refresh({ preserveDetail: true });
  assert.equal(s.lists.length, 2);
  assert.equal(s.state.attempts[0].status, 'completed');
  pending.resolve(material(MATERIAL, { title: 'Старое название' }));
  await first;
  assert.notEqual(s.state.attempts[0].materialTitle, 'Старое название');
});

test('preserveDetail refresh во время list GET объединяется в один последующий запрос', async () => {
  const pending = deferred();
  const s = setup({ rows: [info()], lists: [page([info()]), pending.promise, page([completedInfo()])] });
  await s.controller.refresh();
  await s.controller.openAttempt(info().id);
  const child = s.state.detail;
  const reading = s.controller.refresh({ preserveDetail: true });
  await s.controller.refresh({ preserveDetail: true });
  await s.controller.refresh({ preserveDetail: true });
  assert.equal(s.lists.length, 2);
  pending.resolve(page([info()]));
  await reading;
  assert.equal(s.lists.length, 3);
  assert.equal(s.state.attempts[0].status, 'completed');
  assert.deepEqual(s.state.detail, child);
  assert.equal(s.detailCalls.length, 1);
});

test('Отложенный refresh отменяется новым фильтром и не обходит Retry-After', async () => {
  const pending = deferred();
  const s = setup({ rows: [completedInfo()], lists: [pending.promise] });
  const reading = s.controller.refresh();
  await s.controller.refresh({ preserveDetail: true });
  await s.controller.setFilters({ status: 'completed' });
  pending.resolve(page([info()]));
  await reading;
  assert.equal(s.lists.length, 2);
  assert.equal(s.state.filters.status, 'completed');
  const delayed = deferred();
  const limited = setup({ lists: [delayed.promise] });
  const limitedRead = limited.controller.refresh();
  await limited.controller.refresh({ preserveDetail: true });
  delayed.reject(failure('RATE_LIMITED', 429, { retryAfterSeconds: 2 }));
  await limitedRead;
  assert.equal(limited.lists.length, 1);
  assert.equal(limited.state.listStale, true);
  limited.setNow(3000);
  assert.equal(limited.lists.length, 1);
});

test('Metadata confirmed missing немедленно закрывает открытый detail даже при preserveDetail', async () => {
  const s = setup({ rows: [info()], materials: [material(), material(), failure('MATERIAL_NOT_AVAILABLE', 409)] });
  await s.controller.refresh();
  await s.controller.openAttempt(info().id);
  await s.controller.refresh({ preserveDetail: true });
  assert.equal(s.state.detail, null);
  assert.equal(s.state.selectedAttemptId, null);
  assert.equal(s.state.attempts[0].materialStatus, 'unavailable');
});

test('Закрытие/re-auth сохраняет filter/page/selected ID, mount восстанавливает только через GET', async () => {
  const record = {};
  const rows = [completedInfo()];
  const first = setup({ record, rows });
  await first.controller.setFilters({ status: 'completed', materialId: MATERIAL });
  await first.controller.openAttempt(info().id);
  first.controller.stop();
  assert.equal(first.state.detail, null);
  assert.deepEqual(first.state.attempts, []);
  const restored = setup({ record, rows });
  await restored.controller.refresh();
  await tick();
  assert.equal(restored.state.detailPhase, 'ready');
  assert.equal(restored.lists[0].status, 'completed');
  assert.equal(restored.detailCalls[0].id, info().id);
  assert.ok(restored.calls.every((call) => ['list', 'material', 'detail'].includes(call.kind)));
});

test('List/detail Retry-After сохраняется между mounts и не приводит к автоматическим запросам', async () => {
  for (const stage of ['list', 'detail']) {
    const record = {};
    const error = failure('RATE_LIMITED', 429, { retryAfterSeconds: 2 });
    const first = setup({ record, rows: [info()], lists: stage === 'list' ? [error] : [], details: stage === 'detail' ? [error] : [] });
    await first.controller.refresh();
    if (stage === 'detail') await first.controller.openAttempt(info().id);
    first.controller.stop();
    const restored = setup({ record, rows: [info()] });
    restored.setNow(2999);
    await restored.controller.refresh();
    await tick();
    assert.equal(stage === 'list' ? restored.lists.length : restored.detailCalls.length, 0);
    restored.setNow(3000);
    assert.equal(stage === 'list' ? restored.lists.length : restored.detailCalls.length, 0);
    await restored.controller.refresh();
    await tick();
    assert.equal(stage === 'list' ? restored.lists.length : restored.detailCalls.length, 1);
  }
});

test('Metadata429 прекращает выдачу следующих GET в очереди и сохраняет fallback', async () => {
  const pending = [deferred(), deferred(), deferred(), deferred()];
  const rows = Array.from({ length: 7 }, (_, index) => info(index + 1, { materialId: uuid(20 + index) }));
  const s = setup({ rows, materials: pending.map((value) => value.promise) });
  const reading = s.controller.refresh();
  await tick();
  pending[0].reject(failure('RATE_LIMITED', 429, { retryAfterSeconds: 2 }));
  await tick();
  pending.slice(1).forEach((value, index) => value.resolve(material(uuid(21 + index))));
  await reading;
  assert.equal(s.materialCalls.length, 4);
  assert.equal(s.state.retryAt, 3000);
  assert.equal(s.state.namesError, true);
  assert.equal(s.state.namesLoading, false);
  assert.ok(s.state.attempts.slice(4).every((row) => row.materialStatus === 'error'));
});

test('401 из параллельных metadata отменяет все сигналы и вызывает общий обработчик один раз', async () => {
  const pending = Array.from({ length: 4 }, deferred);
  const rows = pending.map((_, index) => info(index + 1, { materialId: uuid(30 + index) }));
  const s = setup({ rows, materials: pending.map((value) => value.promise) });
  const reading = s.controller.refresh();
  await tick();
  pending[0].reject(failure('AUTHENTICATION_REQUIRED', 401));
  await tick();
  assert.equal(s.access.length, 1);
  assert.ok(s.materialCalls.every((call) => call.signal.aborted));
  pending.slice(1).forEach((value) => value.reject(failure('AUTHENTICATION_REQUIRED', 401)));
  await reading;
  assert.equal(s.access.length, 1);
  assert.deepEqual(s.state.attempts, []);
  assert.equal(s.state.detail, null);
});

test('Auth из list/detail/material detail скрывает приватные данные и не продолжает цепочку', async () => {
  for (const stage of ['list', 'detail', 'material']) {
    const error = failure('AUTHENTICATION_REQUIRED', 401);
    const s = setup({ rows: [info()], lists: stage === 'list' ? [error] : [], details: stage === 'detail' ? [error] : [], materials: stage === 'material' ? [material(), error] : [] });
    await s.controller.refresh();
    if (stage !== 'list') await s.controller.openAttempt(info().id);
    assert.deepEqual(s.access, [error]);
    assert.equal(s.state.detail, null);
    assert.deepEqual(s.state.attempts, []);
  }
});

test('Late list/detail/title после scope/record смены не меняет приватную запись или callbacks', async () => {
  for (const stage of ['list', 'detail', 'title']) {
    for (const mode of ['deny', 'replace']) {
      const pending = deferred();
      const s = setup({ rows: [info()], lists: stage === 'list' ? [pending.promise] : [], details: stage === 'detail' ? [pending.promise] : [], materials: stage === 'title' ? [pending.promise] : [] });
      let running;
      if (stage === 'detail') { await s.controller.refresh(); running = s.controller.openAttempt(info().id); }
      else running = s.controller.refresh();
      await tick();
      const draft = s.record.attemptHistory;
      const before = { ...draft, view: { ...draft.view } };
      const count = s.states.length;
      if (mode === 'deny') s.deny();
      else s.record.attemptHistory = null;
      pending.reject(failure('AUTHENTICATION_REQUIRED', 401));
      await running;
      assert.deepEqual(draft, before);
      assert.equal(s.states.length, count);
      assert.equal(s.access.length, 0);
      s.controller.stop();
    }
  }
});

test('Snapshot не раскрывает APIextras и изолирует вложенный разбор/вопросы', async () => {
  const value = detail(completedInfo());
  value.questions[0].correctOptionId = OTHER;
  value.questions[0].options[0].isCorrect = true;
  const s = setup({ rows: [{ ...completedInfo(), answers: ['secret'] }], details: [value] });
  await s.controller.refresh();
  await s.controller.openAttempt(info().id);
  const state = s.state;
  assert.equal(Object.hasOwn(state.attempts[0], 'answers'), false);
  assert.equal(Object.hasOwn(state.detail.quiz.questions[0], 'correctOptionId'), false);
  assert.equal(Object.hasOwn(state.detail.attempt.questions[0].options[0], 'isCorrect'), false);
  state.detail.attempt.review[0].sourcePages.push(99);
  state.detail.quiz.questions[0].text = 'Подмена';
  state.filters.status = 'completed';
  assert.deepEqual(s.state.detail.attempt.review[0].sourcePages, [1, 3]);
  assert.notEqual(s.state.detail.quiz.questions[0].text, 'Подмена');
  assert.deepEqual(s.state.filters, {});
});

test('onAccessRestored может синхронно отменить scope без публикации fresh private data', async () => {
  let s;
  s = setup({ rows: [info()], onAccessRestored: () => s.deny() });
  await s.controller.refresh();
  assert.deepEqual(s.state.attempts, []);
  assert.equal(s.materialCalls.length, 0);
});
