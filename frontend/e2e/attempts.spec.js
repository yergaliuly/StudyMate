import { test, expect } from '@playwright/test';

// Изолированные HTTP-mocks. Реальные backend, R2, ИИ и история попыток не вызываются.
const MIB = 1024 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const USER = { id: '1164903f-7ba3-40d8-8c79-b9009361b950', email: 'attempts@example.com', displayName: 'Студент Тестов' };
const OTHER_USER = { id: '3264903f-7ba3-40d8-8c79-b9009361b951', email: 'other-attempts@example.com', displayName: 'Другой Студент' };
const SUBJECT = {
  id: 'c6f924b2-b4b0-4926-8d28-a7409a3f2710', title: 'Математический анализ',
  description: 'Описание предмета с сервера', icon: 'book', tone: 'blue',
  lectureCount: 1, progressPercent: null, version: 1, createdAt: '2026-09-28T12:00:00Z',
};
const OTHER_SUBJECT = { ...SUBJECT, id: 'd6f924b2-b4b0-4926-8d28-a7409a3f2711', title: 'Общая физика' };
const MATERIAL_ID = 'f73de5ee-311e-45cb-b7e2-000000000001';
const JOB_ID = 'b6fc0911-af70-4cbb-8a9b-000000000001';
const quizId = (number = 1) => 'e918f662-eebb-4211-86b2-' + String(number).padStart(12, '0');
const attemptId = (number = 1) => '78a17ba9-2619-47e6-a98c-' + String(number).padStart(12, '0');
const states = new WeakMap();
const QUESTIONS = [
  ['Чему равна производная функции f(x) = x²?', ['2x', 'x', 'x³', '2']],
  ['Как называется предел отношения приращения функции к приращению аргумента?', ['Производная', 'Интеграл', 'Медиана', 'Дисперсия']],
  ['Чему равна производная постоянной функции?', ['0', '1', 'x', 'Постоянной']],
  ['Как геометрически интерпретируется определённый интеграл положительной функции?', ['Площадь под графиком', 'Угол наклона касательной', 'Длина оси', 'Число точек графика']],
  ['Чему равна производная функции sin(x)?', ['cos(x)', '−sin(x)', 'tan(x)', '1']],
  ['Какое условие необходимо для локального экстремума дифференцируемой функции внутри интервала?', ['Производная равна нулю', 'Функция равна нулю', 'Производная положительна', 'Производная равна единице']],
  ['Чему равна производная функции eˣ?', ['eˣ', 'x · eˣ', 'ln(x)', '1 / x']],
  ['Какой символ обозначает неопределённый интеграл?', ['∫', 'Σ', 'Δ', '∞']],
  ['Чему равна производная функции ln(x) при x > 0?', ['1 / x', 'ln(x) / x', 'x', 'eˣ']],
  ['Что выражает формула Ньютона — Лейбница?', ['Связь определённого интеграла с первообразной', 'Правило умножения матриц', 'Закон распределения вероятности', 'Условие сходимости ряда']],
];

