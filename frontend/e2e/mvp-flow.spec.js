import { test, expect } from '@playwright/test';

// Сквозной stateful HTTP-mock. Backend, R2 и OpenAI не вызываются.
const MIB = 1024 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const USER = { id: '1164903f-7ba3-40d8-8c79-b9009361b950', email: 'attempts@example.com', displayName: 'Студент Тестов' };
const SUBJECT = {
  id: 'c6f924b2-b4b0-4926-8d28-a7409a3f2710', title: 'Математический анализ',
  description: 'Описание предмета с сервера', icon: 'book', tone: 'blue',
  lectureCount: 1, progressPercent: null, version: 1, createdAt: '2026-09-28T12:00:00Z',
};
const MATERIAL_ID = 'f73de5ee-311e-45cb-b7e2-000000000001';
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
const reply = (route, data, status = 200) => route.fulfill({ status, json: { data } });
function fail(route, status, code, headers = {}, fieldErrors = {}) {
  return route.fulfill({ status, headers, json: { error: { code, message: 'Сырые подробности сервера.', fieldErrors } } });
}

const PROCESS_JOB = '84971941-cc75-4e13-9e67-000000000001';
const SUMMARY_JOB = 'b6fc0911-af70-4cbb-8a9b-000000000010';
const DELETE_JOB = 'b6fc0911-af70-4cbb-8a9b-000000000099';
const quizJobId = (version) => 'b6fc0911-af70-4cbb-8a9b-' + String(20 + version).padStart(12, '0');
const PDF_FILE = { name: 'calculus.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nStateful browser fixture, no real PDF extraction.\n%%EOF\n') };
const PAGES = [
  { pageNumber: 1, text: 'Производная описывает скорость изменения функции. Производная x² равна 2x.' },
  { pageNumber: 2, text: 'Определённый интеграл положительной функции равен площади под её графиком.' },
  { pageNumber: 3, text: 'Формула Ньютона — Лейбница связывает определённый интеграл с первообразной.' },
];
const SUMMARY_CONTENT = 'Производная и интеграл\n\nПроизводная x² равна 2x (стр. 1).\nИнтеграл положительной функции выражает площадь (стр. 2).\nФормула Ньютона — Лейбница связывает интеграл с первообразной (стр. 3).';
function readyMaterial() {
  return { ...material(), sizeBytes: PDF_FILE.buffer.length, pageCount: PAGES.length,
    textCharacters: PAGES.reduce((sum, value) => sum + value.text.length, 0) };
}
function summary(ready = true) {
  return {
    materialId: MATERIAL_ID, status: ready ? 'ready' : 'queued', jobId: SUMMARY_JOB,
    version: ready ? 1 : null, content: ready ? SUMMARY_CONTENT : null,
    sourcePages: ready ? [1, 2, 3] : null, origin: ready ? 'ai' : null,
    model: ready ? 'fake-local' : null, inputTokens: ready ? 1000 : null,
    outputTokens: ready ? 100 : null, createdAt: ready ? '2026-10-03T12:00:00Z' : null,
    updatedAt: '2026-10-03T12:01:00Z', error: null,
  };
}
function job(value, done) {
  return {
    id: value.id, type: value.type, status: done ? 'succeeded' : 'running',
    attemptCount: 1, maxAttempts: ['material.summary', 'material.quiz'].includes(value.type) ? 1 : 3,
    createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:01Z',
    nextAttemptAt: null, finishedAt: done ? '2026-10-03T12:00:01Z' : null,
    resultId: done ? value.resultId : null, error: null,
  };
}
function pageReply(route, values, extra = {}) {
  const query = new URL(route.request().url()).searchParams;
  const page = Number(query.get('page'));
  const pageSize = Number(query.get('pageSize'));
  return route.fulfill({ status: 200, json: { data: values.slice((page - 1) * pageSize, page * pageSize),
    meta: { page, pageSize, total: values.length, ...extra } } });
}
function account(page) { return page.locator('#account-main-content'); }
function files(page) { return page.getByRole('region', { name: 'Файлы предмета', exact: true }); }
function textPanel(page) { return page.getByRole('region', { name: 'Текст материала', exact: true }); }
function summaryPanel(page) { return page.getByRole('region', { name: 'Конспект материала', exact: true }); }
function quizPanel(page) { return page.getByRole('region', { name: 'Тесты материала', exact: true }); }
function preview(page) { return quizPanel(page).getByRole('region', { name: 'Просмотр теста', exact: true }); }
function history(page) { return page.getByRole('region', { name: 'История попыток', exact: true }); }
function historyRows(page) { return history(page).getByRole('list', { name: 'Попытки', exact: true }).locator(':scope > li'); }
function exercise(page) { return page.getByRole('region', { name: 'Прохождение теста', exact: true }); }
function result(page) { return page.getByRole('region', { name: 'Результат теста', exact: true }); }
function question(page, number) { return exercise(page).getByRole('group', { name: new RegExp('^Вопрос ' + number + '\\.') }); }

