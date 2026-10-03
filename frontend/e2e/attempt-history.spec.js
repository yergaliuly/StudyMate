import { test, expect } from '@playwright/test';

// Только HTTP-mocks истории. Реальные backend, R2 и ИИ не вызываются.
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

const materialId = (number = 1) => 'f73de5ee-311e-45cb-b7e2-' + String(number).padStart(12, '0');
function source(number = 1) { return { ...material(), id: materialId(number), title: number === 1 ? material().title : 'Учебный материал ' + number }; }
function saved(number = 1, { status = 'in_progress', version = 1, materialNumber = 1, correct = 0 } = {}) {
  const value = attempt({ ...quiz(version), materialId: materialId(materialNumber) }, attemptId(number));
  value.startedAt = '2026-10-03T12:' + String(number % 60).padStart(2, '0') + ':00Z';
  if (status === 'in_progress') return value;
  const answers = answersFor(quiz(version), Object.fromEntries(Array.from({ length: correct }, (_, index) => [index + 1, 1])));
  return { ...completed(value, answers), completedAt: '2026-10-03T13:00:00Z' };
}
function historyReply(route, state) {
  const params = new URL(route.request().url()).searchParams;
  const page = Number(params.get('page'));
  const pageSize = Number(params.get('pageSize'));
  const matches = [...state.attempts.values()].filter((value) => ['status', 'materialId', 'quizId'].every((field) => !params.has(field) || value[field] === params.get(field)))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id));
  const data = matches.slice((page - 1) * pageSize, page * pageSize).map(({ questions, review, ...value }) => value);
  return route.fulfill({ status: 200, json: { data, meta: { page, pageSize, total: matches.length } } });
}
function account(page) { return page.locator('#account-main-content'); }
function history(page) { return page.getByRole('region', { name: 'История попыток', exact: true }); }
function rows(page) { return history(page).getByRole('list', { name: 'Попытки', exact: true }).locator(':scope > li'); }
function selected(page) { return history(page).getByRole('region', { name: 'Выбранная попытка', exact: true }); }
function exercise(page) { return selected(page).getByRole('region', { name: 'Прохождение теста', exact: true }); }
function result(page) { return selected(page).getByRole('region', { name: 'Результат теста', exact: true }); }
function refresh(page) { return history(page).getByRole('button', { name: 'Обновить историю', exact: true }); }
function statusFilter(page) { return history(page).getByRole('combobox', { name: 'Статус попытки', exact: true }); }
function question(page, number) { return exercise(page).getByRole('group', { name: new RegExp('^Вопрос ' + number + '\\.') }); }
async function openHistory(page) {
  await page.getByRole('navigation', { name: 'Основная навигация', exact: true }).getByRole('button', { name: 'Результаты', exact: true }).click();
  await expect(history(page)).toBeVisible();
}
async function openRow(page, index = 0, done = false) {
  await rows(page).nth(index).getByRole('button', { name: done ? 'Открыть результат' : 'Продолжить', exact: true }).click();
  await expect(selected(page)).toBeVisible();
}
async function closeSelected(page) { await selected(page).getByRole('button', { name: 'Закрыть попытку', exact: true }).click(); }
async function choose(page, number, option = 1) { await question(page, number).getByRole('radio').nth(option - 1).check(); }
async function submit(page) {
  await exercise(page).getByRole('button', { name: 'Отправить ответы', exact: true }).click();
  await page.getByRole('dialog', { name: 'Отправить ответы?', exact: true }).getByRole('button', { name: 'Подтвердить отправку', exact: true }).click();
}
async function capture(page, testInfo, region, name) {
  await region.getByRole('heading').first().evaluate((heading) => {
    heading.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -100);
  });
  await page.screenshot({ path: testInfo.outputPath(name) });
}
async function openMaterials(page) {
  await page.getByRole('navigation', { name: 'Основная навигация', exact: true }).getByRole('button', { name: 'Мои предметы', exact: true }).click();
  await account(page).getByRole('button', { name: 'Открыть предмет «' + SUBJECT.title + '»', exact: true }).click();
  await page.getByRole('dialog', { name: 'Предмет', exact: true }).getByRole('button', { name: 'Материалы предмета', exact: true }).click();
  const files = page.getByRole('region', { name: 'Файлы предмета', exact: true });
  await expect(files).toBeVisible();
  return files;
}
async function login(page, user) {
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Пароль', { exact: true }).fill('Only-for-history-tests!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(account(page).getByText(user.email, { exact: true })).toBeVisible();
}