function material() {
  return {
    id: MATERIAL_ID, subjectId: SUBJECT.id, title: 'Основы математического анализа',
    fileName: 'calculus.pdf', contentType: 'application/pdf', sizeBytes: MIB,
    status: 'stored', processingStatus: 'ready', version: 1,
    createdAt: '2026-09-28T12:00:00Z', updatedAt: '2026-09-28T12:00:00Z',
    deletionJobId: null, processingJobId: '84971941-cc75-4e13-9e67-000000000001',
    pageCount: 5, textCharacters: 1200, processingError: null,
  };
}
function quiz(version = 1) {
  return {
    id: quizId(version), materialId: MATERIAL_ID, version, questionCount: 10,
    model: 'fake-local', createdAt: '2026-10-03T12:00:00Z',
    questions: QUESTIONS.map(([text, options], index) => ({
      id: 'c113aa11-b122-4911-8680-' + String(version * 100 + index + 1).padStart(12, '0'),
      position: index + 1, text,
      options: options.map((value, option) => ({
        id: 'd114aa11-b122-4911-8680-' + String(version * 1000 + index * 10 + option + 1).padStart(12, '0'),
        position: option + 1, text: value,
      })),
    })),
  };
}
function attempt(source = quiz(), id = attemptId()) {
  return {
    id, quizId: source.id, materialId: source.materialId, quizVersion: source.version,
    status: 'in_progress', questionCount: 10, startedAt: '2026-10-03T12:10:00Z',
    completedAt: null, correctCount: null, scorePercent: null,
    questions: structuredClone(source.questions), review: null,
  };
}
function completed(value = attempt(), answers = []) {
  const review = value.questions.map((question) => {
    const selectedOptionId = answers.find((answer) => answer.questionId === question.id)?.optionId ?? null;
    const correctOptionId = question.options[0].id;
    return {
      questionId: question.id, selectedOptionId, correctOptionId,
      isCorrect: selectedOptionId === correctOptionId,
      explanation: 'Ответ следует из определения и примера в учебном материале.', sourcePages: [1, 3],
    };
  });
  const correctCount = review.filter((item) => item.isCorrect).length;
  return { ...value, status: 'completed', completedAt: '2026-10-03T12:15:00Z', correctCount, scorePercent: 10 * correctCount, review };
}
function answersFor(source, selections) {
  return Object.entries(selections).map(([question, option]) => ({
    questionId: source.questions[Number(question) - 1].id,
    optionId: option === null ? null : source.questions[Number(question) - 1].options[option - 1].id,
  }));
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const reply = (route, data, status = 200) => route.fulfill({ status, json: { data } });
function fail(route, status, code, headers = {}, fieldErrors = {}) {
  return route.fulfill({ status, headers, json: { error: { code, message: 'Сырые подробности сервера.', fieldErrors } } });
}
function listReply(route, data, extra = {}) {
  const params = new URL(route.request().url()).searchParams;
  return route.fulfill({ status: 200, json: { data, meta: {
    page: Number(params.get('page')), pageSize: Number(params.get('pageSize')), total: data.length, ...extra,
  } } });
}

function account(page) { return page.locator('#account-main-content'); }
function materials(page) { return page.getByRole('region', { name: 'Файлы предмета', exact: true }); }
function panel(page) { return page.getByRole('region', { name: 'Тесты материала', exact: true }); }
function detail(page) { return panel(page).getByRole('region', { name: 'Просмотр теста', exact: true }); }
function exercise(page) { return detail(page).getByRole('region', { name: 'Прохождение теста', exact: true }); }
function result(page) { return detail(page).getByRole('region', { name: 'Результат теста', exact: true }); }
function question(page, number) { return exercise(page).getByRole('group', { name: new RegExp('^Вопрос ' + number + '\\.') }); }
function confirmation(page) { return page.getByRole('dialog', { name: 'Отправить ответы?', exact: true }); }
function submitButton(page) { return exercise(page).getByRole('button', { name: 'Отправить ответы', exact: true }); }
function confirmButton(page) { return confirmation(page).getByRole('button', { name: 'Подтвердить отправку', exact: true }); }
function action(page, name) { return detail(page).getByRole('button', { name, exact: true }); }

async function mockAttempts(page, options = {}) {
  const state = {
    user: USER, loginUser: USER, subjects: [SUBJECT], files: [material()], quizzes: [quiz()],
    generation: { status: 'ready', jobId: JOB_ID, error: null },
    attempts: new Map(), keys: new Map(), nextAttempt: 1,
    starts: [], submits: [], attemptGets: [], quizGets: [], jobGets: [], writes: [],
    generationPosts: [], unexpected: [], pageErrors: [], csrfCount: 0,
    onStart: null, onSubmit: null, onAttempt: null, onQuiz: null, ...options,
  };
  states.set(page, state);
  page.on('pageerror', (error) => state.pageErrors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice('/api/v1'.length);
    const method = request.method();
    if (method !== 'GET') state.writes.push(method + ' ' + path);
    if (method === 'GET' && path === '/auth/csrf') {
      await reply(route, { headerName: 'X-CSRF-TOKEN', token: 'attempt-csrf-' + ++state.csrfCount });
    } else if (method === 'GET' && path === '/auth/me') {
      if (state.user) await reply(route, state.user);
      else await fail(route, 401, 'AUTHENTICATION_REQUIRED');
    } else if (method === 'POST' && path === '/auth/login') {
      state.user = state.loginUser;
      await reply(route, state.user);
    } else if (method === 'POST' && path === '/auth/logout') {
      state.user = null;
      await route.fulfill({ status: 204, body: '' });
    } else if (method === 'GET' && path === '/subjects') {
      await listReply(route, state.subjects);
    } else if (method === 'GET' && path.startsWith('/subjects/')) {
      const value = state.subjects.find((item) => item.id === path.split('/')[2]);
      if (value) await reply(route, value);
      else await fail(route, 404, 'SUBJECT_NOT_FOUND');
    } else if (method === 'GET' && path === '/storage/usage') {
      await reply(route, { usedBytes: MIB, reservedBytes: 0, limitBytes: 500 * MIB, maxUploadBytes: 25 * MIB });
    } else if (method === 'GET' && path === '/materials') {
      await listReply(route, state.files.filter((item) => item.subjectId === url.searchParams.get('subjectId')));
    } else if (method === 'GET' && /^\/materials\/[^/]+$/.test(path)) {
      const value = state.files.find((item) => item.id === path.split('/')[2]);
      if (value) await reply(route, value);
      else await fail(route, 404, 'MATERIAL_NOT_FOUND');
    } else if (method === 'GET' && /^\/materials\/[^/]+\/quizzes$/.test(path)) {
      await listReply(route, state.quizzes.slice().reverse().map(({ questions, ...value }) => value), { generation: state.generation });
    } else if (method === 'POST' && /^\/quizzes\/[^/]+\/attempts$/.test(path)) {
      const id = path.split('/')[2];
      const key = request.headers()['idempotency-key'];
      state.starts.push({ id, key, body: request.postData(), headers: request.headers() });
      if (state.onStart) await state.onStart(route, id, key);
      else {
        if (!state.keys.has(key)) {
          const value = attempt(state.quizzes.find((item) => item.id === id), attemptId(state.nextAttempt++));
          state.keys.set(key, value.id);
          state.attempts.set(value.id, value);
        }
        await reply(route, state.attempts.get(state.keys.get(key)), 201);
      }
    } else if (method === 'POST' && /^\/attempts\/[^/]+\/submit$/.test(path)) {
      const id = path.split('/')[2];
      const body = request.postDataJSON();
      state.submits.push({ id, body, headers: request.headers() });
      if (state.onSubmit) await state.onSubmit(route, id, body);
      else {
        const value = completed(state.attempts.get(id), body.answers);
        state.attempts.set(id, value);
        await reply(route, value);
      }
    } else if (method === 'GET' && /^\/attempts\/[^/]+$/.test(path)) {
      const id = path.split('/')[2];
      state.attemptGets.push(id);
      if (state.onAttempt) await state.onAttempt(route, id);
      else if (state.attempts.has(id)) await reply(route, state.attempts.get(id));
      else await fail(route, 404, 'ATTEMPT_NOT_FOUND');
    } else if (method === 'GET' && /^\/quizzes\/[^/]+$/.test(path)) {
      const id = path.split('/')[2];
      state.quizGets.push(id);
      if (state.onQuiz) await state.onQuiz(route, id);
      else await reply(route, state.quizzes.find((item) => item.id === id));
    } else if (method === 'GET' && path.startsWith('/jobs/')) {
      const id = path.split('/')[2];
      state.jobGets.push(id);
      await reply(route, {
        id, type: 'material.quiz', status: 'running', attemptCount: 1, maxAttempts: 1,
        createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:01Z',
        nextAttemptAt: null, finishedAt: null, resultId: null, error: null,
      });
    } else if (method === 'GET' && /^\/materials\/[^/]+\/summary$/.test(path)) {
      await fail(route, 404, 'SUMMARY_NOT_FOUND');
    } else if (method === 'GET' && /^\/materials\/[^/]+\/pages$/.test(path)) {
      await listReply(route, [{ pageNumber: 1, text: 'Первая страница' }, { pageNumber: 2, text: 'Вторая страница' }]);
    } else {
      if (method === 'POST' && /^\/materials\/[^/]+\/quizzes$/.test(path)) state.generationPosts.push(path);
      state.unexpected.push(method + ' ' + path);
      await fail(route, 500, 'UNEXPECTED_TEST_REQUEST');
    }
  });
  await page.goto('/');
  await expect(account(page).getByRole('heading', { name: SUBJECT.title, exact: true })).toBeVisible();
  return state;
}

