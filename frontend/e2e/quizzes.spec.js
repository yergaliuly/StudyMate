import { test, expect } from '@playwright/test';

// Только вымышленные HTTP-mocks: backend, R2 и OpenAI не вызываются.
const MIB = 1024 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const USER = { id: '1164903f-7ba3-40d8-8c79-b9009361b950', email: 'quizzes@example.com', displayName: 'Студент Тестов' };
const OTHER_USER = { id: '3264903f-7ba3-40d8-8c79-b9009361b951', email: 'other-quizzes@example.com', displayName: 'Другой Студент' };
const SUBJECT = {
  id: 'c6f924b2-b4b0-4926-8d28-a7409a3f2710', title: 'Математический анализ',
  description: 'Описание предмета с сервера', icon: 'book', tone: 'blue',
  lectureCount: 1, progressPercent: null, version: 1, createdAt: '2026-09-28T12:00:00Z',
};
const OTHER_SUBJECT = { ...SUBJECT, id: 'd6f924b2-b4b0-4926-8d28-a7409a3f2711', title: 'Общая физика' };
const MATERIAL_ID = 'f73de5ee-311e-45cb-b7e2-000000000001';
const SECOND_MATERIAL_ID = 'f73de5ee-311e-45cb-b7e2-000000000002';
const PROCESS_JOB = '84971941-cc75-4e13-9e67-000000000001';
const jobId = (number = 1) => 'b6fc0911-af70-4cbb-8a9b-' + String(number).padStart(12, '0');
const quizId = (number = 1) => 'e918f662-eebb-4211-86b2-' + String(number).padStart(12, '0');
const states = new WeakMap();

function material(overrides = {}) {
  return {
    id: MATERIAL_ID, subjectId: SUBJECT.id, title: 'Материал для теста',
    fileName: 'quiz-source.pdf', contentType: 'application/pdf', sizeBytes: MIB,
    status: 'stored', processingStatus: 'ready', version: 1,
    createdAt: '2026-09-28T12:00:00Z', updatedAt: '2026-09-28T12:00:00Z',
    deletionJobId: null, processingJobId: PROCESS_JOB, pageCount: 2,
    textCharacters: 1200, processingError: null, ...overrides,
  };
}

function quiz(version = 1, overrides = {}) {
  return {
    id: quizId(version), materialId: MATERIAL_ID, version, questionCount: 10,
    model: 'gpt-6-luna', createdAt: '2026-10-03T12:00:00Z',
    questions: Array.from({ length: 10 }, (_, index) => ({
      id: 'c113aa11-b122-4911-8680-' + String(version * 100 + index + 1).padStart(12, '0'),
      position: index + 1, text: 'Вопрос ' + (index + 1) + ' версии ' + version + '?',
      options: Array.from({ length: 4 }, (__, option) => ({
        id: 'd114aa11-b122-4911-8680-' + String(version * 1000 + index * 10 + option + 1).padStart(12, '0'),
        position: option + 1, text: 'Вариант ' + (option + 1) + ' вопроса ' + (index + 1),
      })),
    })),
    ...overrides,
  };
}

function generation(status = 'not_started', id = status === 'not_started' ? null : jobId(), code = 'AI_INVALID_RESPONSE') {
  return { status, jobId: id, error: status === 'failed' ? { code, message: 'Сырые подробности ИИ.' } : null };
}