async function mockMvp(page, { prepared = false } = {}) {
  const state = {
    user: null, subject: prepared ? { ...SUBJECT } : null,
    file: prepared ? readyMaterial() : null, summary: prepared ? summary() : null,
    quizzes: prepared ? [quiz()] : [], generation: prepared
      ? { status: 'ready', jobId: quizJobId(1), error: null }
      : { status: 'not_started', jobId: null, error: null },
    attempts: new Map(), jobs: new Map(), keys: new Map(), nextAttempt: 1,
    requests: [], writes: [], unexpected: [], pageErrors: [], csrfCount: 0,
  };
  states.set(page, state);
  page.on('pageerror', (error) => state.pageErrors.push(error.message));
  function beginJob(id, type, resultId, complete) {
    state.jobs.set(id, { id, type, resultId, complete, reads: 0, done: false });
  }
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice('/api/v1'.length);
    const method = request.method();
    const headers = request.headers();
    const key = headers['idempotency-key'];
    state.requests.push(method + ' ' + path);
    if (method !== 'GET') {
      state.writes.push({ method, path, key, headers, body: request.postData() });
      if (!headers['x-csrf-token']) state.unexpected.push('Нет CSRF: ' + method + ' ' + path);
    }
    if (method === 'GET' && path === '/auth/csrf') {
      await reply(route, { headerName: 'X-CSRF-TOKEN', token: 'mvp-csrf-' + ++state.csrfCount });
    } else if (method === 'GET' && path === '/auth/me') {
      if (state.user) await reply(route, state.user);
      else await fail(route, 401, 'AUTHENTICATION_REQUIRED');
    } else if (method === 'POST' && path === '/auth/login') {
      state.user = USER;
      await reply(route, state.user);
    } else if (method === 'POST' && path === '/auth/logout') {
      state.user = null;
      await route.fulfill({ status: 204, body: '' });
    } else if (!state.user) {
      await fail(route, 401, 'AUTHENTICATION_REQUIRED');
    } else if (method === 'GET' && path === '/subjects') {
      await pageReply(route, state.subject ? [{ ...state.subject, lectureCount: state.file ? 1 : 0 }] : []);
    } else if (method === 'POST' && path === '/subjects') {
      state.subject = { ...SUBJECT, ...request.postDataJSON(), lectureCount: 0 };
      await reply(route, state.subject, 201);
    } else if (method === 'GET' && path === '/subjects/' + SUBJECT.id) {
      await reply(route, { ...state.subject, lectureCount: state.file ? 1 : 0 });
    } else if (method === 'GET' && path === '/storage/usage') {
      await reply(route, { usedBytes: state.file?.sizeBytes ?? 0, reservedBytes: 0, limitBytes: 500 * MIB, maxUploadBytes: 25 * MIB });
    } else if (method === 'GET' && path === '/materials') {
      await pageReply(route, state.file && (!url.searchParams.has('subjectId') || url.searchParams.get('subjectId') === SUBJECT.id) ? [state.file] : []);
    } else if (method === 'POST' && path === '/materials') {
      if (!state.keys.has(key)) {
        state.file = { ...readyMaterial(), processingStatus: 'queued', pageCount: null, textCharacters: null };
        state.keys.set(key, structuredClone(state.file));
        beginJob(PROCESS_JOB, 'material.extract_text', MATERIAL_ID, () => { state.file = readyMaterial(); });
      }
      await reply(route, state.keys.get(key), 201);
    } else if (method === 'GET' && path === '/materials/' + MATERIAL_ID) {
      if (state.file) await reply(route, state.file);
      else await fail(route, 404, 'MATERIAL_NOT_FOUND');
    } else if (method === 'GET' && path === '/materials/' + MATERIAL_ID + '/pages') {
      if (state.file?.processingStatus === 'ready') await pageReply(route, PAGES);
      else await fail(route, 409, 'TEXT_NOT_READY');
    } else if (method === 'GET' && path === '/materials/' + MATERIAL_ID + '/summary') {
      if (!state.file) await fail(route, 404, 'MATERIAL_NOT_FOUND');
      else if (state.summary) await reply(route, state.summary);
      else await fail(route, 404, 'SUMMARY_NOT_FOUND');
    } else if (method === 'POST' && path === '/materials/' + MATERIAL_ID + '/summary') {
      if (!state.keys.has(key)) {
        state.summary = summary(false);
        state.keys.set(key, SUMMARY_JOB);
        beginJob(SUMMARY_JOB, 'material.summary', MATERIAL_ID, () => { state.summary = summary(); });
      }
      await reply(route, { materialId: MATERIAL_ID, jobId: state.keys.get(key) }, 202);
    } else if (method === 'GET' && path === '/materials/' + MATERIAL_ID + '/quizzes') {
      await pageReply(route, state.quizzes.slice().reverse().map(({ questions, ...value }) => value), { generation: state.generation });
    } else if (method === 'POST' && path === '/materials/' + MATERIAL_ID + '/quizzes') {
      if (!state.keys.has(key)) {
        const version = state.quizzes.length + 1;
        const id = quizJobId(version);
        state.keys.set(key, id);
        state.generation = { status: 'queued', jobId: id, error: null };
        beginJob(id, 'material.quiz', quizId(version), () => {
          state.quizzes.push(quiz(version));
          state.generation = { status: 'ready', jobId: id, error: null };
        });
      }
      await reply(route, { materialId: MATERIAL_ID, jobId: state.keys.get(key) }, 202);
    } else if (method === 'GET' && /^\/quizzes\/[^/]+$/.test(path)) {
      const value = state.quizzes.find((item) => item.id === path.split('/')[2]);
      if (value) await reply(route, value);
      else await fail(route, 404, 'QUIZ_NOT_FOUND');
    } else if (method === 'POST' && /^\/quizzes\/[^/]+\/attempts$/.test(path)) {
      if (!state.keys.has(key)) {
        const number = state.nextAttempt++;
        const value = attempt(state.quizzes.find((item) => item.id === path.split('/')[2]), attemptId(number));
        value.startedAt = '2026-10-03T12:' + String(10 + number).padStart(2, '0') + ':00Z';
        state.attempts.set(value.id, value);
        state.keys.set(key, value.id);
      }
      await reply(route, state.attempts.get(state.keys.get(key)), 201);
    } else if (method === 'POST' && /^\/attempts\/[^/]+\/submit$/.test(path)) {
      const id = path.split('/')[2];
      const previous = state.attempts.get(id);
      const value = previous.status === 'completed' ? previous : completed(previous, request.postDataJSON().answers);
      state.attempts.set(id, value);
      await reply(route, value);
    } else if (method === 'GET' && /^\/attempts\/[^/]+$/.test(path)) {
      const value = state.attempts.get(path.split('/')[2]);
      if (value) await reply(route, value);
      else await fail(route, 404, 'ATTEMPT_NOT_FOUND');
    } else if (method === 'GET' && path === '/attempts') {
      const values = [...state.attempts.values()].filter((value) => state.file?.status === 'stored'
        && ['status', 'materialId', 'quizId'].every((field) => !url.searchParams.has(field) || url.searchParams.get(field) === value[field]))
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id))
        .map(({ questions, review, ...value }) => value);
      await pageReply(route, values);
    } else if (method === 'DELETE' && path === '/materials/' + MATERIAL_ID) {
      state.file = { ...state.file, status: 'deleting', deletionJobId: DELETE_JOB };
      beginJob(DELETE_JOB, 'material.delete', MATERIAL_ID, () => {
        state.file = null;
        state.summary = null;
        state.quizzes = [];
        state.attempts.clear();
      });
      await reply(route, { materialId: MATERIAL_ID, jobId: DELETE_JOB }, 202);
    } else if (method === 'GET' && path.startsWith('/jobs/')) {
      const value = state.jobs.get(path.split('/')[2]);
      if (!value) {
        state.unexpected.push(method + ' ' + path);
        await fail(route, 404, 'JOB_NOT_FOUND');
      } else {
        value.reads += 1;
        if (value.reads >= 2 && !value.done) { value.complete(); value.done = true; }
        await reply(route, job(value, value.done));
      }
    } else {
      state.unexpected.push(method + ' ' + path);
      await fail(route, 500, 'UNEXPECTED_TEST_REQUEST');
    }
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'С возвращением!', exact: true })).toBeVisible();
  return state;
}