test.afterEach(async ({ page }) => {
  const state = states.get(page);
  expect(state?.unexpected ?? [], 'Неожиданные API-запросы, включая историю').toEqual([]);
  expect(state?.pageErrors ?? [], 'Ошибки JavaScript').toEqual([]);
  expect(state?.generationPosts ?? [], 'Прохождение не вызывает ИИ').toEqual([]);
});
async function openMaterials(page, subject = SUBJECT) {
  await account(page).getByRole('button', { name: 'Открыть предмет «' + subject.title + '»', exact: true }).click();
  await page.getByRole('dialog', { name: 'Предмет', exact: true }).getByRole('button', { name: 'Материалы предмета', exact: true }).click();
  await expect(materials(page)).toBeVisible();
}
async function openQuizzes(page) {
  await materials(page).getByRole('button', { name: 'Открыть тесты «' + material().title + '»', exact: true }).click();
  await expect(panel(page)).toBeVisible();
}
async function openVersion(page, version = 1) {
  await panel(page).getByRole('button', { name: 'Просмотреть версию ' + version, exact: true }).click();
  await expect(detail(page)).toBeVisible();
}
async function openReady(page) {
  await openMaterials(page);
  await openQuizzes(page);
  await openVersion(page);
  await expect(action(page, 'Начать тест')).toBeEnabled();
}
async function start(page) {
  await action(page, 'Начать тест').click();
  await expect(question(page, 1)).toBeVisible();
}
async function choose(page, number, option = 1) { await question(page, number).getByRole('radio').nth(option - 1).check(); }
async function send(page) {
  await submitButton(page).click();
  await confirmButton(page).click();
}
async function login(page, user) {
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Пароль', { exact: true }).fill('Only-for-attempt-tests!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(account(page).getByText(user.email, { exact: true })).toBeVisible();
}
async function capture(page, testInfo, region, name) {
  await region.getByRole('heading').first().evaluate((heading) => {
    heading.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -100);
  });
  await page.screenshot({ path: testInfo.outputPath(name) });
}

