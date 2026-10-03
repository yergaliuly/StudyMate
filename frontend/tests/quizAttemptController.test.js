import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/services/apiClient.js';
import { createQuizAttemptController, getQuizAttemptState } from '../src/services/quizAttemptController.js';

const uuid = (number) => number.toString(16).padStart(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MATERIAL = uuid(1);
const SUBJECT = uuid(2);
const QUIZ = uuid(3);
const ATTEMPT = uuid(4);
const NEXT_ATTEMPT = uuid(5);
const KEY = uuid(6);
const OTHER = uuid(7);
const KEY2 = uuid(8);
const questions = () => Array.from({ length: 10 }, (_, index) => ({
  id: uuid(100 + index), position: index + 1, text: 'Вопрос ' + (index + 1),
  options: Array.from({ length: 4 }, (_, option) => ({
    id: uuid(1000 + index * 4 + option), position: option + 1, text: 'Ответ ' + (option + 1),
  })),
}));
const quiz = () => ({ id: QUIZ, materialId: MATERIAL, version: 2, questionCount: 10, questions: questions() });
const blank = () => questions().map(({ id }) => ({ questionId: id, optionId: null }));
const answer = (index = 0, option = 0) => ({ questionId: questions()[index].id, optionId: questions()[index].options[option].id });
const material = (changes = {}) => ({ id: MATERIAL, subjectId: SUBJECT, status: 'stored', processingStatus: 'ready', ...changes });
const attempt = (changes = {}) => ({
  id: ATTEMPT, quizId: QUIZ, materialId: MATERIAL, quizVersion: 2, status: 'in_progress',
  questionCount: 10, startedAt: '2026-10-03T00:00:00Z', completedAt: null,
  correctCount: null, scorePercent: null, questions: questions(), review: null, ...changes,
});
function completed(answers = blank(), changes = {}) {
  const review = questions().map((question) => {
    const selectedOptionId = answers.find((item) => item.questionId.toLowerCase() === question.id.toLowerCase())?.optionId ?? null;
    const correctOptionId = question.options[0].id;
    return {
      questionId: question.id, selectedOptionId, correctOptionId,
      isCorrect: selectedOptionId?.toLowerCase() === correctOptionId.toLowerCase(),
      explanation: 'Объяснение <script>остаётся текстом</script>', sourcePages: [1, 3],
    };
  });
  const correctCount = review.filter((item) => item.isCorrect).length;
  return attempt({ status: 'completed', completedAt: '2026-10-03T00:01:00Z', correctCount, scorePercent: correctCount * 10, review, ...changes });
}
const failure = (code, status = 0, extra = {}) => new ApiError('Сырые сведения сервера', { code, status, ...extra });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function setup({ record = {}, materialReads = [], starts = [], submissions = [], reads = [], keys = [KEY], onChange, quizValue = quiz() } = {}) {
  let allowed = true;
  let timestamp = 1000;
  let keyCount = 0;
  const calls = [];
  const states = [];
  const access = [];
  async function respond(queue, fallback) {
    const response = queue.length ? queue.shift() : fallback;
    if (response instanceof Error) throw response;
    return await response;
  }
  const controller = createQuizAttemptController({
    record, quiz: quizValue, materialId: MATERIAL, subjectId: SUBJECT,
    canAct: () => allowed, now: () => timestamp,
    makeKey: () => { keyCount += 1; return keys.shift(); },
    onChange: (state) => { states.push(state); onChange?.(state); },
    onAccessError: (error) => access.push(error),
    materials: { async getById(id, options) { calls.push({ kind: 'material', id, ...options }); return await respond(materialReads, material()); } },
    api: {
      async start(id, options) { calls.push({ kind: 'start', id, ...options }); return await respond(starts, attempt()); },
      async submit(id, answers, options) {
        calls.push({ kind: 'submit', id, answers, ...options });
        return await respond(submissions, completed(answers, { id }));
      },
      async getById(id, options) { calls.push({ kind: 'read', id, ...options }); return await respond(reads, attempt({ id })); },
    },
  });
  return {
    controller, record, calls, states, access,
    get state() { return getQuizAttemptState(record, QUIZ); },
    get starts() { return calls.filter((call) => call.kind === 'start'); },
    get submissions() { return calls.filter((call) => call.kind === 'submit'); },
    get reads() { return calls.filter((call) => call.kind === 'read'); },
    get keyCount() { return keyCount; },
    deny() { allowed = false; }, setNow(value) { timestamp = value; },
  };
}

test('Idle refresh публикует инициализированный выбор без HTTP; start проверяет материал и начинает только явно', async () => {
  const record = {};
  const beforeFactory = getQuizAttemptState(record, QUIZ);
  assert.deepEqual(beforeFactory.answers, []);
  const s = setup({ record });
  assert.equal(s.calls.length, 0);
  await s.controller.refresh();
  assert.equal(s.calls.length, 0);
  assert.equal(s.states.at(-1).canStart, true);
  assert.deepEqual(s.states.at(-1).answers, blank());
  await s.controller.start();
  assert.deepEqual(s.calls.map((call) => call.kind), ['material', 'start']);
  assert.equal(s.starts[0].id, QUIZ);
  assert.equal(s.starts[0].idempotencyKey, KEY);
  assert.deepEqual(Object.keys(s.starts[0]).sort(), ['id', 'idempotencyKey', 'kind', 'signal']);
  assert.equal(s.state.attemptId, ATTEMPT);
  assert.equal(s.state.phase, 'in_progress');
  assert.equal(s.state.canStart, false);
  assert.equal(s.state.canChoose, true);
  assert.equal(s.state.attempt.review, null);
});

test('Сохранённый quiz доступен без готового extracted text; чужой/удаляемый материал блокирует start', async () => {
  for (const processingStatus of ['not_started', 'queued', 'running', 'failed', 'ready']) {
    const s = setup({ materialReads: [material({ processingStatus })] });
    await s.controller.start();
    assert.equal(s.starts.length, 1, processingStatus);
  }
  for (const changes of [{ id: OTHER }, { subjectId: OTHER }, { status: 'deleting' }, { status: 'uploading' }]) {
    const s = setup({ materialReads: [material(changes)] });
    await s.controller.start();
    assert.equal(s.starts.length, 0);
    assert.equal(s.keyCount, 0);
    assert.equal(s.state.attempt, null);
  }
});

test('Двойной start блокируется синхронно во время preflight и отправленного POST', async () => {
  const preflight = deferred();
  const post = deferred();
  const s = setup({ materialReads: [preflight.promise], starts: [post.promise] });
  const starting = s.controller.start();
  await s.controller.start();
  await s.controller.refresh();
  assert.equal(s.calls.length, 1);
  preflight.resolve(material());
  await tick();
  await s.controller.start();
  assert.equal(s.starts.length, 1);
  post.resolve(attempt());
  await starting;
  assert.equal(s.keyCount, 1);
});

test('Start сверяет принадлежность и неизменяемые вопросы, варианты и version', async () => {
  const changedQuestion = questions();
  changedQuestion[0].text = 'Подмена вопроса';
  const changedOption = questions();
  changedOption[0].options[0].text = 'Подмена варианта';
  for (const changes of [{ quizId: OTHER }, { materialId: OTHER }, { quizVersion: 3 }, { questions: changedQuestion }, { questions: changedOption }, { status: 'ready' }]) {
    const s = setup({ starts: [attempt(changes)] });
    await s.controller.start();
    assert.equal(s.state.attempt, null);
    assert.equal(s.state.startUncertain, true);
    assert.equal(s.state.canStart, false);
    assert.equal(s.state.canRetryStart, true);
  }
});

test('Неизвестный start сохраняет прежний ключ; reopen/refresh не создаёт новую попытку', async () => {
  for (const error of [failure('NETWORK_ERROR'), failure('INTERNAL_ERROR', 500), failure('INVALID_RESPONSE', 201), failure('REQUEST_CANCELLED')]) {
    const record = {};
    const first = setup({ record, starts: [error] });
    await first.controller.start();
    assert.equal(first.state.startUncertain, true);
    first.controller.stop();
    const beforeFactory = getQuizAttemptState(record, QUIZ);
    assert.equal(beforeFactory.canRetryStart, false);
    const restored = setup({ record });
    await restored.controller.refresh();
    assert.equal(restored.calls.length, 0);
    assert.equal(restored.states.at(-1).canRetryStart, true);
    await restored.controller.start();
    assert.equal(restored.starts[0].idempotencyKey, KEY);
    assert.equal(restored.keyCount, 0);
    assert.equal(restored.state.startUncertain, false);
  }
});

test('Start replay может вернуть completed; следующий явный проход получает новый ключ', async () => {
  const s = setup({ starts: [completed(), attempt({ id: NEXT_ATTEMPT })], keys: [KEY, KEY2] });
  await s.controller.start();
  assert.equal(s.state.phase, 'completed');
  assert.equal(s.state.attempt.scorePercent, 0);
  assert.equal(s.state.canChoose, false);
  assert.equal(s.state.canStart, true);
  await s.controller.start();
  assert.equal(s.starts[1].idempotencyKey, KEY2);
  assert.equal(s.state.attemptId, NEXT_ATTEMPT);
  assert.deepEqual(s.state.answers, blank());
  assert.equal(s.state.attempt.review, null);
});

test('Выбор принимает только варианты своего вопроса и явный пропуск; start in_progress не дублируется', async () => {
  const s = setup();
  s.controller.choose(answer().questionId, answer().optionId);
  assert.deepEqual(s.state.answers, blank());
  await s.controller.start();
  s.controller.choose(answer().questionId.toUpperCase(), answer().optionId.toUpperCase());
  assert.deepEqual(s.state.answers[0], answer());
  for (const [questionId, optionId] of [[OTHER, answer().optionId], [answer().questionId, answer(1).optionId], [answer().questionId, undefined]]) {
    s.controller.choose(questionId, optionId);
    assert.deepEqual(s.state.answers[0], answer());
  }
  s.controller.choose(answer().questionId, null);
  assert.equal(s.state.answers[0].optionId, null);
  await s.controller.start();
  assert.equal(s.starts.length, 1);
  assert.equal(s.submissions.length, 0);
});

test('Submit отправляет ровно снимок 10 ответов без ключа/баллов; нулевой результат допустим', async () => {
  for (const chooseFirst of [false, true]) {
    const s = setup();
    await s.controller.start();
    if (chooseFirst) s.controller.choose(answer().questionId, answer().optionId);
    const confirmation = s.state.answers;
    await s.controller.submit(confirmation);
    assert.equal(s.submissions.length, 1);
    assert.deepEqual(s.submissions[0].answers, confirmation);
    assert.deepEqual(Object.keys(s.submissions[0]).sort(), ['answers', 'id', 'kind', 'signal']);
    assert.equal(s.state.phase, 'completed');
    assert.equal(s.state.attempt.scorePercent, chooseFirst ? 10 : 0);
    assert.equal(s.state.frozen, false);
    await s.controller.submit();
    assert.equal(s.submissions.length, 1);
  }
});

test('Изменённое подтверждение и невалидный snapshot не отправляются; эквивалентные пропуски разрешены', async () => {
  const s = setup();
  await s.controller.start();
  const old = s.state.answers;
  s.controller.choose(answer().questionId, answer().optionId);
  for (const confirmation of [old, [{ questionId: OTHER, optionId: null }], [answer(), { ...answer(), questionId: answer().questionId.toUpperCase() }], [{ ...answer(), optionId: answer(1).optionId }]]) {
    await s.controller.submit(confirmation);
    assert.equal(s.submissions.length, 0);
    assert.equal(s.state.frozen, false);
  }
  await s.controller.submit([{ questionId: answer().questionId.toUpperCase(), optionId: answer().optionId.toUpperCase() }]);
  assert.equal(s.submissions.length, 1);
});

test('Submit блокирует выбор и двойную отправку до ответа', async () => {
  const pending = deferred();
  const s = setup({ submissions: [pending.promise] });
  await s.controller.start();
  s.controller.choose(answer().questionId, answer().optionId);
  const submitting = s.controller.submit();
  s.controller.choose(answer().questionId, answer(0, 1).optionId);
  await s.controller.submit();
  await s.controller.start();
  await s.controller.refresh();
  assert.equal(s.submissions.length, 1);
  assert.deepEqual(s.state.answers[0], answer());
  pending.resolve(completed(s.state.answers));
  await submitting;
  assert.equal(s.state.phase, 'completed');
});

test('Unknown submit замораживает снимок; GET in_progress сохраняет freeze, явный retry отправляет те же ответы', async () => {
  for (const error of [failure('NETWORK_ERROR'), failure('INTERNAL_ERROR', 503), failure('INVALID_RESPONSE', 200), failure('REQUEST_CANCELLED')]) {
    const s = setup({ submissions: [error] });
    await s.controller.start();
    s.controller.choose(answer().questionId, answer().optionId);
    await s.controller.submit();
    assert.equal(s.state.submitUncertain, true);
    assert.equal(s.state.canChoose, false);
    assert.equal(s.state.canRetrySubmit, true);
    s.controller.choose(answer().questionId, answer(0, 1).optionId);
    await s.controller.refresh();
    assert.equal(s.submissions.length, 1);
    assert.equal(s.state.frozen, true);
    assert.equal(s.state.canRetrySubmit, true);
    await s.controller.submit();
    assert.deepEqual(s.submissions[1].answers, s.submissions[0].answers);
    assert.equal(s.state.submitUncertain, false);
  }
});

test('Completed POST с другими selected answers считается неизвестным; GET принимает сохранённый серверный результат', async () => {
  const s = setup({ submissions: [completed()], reads: [completed()] });
  await s.controller.start();
  s.controller.choose(answer().questionId, answer().optionId);
  await s.controller.submit();
  assert.equal(s.state.submitUncertain, true);
  assert.equal(s.state.frozen, true);
  assert.equal(s.state.attempt.status, 'in_progress');
  await s.controller.refresh();
  assert.equal(s.state.phase, 'completed');
  assert.equal(s.state.frozen, false);
  assert.equal(s.state.submitUncertain, false);
  assert.equal(s.state.answers[0].optionId, null);
});

test('409 ATTEMPT_ALREADY_SUBMITTED делает отдельный GET результата, никогда повторный submit', async () => {
  const s = setup({ submissions: [failure('ATTEMPT_ALREADY_SUBMITTED', 409)], reads: [completed()] });
  await s.controller.start();
  s.controller.choose(answer().questionId, answer().optionId);
  await s.controller.submit();
  assert.deepEqual(s.calls.map((call) => call.kind), ['material', 'start', 'submit', 'read']);
  assert.notEqual(s.submissions[0].signal, s.reads[0].signal);
  assert.equal(s.reads[0].signal.aborted, false);
  assert.equal(s.state.phase, 'completed');
  assert.equal(s.state.answers[0].optionId, null);
});

test('GETerror после 409 сохраняет freeze и прячет DTO, восстановление требует только явный GET', async () => {
  const s = setup({ submissions: [failure('ATTEMPT_ALREADY_SUBMITTED', 409)], reads: [failure('NETWORK_ERROR'), completed()] });
  await s.controller.start();
  await s.controller.submit();
  assert.equal(s.state.attempt, null);
  assert.equal(s.state.frozen, true);
  assert.equal(s.state.canRetrySubmit, false);
  assert.equal(s.state.canRefresh, true);
  await s.controller.submit();
  assert.equal(s.submissions.length, 1);
  await s.controller.refresh();
  assert.equal(s.state.phase, 'completed');
});

test('Definite422 сохраняет выбор, снимает freeze и разрешает исправление без сырых сообщений', async () => {
  const s = setup({ submissions: [failure('VALIDATION_FAILED', 422, { fieldErrors: { answers: 'Сырые сведения' } })] });
  await s.controller.start();
  s.controller.choose(answer().questionId, answer().optionId);
  await s.controller.submit();
  assert.equal(s.state.frozen, false);
  assert.equal(s.state.canChoose, true);
  assert.deepEqual(s.state.answers[0], answer());
  assert.doesNotMatch(s.state.message, /Сырые/);
  s.controller.choose(answer().questionId, answer(0, 1).optionId);
  await s.controller.submit();
  assert.equal(s.state.attempt.review[0].selectedOptionId, answer(0, 1).optionId);
});

test('422 после неизвестной отправки не отменяет неопределённость первой попытки и не размораживает ответы', async () => {
  const s = setup({ submissions: [failure('NETWORK_ERROR'), failure('VALIDATION_FAILED', 422)] });
  await s.controller.start();
  s.controller.choose(answer().questionId, answer().optionId);
  await s.controller.submit();
  await s.controller.submit();
  assert.equal(s.state.submitUncertain, true);
  assert.equal(s.state.frozen, true);
  assert.equal(s.state.canChoose, false);
  assert.deepEqual(s.submissions[1].answers, s.submissions[0].answers);
  await s.controller.refresh();
  assert.equal(s.state.attempt.status, 'in_progress');
  assert.equal(s.state.frozen, true);
  assert.equal(s.state.canChoose, false);
  s.controller.choose(answer().questionId, answer(0, 1).optionId);
  assert.deepEqual(s.state.answers[0], answer());
});

test('Retry-After сохраняется через close: mount публикует флаги без HTTP, таймер ничего не отправляет', async () => {
  const record = {};
  const first = setup({ record, submissions: [failure('RATE_LIMITED', 429, { retryAfterSeconds: 2 })] });
  await first.controller.start();
  await first.controller.submit();
  assert.equal(first.state.retryAt, 3000);
  first.controller.stop();
  const restored = setup({ record });
  restored.setNow(2999);
  await restored.controller.refresh();
  assert.equal(restored.calls.length, 0);
  assert.equal(restored.states.at(-1).canRefresh, true);
  assert.equal(restored.states.at(-1).attempt, null);
  await restored.controller.submit();
  restored.setNow(3000);
  assert.equal(restored.calls.length, 0);
  await restored.controller.refresh();
  assert.equal(restored.state.frozen, true);
  await restored.controller.submit();
  assert.deepEqual(restored.submissions[0].answers, first.submissions[0].answers);
});

test('Начальная 429 и key collision сохраняют ключ, не позволяют автоматическую ротацию', async () => {
  const s = setup({ starts: [failure('RATE_LIMITED', 429, { retryAfterSeconds: 2 })] });
  await s.controller.start();
  await s.controller.start();
  assert.equal(s.starts.length, 1);
  s.setNow(3000);
  await s.controller.start();
  assert.equal(s.starts[1].idempotencyKey, KEY);
  assert.equal(s.keyCount, 1);
  const collision = setup({ starts: [failure('IDEMPOTENCY_KEY_REUSED', 409)], keys: [KEY, KEY2] });
  await collision.controller.start();
  await collision.controller.refresh();
  await collision.controller.start();
  assert.equal(collision.starts.length, 1);
  assert.equal(collision.keyCount, 1);
  assert.equal(collision.state.canStart, false);
  assert.equal(collision.state.canRetryStart, false);
});

test('401/CSRF очищает приватный DTO и вызывает global handler без автоматического POST после восстановления', async () => {
  for (const stage of ['material', 'start', 'submit', 'read']) {
    const record = {};
    const error = failure(stage === 'submit' ? 'CSRF_INVALID' : 'AUTHENTICATION_REQUIRED', stage === 'submit' ? 403 : 401);
    const first = setup({
      record, materialReads: stage === 'material' ? [error] : [], starts: stage === 'start' ? [error] : [],
      submissions: stage === 'submit' ? [error] : [], reads: stage === 'read' ? [error] : [],
    });
    await first.controller.start();
    if (stage === 'submit') { first.controller.choose(answer().questionId, answer().optionId); await first.controller.submit(); }
    if (stage === 'read') await first.controller.refresh();
    assert.deepEqual(first.access, [error]);
    assert.equal(first.state.attempt, null);
    const restored = setup({ record });
    await restored.controller.refresh();
    assert.equal(restored.starts.length, 0);
    assert.equal(restored.submissions.length, 0);
    if (stage === 'start') {
      await restored.controller.start();
      assert.equal(restored.starts[0].idempotencyKey, KEY);
      assert.equal(restored.keyCount, 0);
    }
    if (stage === 'submit') {
      assert.equal(restored.state.frozen, true);
      assert.deepEqual(restored.state.answers[0], answer());
      await restored.controller.submit();
      assert.deepEqual(restored.submissions[0].answers, first.submissions[0].answers);
    }
  }
});

test('Stop отправленного start/submit сохраняет неопределённость и подавляет поздний ответ после reopen', async () => {
  for (const stage of ['start', 'submit']) {
    const pending = deferred();
    const record = {};
    const first = setup({ record, starts: stage === 'start' ? [pending.promise] : [], submissions: stage === 'submit' ? [pending.promise] : [] });
    let running;
    if (stage === 'start') running = first.controller.start();
    else { await first.controller.start(); running = first.controller.submit(); }
    await tick();
    first.deny();
    first.controller.stop();
    assert.equal(first.state[stage === 'start' ? 'startUncertain' : 'submitUncertain'], true);
    assert.equal(first.calls.at(-1).signal.aborted, true);
    const restored = setup({ record });
    await restored.controller.refresh();
    const state = restored.state;
    pending.resolve(stage === 'start' ? attempt() : completed());
    await running;
    assert.deepEqual(restored.state, state);
    assert.equal(restored.starts.length, 0);
    assert.equal(restored.submissions.length, 0);
  }
});

test('Stop во время preflight не создаёт key/uncertain; восстановленный start остаётся явным', async () => {
  const pending = deferred();
  const record = {};
  const first = setup({ record, materialReads: [pending.promise] });
  const starting = first.controller.start();
  first.controller.stop();
  pending.resolve(material());
  await starting;
  assert.equal(first.keyCount, 0);
  assert.equal(first.state.startUncertain, false);
  const restored = setup({ record });
  await restored.controller.refresh();
  assert.equal(restored.state.canStart, true);
  assert.equal(restored.calls.length, 0);
});

test('Неуспешный GET скрывает даже ранее показанный review, до успешной проверки новый проход невозможен', async () => {
  const pending = deferred();
  const s = setup({ starts: [completed()], reads: [pending.promise, completed()] });
  await s.controller.start();
  const reading = s.controller.refresh();
  assert.equal(s.state.attempt, null);
  assert.equal(s.state.canStart, false);
  pending.reject(failure('NETWORK_ERROR'));
  await reading;
  assert.equal(s.state.attempt, null);
  assert.equal(s.state.canStart, false);
  assert.equal(s.state.canRefresh, true);
  await s.controller.start();
  assert.equal(s.starts.length, 1);
  await s.controller.refresh();
  assert.equal(s.state.attempt.review.length, 10);
  assert.equal(s.state.canStart, true);
});

test('Подтверждённый completed не регрессирует в in_progress и не меняет итог после reopen', async () => {
  for (const response of [attempt(), completed([answer()]), completed(blank(), { completedAt: '2026-10-03T00:02:00Z' })]) {
    const record = {};
    const first = setup({ record, starts: [completed()] });
    await first.controller.start();
    first.controller.stop();
    const restored = setup({ record, reads: [response, completed()] });
    await restored.controller.refresh();
    assert.equal(restored.state.attempt, null);
    assert.equal(restored.state.canChoose, false);
    assert.equal(restored.state.canStart, false);
    assert.equal(restored.state.canRefresh, true);
    await restored.controller.refresh();
    assert.equal(restored.state.phase, 'completed');
    assert.equal(restored.state.attempt.scorePercent, 0);
  }
});

test('404 и удаляемый материал скрывают DTO и блокируют mutations на start/submit/read', async () => {
  for (const stage of ['start', 'submit', 'read']) {
    for (const error of [failure(stage === 'start' ? 'QUIZ_NOT_FOUND' : 'ATTEMPT_NOT_FOUND', 404), failure('MATERIAL_NOT_AVAILABLE', 409)]) {
      const s = setup({ starts: stage === 'start' ? [error] : [], submissions: stage === 'submit' ? [error] : [], reads: stage === 'read' ? [error] : [] });
      await s.controller.start();
      if (stage === 'submit') await s.controller.submit();
      if (stage === 'read') await s.controller.refresh();
      assert.equal(s.state.phase, 'unavailable');
      assert.equal(s.state.attempt, null);
      assert.equal(s.state.canChoose, false);
      assert.equal(s.state.canStart, false);
      assert.equal(s.state.canRetryStart, false);
      assert.equal(s.state.canRetrySubmit, false);
    }
  }
});

test('Чужой ID/version или подмена вопросов в GET не раскрывает чужой review', async () => {
  for (const changes of [{ id: OTHER }, { quizId: OTHER }, { materialId: OTHER }, { quizVersion: 3 }, { questions: questions().reverse() }]) {
    const s = setup({ reads: [completed(blank(), changes)] });
    await s.controller.start();
    await s.controller.refresh();
    assert.equal(s.state.attempt, null);
    assert.equal(s.state.canSubmit, false);
  }
});

test('Поздние HTTP success/error после scope/record смены не меняют запись и не вызывают callbacks', async () => {
  for (const stage of ['material', 'start', 'submit', 'read']) {
    for (const mode of ['deny', 'replace']) {
      for (const outcome of ['success', 'error']) {
        const pending = deferred();
        const s = setup({ materialReads: stage === 'material' ? [pending.promise] : [], starts: stage === 'start' ? [pending.promise] : [], submissions: stage === 'submit' ? [pending.promise] : [], reads: stage === 'read' ? [pending.promise] : [] });
        let running;
        if (stage === 'material' || stage === 'start') running = s.controller.start();
        else { await s.controller.start(); running = stage === 'submit' ? s.controller.submit() : s.controller.refresh(); }
        await tick();
        const draft = s.record.quizAttempts[QUIZ];
        const before = { ...draft, startAttempt: draft.startAttempt ? { ...draft.startAttempt } : null, view: { ...draft.view } };
        const count = s.states.length;
        if (mode === 'deny') s.deny();
        else s.record.quizAttempts = {};
        if (outcome === 'error') pending.reject(failure('AUTHENTICATION_REQUIRED', 401));
        else pending.resolve(stage === 'material' ? material() : stage === 'submit' ? completed() : attempt());
        await running;
        assert.deepEqual(draft, before, `${stage}/${mode}/${outcome}`);
        assert.equal(s.states.length, count);
        assert.equal(s.access.length, 0);
        s.controller.stop();
      }
    }
  }
});

test('Snapshot изолирует questions/review/answers и не публикует start key или frozen request', async () => {
  const value = completed();
  value.questions[0].correctOptionId = OTHER;
  value.questions[0].options[0].isCorrect = true;
  const s = setup({ starts: [value] });
  await s.controller.start();
  const state = s.state;
  assert.equal(Object.hasOwn(state.attempt.questions[0], 'correctOptionId'), false);
  assert.equal(Object.hasOwn(state.attempt.questions[0].options[0], 'isCorrect'), false);
  state.attempt.questions[0].text = 'Подмена';
  state.attempt.review[0].sourcePages.push(99);
  state.answers[0].optionId = OTHER;
  assert.notEqual(s.state.attempt.questions[0].text, 'Подмена');
  assert.deepEqual(s.state.attempt.review[0].sourcePages, [1, 3]);
  assert.equal(s.state.answers[0].optionId, null);
  for (const key of ['startAttempt', 'usedKeys', 'frozenAnswers', 'operation']) assert.equal(Object.hasOwn(state, key), false);
});

test('Синхронное закрытие из callback confirmed success не превращает результат в unknown', async () => {
  let controller;
  const s = setup({ onChange: (state) => { if (state.phase === 'completed') controller.stop(); } });
  controller = s.controller;
  await s.controller.start();
  await s.controller.submit();
  assert.equal(s.state.submitUncertain, false);
  assert.equal(s.state.frozen, false);
  assert.equal(s.state.attemptId, ATTEMPT);
  assert.equal(s.state.attempt, null);
});