function job(status, { id = jobId(), resultId = quizId(), code = 'AI_INVALID_RESPONSE' } = {}) {
  return {
    id, type: 'material.quiz', status, attemptCount: status === 'queued' ? 0 : 1, maxAttempts: 1,
    createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:01Z',
    nextAttemptAt: status === 'queued' ? '2026-10-03T12:00:01Z' : null,
    finishedAt: ['succeeded', 'failed', 'cancelled'].includes(status) ? '2026-10-03T12:00:01Z' : null,
    resultId: status === 'succeeded' ? resultId : null,
    error: status === 'failed' ? { code, message: 'Сырые подробности ИИ.' } : null,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function reply(route, data, status = 200) { return route.fulfill({ status, json: { data } }); }
function fail(route, status, code, headers = {}) {
  return route.fulfill({ status, headers, json: { error: { code, message: 'Сырые подробности сервера.', fieldErrors: {} } } });
}
function listReply(route, data) {
  const params = new URL(route.request().url()).searchParams;
  return route.fulfill({ status: 200, json: { data, meta: { page: Number(params.get('page')), pageSize: Number(params.get('pageSize')), total: data.length } } });
}
function versionsReply(route, state) {
  const params = new URL(route.request().url()).searchParams;
  const page = Number(params.get('page'));
  const pageSize = Number(params.get('pageSize'));
  const rows = state.quizzes.slice().sort((a, b) => b.version - a.version);
  const data = rows.slice((page - 1) * pageSize, page * pageSize).map(({ questions, ...value }) => value);
  return route.fulfill({ status: 200, json: { data, meta: { page, pageSize, total: rows.length, generation: state.generation } } });
}

function account(page) { return page.locator('#account-main-content'); }
function materials(page) { return page.getByRole('region', { name: 'Файлы предмета', exact: true }); }
function panel(page) { return page.getByRole('region', { name: 'Тесты материала', exact: true }); }
function detail(page) { return panel(page).getByRole('region', { name: 'Просмотр теста', exact: true }); }
function refresh(page) { return panel(page).getByRole('button', { name: 'Обновить тесты', exact: true }); }
function requestButton(page, mode = 'initial') {
  return panel(page).getByRole('button', { name: mode === 'initial' ? 'Создать тест' : mode === 'retry' ? 'Повторить запрос' : 'Создать новую версию', exact: true });
}
function consent(page, mode = 'initial') {
  return page.getByRole('dialog', { name: mode === 'initial' ? 'Создать тест?' : mode === 'retry' ? 'Повторить запрос?' : 'Создать новую версию теста?', exact: true });
}
function confirm(page, mode = 'initial') {
  return consent(page, mode).getByRole('button', { name: mode === 'initial' ? 'Подтвердить генерацию' : mode === 'retry' ? 'Подтвердить повтор' : 'Подтвердить новую генерацию', exact: true });
}
async function capture(page, testInfo, name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
}
async function capturePreview(page, testInfo, name) {
  await detail(page).getByRole('heading', { name: 'Версия 1', exact: true }).evaluate((heading) => {
    heading.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -100);
  });
  await page.screenshot({ path: testInfo.outputPath(name) });
}

async function mockQuizzes(page, options = {}) {
  const state = {
    user: USER, loginUser: USER, subjects: [SUBJECT], files: [material()], quizzes: [],
    generation: generation(), materialGets: [], lists: [], quizGets: [], jobGets: [], posts: [],
    writes: [], requests: [], csrfCount: 0, unexpected: [], pageErrors: [],
    generationJobs: new Map(), nextJob: options.generation?.jobId ? 2 : 1,
    onMaterial: null, onList: null, onQuiz: null, onPost: null, onJob: null, ...options,
  };
  states.set(page, state);
  page.on('pageerror', (error) => state.pageErrors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice('/api/v1'.length);
    const method = request.method();
    state.requests.push(method + ' ' + path);
    if (method !== 'GET') state.writes.push(method + ' ' + path);
    if (method === 'GET' && path === '/auth/csrf') {
      await reply(route, { headerName: 'X-CSRF-TOKEN', token: 'quiz-csrf-' + ++state.csrfCount });
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
      const q = (url.searchParams.get('q') || '').toLocaleLowerCase('ru');
      await listReply(route, state.files.filter((item) => item.subjectId === url.searchParams.get('subjectId') && item.title.toLocaleLowerCase('ru').includes(q)));
    } else if (method === 'GET' && /^\/materials\/[^/]+$/.test(path)) {
      const id = path.split('/')[2];
      state.materialGets.push(id);
      if (state.onMaterial) await state.onMaterial(route, id);
      else {
        const value = state.files.find((item) => item.id === id);
        if (value) await reply(route, value);
        else await fail(route, 404, 'MATERIAL_NOT_FOUND');
      }
    } else if (method === 'GET' && /^\/materials\/[^/]+\/quizzes$/.test(path)) {
      const id = path.split('/')[2];
      state.lists.push({ id, ...Object.fromEntries(url.searchParams) });
      if (state.onList) await state.onList(route, id);
      else await versionsReply(route, state);
    } else if (method === 'POST' && /^\/materials\/[^/]+\/quizzes$/.test(path)) {
      const id = path.split('/')[2];
      const key = request.headers()['idempotency-key'];
      state.posts.push({ id, key, headers: request.headers(), body: request.postData() });
      if (state.onPost) await state.onPost(route, id);
      else {
        if (!state.generationJobs.has(key)) {
          const next = jobId(state.nextJob++);
          state.generationJobs.set(key, next);
          state.generation = generation('queued', next);
        }
        await reply(route, { materialId: id, jobId: state.generationJobs.get(key) }, 202);
      }
    } else if (method === 'GET' && path.startsWith('/quizzes/')) {
      const id = path.split('/')[2];
      state.quizGets.push(id);
      if (state.onQuiz) await state.onQuiz(route, id);
      else {
        const value = state.quizzes.find((item) => item.id === id);
        if (value) await reply(route, value);
        else await fail(route, 404, 'QUIZ_NOT_FOUND');
      }
    } else if (method === 'GET' && path.startsWith('/jobs/')) {
      const id = path.split('/')[2];
      state.jobGets.push(id);
      if (state.onJob) await state.onJob(route, id);
      else {
        state.unexpected.push(method + ' ' + path);
        await fail(route, 500, 'UNEXPECTED_TEST_REQUEST');
      }
    } else if (method === 'GET' && /^\/materials\/[^/]+\/summary$/.test(path)) {
      await fail(route, 404, 'SUMMARY_NOT_FOUND');
    } else if (method === 'GET' && /^\/materials\/[^/]+\/pages$/.test(path)) {
      await listReply(route, [{ pageNumber: 1, text: 'Первая страница' }, { pageNumber: 2, text: 'Вторая страница' }]);
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
  expect(state?.unexpected ?? [], 'Неожиданные API-запросы').toEqual([]);
  expect(state?.pageErrors ?? [], 'Ошибки JavaScript в браузере').toEqual([]);
});
async function openMaterials(page, subject = SUBJECT) {
  await account(page).getByRole('button', { name: 'Открыть предмет «' + subject.title + '»', exact: true }).click();
  await page.getByRole('dialog', { name: 'Предмет', exact: true }).getByRole('button', { name: 'Материалы предмета', exact: true }).click();
  await expect(materials(page)).toBeVisible();
}
async function openQuizzes(page, item = material()) {
  await materials(page).getByRole('button', { name: 'Открыть тесты «' + item.title + '»', exact: true }).click();
  await expect(panel(page)).toBeVisible();
}
async function closeQuizzes(page) {
  await panel(page).getByRole('button', { name: 'Закрыть тесты', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
}
async function generate(page, mode = 'initial') {
  await requestButton(page, mode).click();
  await confirm(page, mode).click();
}
async function openVersion(page, version = 1) {
  await panel(page).getByRole('button', { name: 'Просмотреть версию ' + version, exact: true }).click();
  await expect(detail(page)).toBeVisible();
}
async function login(page, user) {
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Пароль', { exact: true }).fill('Only-for-quiz-tests!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(account(page).getByText(user.email, { exact: true })).toBeVisible();
}

test('Тесты: пустой список и отмена согласия не запускают генерацию', async ({ page }, testInfo) => {
  const state = await mockQuizzes(page);
  await openMaterials(page);
  await openQuizzes(page);
  await expect(requestButton(page)).toBeEnabled();
  expect(state.posts).toHaveLength(0);
  await requestButton(page).click();
  await expect(consent(page)).toContainText('OpenAI');
  await expect(consent(page)).toContainText(/баланс/i);
  await expect(consent(page)).toContainText(/ошибк/i);
  await expect(consent(page).getByRole('button', { name: 'Отмена', exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('quiz-consent-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await consent(page).boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: testInfo.outputPath('quiz-consent-mobile.png') });
  await consent(page).getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(consent(page)).toHaveCount(0);
  await expect(requestButton(page)).toBeFocused();
  expect(state.writes).toEqual([]);
});

test('Тесты: версии DESC, пагинация и безопасный просмотр 10 вопросов по 4 варианта', async ({ page }, testInfo) => {
  const rows = Array.from({ length: 21 }, (_, index) => quiz(index + 1));
  rows[0].model = 'fake-local';
  rows[0].correctOptionId = 'PRIVATE_ANSWER_KEY';
  rows[0].explanation = 'PRIVATE_ANSWER_EXPLANATION';
  rows[0].sourcePages = [999];
  rows[0].questions[0].text = '<img src=x onerror="window.quizExecuted=true"> Текст вопроса';
  rows[0].questions[0].correctOptionId = 'PRIVATE_QUESTION_ANSWER';
  rows[0].questions[0].explanation = 'PRIVATE_QUESTION_EXPLANATION';
  rows[0].questions[0].options[0].text = '<script>window.quizExecuted=true</script> Вариант';
  rows[0].questions[0].options[0].isCorrect = true;
  const state = await mockQuizzes(page, { quizzes: rows, generation: generation('ready') });
  await openMaterials(page);
  await openQuizzes(page);
  await expect(panel(page).getByRole('heading', { name: 'Версии теста', exact: true })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Просмотреть версию 21', exact: true })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Просмотреть версию 1', exact: true })).toHaveCount(0);
  await capture(page, testInfo, 'quiz-versions-desktop.png');
  const nav = panel(page).getByRole('navigation', { name: 'Страницы версий теста', exact: true });
  await nav.getByRole('button', { name: 'Следующие версии', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Просмотреть версию 1', exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Следующие версии', exact: true })).toBeDisabled();
  expect(state.lists.at(-1)).toEqual({ id: MATERIAL_ID, page: '2', pageSize: '20' });
  await openVersion(page);
  await expect(detail(page)).toContainText('Демонстрационный тест');
  await expect(detail(page).getByRole('list', { name: 'Вопросы теста', exact: true }).locator(':scope > li')).toHaveCount(10);
  for (const question of rows[0].questions) {
    await expect(detail(page).getByRole('heading').filter({ hasText: question.text })).toBeVisible();
    await expect(detail(page).getByRole('list', { name: 'Варианты ответа на вопрос ' + question.position, exact: true }).locator(':scope > li')).toHaveCount(4);
    for (const option of question.options) await expect(detail(page).getByText(option.text, { exact: true })).toBeVisible();
  }
  await expect(detail(page).locator('img, script, input, select, textarea')).toHaveCount(0);
  await expect(detail(page).getByRole('radio')).toHaveCount(0);
  await expect(detail(page).getByRole('button', { name: /отправить|завершить|ответить/i })).toHaveCount(0);
  await expect(detail(page).getByRole('button', { name: 'Начать тест', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => Boolean(window.quizExecuted))).toBe(false);
  await expect(detail(page)).not.toContainText(/правильный ответ|объяснение ответа/i);
  expect(await detail(page).innerHTML()).not.toContain('PRIVATE_');
  expect(await detail(page).innerHTML()).not.toContain('isCorrect');
  await capture(page, testInfo, 'quiz-detail-desktop.png');
  await capturePreview(page, testInfo, 'quiz-detail-viewport-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await capture(page, testInfo, 'quiz-detail-mobile.png');
  await capturePreview(page, testInfo, 'quiz-detail-viewport-mobile.png');
  await detail(page).getByRole('button', { name: 'Закрыть просмотр', exact: true }).click();
  await capture(page, testInfo, 'quiz-versions-mobile.png');
  await openVersion(page);
  expect(state.quizGets).toEqual([quizId(), quizId()]);
  expect(state.writes).toEqual([]);
});

test('Тесты: двойное подтверждение отправляет один POST; результат задания — quizId', async ({ page }) => {
  await page.clock.install();
  const gate = deferred();
  const state = await mockQuizzes(page);
  state.onPost = async (route, id) => {
    await gate.promise;
    state.generation = generation('queued');
    await reply(route, { materialId: id, jobId: jobId() }, 202);
  };
  state.onJob = async (route, id) => {
    const status = ['queued', 'running', 'succeeded'][state.jobGets.length - 1];
    if (status === 'succeeded') {
      state.quizzes = [quiz()];
      state.generation = generation('ready');
    }
    await reply(route, job(status, { id }));
  };
  await openMaterials(page);
  await openQuizzes(page);
  await requestButton(page).click();
  const before = state.requests.length;
  try {
    await confirm(page).evaluate((button) => { button.click(); button.click(); });
    await expect.poll(() => state.posts.length).toBe(1);
    const actionRequests = state.requests.slice(before).filter((value) => value.includes('/materials/' + MATERIAL_ID));
    expect(actionRequests).toEqual(['GET /materials/' + MATERIAL_ID, 'GET /materials/' + MATERIAL_ID + '/quizzes', 'POST /materials/' + MATERIAL_ID + '/quizzes']);
  } finally { gate.resolve(); }
  await expect.poll(() => state.jobGets.length).toBe(1);
  await expect(panel(page).getByRole('progressbar')).toHaveCount(0);
  await page.clock.runFor(2100);
  await expect.poll(() => state.jobGets.length).toBe(2);
  await page.clock.runFor(2100);
  await expect(detail(page).getByRole('heading', { name: 'Версия 1', exact: true })).toBeVisible();
  expect(state.quizGets).toContain(quizId());
  expect(state.quizGets).not.toContain(MATERIAL_ID);
  expect(state.posts[0].key).toMatch(UUID);
  expect(state.posts[0].headers['x-csrf-token']).toBeTruthy();
  expect(state.posts[0].headers['content-type']).toBeUndefined();
  expect(state.posts[0].body).toBeNull();
  await page.clock.runFor(5000);
  expect(state.posts).toHaveLength(1);
  expect(state.jobGets).toHaveLength(3);
});

test('Тесты: accepted 202 со старым GET наблюдает новый job и сохраняет выбранную старую версию', async ({ page }) => {
  await page.clock.install();
  const previous = Array.from({ length: 21 }, (_, index) => quiz(index + 1));
  const state = await mockQuizzes(page, { quizzes: previous, generation: generation('ready') });
  state.onPost = (route, id) => reply(route, { materialId: id, jobId: jobId(2) }, 202);
  state.onJob = async (route, id) => {
    if (state.jobGets.length === 1) await reply(route, job('running', { id }));
    else {
      state.quizzes = [quiz(22), ...previous];
      state.generation = generation('ready', jobId(2));
      await reply(route, job('succeeded', { id, resultId: quizId(22) }));
    }
  };
  await openMaterials(page);
  await openQuizzes(page);
  await panel(page).getByRole('button', { name: 'Следующие версии', exact: true }).click();
  await openVersion(page);
  await generate(page, 'new');
  await expect.poll(() => state.jobGets.length).toBe(1);
  expect(state.jobGets[0]).toBe(jobId(2));
  await expect(detail(page).getByRole('heading', { name: 'Версия 1', exact: true })).toBeVisible();
  await page.clock.runFor(2100);
  await expect(panel(page).getByRole('button', { name: 'Открыть созданную версию', exact: true })).toBeEnabled();
  await expect(detail(page).getByRole('heading', { name: 'Версия 1', exact: true })).toBeVisible();
  expect(state.lists.at(-1).page).toBe('2');
  await panel(page).getByRole('button', { name: 'Открыть созданную версию', exact: true }).click();
  await expect(detail(page).getByRole('heading', { name: 'Версия 22', exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(1);
});

test('Тесты: failed и cancelled сохраняют версии; новая генерация получает новый ключ', async ({ page }) => {
  await page.clock.install();
  const state = await mockQuizzes(page, { quizzes: [quiz()], generation: generation('ready') });
  state.onJob = async (route, id) => {
    const status = id === jobId(2) ? 'failed' : 'cancelled';
    state.generation = generation(status, id, 'QUIZ_INSUFFICIENT_CONTENT');
    await reply(route, job(status, { id, code: 'QUIZ_INSUFFICIENT_CONTENT' }));
  };
  await openMaterials(page);
  await openQuizzes(page);
  await generate(page, 'new');
  await expect(requestButton(page, 'new')).toBeEnabled();
  await expect(panel(page).getByRole('alert').first()).toBeVisible();
  await expect(panel(page)).not.toContainText('Сырые подробности ИИ.');
  await expect(panel(page).getByRole('button', { name: 'Просмотреть версию 1', exact: true })).toBeVisible();
  await page.clock.runFor(5000);
  expect(state.posts).toHaveLength(1);
  await generate(page, 'new');
  await expect(requestButton(page, 'new')).toBeEnabled();
  await expect(panel(page).getByRole('button', { name: 'Просмотреть версию 1', exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1].key).not.toBe(state.posts[0].key);
  expect(state.jobGets).toEqual([jobId(2), jobId(3)]);
});

test('Тесты: неизвестный POST и старый список допускают только явный повтор с прежним ключом', async ({ page }) => {
  await page.clock.install();
  const state = await mockQuizzes(page, { quizzes: [quiz()], generation: generation('ready') });
  state.onPost = (route) => route.abort('failed');
  state.onJob = async (route, id) => {
    state.quizzes = [quiz(2), quiz()];
    state.generation = generation('ready', id);
    await reply(route, job('succeeded', { id, resultId: quizId(2) }));
  };
  await openMaterials(page);
  await openQuizzes(page);
  await generate(page, 'new');
  await expect(requestButton(page, 'retry')).toBeEnabled();
  await refresh(page).click();
  await expect(requestButton(page, 'retry')).toBeEnabled();
  await closeQuizzes(page);
  await openQuizzes(page);
  await expect(requestButton(page, 'retry')).toBeEnabled();
  await page.clock.runFor(5000);
  expect(state.posts).toHaveLength(1);
  state.onPost = null;
  await generate(page, 'retry');
  await expect(detail(page).getByRole('heading', { name: 'Версия 2', exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1].key).toBe(state.posts[0].key);
});

test('Тесты: Retry-After переживает закрытие, срок не запускает POST автоматически', async ({ page }) => {
  await page.clock.install();
  const state = await mockQuizzes(page);
  state.onPost = (route) => fail(route, 429, 'RATE_LIMITED', { 'Retry-After': '30' });
  state.onJob = async (route, id) => {
    state.quizzes = [quiz()];
    state.generation = generation('ready', id);
    await reply(route, job('succeeded', { id }));
  };
  await openMaterials(page);
  await openQuizzes(page);
  await generate(page);
  await expect(requestButton(page, 'retry')).toBeDisabled();
  await closeQuizzes(page);
  await openQuizzes(page);
  await expect(refresh(page)).toBeDisabled();
  await page.clock.runFor(30_500);
  await expect(refresh(page)).toBeEnabled();
  expect(state.posts).toHaveLength(1);
  await refresh(page).click();
  await expect(requestButton(page, 'retry')).toBeEnabled();
  state.onPost = null;
  await generate(page, 'retry');
  await expect(detail(page)).toBeVisible();
  expect(state.posts[1].key).toBe(state.posts[0].key);
});

test('Тесты: ошибка списка не выглядит пустым состоянием, 404 материала запрещает генерацию', async ({ page }) => {
  const state = await mockQuizzes(page);
  state.onList = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');
  await openMaterials(page);
  await openQuizzes(page);
  await expect(panel(page).getByRole('alert').first()).toBeVisible();
  await expect(requestButton(page)).toBeDisabled();
  await expect(panel(page)).not.toContainText('Сырые подробности сервера.');
  state.onList = null;
  await refresh(page).click();
  await expect(requestButton(page)).toBeEnabled();
  state.files = [];
  await refresh(page).click();
  await expect(panel(page)).toContainText(/недоступ|удалён|не найден/i);
  await expect(requestButton(page)).toHaveCount(0);
  expect(state.posts).toHaveLength(0);
});

test('Тесты: stored и ready проверяются заново перед POST', async ({ page }) => {
  const state = await mockQuizzes(page);
  await openMaterials(page);
  await openQuizzes(page);
  await requestButton(page).click();
  state.files = [material({ processingStatus: 'not_started', processingJobId: null, pageCount: null, textCharacters: null })];
  await confirm(page).click();
  await expect(consent(page)).toHaveCount(0);
  await expect(panel(page)).toContainText(/текст/i);
  expect(state.posts).toHaveLength(0);
  for (const status of ['uploading', 'deleting']) {
    state.files = [material({ status, deletionJobId: status === 'deleting' ? jobId() : null })];
    await refresh(page).click();
    await expect(panel(page)).toContainText(/недоступ|удален|удалён|сохранен|сохранён/i);
    await expect(requestButton(page)).toHaveCount(0);
  }
  expect(state.writes).toEqual([]);
});

test('Тесты: новая генерация в другой вкладке между согласием и POST не запускает ещё одну', async ({ page }) => {
  const state = await mockQuizzes(page, { quizzes: [quiz()], generation: generation('ready') });
  state.onJob = (route, id) => reply(route, job('running', { id }));
  await openMaterials(page);
  await openQuizzes(page);
  await requestButton(page, 'new').click();
  state.generation = generation('running', jobId(2));
  await confirm(page, 'new').click();
  await expect.poll(() => state.jobGets.length).toBe(1);
  expect(state.jobGets[0]).toBe(jobId(2));
  expect(state.posts).toHaveLength(0);
});

test('Тесты: ошибка GET версии требует ручного повтора и не показывает прежний тест', async ({ page }) => {
  const state = await mockQuizzes(page, { quizzes: [quiz(2), quiz()], generation: generation('ready') });
  await openMaterials(page);
  await openQuizzes(page);
  await openVersion(page);
  await expect(detail(page)).toContainText('Вопрос 1 версии 1?');
  state.onQuiz = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');
  await openVersion(page, 2);
  const retry = detail(page).getByRole('button', { name: 'Повторить загрузку теста', exact: true });
  await expect(retry).toBeEnabled();
  await expect(detail(page)).not.toContainText('Вопрос 1 версии 1?');
  await expect(detail(page)).not.toContainText('Сырые подробности сервера.');
  state.onQuiz = null;
  await retry.click();
  await expect(detail(page)).toContainText('Вопрос 1 версии 2?');
  state.onQuiz = (route) => fail(route, 404, 'QUIZ_NOT_FOUND');
  await openVersion(page, 2);
  await expect(detail(page)).not.toContainText('Вопрос 1 версии 2?');
  await expect(detail(page).getByRole('alert').first()).toBeVisible();
  await expect(detail(page).getByRole('list', { name: 'Вопросы теста', exact: true })).toHaveCount(0);
  expect(state.quizGets).toEqual([quizId(), quizId(2), quizId(2), quizId(2)]);
  expect(state.posts).toHaveLength(0);
});

test('Тесты: ошибка watcher останавливает опрос и восстанавливается явным GET', async ({ page }) => {
  await page.clock.install();
  const state = await mockQuizzes(page, { quizzes: [quiz()], generation: generation('running', jobId(2)) });
  state.onJob = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');
  await openMaterials(page);
  await openQuizzes(page);
  await expect(panel(page).getByRole('alert').first()).toBeVisible();
  await page.clock.runFor(10_000);
  expect(state.jobGets).toHaveLength(1);
  await expect(panel(page).getByRole('button', { name: 'Просмотреть версию 1', exact: true })).toBeVisible();
  state.onJob = async (route, id) => {
    state.quizzes = [quiz(2), quiz()];
    state.generation = generation('ready', id);
    await reply(route, job('succeeded', { id, resultId: quizId(2) }));
  };
  await refresh(page).click();
  await expect(detail(page).getByRole('heading', { name: 'Версия 2', exact: true })).toBeVisible();
  expect(state.jobGets).toEqual([jobId(2), jobId(2)]);
  expect(state.posts).toHaveLength(0);
});

for (const [status, code] of [[401, 'AUTHENTICATION_REQUIRED'], [403, 'CSRF_INVALID']]) {
  test('Тесты: восстановление ' + code + ' требует согласия и сохраняет ключ', async ({ page }) => {
    await page.clock.install();
    const state = await mockQuizzes(page);
    state.onPost = (route) => fail(route, status, code);
    state.onJob = async (route, id) => {
      state.quizzes = [quiz()];
      state.generation = generation('ready', id);
      await reply(route, job('succeeded', { id }));
    };
    await openMaterials(page);
    await openQuizzes(page);
    const csrf = state.csrfCount;
    await generate(page);
    await expect.poll(() => state.csrfCount).toBeGreaterThan(csrf);
    await expect(requestButton(page, 'retry')).toBeEnabled();
    await page.clock.runFor(3000);
    expect(state.posts).toHaveLength(1);
    state.onPost = null;
    await generate(page, 'retry');
    await expect(detail(page)).toBeVisible();
    expect(state.posts).toHaveLength(2);
    expect(state.posts[1].key).toBe(state.posts[0].key);
    expect(state.posts[1].headers['x-csrf-token']).not.toBe(state.posts[0].headers['x-csrf-token']);
  });
}

test('Тесты: закрытие и переход к конспекту, тексту, удалению прекращают опрос', async ({ page }) => {
  await page.clock.install();
  const state = await mockQuizzes(page, { generation: generation('running') });
  state.onJob = (route, id) => reply(route, job('running', { id }));
  await openMaterials(page);
  for (const [index, destination] of ['close', 'summary', 'text', 'delete'].entries()) {
    await openQuizzes(page);
    await expect.poll(() => state.jobGets.length).toBe(index + 1);
    if (destination === 'close') await closeQuizzes(page);
    else {
      const name = destination === 'summary' ? 'Открыть конспект «' : destination === 'text' ? 'Открыть обработку и текст «' : 'Удалить материал «';
      await materials(page).getByRole('button', { name: name + material().title + '»', exact: true }).click();
      await expect(panel(page)).toHaveCount(0);
    }
    await page.clock.runFor(5000);
    expect(state.jobGets).toHaveLength(index + 1);
  }
  expect(state.posts).toHaveLength(0);
});

test('Тесты: поздний GET выбранной версии не подменяет другой материал', async ({ page }) => {
  const gate = deferred();
  let responded = false;
  const second = material({ id: SECOND_MATERIAL_ID, title: 'Второй материал' });
  const state = await mockQuizzes(page, { files: [material(), second], quizzes: [quiz()], generation: generation('ready') });
  state.onQuiz = async (route) => {
    await gate.promise;
    await reply(route, quiz()).catch(() => {});
    responded = true;
  };
  await openMaterials(page);
  await openQuizzes(page);
  await openVersion(page);
  try {
    await expect.poll(() => state.quizGets.length).toBe(1);
    state.quizzes = [];
    state.generation = generation();
    await openQuizzes(page, second);
    await expect(requestButton(page)).toBeEnabled();
  } finally { gate.resolve(); }
  await expect.poll(() => responded).toBe(true);
  await expect(detail(page)).toHaveCount(0);
  await expect(panel(page)).not.toContainText('Вопрос 1 версии 1?');
  expect(state.posts).toHaveLength(0);
});

test('Тесты: поздний POST после закрытия восстанавливается GET без новой платной попытки', async ({ page }) => {
  await page.clock.install();
  const gate = deferred();
  let responded = false;
  const state = await mockQuizzes(page);
  state.onPost = async (route, id) => {
    await gate.promise;
    state.generation = generation('queued');
    await reply(route, { materialId: id, jobId: jobId() }, 202).catch(() => {});
    responded = true;
  };
  state.onJob = async (route, id) => {
    state.quizzes = [quiz()];
    state.generation = generation('ready', id);
    await reply(route, job('succeeded', { id }));
  };
  await openMaterials(page);
  await openQuizzes(page);
  await generate(page);
  try {
    await expect.poll(() => state.posts.length).toBe(1);
    await closeQuizzes(page);
  } finally { gate.resolve(); }
  await expect.poll(() => responded).toBe(true);
  await page.clock.runFor(5000);
  expect(state.jobGets).toHaveLength(0);
  await openQuizzes(page);
  await expect(detail(page)).toBeVisible();
  expect(state.posts).toHaveLength(1);
  expect(state.jobGets).toHaveLength(1);
});

test('Тесты: поздний job после выхода не открывает результат другому аккаунту', async ({ page }) => {
  await page.clock.install();
  const gate = deferred();
  let responded = false;
  const state = await mockQuizzes(page, { generation: generation('running') });
  state.onJob = async (route, id) => {
    await gate.promise;
    await reply(route, job('succeeded', { id })).catch(() => {});
    responded = true;
  };
  await openMaterials(page);
  await openQuizzes(page);
  try {
    await expect.poll(() => state.jobGets.length).toBe(1);
    await account(page).getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'С возвращением!', exact: true })).toBeVisible();
    state.loginUser = OTHER_USER;
    state.subjects = [OTHER_SUBJECT];
    state.files = [];
    await login(page, OTHER_USER);
    await openMaterials(page, OTHER_SUBJECT);
  } finally { gate.resolve(); }
  await expect.poll(() => responded).toBe(true);
  await page.clock.runFor(5000);
  await expect(panel(page)).toHaveCount(0);
  await expect(materials(page).getByText('Пока нет материалов', { exact: true })).toBeVisible();
  expect(state.quizGets).toHaveLength(0);
  expect(state.posts).toHaveLength(0);
});