test('Попытки: только явное начало, двойное нажатие создаёт одну попытку без ответов', async ({ page }) => {
  await page.clock.install();
  const gate = deferred();
  const state = await mockAttempts(page);
  state.onStart = async (route) => {
    await gate.promise;
    const value = attempt();
    state.attempts.set(value.id, value);
    await reply(route, value, 201);
  };
  await openReady(page);
  expect(state.starts).toHaveLength(0);
  expect(state.attemptGets).toHaveLength(0);
  try {
    await action(page, 'Начать тест').evaluate((button) => { button.click(); button.click(); });
    await expect.poll(() => state.starts.length).toBe(1);
  } finally { gate.resolve(); }
  await expect(question(page, 1)).toBeVisible();
  await expect(exercise(page).getByRole('group')).toHaveCount(10);
  await expect(exercise(page).getByRole('radio')).toHaveCount(40);
  await expect(exercise(page)).toContainText('Отвечено: 0 из 10');
  await expect(exercise(page)).not.toContainText(/Правильный ответ|Объяснение|Страницы PDF/);
  await expect(result(page)).toHaveCount(0);
  expect(state.starts[0].id).toBe(quizId());
  expect(state.starts[0].key).toMatch(UUID);
  expect(state.starts[0].body).toBeNull();
  expect(state.starts[0].headers['content-type']).toBeUndefined();
  expect(state.starts[0].headers['x-csrf-token']).toBeTruthy();
  await page.clock.runFor(60_000);
  expect(state.starts).toHaveLength(1);
  expect(state.submits).toHaveLength(0);
  expect(state.attemptGets).toHaveLength(0);
  expect(state.jobGets).toHaveLength(0);
});