test.afterEach(async ({ page }) => {
  const state = states.get(page);
  expect(state?.unexpected ?? [], 'Неожиданные или небезопасные mock API-запросы').toEqual([]);
  expect(state?.pageErrors ?? [], 'Ошибки JavaScript').toEqual([]);
});
async function login(page) {
  await page.getByLabel('Email', { exact: true }).fill(USER.email);
  await page.getByLabel('Пароль', { exact: true }).fill('Only-for-MVP-flow!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(account(page).getByText(USER.email, { exact: true })).toBeVisible();
}
async function navigate(page, label) {
  const navigation = page.getByRole('navigation', { name: 'Основная навигация', exact: true });
  if (!await navigation.isVisible()) await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
  await navigation.getByRole('button', { name: label, exact: true }).click();
}
async function openMaterials(page) {
  await navigate(page, 'Мои предметы');
  await account(page).getByRole('button', { name: 'Открыть предмет «' + SUBJECT.title + '»', exact: true }).click();
  await page.getByRole('dialog', { name: 'Предмет', exact: true }).getByRole('button', { name: 'Материалы предмета', exact: true }).click();
  await expect(files(page)).toBeVisible();
}
async function finishJob(page, state, id) {
  await expect.poll(() => state.jobs.get(id)?.reads).toBe(1);
  await page.clock.runFor(2100);
  await expect.poll(() => state.jobs.get(id)?.done).toBe(true);
}
async function openQuizzes(page) {
  await files(page).getByRole('button', { name: 'Открыть тесты «' + material().title + '»', exact: true }).click();
  await expect(quizPanel(page)).toBeVisible();
}
async function confirmGeneration(page, kind, isNew = false) {
  const panel = kind === 'summary' ? summaryPanel(page) : quizPanel(page);
  const button = kind === 'summary' ? 'Создать конспект' : isNew ? 'Создать новую версию' : 'Создать тест';
  const title = kind === 'summary' ? 'Создать конспект?' : isNew ? 'Создать новую версию теста?' : 'Создать тест?';
  await panel.getByRole('button', { name: button, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await expect(dialog).toContainText('OpenAI');
  await expect(dialog).toContainText(/баланс/);
  await dialog.getByRole('button', { name: isNew ? 'Подтвердить новую генерацию' : 'Подтвердить генерацию', exact: true }).click();
}
async function sendAnswers(page) {
  await exercise(page).getByRole('button', { name: 'Отправить ответы', exact: true }).click();
  await page.getByRole('dialog', { name: 'Отправить ответы?', exact: true }).getByRole('button', { name: 'Подтвердить отправку', exact: true }).click();
}
function writesTo(state, path) { return state.writes.filter((value) => value.path === path); }
async function capture(page, testInfo, region, filename) {
  await region.getByRole('heading').first().evaluate((heading) => {
    heading.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -100);
  });
  await page.screenshot({ path: testInfo.outputPath(filename) });
}

test('MVP: вход, предмет, PDF, конспект, тест, результат и удаление всех связанных данных', async ({ page }, testInfo) => {
  await page.clock.install();
  const state = await mockMvp(page);
  await login(page);
  await account(page).getByRole('button', { name: 'Добавить предмет', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Новый предмет', exact: true });
  await create.getByLabel('Название предмета').fill(SUBJECT.title);
  await create.getByLabel('Описание').fill('Производные и интегралы');
  await create.getByRole('button', { name: 'Создать предмет', exact: true }).click();
  await expect(account(page).getByRole('heading', { name: SUBJECT.title, exact: true })).toBeVisible();
  await openMaterials(page);
  await expect(files(page).getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
  const upload = page.getByRole('region', { name: 'Загрузить PDF', exact: true });
  await upload.getByLabel('PDF-файл', { exact: true }).setInputFiles(PDF_FILE);
  await upload.getByLabel('Название материала', { exact: false }).fill(material().title);
  await upload.getByRole('button', { name: 'Загрузить PDF', exact: true }).click();
  await expect(textPanel(page)).toBeVisible();
  await finishJob(page, state, PROCESS_JOB);
  await expect(textPanel(page)).toContainText(PAGES[0].text);
  await expect(textPanel(page)).toContainText(PAGES[2].text);
  await expect(files(page).getByRole('meter')).toHaveAttribute('aria-valuenow', String(PDF_FILE.buffer.length));
  const uploaded = writesTo(state, '/materials')[0];
  expect(uploaded.key).toMatch(UUID);
  expect(uploaded.headers['content-type']).toContain('multipart/form-data');
  expect(uploaded.body).toContain('name="subjectId"');
  expect(uploaded.body).toContain(SUBJECT.id);
  expect(uploaded.body).toContain('name="file"; filename="' + PDF_FILE.name + '"');
  expect(uploaded.body).toContain('Content-Type: application/pdf\r\n\r\n');
  expect(uploaded.body).toContain(PDF_FILE.buffer.toString('utf8'));
  expect(uploaded.body).toContain('name="title"\r\n\r\n' + material().title + '\r\n');
  expect(writesTo(state, '/materials/' + MATERIAL_ID + '/process')).toHaveLength(0);
  expect(writesTo(state, '/materials/' + MATERIAL_ID + '/summary')).toHaveLength(0);
  expect(writesTo(state, '/materials/' + MATERIAL_ID + '/quizzes')).toHaveLength(0);

  await files(page).getByRole('button', { name: 'Открыть конспект «' + material().title + '»', exact: true }).click();
  await expect(textPanel(page)).toHaveCount(0);
  await summaryPanel(page).getByRole('button', { name: 'Создать конспект', exact: true }).click();
  await page.getByRole('dialog', { name: 'Создать конспект?', exact: true }).getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(writesTo(state, '/materials/' + MATERIAL_ID + '/summary')).toHaveLength(0);
  await confirmGeneration(page, 'summary');
  await finishJob(page, state, SUMMARY_JOB);
  await expect(summaryPanel(page)).toContainText(SUMMARY_CONTENT);
  await expect(summaryPanel(page)).toContainText('Демонстрационный конспект');
  await capture(page, testInfo, summaryPanel(page), 'mvp-summary-desktop.png');

  await openQuizzes(page);
  await expect(summaryPanel(page)).toHaveCount(0);
  await expect(quizPanel(page)).toContainText('Сохранённых версий пока нет.');
  await confirmGeneration(page, 'quiz');
  await finishJob(page, state, quizJobId(1));
  await expect(preview(page).getByRole('heading', { name: 'Версия 1', exact: true })).toBeVisible();
  await preview(page).getByRole('button', { name: 'Начать тест', exact: true }).click();
  await question(page, 1).getByRole('radio').first().check();
  await question(page, 2).getByRole('radio').first().check();
  await question(page, 3).getByRole('radio').nth(1).check();
  await expect(exercise(page)).toContainText('Отвечено: 3 из 10');
  await sendAnswers(page);
  await expect(result(page).locator('.quiz-attempt-score strong')).toHaveText('20%');
  await expect(result(page)).toContainText('Правильных ответов: 2 из 10');
  await navigate(page, 'Результаты');
  await expect(historyRows(page)).toHaveCount(1);
  await expect(historyRows(page).first().locator('.attempt-history-score')).toHaveText('20% Правильных ответов: 2 из 10');
  await expect(historyRows(page).first()).toContainText(material().title);
  await historyRows(page).first().getByRole('button', { name: 'Открыть результат', exact: true }).click();
  await expect(result(page).locator('.quiz-attempt-score strong')).toHaveText('20%');
  await expect(result(page)).toContainText('Страницы PDF: 1, 3.');
  await capture(page, testInfo, result(page), 'mvp-result-desktop.png');
  const paidBeforeDeletion = state.writes.filter((value) => /\/(summary|quizzes)$/.test(value.path));
  expect(paidBeforeDeletion).toHaveLength(2);
  expect(paidBeforeDeletion.every((value) => UUID.test(value.key))).toBe(true);
  expect(new Set(paidBeforeDeletion.map((value) => value.key)).size).toBe(2);
  expect(paidBeforeDeletion.every((value) => value.body === null)).toBe(true);

  await openMaterials(page);
  await files(page).getByRole('button', { name: 'Удалить материал «' + material().title + '»', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Удаление материала', exact: true });
  await expect(deletion).toContainText('Материал и связанные конспекты, тесты и история попыток будут удалены');
  await deletion.getByRole('button', { name: 'Удалить материал', exact: true }).click();
  await expect(deletion).toContainText('Удаление выполняется');
  await expect(files(page).locator('[role="meter"]')).toHaveAttribute('aria-valuenow', String(PDF_FILE.buffer.length));
  await finishJob(page, state, DELETE_JOB);
  await expect(deletion).toContainText('Материал удалён.');
  await deletion.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(files(page).getByText('Пока нет материалов', { exact: true })).toBeVisible();
  await expect(files(page).getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
  await navigate(page, 'Результаты');
  await expect(history(page).getByRole('heading', { name: 'Пока нет попыток', exact: true })).toBeVisible();
  await expect(historyRows(page)).toHaveCount(0);
  expect(state.summary).toBeNull();
  expect(state.quizzes).toHaveLength(0);
  expect(state.attempts.size).toBe(0);
  expect(state.requests.slice(state.requests.indexOf('DELETE /materials/' + MATERIAL_ID))).toContain('GET /materials/' + MATERIAL_ID);
  await page.clock.runFor(5000);
  expect(state.writes.map((value) => value.method + ' ' + value.path)).toEqual([
    'POST /auth/login', 'POST /subjects', 'POST /materials',
    'POST /materials/' + MATERIAL_ID + '/summary', 'POST /materials/' + MATERIAL_ID + '/quizzes',
    'POST /quizzes/' + quizId(1) + '/attempts', 'POST /attempts/' + attemptId(1) + '/submit',
    'DELETE /materials/' + MATERIAL_ID,
  ]);
});

test('MVP mobile: клавиатурный выбор, reload/resume и новая версия сохраняют прежние результаты', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
  const state = await mockMvp(page, { prepared: true });
  await login(page);
  await openMaterials(page);
  await files(page).getByRole('button', { name: 'Открыть конспект «' + material().title + '»', exact: true }).click();
  await expect(summaryPanel(page)).toContainText(SUMMARY_CONTENT);
  await capture(page, testInfo, summaryPanel(page), 'mvp-summary-mobile.png');
  await openQuizzes(page);
  await quizPanel(page).getByRole('button', { name: 'Просмотреть версию 1', exact: true }).click();
  await preview(page).getByRole('button', { name: 'Начать тест', exact: true }).click();
  const first = question(page, 1).getByRole('radio').first();
  await first.focus();
  await page.keyboard.press('ArrowDown');
  await expect(question(page, 1).getByRole('radio').nth(1)).toBeChecked();
  await page.keyboard.press('ArrowUp');
  await expect(first).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(question(page, 1).getByRole('button', { name: 'Сбросить ответ', exact: true })).toBeFocused();
  await navigate(page, 'Результаты');
  await historyRows(page).first().getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(question(page, 1).getByRole('radio').first()).toBeChecked();
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(account(page).getByText(USER.email, { exact: true })).toBeVisible();
  await navigate(page, 'Результаты');
  await historyRows(page).first().getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(exercise(page)).toContainText('Отвечено: 0 из 10');
  await question(page, 2).getByRole('radio').first().focus();
  await page.keyboard.press('Space');
  await expect(question(page, 2).getByRole('radio').first()).toBeChecked();
  const send = exercise(page).getByRole('button', { name: 'Отправить ответы', exact: true });
  await send.focus();
  await page.keyboard.press('Enter');
  const confirmation = page.getByRole('dialog', { name: 'Отправить ответы?', exact: true });
  await expect(confirmation.getByRole('button', { name: 'Вернуться к вопросам', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(send).toBeFocused();
  expect(writesTo(state, '/attempts/' + attemptId(1) + '/submit')).toHaveLength(0);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(confirmation.getByRole('button', { name: 'Подтвердить отправку', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(result(page).locator('.quiz-attempt-score strong')).toHaveText('10%');
  await capture(page, testInfo, result(page), 'mvp-resumed-result-mobile.png');
  const oldAttempt = structuredClone(state.attempts.get(attemptId(1)));

  await openMaterials(page);
  await openQuizzes(page);
  await confirmGeneration(page, 'quiz', true);
  await finishJob(page, state, quizJobId(2));
  const openCreated = quizPanel(page).getByRole('button', { name: 'Открыть созданную версию', exact: true });
  if (await openCreated.isVisible()) await openCreated.click();
  await expect(preview(page).getByRole('heading', { name: 'Версия 2', exact: true })).toBeVisible();
  await preview(page).getByRole('button', { name: 'Начать тест', exact: true }).click();
  await sendAnswers(page);
  await expect(result(page).locator('.quiz-attempt-score strong')).toHaveText('0%');
  await navigate(page, 'Результаты');
  await expect(historyRows(page)).toHaveCount(2);
  await expect(historyRows(page).first()).toContainText('Версия 2');
  await expect(historyRows(page).first().locator('.attempt-history-score')).toHaveText('0% Правильных ответов: 0 из 10');
  await expect(historyRows(page).nth(1)).toContainText('Версия 1');
  await expect(historyRows(page).nth(1).locator('.attempt-history-score')).toHaveText('10% Правильных ответов: 1 из 10');
  await capture(page, testInfo, history(page), 'mvp-history-mobile.png');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(state.attempts.get(attemptId(1))).toEqual(oldAttempt);
  expect(writesTo(state, '/materials/' + MATERIAL_ID + '/summary')).toHaveLength(0);
  expect(writesTo(state, '/materials/' + MATERIAL_ID + '/quizzes')).toHaveLength(1);
  const starts = state.writes.filter((value) => /^\/quizzes\/[^/]+\/attempts$/.test(value.path));
  expect(starts).toHaveLength(2);
  expect(starts.map((value) => value.path)).toEqual(['/quizzes/' + quizId(1) + '/attempts', '/quizzes/' + quizId(2) + '/attempts']);
  expect(starts.every((value) => UUID.test(value.key))).toBe(true);
  expect(new Set(starts.map((value) => value.key)).size).toBe(2);
  expect(writesTo(state, '/attempts/' + attemptId(1) + '/submit')).toHaveLength(1);
  expect(writesTo(state, '/attempts/' + attemptId(2) + '/submit')).toHaveLength(1);
});