async function mockHistory(page, options = {}) {
  const state = {
    user: USER, loginUser: USER, subjects: [SUBJECT], files: [source()], quizzes: [quiz()],
    attempts: new Map(), queries: [], materialGets: [], attemptGets: [], quizGets: [], submits: [], starts: [],
    writes: [], unexpected: [], pageErrors: [], csrfCount: 0,
    onList: null, onMaterial: null, onAttempt: null, onSubmit: null, explicitStart: null, ...options,
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
      await reply(route, { headerName: 'X-CSRF-TOKEN', token: 'history-csrf-' + ++state.csrfCount });
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
      const id = path.split('/')[2];
      state.materialGets.push(id);
      if (state.onMaterial) await state.onMaterial(route, id);
      else if (state.files.some((item) => item.id === id)) await reply(route, state.files.find((item) => item.id === id));
      else await fail(route, 404, 'MATERIAL_NOT_FOUND');
    } else if (method === 'GET' && path === '/attempts') {
      const query = Object.fromEntries(url.searchParams);
      state.queries.push(query);
      if (state.onList) await state.onList(route, query);
      else await historyReply(route, state);
    } else if (method === 'GET' && /^\/attempts\/[^/]+$/.test(path)) {
      const id = path.split('/')[2];
      state.attemptGets.push(id);
      if (state.onAttempt) await state.onAttempt(route, id);
      else if (state.attempts.has(id)) await reply(route, state.attempts.get(id));
      else await fail(route, 404, 'ATTEMPT_NOT_FOUND');
    } else if (method === 'POST' && /^\/quizzes\/[^/]+\/attempts$/.test(path) && state.explicitStart) {
      state.starts.push({ id: path.split('/')[2], headers: request.headers() });
      state.attempts.set(state.explicitStart.id, state.explicitStart);
      await reply(route, state.explicitStart, 201);
    } else if (method === 'POST' && /^\/attempts\/[^/]+\/submit$/.test(path)) {
      const id = path.split('/')[2];
      const body = request.postDataJSON();
      state.submits.push({ id, body, headers: request.headers() });
      if (state.onSubmit) await state.onSubmit(route, id, body);
      else {
        const value = { ...completed(state.attempts.get(id), body.answers), completedAt: '2026-10-03T13:00:00Z' };
        state.attempts.set(id, value);
        await reply(route, value);
      }
    } else if (method === 'GET' && /^\/materials\/[^/]+\/quizzes$/.test(path)) {
      await listReply(route, state.quizzes.slice().reverse().map(({ questions, ...value }) => value), { generation: { status: 'ready', jobId: JOB_ID, error: null } });
    } else if (method === 'GET' && /^\/quizzes\/[^/]+$/.test(path)) {
      const id = path.split('/')[2];
      state.quizGets.push(id);
      await reply(route, state.quizzes.find((item) => item.id === id));
    } else {
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
  expect(state?.unexpected ?? [], 'История не вызывает новые попытки, ИИ или jobs').toEqual([]);
  expect(state?.pageErrors ?? [], 'Ошибки JavaScript').toEqual([]);
});
const withAttempts = (...items) => new Map(items.map((item) => [item.id, item]));

test('История: пустой ответ отличается от загрузки и не запускает попытки или расчёт статистики', async ({ page }) => {
  const state = await mockHistory(page);
  await openHistory(page);
  await expect(history(page)).toContainText(/попыток пока нет|пока нет попыток|нет попыток/i);
  await expect(rows(page)).toHaveCount(0);
  await expect(history(page).getByRole('progressbar')).toHaveCount(0);
  await expect(history(page).getByRole('button', { name: /Начать тест|Пройти ещё раз/ })).toHaveCount(0);
  expect(state.queries).toEqual([{ page: '1', pageSize: '20' }]);
  expect(state.attemptGets).toHaveLength(0);
  expect(state.writes).toHaveLength(0);
});