test('Попытки: выбор, сброс, пропуски и подтверждение отправляют только ID; серверный разбор', async ({ page }, testInfo) => {
  const gate = deferred();
  const state = await mockAttempts(page);
  await openReady(page);
  await start(page);
  await choose(page, 1);
  await choose(page, 2, 2);
  await choose(page, 3, 3);
  await question(page, 3).getByRole('button', { name: 'Сбросить ответ', exact: true }).click();
  await expect(question(page, 3).getByRole('radio').nth(2)).not.toBeChecked();
  await expect(exercise(page)).toContainText('Отвечено: 2 из 10');
  await capture(page, testInfo, exercise(page), 'attempt-questions-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, testInfo, exercise(page), 'attempt-questions-mobile.png');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await submitButton(page).click();
  await expect(confirmation(page)).toContainText(/8/);
  await expect(confirmation(page).getByRole('button', { name: 'Вернуться к вопросам', exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('attempt-confirm-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: testInfo.outputPath('attempt-confirm-desktop.png') });
  await confirmation(page).getByRole('button', { name: 'Вернуться к вопросам', exact: true }).click();
  expect(state.submits).toHaveLength(0);
  await expect(question(page, 1).getByRole('radio').first()).toBeChecked();
  state.onSubmit = async (route, id, body) => {
    await gate.promise;
    const value = completed(state.attempts.get(id), body.answers);
    state.attempts.set(id, value);
    await reply(route, value);
  };
  await submitButton(page).click();
  try {
    await confirmButton(page).evaluate((button) => { button.click(); button.click(); });
    await expect.poll(() => state.submits.length).toBe(1);
    await expect(exercise(page).getByRole('radio').first()).toBeDisabled();
  } finally { gate.resolve(); }
  await expect(result(page)).toBeVisible();
  const sent = state.submits[0];
  expect(Object.keys(sent.body)).toEqual(['answers']);
  expect(sent.headers['idempotency-key']).toBeUndefined();
  expect(sent.headers['x-csrf-token']).toBeTruthy();
  expect(sent.headers['content-type']).toContain('application/json');
  for (const answer of sent.body.answers) {
    expect(Object.keys(answer).sort()).toEqual(['optionId', 'questionId']);
    expect(answer.questionId).toMatch(UUID);
    if (answer.optionId !== null) expect(answer.optionId).toMatch(UUID);
  }
  expect(sent.body.answers.filter((answer) => answer.optionId !== null)).toEqual(answersFor(quiz(), { 1: 1, 2: 2 }));
  await expect(result(page)).toContainText('10%');
  await expect(result(page)).toContainText(/Верно|Правильно/);
  await expect(result(page)).toContainText(/Неверно|Неправильно/);
  await expect(result(page)).toContainText(/Пропущен/);
  await expect(result(page)).toContainText('Ответ следует из определения и примера в учебном материале.');
  await expect(result(page)).toContainText(/1, 3/);
  await capture(page, testInfo, result(page), 'attempt-result-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, testInfo, result(page), 'attempt-result-mobile.png');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(state.submits).toHaveLength(1);
});

test('Попытки: все пропуски дают результат 0%, пройти ещё раз создаёт новый ключ', async ({ page }) => {
  const state = await mockAttempts(page);
  await openReady(page);
  await start(page);
  await send(page);
  await expect(result(page)).toContainText('0%');
  await expect(result(page)).toContainText(/Пропущен/);
  expect(state.attempts.get(attemptId()).correctCount).toBe(0);
  expect(state.submits[0].body.answers.every((answer) => answer.optionId === null)).toBe(true);
  await action(page, 'Пройти ещё раз').click();
  await expect(question(page, 1)).toBeVisible();
  await expect(result(page)).toHaveCount(0);
  await expect(exercise(page)).toContainText('Отвечено: 0 из 10');
  expect(state.starts).toHaveLength(2);
  expect(state.starts[1].key).not.toBe(state.starts[0].key);
  expect(state.attempts.size).toBe(2);
});

test('Попытки: POST начала может вернуть завершённую попытку 201 сразу с разбором', async ({ page }) => {
  const state = await mockAttempts(page);
  const value = completed(attempt(), answersFor(quiz(), { 1: 1, 2: 1 }));
  state.onStart = (route) => reply(route, value, 201);
  await openReady(page);
  await action(page, 'Начать тест').click();
  await expect(result(page)).toContainText('20%');
  await expect(detail(page).getByRole('radio')).toHaveCount(0);
  expect(state.submits).toHaveLength(0);
  expect(state.attemptGets).toHaveLength(0);
});

test('Попытки: неизвестное начало переживает закрытие и повторяется только прежним ключом', async ({ page }) => {
  await page.clock.install();
  const state = await mockAttempts(page);
  state.onStart = async (route, id, key) => {
    state.keys.set(key, attemptId());
    state.attempts.set(attemptId(), completed(attempt(), answersFor(quiz(), { 1: 1 })));
    await route.abort('failed');
  };
  await openReady(page);
  await action(page, 'Начать тест').click();
  await expect(action(page, 'Повторить начало')).toBeEnabled();
  await action(page, 'Закрыть просмотр').click();
  await openVersion(page);
  await expect(action(page, 'Повторить начало')).toBeEnabled();
  await page.clock.runFor(5000);
  expect(state.starts).toHaveLength(1);
  expect(state.attemptGets).toHaveLength(0);
  state.onStart = null;
  await action(page, 'Повторить начало').click();
  await expect(result(page)).toContainText('10%');
  expect(state.starts).toHaveLength(2);
  expect(state.starts[1].key).toBe(state.starts[0].key);
  expect(state.attempts.size).toBe(1);
});

for (const [status, code] of [[401, 'AUTHENTICATION_REQUIRED'], [403, 'CSRF_INVALID']]) {
  test('Попытки: восстановление ' + code + ' не начинает автоматически и сохраняет ключ', async ({ page }) => {
    await page.clock.install();
    const state = await mockAttempts(page);
    state.onStart = (route) => fail(route, status, code);
    await openReady(page);
    const csrf = state.csrfCount;
    await action(page, 'Начать тест').click();
    await expect.poll(() => state.csrfCount).toBeGreaterThan(csrf);
    await expect(action(page, 'Повторить начало')).toBeEnabled();
    await page.clock.runFor(3000);
    expect(state.starts).toHaveLength(1);
    state.onStart = null;
    await action(page, 'Повторить начало').click();
    await expect(question(page, 1)).toBeVisible();
    expect(state.starts[1].key).toBe(state.starts[0].key);
    expect(state.starts[1].headers['x-csrf-token']).not.toBe(state.starts[0].headers['x-csrf-token']);
  });
}

test('Попытки: неизвестная отправка блокирует ответы, GET открывает сохранённый результат без POST', async ({ page }) => {
  const state = await mockAttempts(page);
  state.onSubmit = async (route, id, body) => {
    state.attempts.set(id, completed(state.attempts.get(id), body.answers));
    await route.abort('failed');
  };
  await openReady(page);
  await start(page);
  await choose(page, 1);
  await send(page);
  await expect(action(page, 'Проверить результат')).toBeEnabled();
  await expect(question(page, 1).getByRole('radio').first()).toBeDisabled();
  await expect(question(page, 1).getByRole('button', { name: 'Сбросить ответ', exact: true })).toBeDisabled();
  await action(page, 'Проверить результат').click();
  await expect(result(page)).toContainText('10%');
  expect(state.submits).toHaveLength(1);
  expect(state.attemptGets).toEqual([attemptId()]);
});

test('Попытки: GET in_progress после потери submit оставляет ответы замороженными для точного повтора', async ({ page }) => {
  const state = await mockAttempts(page);
  state.onSubmit = (route) => route.abort('failed');
  await openReady(page);
  await start(page);
  await choose(page, 1);
  await choose(page, 5, 2);
  await send(page);
  await expect(action(page, 'Проверить результат')).toBeEnabled();
  await action(page, 'Закрыть просмотр').click();
  await openVersion(page);
  await expect(action(page, 'Повторить отправку')).toBeEnabled();
  await expect(question(page, 1).getByRole('radio').first()).toBeChecked();
  await expect(question(page, 1).getByRole('radio').first()).toBeDisabled();
  expect(state.attemptGets).toEqual([attemptId()]);
  expect(state.submits).toHaveLength(1);
  state.onSubmit = null;
  await action(page, 'Повторить отправку').click();
  await expect(confirmation(page)).toBeVisible();
  expect(state.submits).toHaveLength(1);
  await confirmButton(page).click();
  await expect(result(page)).toContainText('10%');
  expect(state.submits).toHaveLength(2);
  expect(state.submits[1].body).toEqual(state.submits[0].body);
});

test('Попытки: 409 уже сдано читает серверный результат и не повторяет выбранные ответы', async ({ page }) => {
  const state = await mockAttempts(page);
  state.onSubmit = async (route, id) => {
    state.attempts.set(id, completed(state.attempts.get(id), answersFor(quiz(), { 2: 1, 3: 1, 4: 1 })));
    await fail(route, 409, 'ATTEMPT_ALREADY_SUBMITTED');
  };
  await openReady(page);
  await start(page);
  await choose(page, 1);
  await send(page);
  await expect(result(page)).toContainText('30%');
  expect(state.attemptGets).toEqual([attemptId()]);
  expect(state.submits).toHaveLength(1);
  expect(state.starts).toHaveLength(1);
});

test('Попытки: 422 сохраняет выбор и разрешает исправить ответы', async ({ page }) => {
  const state = await mockAttempts(page);
  state.onSubmit = (route) => fail(route, 422, 'VALIDATION_FAILED', {}, { answers: 'Проверь выбранные варианты.' });
  await openReady(page);
  await start(page);
  await choose(page, 1, 2);
  await send(page);
  await expect(question(page, 1).getByRole('radio').nth(1)).toBeEnabled();
  await expect(question(page, 1).getByRole('radio').nth(1)).toBeChecked();
  await expect(detail(page).getByRole('alert').first()).toBeVisible();
  await expect(detail(page)).not.toContainText('Сырые подробности сервера.');
  await choose(page, 1);
  state.onSubmit = null;
  await send(page);
  await expect(result(page)).toContainText('10%');
  expect(state.submits).toHaveLength(2);
  expect(state.submits[1].body).not.toEqual(state.submits[0].body);
});

test('Попытки: Retry-After начала сохраняется при закрытии и не запускает запрос по таймеру', async ({ page }) => {
  await page.clock.install();
  const state = await mockAttempts(page);
  state.onStart = (route) => fail(route, 429, 'RATE_LIMITED', { 'Retry-After': '30' });
  await openReady(page);
  await action(page, 'Начать тест').click();
  await expect(action(page, 'Повторить начало')).toBeDisabled();
  await action(page, 'Закрыть просмотр').click();
  await openVersion(page);
  await expect(action(page, 'Повторить начало')).toBeDisabled();
  await page.clock.runFor(30_500);
  await expect(action(page, 'Повторить начало')).toBeEnabled();
  expect(state.starts).toHaveLength(1);
  state.onStart = null;
  await action(page, 'Повторить начало').click();
  await expect(question(page, 1)).toBeVisible();
  expect(state.starts[1].key).toBe(state.starts[0].key);
});

test('Попытки: ошибка чтения скрывает прежний разбор, ручной GET восстанавливает; 404 убирает результат', async ({ page }) => {
  const state = await mockAttempts(page);
  await openReady(page);
  await start(page);
  await choose(page, 1);
  await send(page);
  await expect(result(page)).toContainText('10%');
  state.onAttempt = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');
  await action(page, 'Обновить попытку').click();
  await expect(detail(page)).not.toContainText('Ответ следует из определения и примера в учебном материале.');
  await expect(detail(page).getByRole('alert').first()).toBeVisible();
  await expect(detail(page)).not.toContainText('Сырые подробности сервера.');
  state.onAttempt = null;
  await action(page, 'Обновить попытку').click();
  await expect(result(page)).toContainText('10%');
  state.onAttempt = (route) => fail(route, 404, 'ATTEMPT_NOT_FOUND');
  await action(page, 'Обновить попытку').click();
  await expect(detail(page)).not.toContainText('Ответ следует из определения и примера в учебном материале.');
  await expect(detail(page)).toContainText(/недоступ|не найдена|удалена/i);
  expect(state.starts).toHaveLength(1);
  expect(state.submits).toHaveLength(1);
});

test('Попытки: выбор сохраняется при закрытии и возврате, GET не создаёт и не завершает попытку', async ({ page }) => {
  const state = await mockAttempts(page, { quizzes: [quiz(), quiz(2)] });
  await openReady(page);
  await start(page);
  await choose(page, 1, 2);
  await choose(page, 10);
  await openVersion(page, 2);
  await expect(action(page, 'Начать тест')).toBeEnabled();
  await expect(exercise(page)).toHaveCount(0);
  await openVersion(page);
  await expect(question(page, 1).getByRole('radio').nth(1)).toBeChecked();
  await expect(question(page, 10).getByRole('radio').first()).toBeChecked();
  await panel(page).getByRole('button', { name: 'Закрыть тесты', exact: true }).click();
  await openQuizzes(page);
  await expect(exercise(page)).toContainText('Отвечено: 2 из 10');
  expect(state.attemptGets).toEqual([attemptId(), attemptId()]);
  expect(state.starts).toHaveLength(1);
  expect(state.submits).toHaveLength(0);
});

test('Попытки: позднее начало после выбора другой версии не подменяет её; повтор использует прежний ключ', async ({ page }) => {
  const gate = deferred();
  let responded = false;
  const state = await mockAttempts(page, { quizzes: [quiz(), quiz(2)] });
  state.onStart = async (route, id, key) => {
    await gate.promise;
    const value = attempt(quiz());
    state.keys.set(key, value.id);
    state.attempts.set(value.id, value);
    await reply(route, value, 201).catch(() => {});
    responded = true;
  };
  await openReady(page);
  await action(page, 'Начать тест').click();
  try {
    await expect.poll(() => state.starts.length).toBe(1);
    await openVersion(page, 2);
    await expect(action(page, 'Начать тест')).toBeEnabled();
  } finally { gate.resolve(); }
  await expect.poll(() => responded).toBe(true);
  await expect(detail(page).getByRole('heading', { name: 'Версия 2', exact: true })).toBeVisible();
  await expect(exercise(page)).toHaveCount(0);
  state.onStart = null;
  await openVersion(page);
  await action(page, 'Повторить начало').click();
  await expect(question(page, 1)).toBeVisible();
  expect(state.starts).toHaveLength(2);
  expect(state.starts[1].key).toBe(state.starts[0].key);
  expect(state.starts[1].id).toBe(quizId());
});

test('Попытки: поздняя сдача после перехода к тексту не показывает результат; возврат восстанавливает GET', async ({ page }) => {
  const gate = deferred();
  let responded = false;
  const state = await mockAttempts(page);
  state.onSubmit = async (route, id, body) => {
    await gate.promise;
    const value = completed(state.attempts.get(id), body.answers);
    state.attempts.set(id, value);
    await reply(route, value).catch(() => {});
    responded = true;
  };
  await openReady(page);
  await start(page);
  await choose(page, 1);
  await send(page);
  try {
    await expect.poll(() => state.submits.length).toBe(1);
    await materials(page).getByRole('button', { name: 'Открыть обработку и текст «' + material().title + '»', exact: true }).click();
    await expect(panel(page)).toHaveCount(0);
  } finally { gate.resolve(); }
  await expect.poll(() => responded).toBe(true);
  await expect(page.getByRole('region', { name: 'Результат теста', exact: true })).toHaveCount(0);
  await openQuizzes(page);
  await expect(result(page)).toContainText('10%');
  expect(state.submits).toHaveLength(1);
  expect(state.attemptGets).toEqual([attemptId()]);
});

test('Попытки: поздний GET после открытия удаления не возвращает скрытый разбор', async ({ page }) => {
  const gate = deferred();
  let responded = false;
  const state = await mockAttempts(page);
  await openReady(page);
  await start(page);
  state.onAttempt = async (route, id) => {
    await gate.promise;
    await reply(route, completed(state.attempts.get(id), answersFor(quiz(), { 1: 1 }))).catch(() => {});
    responded = true;
  };
  await action(page, 'Обновить попытку').click();
  try {
    await expect.poll(() => state.attemptGets.length).toBe(1);
    await materials(page).getByRole('button', { name: 'Удалить материал «' + material().title + '»', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Удаление материала', exact: true })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
  } finally { gate.resolve(); }
  await expect.poll(() => responded).toBe(true);
  await expect(page.getByRole('region', { name: 'Результат теста', exact: true })).toHaveCount(0);
  expect(state.submits).toHaveLength(0);
  expect(state.writes.some((value) => value.startsWith('DELETE'))).toBe(false);
});

test('Попытки: поздний GET после выхода не раскрывает результат другому аккаунту', async ({ page }) => {
  const gate = deferred();
  let responded = false;
  const state = await mockAttempts(page);
  await openReady(page);
  await start(page);
  await choose(page, 1);
  state.onAttempt = async (route, id) => {
    await gate.promise;
    await reply(route, completed(state.attempts.get(id), answersFor(quiz(), { 1: 1 }))).catch(() => {});
    responded = true;
  };
  await action(page, 'Обновить попытку').click();
  try {
    await expect.poll(() => state.attemptGets.length).toBe(1);
    await account(page).getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'С возвращением!', exact: true })).toBeVisible();
    state.loginUser = OTHER_USER;
    state.subjects = [OTHER_SUBJECT];
    state.files = [];
    await login(page, OTHER_USER);
    await openMaterials(page, OTHER_SUBJECT);
  } finally { gate.resolve(); }
  await expect.poll(() => responded).toBe(true);
  await expect(page.getByRole('region', { name: 'Результат теста', exact: true })).toHaveCount(0);
  await expect(materials(page).getByText('Пока нет материалов', { exact: true })).toBeVisible();
  expect(state.starts).toHaveLength(1);
  expect(state.submits).toHaveLength(0);
});

test('Попытки: сохранённый старый тест можно пройти во время генерации новой версии без вызова ИИ', async ({ page }) => {
  await page.clock.install();
  const state = await mockAttempts(page, { generation: { status: 'running', jobId: JOB_ID, error: null } });
  await openReady(page);
  await start(page);
  await choose(page, 1);
  await send(page);
  await expect(result(page)).toContainText('10%');
  expect(state.starts[0].id).toBe(quizId());
  expect(state.submits[0].id).toBe(attemptId());
  expect(state.jobGets.every((id) => id === JOB_ID)).toBe(true);
  expect(state.generationPosts).toHaveLength(0);
});

test('Попытки: вопросы, варианты и объяснения с HTML отображаются безопасным текстом', async ({ page }) => {
  const source = quiz();
  source.questions[0].text = '<img src=x onerror="window.attemptExecuted=true"> Вопрос из PDF';
  source.questions[0].options[0].text = '<script>window.attemptExecuted=true</script> Вариант из PDF';
  const explanation = '<img src=x onerror="window.attemptExecuted=true"> Объяснение из PDF';
  const state = await mockAttempts(page, { quizzes: [source] });
  state.onSubmit = (route, id, body) => {
    const value = completed(state.attempts.get(id), body.answers);
    value.review[0].explanation = explanation;
    state.attempts.set(id, value);
    return reply(route, value);
  };
  await openReady(page);
  await start(page);
  await expect(question(page, 1)).toContainText(source.questions[0].text);
  await expect(question(page, 1).getByRole('radio', { name: source.questions[0].options[0].text, exact: true })).toBeVisible();
  await choose(page, 1);
  await send(page);
  await expect(result(page)).toContainText(explanation);
  await expect(result(page).locator('img, script')).toHaveCount(0);
  expect(await page.evaluate(() => Boolean(window.attemptExecuted))).toBe(false);
});

for (const [status, code] of [[404, 'QUIZ_NOT_FOUND'], [409, 'MATERIAL_NOT_AVAILABLE']]) {
  test('Попытки: ' + code + ' после неизвестного начала запрещает повтор и не раскрывает сырую ошибку', async ({ page }) => {
    const state = await mockAttempts(page);
    state.onStart = (route) => route.abort('failed');
    await openReady(page);
    await action(page, 'Начать тест').click();
    await expect(action(page, 'Повторить начало')).toBeEnabled();
    state.onStart = (route) => fail(route, status, code);
    await action(page, 'Повторить начало').click();
    await expect(detail(page)).toContainText(/недоступ|не найден|удалён|удаляется/i);
    await expect(action(page, 'Повторить начало')).toHaveCount(0);
    await expect(action(page, 'Начать тест')).toHaveCount(0);
    await expect(detail(page)).not.toContainText('Сырые подробности сервера.');
    expect(state.starts[1].key).toBe(state.starts[0].key);
    expect(state.submits).toHaveLength(0);
  });
}

test('Попытки: перезагрузка очищает выбор и локальный указатель; открытие не запускает новую попытку', async ({ page }) => {
  const state = await mockAttempts(page);
  await openReady(page);
  await start(page);
  await choose(page, 1);
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(account(page).getByRole('heading', { name: SUBJECT.title, exact: true })).toBeVisible();
  await openReady(page);
  await expect(exercise(page)).toHaveCount(0);
  expect(state.starts).toHaveLength(1);
  expect(state.attemptGets).toHaveLength(0);
  expect(state.submits).toHaveLength(0);
});