test('История: DESC, 0% отдельно от незавершённой попытки, серверный разбор только через GET', async ({ page }, testInfo) => {
  const state = await mockHistory(page, { attempts: withAttempts(saved(1, { status: 'completed' }), saved(2), saved(3, { status: 'completed', correct: 7 })) });
  await openHistory(page);
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).first()).toContainText('70%');
  await expect(rows(page).nth(1)).toContainText('Не завершена');
  await expect(rows(page).nth(1)).not.toContainText('%');
  await expect(rows(page).nth(2)).toContainText('0%');
  await expect(rows(page).first()).toContainText(material().title);
  expect(state.materialGets).toEqual([MATERIAL_ID]);
  await capture(page, testInfo, history(page), 'history-list-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, testInfo, history(page), 'history-list-mobile.png');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await openRow(page, 2, true);
  await expect(result(page)).toContainText('0%');
  await expect(result(page)).toContainText('Ответ следует из определения и примера в учебном материале.');
  await expect(selected(page).getByRole('button', { name: /Начать тест|Пройти ещё раз/ })).toHaveCount(0);
  await expect(selected(page).getByRole('radio')).toHaveCount(0);
  await capture(page, testInfo, result(page), 'history-result-mobile.png');
  await page.setViewportSize({ width: 1280, height: 800 });
  await capture(page, testInfo, result(page), 'history-result-desktop.png');
  expect(state.attemptGets.length).toBeGreaterThanOrEqual(2);
  expect(state.attemptGets.every((id) => id === attemptId(1))).toBe(true);
  expect(state.writes).toHaveLength(0);
});

test('История: продолжение известной попытки, отправка убирает строку фильтра, но сохраняет разбор', async ({ page }, testInfo) => {
  const state = await mockHistory(page, { attempts: withAttempts(saved()) });
  await openHistory(page);
  await statusFilter(page).selectOption('in_progress');
  await openRow(page);
  await expect(question(page, 1)).toBeVisible();
  await choose(page, 1);
  await expect(exercise(page)).toContainText('Отвечено: 1 из 10');
  await capture(page, testInfo, exercise(page), 'history-resume-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, testInfo, exercise(page), 'history-resume-mobile.png');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await submit(page);
  await expect(result(page)).toContainText('10%');
  await expect(rows(page)).toHaveCount(0);
  await expect(statusFilter(page)).toHaveValue('in_progress');
  expect(state.queries.at(-1).status).toBe('in_progress');
  expect(state.submits).toHaveLength(1);
  expect(state.submits[0].id).toBe(attemptId());
  expect(state.submits[0].headers['idempotency-key']).toBeUndefined();
  expect(state.submits[0].headers['x-csrf-token']).toBeTruthy();
});

test('История: status, materialId и quizId объединяются AND; сброс возвращает общую первую страницу', async ({ page }) => {
  const state = await mockHistory(page, {
    files: [source(), source(2)],
    attempts: withAttempts(saved(1), saved(2, { status: 'completed' }), saved(3, { status: 'completed', version: 2 }),
      saved(4, { materialNumber: 2, version: 3 }), saved(5, { materialNumber: 2, version: 3, status: 'completed', correct: 8 })),
  });
  await openHistory(page);
  await statusFilter(page).selectOption('completed');
  await expect(rows(page)).toHaveCount(3);
  await rows(page).first().getByRole('button', { name: 'Попытки материала', exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
  expect(state.queries.at(-1)).toEqual({ page: '1', pageSize: '20', status: 'completed', materialId: materialId(2) });
  await rows(page).first().getByRole('button', { name: 'Попытки этой версии', exact: true }).click();
  await expect.poll(() => state.queries.at(-1)).toEqual({ page: '1', pageSize: '20', status: 'completed', materialId: materialId(2), quizId: quizId(3) });
  await history(page).getByRole('button', { name: 'Сбросить фильтры', exact: true }).click();
  await expect(rows(page)).toHaveCount(5);
  await expect(statusFilter(page)).toHaveValue('');
  expect(state.queries.at(-1)).toEqual({ page: '1', pageSize: '20' });
  expect(state.writes).toHaveLength(0);
});

for (const filterButton of ['Попытки материала', 'Попытки этой версии', 'Сбросить фильтры']) {
  test('История: клавиатурный фильтр «' + filterButton + '» возвращает фокус к списку', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    const state = await mockHistory(page, {
      attempts: withAttempts(...Array.from({ length: 6 }, (_, index) =>
        saved(index + 1, { status: index % 2 === 0 ? 'in_progress' : 'completed' }))),
    });
    await openHistory(page);
    await expect(rows(page)).toHaveCount(6);
    if (filterButton === 'Сбросить фильтры') {
      await statusFilter(page).selectOption('completed');
      await expect(rows(page)).toHaveCount(3);
    }
    const gate = deferred();
    state.onList = async (route) => {
      await gate.promise;
      await historyReply(route, state);
    };
    try {
      const button = history(page).getByRole('button', { name: filterButton, exact: true }).last();
      const heading = history(page).getByRole('heading', { name: 'История попыток', exact: true });
      await button.focus();
      if (filterButton !== 'Сбросить фильтры') await expect(heading).not.toBeInViewport();
      await page.keyboard.press('Enter');
      await expect(history(page).getByText('Загружаем историю…', { exact: true })).toBeVisible();
      await expect(button).toHaveCount(0);
      await expect(heading).toBeFocused();
      await expect(heading).toBeInViewport({ ratio: 1 });
      gate.resolve();
      await expect(rows(page)).toHaveCount(6);
      await expect(heading).toBeFocused();
      await expect(heading).toBeInViewport({ ratio: 1 });

      // Selecting a status uses a persistent control and must keep its focus.
      await statusFilter(page).focus();
      await statusFilter(page).selectOption('completed');
      await expect(rows(page)).toHaveCount(3);
      await expect(statusFilter(page)).toBeFocused();
      expect(state.writes).toHaveLength(0);
    } finally {
      gate.resolve();
    }
  });
}

test('История: пагинация по20 и повторный GET последней страницы после уменьшения total', async ({ page }) => {
  const values = Array.from({ length: 21 }, (_, index) => saved(index + 1));
  const state = await mockHistory(page, { attempts: withAttempts(...values) });
  await openHistory(page);
  await expect(rows(page)).toHaveCount(20);
  const nav = history(page).getByRole('navigation', { name: 'Страницы истории', exact: true });
  await expect(nav.getByRole('button', { name: 'Предыдущие попытки', exact: true })).toBeDisabled();
  await nav.getByRole('button', { name: 'Следующие попытки', exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
  expect(state.queries.at(-1).page).toBe('2');
  await expect(nav.getByRole('button', { name: 'Следующие попытки', exact: true })).toBeDisabled();
  state.attempts = withAttempts(values[0]);
  const before = state.queries.length;
  await refresh(page).click();
  await expect.poll(() => state.queries.slice(before).map((value) => value.page)).toEqual(['2', '1']);
  await expect(rows(page)).toHaveCount(1);
  await expect(nav.getByRole('button', { name: 'Предыдущие попытки', exact: true })).toBeDisabled();
});

test('История: ошибка списка не становится пустым состоянием, обновление сохраняет безопасные старые строки', async ({ page }) => {
  const state = await mockHistory(page, { attempts: withAttempts(saved()) });
  state.onList = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');
  await openHistory(page);
  await expect(history(page).getByRole('alert').first()).toBeVisible();
  await expect(history(page)).not.toContainText(/попыток пока нет|пока нет попыток/i);
  await expect(history(page)).not.toContainText('Сырые подробности сервера.');
  state.onList = null;
  await refresh(page).click();
  await expect(rows(page)).toHaveCount(1);
  state.onList = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');
  await refresh(page).click();
  await expect(history(page).getByRole('alert').first()).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  expect(state.writes).toHaveLength(0);
});

test('История: поздний список прежнего фильтра не подменяет новый', async ({ page }) => {
  const gate = deferred();
  let responded = false;
  const state = await mockHistory(page, { attempts: withAttempts(saved(1), saved(2, { status: 'completed', correct: 6 })) });
  await openHistory(page);
  await expect(rows(page)).toHaveCount(2);
  state.onList = async (route, query) => {
    if (query.status !== 'in_progress') {
      await gate.promise;
      await historyReply(route, state).catch(() => {});
      responded = true;
    } else await historyReply(route, state);
  };
  await refresh(page).click();
  try {
    await expect.poll(() => state.queries.length).toBe(2);
    await statusFilter(page).selectOption('in_progress');
    await expect(rows(page)).toHaveCount(1);
  } finally { gate.resolve(); }
  await expect.poll(() => responded).toBe(true);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Не завершена');
  await expect(history(page)).not.toContainText('60%');
  expect(state.writes).toHaveLength(0);
});

test('История: Retry-After не создаёт автоопрос, ручное обновление после срока', async ({ page }) => {
  await page.clock.install();
  const state = await mockHistory(page, { attempts: withAttempts(saved()) });
  state.onList = (route) => fail(route, 429, 'RATE_LIMITED', { 'Retry-After': '30' });
  await openHistory(page);
  await expect(refresh(page)).toBeDisabled();
  await page.clock.runFor(30_500);
  await expect(refresh(page)).toBeEnabled();
  expect(state.queries).toHaveLength(1);
  state.onList = null;
  await refresh(page).click();
  await expect(rows(page)).toHaveCount(1);
  expect(state.queries).toHaveLength(2);
  expect(state.writes).toHaveLength(0);
});

test('История: названия загружаются по уникальным materialId максимум четырьмя запросами одновременно', async ({ page }) => {
  const gate = deferred();
  let active = 0;
  let maximum = 0;
  const files = Array.from({ length: 8 }, (_, index) => source(index + 1));
  const values = Array.from({ length: 16 }, (_, index) => saved(index + 1, { materialNumber: index % 8 + 1 }));
  const state = await mockHistory(page, { files, attempts: withAttempts(...values) });
  state.onMaterial = async (route, id) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await gate.promise;
    active -= 1;
    await reply(route, files.find((item) => item.id === id));
  };
  await openHistory(page);
  try {
    await expect.poll(() => state.materialGets.length).toBe(4);
  } finally { gate.resolve(); }
  await expect.poll(() => state.materialGets.length).toBe(8);
  await expect(rows(page).first()).toContainText(source(8).title);
  expect(new Set(state.materialGets).size).toBe(8);
  expect(maximum).toBeLessThanOrEqual(4);
});

test('История: две незавершённые попытки одной версии сохраняют независимый выбор', async ({ page }) => {
  const state = await mockHistory(page, { attempts: withAttempts(saved(1), saved(2)) });
  await openHistory(page);
  await openRow(page, 0);
  await choose(page, 1, 2);
  await closeSelected(page);
  await openRow(page, 1);
  await expect(question(page, 1).getByRole('radio').nth(1)).not.toBeChecked();
  await choose(page, 1, 1);
  await closeSelected(page);
  await openRow(page, 0);
  await expect(question(page, 1).getByRole('radio').nth(1)).toBeChecked();
  await expect(question(page, 1).getByRole('radio').first()).not.toBeChecked();
  expect(state.writes).toHaveLength(0);
});

test('История: поздний GET первой попытки не подменяет выбранный второй результат', async ({ page }) => {
  const gate = deferred();
  let responded = false;
  const state = await mockHistory(page, { attempts: withAttempts(saved(1, { status: 'completed', correct: 2 }), saved(2, { status: 'completed', correct: 9 })) });
  state.onAttempt = async (route, id) => {
    if (id === attemptId(2)) {
      await gate.promise;
      await reply(route, state.attempts.get(id)).catch(() => {});
      responded = true;
    } else await reply(route, state.attempts.get(id));
  };
  await openHistory(page);
  await openRow(page, 0, true);
  try {
    await expect.poll(() => state.attemptGets.length).toBe(1);
    await openRow(page, 1, true);
    await expect(result(page)).toContainText('20%');
  } finally { gate.resolve(); }
  await expect.poll(() => responded).toBe(true);
  await expect(result(page)).toContainText('20%');
  await expect(result(page)).not.toContainText('90%');
  expect(state.writes).toHaveLength(0);
});

test('История: восстановление сессии сохраняет status и выбранный известный attemptId', async ({ page }) => {
  const state = await mockHistory(page, { attempts: withAttempts(saved(1, { status: 'completed', correct: 4 })) });
  await openHistory(page);
  await statusFilter(page).selectOption('completed');
  const csrf = state.csrfCount;
  let denied = false;
  state.onAttempt = async (route, id) => {
    if (!denied) {
      denied = true;
      await fail(route, 401, 'AUTHENTICATION_REQUIRED');
    } else await reply(route, state.attempts.get(id));
  };
  await openRow(page, 0, true);
  await expect.poll(() => state.csrfCount).toBeGreaterThan(csrf);
  await expect(history(page)).toBeVisible();
  await expect(statusFilter(page)).toHaveValue('completed');
  await expect(result(page)).toContainText('40%');
  expect(state.attemptGets.every((id) => id === attemptId(1))).toBe(true);
  expect(state.writes).toHaveLength(0);
});

test('История: CSRF submit восстанавливает фильтр и замороженный выбор, повтор отправляет те же ответы', async ({ page }) => {
  const state = await mockHistory(page, { attempts: withAttempts(saved()) });
  await openHistory(page);
  await statusFilter(page).selectOption('in_progress');
  await openRow(page);
  await choose(page, 1);
  state.onSubmit = (route) => fail(route, 403, 'CSRF_INVALID');
  const csrf = state.csrfCount;
  await submit(page);
  await expect.poll(() => state.csrfCount).toBeGreaterThan(csrf);
  await expect(statusFilter(page)).toHaveValue('in_progress');
  await expect(selected(page).getByRole('button', { name: 'Повторить отправку', exact: true })).toBeEnabled();
  await expect(question(page, 1).getByRole('radio').first()).toBeChecked();
  await expect(question(page, 1).getByRole('radio').first()).toBeDisabled();
  expect(state.submits).toHaveLength(1);
  state.onSubmit = null;
  await selected(page).getByRole('button', { name: 'Повторить отправку', exact: true }).click();
  await page.getByRole('dialog', { name: 'Отправить ответы?', exact: true }).getByRole('button', { name: 'Подтвердить отправку', exact: true }).click();
  await expect(result(page)).toContainText('10%');
  await expect(rows(page)).toHaveCount(0);
  expect(state.submits).toHaveLength(2);
  expect(state.submits[1].body).toEqual(state.submits[0].body);
  expect(state.submits[1].headers['x-csrf-token']).not.toBe(state.submits[0].headers['x-csrf-token']);
});

test('История: повторное открытие с503 или404 не показывает старый разбор', async ({ page }) => {
  const state = await mockHistory(page, { attempts: withAttempts(saved(1, { status: 'completed', correct: 4 })) });
  await openHistory(page);
  await openRow(page, 0, true);
  await expect(result(page)).toContainText('40%');
  await closeSelected(page);
  state.onAttempt = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');
  await openRow(page, 0, true);
  await expect(selected(page).getByRole('alert').first()).toBeVisible();
  await expect(result(page)).toHaveCount(0);
  await expect(selected(page)).not.toContainText('Сырые подробности сервера.');
  await closeSelected(page);
  state.onAttempt = (route) => fail(route, 404, 'ATTEMPT_NOT_FOUND');
  await openRow(page, 0, true);
  await expect(selected(page)).toContainText(/недоступ|не найдена|удалена/i);
  await expect(result(page)).toHaveCount(0);
  await expect(selected(page).getByRole('button', { name: /Начать тест|Пройти ещё раз/ })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

test('История: материал deleting запрещает продолжение, вопросы и результат скрыты', async ({ page }) => {
  const state = await mockHistory(page, { attempts: withAttempts(saved()) });
  await openHistory(page);
  await expect(rows(page).first()).toContainText(material().title);
  state.onMaterial = (route) => fail(route, 409, 'MATERIAL_NOT_AVAILABLE');
  await openRow(page);
  await expect(selected(page)).toContainText(/недоступ|удалён|удаляется/i);
  await expect(exercise(page)).toHaveCount(0);
  await expect(selected(page).getByRole('radio')).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

test('История: перезагрузка очищает локальный выбор, известную попытку можно продолжить GET', async ({ page }) => {
  const state = await mockHistory(page, { attempts: withAttempts(saved()) });
  await openHistory(page);
  await openRow(page);
  await choose(page, 1);
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(account(page).getByRole('heading', { name: SUBJECT.title, exact: true })).toBeVisible();
  await openHistory(page);
  await openRow(page);
  await expect(exercise(page)).toContainText('Отвечено: 0 из 10');
  await expect(question(page, 1).getByRole('radio').first()).not.toBeChecked();
  expect(state.attemptGets.every((id) => id === attemptId())).toBe(true);
  expect(state.writes).toHaveLength(0);
});

test('История: переходы из материала и конкретной версии открывают соответствующие фильтры', async ({ page }) => {
  const state = await mockHistory(page, { quizzes: [quiz(), quiz(2)], attempts: withAttempts(saved(1), saved(2, { version: 2 })) });
  const files = await openMaterials(page);
  await files.getByRole('button', { name: 'Открыть тесты «' + material().title + '»', exact: true }).click();
  const quizzes = page.getByRole('region', { name: 'Тесты материала', exact: true });
  await quizzes.getByRole('button', { name: 'История материала', exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  expect(state.queries.at(-1)).toEqual({ page: '1', pageSize: '20', materialId: MATERIAL_ID });
  const reopened = await openMaterials(page);
  await reopened.getByRole('button', { name: 'Открыть тесты «' + material().title + '»', exact: true }).click();
  await quizzes.getByRole('button', { name: 'Просмотреть версию 2', exact: true }).click();
  await quizzes.getByRole('region', { name: 'Просмотр теста', exact: true }).getByRole('button', { name: 'История этой версии', exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
  expect(state.queries.at(-1)).toEqual({ page: '1', pageSize: '20', materialId: MATERIAL_ID, quizId: quizId(2) });
  expect(state.writes).toHaveLength(0);
});

test('История: выбор общей текущей попытки разделяется с материалом, старая попытка его не подменяет', async ({ page }) => {
  const current = saved(5);
  const state = await mockHistory(page, { attempts: withAttempts(saved(1)), explicitStart: current });
  const files = await openMaterials(page);
  await files.getByRole('button', { name: 'Открыть тесты «' + material().title + '»', exact: true }).click();
  const quizzes = page.getByRole('region', { name: 'Тесты материала', exact: true });
  await quizzes.getByRole('button', { name: 'Просмотреть версию 1', exact: true }).click();
  const preview = quizzes.getByRole('region', { name: 'Просмотр теста', exact: true });
  await preview.getByRole('button', { name: 'Начать тест', exact: true }).click();
  await preview.getByRole('group', { name: /^Вопрос 1\./ }).getByRole('radio').nth(1).check();
  await openHistory(page);
  await openRow(page, 0);
  await expect(question(page, 1).getByRole('radio').nth(1)).toBeChecked();
  await closeSelected(page);
  await openRow(page, 1);
  await choose(page, 1);
  const reopened = await openMaterials(page);
  await reopened.getByRole('button', { name: 'Открыть тесты «' + material().title + '»', exact: true }).click();
  await expect(preview.getByRole('group', { name: /^Вопрос 1\./ }).getByRole('radio').nth(1)).toBeChecked();
  expect(state.starts).toHaveLength(1);
  expect(state.submits).toHaveLength(0);
});

test('История: позднее название материала после навигации не возвращает список', async ({ page }) => {
  const gate = deferred();
  let responded = false;
  const state = await mockHistory(page, { attempts: withAttempts(saved()) });
  state.onMaterial = async (route) => {
    await gate.promise;
    await reply(route, material()).catch(() => {});
    responded = true;
  };
  await openHistory(page);
  try {
    await expect.poll(() => state.materialGets.length).toBe(1);
    await page.getByRole('navigation', { name: 'Основная навигация', exact: true }).getByRole('button', { name: 'Мои предметы', exact: true }).click();
    await expect(history(page)).toHaveCount(0);
  } finally { gate.resolve(); }
  await expect.poll(() => responded).toBe(true);
  await expect(history(page)).toHaveCount(0);
  await expect(account(page).getByRole('heading', { name: SUBJECT.title, exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(0);
});

test('История: поздний разбор после выхода не раскрывается в другом аккаунте', async ({ page }) => {
  const gate = deferred();
  let responded = false;
  const privateValue = saved(1, { status: 'completed', correct: 8 });
  const state = await mockHistory(page, { attempts: withAttempts(privateValue) });
  state.onAttempt = async (route) => {
    await gate.promise;
    await reply(route, privateValue).catch(() => {});
    responded = true;
  };
  await openHistory(page);
  await openRow(page, 0, true);
  try {
    await expect.poll(() => state.attemptGets.length).toBe(1);
    await account(page).getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'С возвращением!', exact: true })).toBeVisible();
    state.loginUser = OTHER_USER;
    state.subjects = [OTHER_SUBJECT];
    state.files = [];
    state.attempts = new Map();
    await login(page, OTHER_USER);
    await openHistory(page);
    await expect(rows(page)).toHaveCount(0);
  } finally { gate.resolve(); }
  await expect.poll(() => responded).toBe(true);
  await expect(selected(page)).toHaveCount(0);
  await expect(history(page)).not.toContainText('80%');
  expect(state.submits).toHaveLength(0);
});


