import { test, expect } from '@playwright/test';

// Вымышленные HTTP-ответы. Эти проверки не обращаются к backend, R2 или OpenAI.
const MIB = 1024 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const USER = {
  id: '1164903f-7ba3-40d8-8c79-b9009361b950',
  email: 'summaries@example.com',
  displayName: 'Студент Конспектов',
};
const OTHER_USER = {
  id: '3264903f-7ba3-40d8-8c79-b9009361b951',
  email: 'other-summaries@example.com',
  displayName: 'Другой Студент',
};
const SUBJECT = {
  id: 'c6f924b2-b4b0-4926-8d28-a7409a3f2710',
  title: 'Математический анализ',
  description: 'Описание предмета с сервера',
  icon: 'book',
  tone: 'blue',
  lectureCount: 1,
  progressPercent: null,
  version: 1,
  createdAt: '2026-09-28T12:00:00Z',
};
const OTHER_SUBJECT = { ...SUBJECT, id: 'd6f924b2-b4b0-4926-8d28-a7409a3f2711', title: 'Общая физика' };
const MATERIAL_ID = 'f73de5ee-311e-45cb-b7e2-000000000001';
const SECOND_MATERIAL_ID = 'f73de5ee-311e-45cb-b7e2-000000000002';
const PROCESS_JOB = '84971941-cc75-4e13-9e67-000000000001';
const SUMMARY_JOB = 'b6fc0911-af70-4cbb-8a9b-000000000001';
const SUMMARY_JOB_2 = 'b6fc0911-af70-4cbb-8a9b-000000000002';
const SUMMARY_JOB_3 = 'b6fc0911-af70-4cbb-8a9b-000000000003';
const SOURCE_CONTENT = 'Основной тезис лекции (стр. 1)\n\nПодробное объяснение второго тезиса (стр. 2).';
const states = new WeakMap();

function material(overrides = {}) {
  return {
    id: MATERIAL_ID,
    subjectId: SUBJECT.id,
    title: 'Материал для конспекта',
    fileName: 'summary-source.pdf',
    contentType: 'application/pdf',
    sizeBytes: MIB,
    status: 'stored',
    processingStatus: 'ready',
    version: 1,
    createdAt: '2026-09-28T12:00:00Z',
    updatedAt: '2026-09-28T12:00:00Z',
    deletionJobId: null,
    processingJobId: PROCESS_JOB,
    pageCount: 2,
    textCharacters: 1200,
    processingError: null,
    ...overrides,
  };
}

function summary(status = 'ready', overrides = {}) {
  const saved = status === 'ready';
  return {
    materialId: MATERIAL_ID,
    status,
    jobId: SUMMARY_JOB,
    version: saved ? 1 : null,
    content: saved ? SOURCE_CONTENT : null,
    sourcePages: saved ? [1, 2] : null,
    origin: saved ? 'ai' : null,
    model: saved ? 'gpt-6-luna' : null,
    inputTokens: saved ? 1200 : null,
    outputTokens: saved ? 100 : null,
    createdAt: saved ? '2026-10-01T12:00:00Z' : null,
    updatedAt: '2026-10-01T12:00:01Z',
    error: status === 'failed'
      ? { code: 'AI_INVALID_RESPONSE', message: 'Внутренние подробности провайдера.' }
      : null,
    ...overrides,
  };
}

function job(status, overrides = {}) {
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(status);
  return {
    id: SUMMARY_JOB,
    type: 'material.summary',
    status,
    attemptCount: status === 'queued' ? 0 : 1,
    maxAttempts: 1,
    createdAt: '2026-10-01T12:00:00Z',
    updatedAt: '2026-10-01T12:00:01Z',
    nextAttemptAt: status === 'queued' ? '2026-10-01T12:00:01Z' : null,
    finishedAt: terminal ? '2026-10-01T12:00:01Z' : null,
    resultId: status === 'succeeded' ? MATERIAL_ID : null,
    error: status === 'failed'
      ? { code: 'AI_INVALID_RESPONSE', message: 'Внутренние подробности провайдера.' }
      : null,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function reply(route, data, status = 200) {
  return route.fulfill({ status, json: { data } });
}

function fail(route, status, code, headers = {}, fieldErrors = {}) {
  return route.fulfill({
    status,
    headers,
    json: { error: { code, message: 'Внутренние подробности сервера.', fieldErrors } },
  });
}

function listReply(route, data, total = data.length) {
  const params = new URL(route.request().url()).searchParams;
  return route.fulfill({
    status: 200,
    json: { data, meta: { page: Number(params.get('page')), pageSize: Number(params.get('pageSize')), total } },
  });
}

function account(page) { return page.locator('#account-main-content'); }
async function captureSummaryPage(page, testInfo, fileName) {
  // Full-page capture positions fixed navigation at the current scroll offset.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath(fileName), fullPage: true });
}
function materials(page) { return page.getByRole('region', { name: 'Файлы предмета', exact: true }); }
function summaryPanel(page) { return page.getByRole('region', { name: 'Конспект материала', exact: true }); }
function consent(page, retry = false) {
  return page.getByRole('dialog', { name: retry ? 'Повторить запрос?' : 'Создать конспект?', exact: true });
}
function createButton(page) { return summaryPanel(page).getByRole('button', { name: 'Создать конспект', exact: true }); }
function refreshButton(page) { return summaryPanel(page).getByRole('button', { name: 'Обновить конспект', exact: true }); }
function retryButton(page) { return summaryPanel(page).getByRole('button', { name: 'Повторить запрос', exact: true }); }
function confirmButton(page, retry = false) {
  return consent(page, retry).getByRole('button', {
    name: retry ? 'Подтвердить повтор' : 'Подтвердить генерацию', exact: true,
  });
}

async function mockSummaries(page, options = {}) {
  const state = {
    user: USER,
    loginUser: USER,
    subjects: [SUBJECT],
    files: [material()],
    summary: null,
    summaryGets: [],
    materialGets: [],
    jobGets: [],
    posts: [],
    patches: [],
    generationJobs: new Map(),
    nextSummaryJob: options.summary ? 2 : 1,
    writes: [],
    requests: [],
    csrfCount: 0,
    unexpected: [],
    pageErrors: [],
    onMaterial: null,
    onSummaryGet: null,
    onSummaryPost: null,
    onSummaryPatch: null,
    onJob: null,
    ...options,
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
      await reply(route, { headerName: 'X-CSRF-TOKEN', token: 'summaries-csrf-' + ++state.csrfCount });
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
      const item = state.subjects.find((value) => value.id === path.slice('/subjects/'.length));
      if (item) await reply(route, item);
      else await fail(route, 404, 'SUBJECT_NOT_FOUND');
    } else if (method === 'GET' && path === '/storage/usage') {
      await reply(route, { usedBytes: MIB, reservedBytes: 0, limitBytes: 500 * MIB, maxUploadBytes: 25 * MIB });
    } else if (method === 'GET' && path === '/materials') {
      const q = (url.searchParams.get('q') || '').toLocaleLowerCase('ru');
      await listReply(route, state.files.filter((value) =>
        value.subjectId === url.searchParams.get('subjectId') && value.title.toLocaleLowerCase('ru').includes(q)));
    } else if (method === 'GET' && /^\/materials\/[^/]+$/.test(path)) {
      const id = path.split('/')[2];
      state.materialGets.push(id);
      if (state.onMaterial) await state.onMaterial(route, id);
      else {
        const item = state.files.find((value) => value.id === id);
        if (item) await reply(route, item);
        else await fail(route, 404, 'MATERIAL_NOT_FOUND');
      }
    } else if (method === 'GET' && /^\/materials\/[^/]+\/summary$/.test(path)) {
      const id = path.split('/')[2];
      state.summaryGets.push(id);
      if (state.onSummaryGet) await state.onSummaryGet(route, id);
      else if (state.summary) await reply(route, state.summary);
      else await fail(route, 404, 'SUMMARY_NOT_FOUND');
    } else if (method === 'POST' && /^\/materials\/[^/]+\/summary$/.test(path)) {
      const id = path.split('/')[2];
      state.posts.push({ id, key: request.headers()['idempotency-key'], headers: request.headers(), body: request.postData() });
      if (state.onSummaryPost) await state.onSummaryPost(route, id);
      else {
        const key = request.headers()['idempotency-key'];
        if (!state.generationJobs.has(key)) {
          const jobId = 'b6fc0911-af70-4cbb-8a9b-' + String(state.nextSummaryJob++).padStart(12, '0');
          state.generationJobs.set(key, jobId);
          state.summary = state.summary
            ? { ...state.summary, status: 'queued', jobId, error: null }
            : summary('queued', { materialId: id, jobId });
        }
        await reply(route, { materialId: id, jobId: state.generationJobs.get(key) }, 202);
      }
    } else if (method === 'PATCH' && /^\/materials\/[^/]+\/summary$/.test(path)) {
      const id = path.split('/')[2];
      const body = request.postDataJSON();
      state.patches.push({ id, body, headers: request.headers() });
      if (state.onSummaryPatch) await state.onSummaryPatch(route, id);
      else if (!state.summary) await fail(route, 404, 'SUMMARY_NOT_FOUND');
      else if (['queued', 'running'].includes(state.summary.status)) await fail(route, 409, 'SUMMARY_IN_PROGRESS');
      else if (body.version !== state.summary.version) await fail(route, 409, 'SUMMARY_VERSION_CONFLICT');
      else {
        state.summary = {
          ...state.summary, content: body.content, version: body.version + 1,
          origin: 'user', model: null, sourcePages: [], inputTokens: null, outputTokens: null,
        };
        await reply(route, state.summary);
      }
    } else if (method === 'GET' && path.startsWith('/jobs/')) {
      const id = path.slice('/jobs/'.length);
      state.jobGets.push(id);
      if (state.onJob) await state.onJob(route, id);
      else {
        state.unexpected.push(method + ' ' + path);
        await fail(route, 500, 'UNEXPECTED_TEST_REQUEST');
      }
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
  await page.getByRole('dialog', { name: 'Предмет', exact: true })
    .getByRole('button', { name: 'Материалы предмета', exact: true }).click();
  await expect(materials(page)).toBeVisible();
}

async function openSummary(page, item = material()) {
  await materials(page).getByRole('button', { name: 'Открыть конспект «' + item.title + '»', exact: true }).click();
  await expect(summaryPanel(page)).toBeVisible();
}

async function closeSummary(page) {
  await summaryPanel(page).getByRole('button', { name: 'Закрыть конспект', exact: true }).click();
  await expect(summaryPanel(page)).toHaveCount(0);
}

async function confirmGeneration(page, retry = false) {
  await (retry ? retryButton(page) : createButton(page)).click();
  await expect(consent(page, retry)).toBeVisible();
  await confirmButton(page, retry).click();
}

async function login(page, user) {
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Пароль', { exact: true }).fill('Only-for-summary-tests!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(account(page).getByText(user.email, { exact: true })).toBeVisible();
}

test('Конспект: чтение сохранённого текста экранирует разметку, ничего не генерирует и работает после перезагрузки', async ({ page }, testInfo) => {
  const content = '# Тезис\n<img src=x onerror="window.summaryExecuted=true">\n<script>window.summaryExecuted=true</script>\nСтраницы 1 и 2.';
  const state = await mockSummaries(page, { summary: summary('ready', { content }) });
  await openMaterials(page);
  await openSummary(page);
  await expect(summaryPanel(page)).toContainText(content);
  await expect(summaryPanel(page).locator('img, script')).toHaveCount(0);
  expect(await page.evaluate(() => Boolean(window.summaryExecuted))).toBe(false);
  await expect(createButton(page)).toHaveCount(0);
  await expect(summaryPanel(page).getByRole('textbox')).toHaveCount(0);
  await expect(summaryPanel(page).getByRole('progressbar')).toHaveCount(0);
  await captureSummaryPage(page, testInfo, 'summary-read-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await captureSummaryPage(page, testInfo, 'summary-read-mobile.png');
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain('summaryExecuted');
  await page.reload();
  await expect(account(page).getByRole('heading', { name: SUBJECT.title, exact: true })).toBeVisible();
  await openMaterials(page);
  await openSummary(page);
  await expect(summaryPanel(page)).toContainText(content);
  expect(state.posts).toHaveLength(0);
  expect(state.jobGets).toHaveLength(0);
  expect(state.writes).toEqual([]);
});

test('Конспект: отсутствие, согласие на OpenAI и отмена не отправляют POST', async ({ page }, testInfo) => {
  const state = await mockSummaries(page);
  await openMaterials(page);
  await materials(page).getByRole('button', {
    name: 'Открыть обработку и текст «' + material().title + '»', exact: true,
  }).click();
  await expect(page.getByRole('region', { name: 'Текст материала', exact: true })).toBeVisible();
  await openSummary(page);
  await expect(page.getByRole('region', { name: 'Текст материала', exact: true })).toHaveCount(0);
  await expect(createButton(page)).toBeEnabled();
  expect(state.posts).toHaveLength(0);
  await createButton(page).click();
  await expect(consent(page)).toContainText('OpenAI');
  await expect(consent(page)).toContainText(/баланс/i);
  await expect(consent(page)).toContainText(/ошибк/i);
  await expect(consent(page)).toContainText(/текст/i);
  await expect(consent(page).getByRole('button', { name: 'Отмена', exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('summary-consent-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await consent(page).boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: testInfo.outputPath('summary-consent-mobile.png') });
  await consent(page).getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(consent(page)).toHaveCount(0);
  await expect(createButton(page)).toBeFocused();
  expect(state.posts).toHaveLength(0);
});

test('Конспект: явное подтверждение перечитывает материал, один POST запускает опрос и читает результат', async ({ page }) => {
  await page.clock.install();
  const gate = deferred();
  const state = await mockSummaries(page);
  state.onSummaryPost = async (route, id) => {
    await gate.promise;
    state.summary = summary('queued');
    await reply(route, { materialId: id, jobId: SUMMARY_JOB }, 202);
  };
  state.onJob = async (route) => {
    const status = ['queued', 'running', 'succeeded'][state.jobGets.length - 1];
    if (status === 'succeeded') state.summary = summary();
    await reply(route, job(status));
  };
  await openMaterials(page);
  await openSummary(page);
  await createButton(page).click();
  const before = state.requests.length;
  try {
    await confirmButton(page).evaluate((button) => { button.click(); button.click(); });
    await expect.poll(() => state.posts.length).toBe(1);
    const actionRequests = state.requests.slice(before).filter((value) => value.includes('/materials/' + MATERIAL_ID));
    expect(actionRequests).toEqual([
      'GET /materials/' + MATERIAL_ID,
      'GET /materials/' + MATERIAL_ID + '/summary',
      'POST /materials/' + MATERIAL_ID + '/summary',
    ]);
  } finally { gate.resolve(); }
  await expect.poll(() => state.jobGets.length).toBe(1);
  await expect(summaryPanel(page).getByRole('progressbar')).toHaveCount(0);
  await page.clock.runFor(2100);
  await expect.poll(() => state.jobGets.length).toBe(2);
  await page.clock.runFor(2100);
  await expect(summaryPanel(page)).toContainText(SOURCE_CONTENT);
  expect(state.jobGets).toEqual(Array(3).fill(SUMMARY_JOB));
  expect(state.posts[0].id).toBe(MATERIAL_ID);
  expect(state.posts[0].key).toMatch(UUID);
  expect(state.posts[0].headers['x-csrf-token']).toBeTruthy();
  expect(state.posts[0].headers['content-type']).toBeUndefined();
  expect(state.posts[0].body).toBeNull();
  await page.clock.runFor(10_000);
  expect(state.posts).toHaveLength(1);
  expect(state.jobGets).toHaveLength(3);
});

test('Конспект: материал изменился между согласием и POST — генерация не отправляется', async ({ page }) => {
  const state = await mockSummaries(page);
  await openMaterials(page);
  await openSummary(page);
  await createButton(page).click();
  state.files = [material({ processingStatus: 'failed', pageCount: null, textCharacters: null,
    processingError: { code: 'PDF_INVALID', message: 'Внутренние подробности сервера.' } })];
  await confirmButton(page).click();
  await expect(consent(page)).toHaveCount(0);
  await expect(createButton(page)).toHaveCount(0);
  await expect(summaryPanel(page)).not.toContainText('Внутренние подробности сервера.');
  expect(state.posts).toHaveLength(0);

  state.files = [material()];
  await refreshButton(page).click();
  await createButton(page).click();
  state.summary = summary();
  await confirmButton(page).click();
  await expect(summaryPanel(page)).toContainText(SOURCE_CONTENT);
  expect(state.posts).toHaveLength(0);
});

test('Конспект: ошибки чтения и отсутствующий материал не выглядят отсутствующим конспектом', async ({ page }) => {
  const state = await mockSummaries(page);
  state.onSummaryGet = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');
  await openMaterials(page);
  await openSummary(page);
  await expect(summaryPanel(page).getByRole('alert')).toBeVisible();
  await expect(createButton(page)).toHaveCount(0);
  await expect(summaryPanel(page)).not.toContainText('Внутренние подробности сервера.');
  state.onSummaryGet = null;
  await refreshButton(page).click();
  await expect(createButton(page)).toBeEnabled();
  state.files = [];
  await refreshButton(page).click();
  await expect(createButton(page)).toHaveCount(0);
  await expect(summaryPanel(page)).toContainText(/недоступен|удалён|не найден/i);
  expect(state.posts).toHaveLength(0);
});

test('Конспект: stored и готовый текст обязательны; чтение не запускает обработку', async ({ page }) => {
  const state = await mockSummaries(page);
  await openMaterials(page);
  for (const status of ['uploading', 'deleting']) {
    state.onMaterial = (route) => reply(route, material({ status, deletionJobId: status === 'deleting' ? SUMMARY_JOB : null }));
    await openSummary(page);
    await expect(createButton(page)).toHaveCount(0);
    await expect(summaryPanel(page)).toContainText(/недоступ|сохранен|сохранён|удал/i);
    await closeSummary(page);
  }
  state.onMaterial = (route) => reply(route, material({ processingStatus: 'not_started', processingJobId: null, pageCount: null, textCharacters: null }));
  await openSummary(page);
  await expect(createButton(page)).toHaveCount(0);
  await expect(summaryPanel(page)).toContainText(/текст/i);
  expect(state.writes).toEqual([]);
});

test('Конспект: неизвестный POST повторяется только явно с прежним ключом после закрытия', async ({ page }) => {
  await page.clock.install();
  const state = await mockSummaries(page);
  state.onSummaryPost = (route) => route.abort('failed');
  state.onJob = async (route) => {
    state.summary = summary();
    await reply(route, job('succeeded'));
  };
  await openMaterials(page);
  await openSummary(page);
  await confirmGeneration(page);
  await expect(retryButton(page)).toBeEnabled();
  await closeSummary(page);
  await openSummary(page);
  await expect(retryButton(page)).toBeEnabled();
  await page.clock.runFor(5000);
  expect(state.posts).toHaveLength(1);
  state.onSummaryPost = null;
  await confirmGeneration(page, true);
  await expect(summaryPanel(page)).toContainText(SOURCE_CONTENT);
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1].key).toBe(state.posts[0].key);
});

test('Конспект: Retry-After переживает закрытие; истечение срока не запускает платный запрос', async ({ page }) => {
  await page.clock.install();
  const state = await mockSummaries(page);
  state.onSummaryPost = (route) => fail(route, 429, 'RATE_LIMITED', { 'Retry-After': '30' });
  state.onJob = async (route) => {
    state.summary = summary();
    await reply(route, job('succeeded'));
  };
  await openMaterials(page);
  await openSummary(page);
  await confirmGeneration(page);
  await expect(retryButton(page)).toBeDisabled();
  await closeSummary(page);
  await openSummary(page);
  await expect(refreshButton(page)).toBeDisabled();
  await page.clock.runFor(10_000);
  await expect(refreshButton(page)).toBeDisabled();
  await page.clock.runFor(20_500);
  await expect(refreshButton(page)).toBeEnabled();
  expect(state.posts).toHaveLength(1);
  await refreshButton(page).click();
  await expect(retryButton(page)).toBeEnabled();
  state.onSummaryPost = null;
  await confirmGeneration(page, true);
  await expect(summaryPanel(page)).toContainText(SOURCE_CONTENT);
  expect(state.posts[1].key).toBe(state.posts[0].key);
});

test('Конспект: старое содержимое доступно при новом running/failed, ошибки ИИ не запускают новую генерацию', async ({ page }) => {
  await page.clock.install();
  const saved = summary();
  const state = await mockSummaries(page, { summary: { ...saved, status: 'running' } });
  state.onJob = (route) => reply(route, job('running'));
  await openMaterials(page);
  await openSummary(page);
  await expect(summaryPanel(page)).toContainText(SOURCE_CONTENT);
  await expect.poll(() => state.jobGets.length).toBe(1);
  await expect(createButton(page)).toHaveCount(0);
  for (const code of ['AI_UNAVAILABLE', 'AI_INVALID_RESPONSE', 'AI_OUTCOME_UNKNOWN', 'JOB_OUTCOME_UNKNOWN']) {
    state.summary = { ...saved, status: 'failed', error: { code, message: 'Внутренние подробности провайдера.' } };
    state.onJob = (route) => reply(route, job('failed', { error: { code, message: 'Внутренние подробности провайдера.' } }));
    await refreshButton(page).click();
    await expect(summaryPanel(page)).toContainText(SOURCE_CONTENT);
    await expect(summaryPanel(page).getByRole('alert').first()).toBeVisible();
    await expect(summaryPanel(page)).not.toContainText('Внутренние подробности провайдера.');
    await expect(createButton(page)).toHaveCount(0);
    await page.clock.runFor(3000);
    expect(state.posts).toHaveLength(0);
  }
});

for (const origin of ['fake', 'user']) {
  test('Конспект: источник ' + origin + ' отмечен явно', async ({ page }) => {
    const value = origin === 'fake'
      ? summary('ready', { model: 'fake-local' })
      : summary('ready', { origin: 'user', model: null, sourcePages: [], inputTokens: null, outputTokens: null });
    const state = await mockSummaries(page, { summary: value });
    await openMaterials(page);
    await openSummary(page);
    await expect(summaryPanel(page)).toContainText(origin === 'fake' ? 'Демонстрационный конспект' : 'Отредактирован вручную');
    await expect(summaryPanel(page)).toContainText(SOURCE_CONTENT);
    expect(state.posts).toHaveLength(0);
  });
}

test('Конспект: закрытие останавливает опрос, повторное открытие восстанавливает задание без POST', async ({ page }) => {
  await page.clock.install();
  const state = await mockSummaries(page, { summary: summary('queued') });
  state.onJob = (route) => reply(route, job('running'));
  await openMaterials(page);
  await openSummary(page);
  await expect.poll(() => state.jobGets.length).toBe(1);
  await closeSummary(page);
  await page.clock.runFor(10_000);
  expect(state.jobGets).toHaveLength(1);
  state.onJob = async (route) => {
    state.summary = summary();
    await reply(route, job('succeeded'));
  };
  await openSummary(page);
  await expect(summaryPanel(page)).toContainText(SOURCE_CONTENT);
  expect(state.jobGets).toEqual([SUMMARY_JOB, SUMMARY_JOB]);
  expect(state.posts).toHaveLength(0);
});

test('Конспект: восстановление CSRF сохраняет ключ и требует повторного согласия', async ({ page }) => {
  await page.clock.install();
  const state = await mockSummaries(page);
  state.onSummaryPost = (route) => fail(route, 403, 'CSRF_INVALID');
  state.onJob = async (route) => {
    state.summary = summary();
    await reply(route, job('succeeded'));
  };
  await openMaterials(page);
  await openSummary(page);
  const csrfBefore = state.csrfCount;
  await confirmGeneration(page);
  await expect.poll(() => state.csrfCount).toBeGreaterThan(csrfBefore);
  await expect(retryButton(page)).toBeEnabled();
  await page.clock.runFor(3000);
  expect(state.posts).toHaveLength(1);
  state.onSummaryPost = null;
  await confirmGeneration(page, true);
  await expect(summaryPanel(page)).toContainText(SOURCE_CONTENT);
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1].key).toBe(state.posts[0].key);
  expect(state.posts[1].headers['x-csrf-token']).not.toBe(state.posts[0].headers['x-csrf-token']);
});

test('Конспект: поздний ответ при смене материала не подменяет открытый конспект', async ({ page }) => {
  const gate = deferred();
  let responded = false;
  const second = material({ id: SECOND_MATERIAL_ID, title: 'Второй материал' });
  const state = await mockSummaries(page, { files: [material(), second] });
  state.onSummaryGet = async (route, id) => {
    if (id === MATERIAL_ID) {
      await gate.promise;
      await reply(route, summary('ready', { content: 'Поздний конспект первого' })).catch(() => {});
      responded = true;
    } else await reply(route, summary('ready', { materialId: id, content: 'Актуальный конспект второго' }));
  };
  await openMaterials(page);
  await openSummary(page);
  try {
    await expect.poll(() => state.summaryGets.length).toBe(1);
    await openSummary(page, second);
    await expect(summaryPanel(page)).toContainText('Актуальный конспект второго');
  } finally { gate.resolve(); }
  await expect.poll(() => responded).toBe(true);
  await expect(summaryPanel(page)).not.toContainText('Поздний конспект первого');
  expect(state.posts).toHaveLength(0);
});

test('Конспект: поздний job после выхода не возвращает текст в другой аккаунт', async ({ page }) => {
  await page.clock.install();
  const gate = deferred();
  let responded = false;
  const state = await mockSummaries(page, { summary: summary('running') });
  state.onJob = async (route) => {
    await gate.promise;
    await reply(route, job('succeeded')).catch(() => {});
    responded = true;
  };
  await openMaterials(page);
  await openSummary(page);
  try {
    await expect.poll(() => state.jobGets.length).toBe(1);
    await account(page).getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'С возвращением!', exact: true })).toBeVisible();
    state.loginUser = OTHER_USER;
    state.subjects = [OTHER_SUBJECT];
    state.files = [];
    state.summary = summary('ready', { content: 'Частный результат первого аккаунта' });
    await login(page, OTHER_USER);
    await openMaterials(page, OTHER_SUBJECT);
  } finally { gate.resolve(); }
  await expect.poll(() => responded).toBe(true);
  const reads = state.summaryGets.length;
  await page.clock.runFor(5000);
  await expect(summaryPanel(page)).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Частный результат первого аккаунта');
  await expect(materials(page).getByText('Пока нет материалов', { exact: true })).toBeVisible();
  expect(state.summaryGets).toHaveLength(reads);
  expect(state.posts).toHaveLength(0);
});

test('Конспект: открытие удаления закрывает панель и подавляет поздний job', async ({ page }) => {
  await page.clock.install();
  const gate = deferred();
  let responded = false;
  const state = await mockSummaries(page, { summary: summary('running') });
  state.onJob = async (route) => {
    await gate.promise;
    await reply(route, job('succeeded')).catch(() => {});
    responded = true;
  };
  await openMaterials(page);
  await openSummary(page);
  try {
    await expect.poll(() => state.jobGets.length).toBe(1);
    await materials(page).getByRole('button', {
      name: 'Удалить материал «' + material().title + '»', exact: true,
    }).click();
    await expect(page.getByRole('dialog', { name: 'Удаление материала', exact: true })).toBeVisible();
    await expect(summaryPanel(page)).toHaveCount(0);
  } finally { gate.resolve(); }
  await expect.poll(() => responded).toBe(true);
  const reads = state.summaryGets.length;
  await page.clock.runFor(5000);
  expect(state.summaryGets).toHaveLength(reads);
  expect(state.jobGets).toHaveLength(1);
  expect(state.writes).toEqual([]);
});

test('Конспект: поздний POST после закрытия не начинает наблюдение; GET восстанавливает принятое задание', async ({ page }) => {
  await page.clock.install();
  const gate = deferred();
  let responded = false;
  const state = await mockSummaries(page);
  state.onSummaryPost = async (route, id) => {
    await gate.promise;
    state.summary = summary('queued');
    await reply(route, { materialId: id, jobId: SUMMARY_JOB }, 202).catch(() => {});
    responded = true;
  };
  state.onJob = async (route) => {
    state.summary = summary();
    await reply(route, job('succeeded'));
  };
  await openMaterials(page);
  await openSummary(page);
  await confirmGeneration(page);
  try {
    await expect.poll(() => state.posts.length).toBe(1);
    await closeSummary(page);
  } finally { gate.resolve(); }
  await expect.poll(() => responded).toBe(true);
  await page.clock.runFor(5000);
  expect(state.jobGets).toHaveLength(0);
  await openSummary(page);
  await expect(summaryPanel(page)).toContainText(SOURCE_CONTENT);
  expect(state.jobGets).toHaveLength(1);
  expect(state.posts).toHaveLength(1);
});

function editor(page) {
  return summaryPanel(page).getByRole('form', { name: 'Редактирование конспекта', exact: true });
}

function editorInput(page) { return editor(page).getByLabel('Текст конспекта', { exact: true }); }
function saveSummary(page) { return editor(page).getByRole('button', { name: 'Сохранить конспект', exact: true }); }
function editButton(page) { return summaryPanel(page).getByRole('button', { name: 'Редактировать конспект', exact: true }); }
function regenerateButton(page) { return summaryPanel(page).getByRole('button', { name: 'Создать заново', exact: true }); }
function regenerateConsent(page) { return page.getByRole('dialog', { name: 'Создать конспект заново?', exact: true }); }
function regenerateConfirm(page) { return regenerateConsent(page).getByRole('button', { name: 'Подтвердить новую генерацию', exact: true }); }

async function openEditor(page) {
  await editButton(page).click();
  await expect(editorInput(page)).toBeEnabled();
}

async function regenerate(page) {
  await regenerateButton(page).click();
  await expect(regenerateConsent(page)).toBeVisible();
  await regenerateConfirm(page).click();
}

async function expectEditorReview(page, draft, serverContent) {
  await expect(editor(page).getByText('На сервере', { exact: true })).toBeVisible();
  await expect(editor(page).getByText('Твой черновик', { exact: true })).toBeVisible();
  await expect(editorInput(page)).toHaveValue(draft);
  await expect(editor(page)).toContainText(serverContent);
  await expect(saveSummary(page)).toBeDisabled();
  await expect(editor(page).getByRole('button', { name: 'Продолжить с моим черновиком', exact: true })).toBeEnabled();
}

async function chooseEditorDraft(page) {
  await editor(page).getByRole('button', { name: 'Продолжить с моим черновиком', exact: true }).click();
}

test('Редактирование конспекта: свежая версия, один PATCH и сохранение переносов строк', async ({ page }, testInfo) => {
  const readGate = deferred();
  const writeGate = deferred();
  const state = await mockSummaries(page, { summary: summary() });
  await openMaterials(page);
  await openSummary(page);
  await expect(editButton(page)).toBeEnabled();
  state.summary = summary('ready', { content: 'Свежий текст с сервера', version: 4 });
  state.onSummaryGet = async (route) => {
    await readGate.promise;
    await reply(route, state.summary);
  };
  try {
    await editButton(page).click();
    await expect.poll(() => state.summaryGets.length).toBeGreaterThan(1);
    await expect(saveSummary(page)).toBeDisabled();
    expect(state.patches).toHaveLength(0);
  } finally { readGate.resolve(); }
  await expect(editorInput(page)).toHaveValue('Свежий текст с сервера');
  const draft = 'Первый абзац правки.\n\nВторой абзац.\nСтрока со  внутренними   пробелами.';
  await editorInput(page).fill(draft);
  await expect(regenerateButton(page)).toBeDisabled();
  await captureSummaryPage(page, testInfo, 'summary-editor-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await captureSummaryPage(page, testInfo, 'summary-editor-mobile.png');
  state.onSummaryGet = null;
  state.onSummaryPatch = async (route) => {
    await writeGate.promise;
    const { content, version } = route.request().postDataJSON();
    state.summary = summary('ready', {
      content, version: version + 1, origin: 'user', model: null,
      sourcePages: [], inputTokens: null, outputTokens: null,
    });
    await reply(route, state.summary);
  };
  try {
    await editor(page).evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await expect.poll(() => state.patches.length).toBe(1);
    await expect(editorInput(page)).toBeDisabled();
    await expect(summaryPanel(page).locator('.material-summary-content')).not.toHaveText(draft);
  } finally { writeGate.resolve(); }
  await expect(editor(page)).toHaveCount(0);
  await expect(summaryPanel(page).locator('.material-summary-content')).toHaveText(draft);
  await expect(summaryPanel(page)).toContainText('Отредактирован вручную');
  await expect(summaryPanel(page)).not.toContainText('Страницы-источники:');
  expect(state.patches).toHaveLength(1);
  expect(state.patches[0].body).toEqual({ content: draft, version: 4 });
  expect(state.patches[0].headers['x-csrf-token']).toBeTruthy();
  expect(state.patches[0].headers['idempotency-key']).toBeUndefined();
  expect(state.posts).toHaveLength(0);
});

test('Редактирование конспекта: пустой текст и 422 сохраняют черновик после скрытия редактора', async ({ page }) => {
  const state = await mockSummaries(page, { summary: summary() });
  await openMaterials(page);
  await openSummary(page);
  await openEditor(page);
  await editorInput(page).fill('   \n\n   ');
  await saveSummary(page).click();
  await expect(editorInput(page)).toHaveAttribute('aria-invalid', 'true');
  expect(state.patches).toHaveLength(0);
  const draft = 'Черновик, который нужно сохранить.\nВторая строка.';
  state.onSummaryPatch = (route) => fail(route, 422, 'VALIDATION_FAILED', {}, {
    content: 'Уточни текст конспекта.',
  });
  await editorInput(page).fill(draft);
  await saveSummary(page).click();
  await expect(editorInput(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(editorInput(page)).toHaveValue(draft);
  await expect(editor(page)).not.toContainText('Внутренние подробности сервера.');
  await editor(page).getByRole('button', { name: 'Скрыть редактор', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(regenerateButton(page)).toBeEnabled();
  await openEditor(page);
  await expect(editorInput(page)).toHaveValue(draft);
  state.onSummaryPatch = null;
  await saveSummary(page).click();
  await expect(editor(page)).toHaveCount(0);
  expect(state.patches).toHaveLength(2);
  expect(state.patches[1].body).toEqual({ content: draft, version: 1 });
});

test('Редактирование конспекта: конфликт и неудачный GET не разрешают перезапись до явного выбора', async ({ page }, testInfo) => {
  const state = await mockSummaries(page, { summary: summary() });
  await openMaterials(page);
  await openSummary(page);
  await openEditor(page);
  const draft = 'Моя версия конспекта\n\nС дополнительными замечаниями.';
  const serverContent = 'Текст, изменённый в другой вкладке.\n<script>window.comparisonExecuted=true</script>';
  await editorInput(page).fill(draft);
  state.summary = summary('ready', { content: serverContent, version: 7 });
  await saveSummary(page).click();
  const review = editor(page).getByRole('button', { name: 'Загрузить актуальную версию', exact: true });
  await expect(review).toBeEnabled();
  await expect(saveSummary(page)).toBeDisabled();
  state.onSummaryGet = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');
  await review.click();
  await expect(review).toBeEnabled();
  await expect(saveSummary(page)).toBeDisabled();
  await expect(editorInput(page)).toHaveValue(draft);
  await expect(editor(page).getByRole('button', { name: 'Продолжить с моим черновиком', exact: true })).toHaveCount(0);
  state.onSummaryGet = null;
  await review.click();
  await expectEditorReview(page, draft, serverContent);
  await expect(editor(page).locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => Boolean(window.comparisonExecuted))).toBe(false);
  await captureSummaryPage(page, testInfo, 'summary-editor-conflict-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await captureSummaryPage(page, testInfo, 'summary-editor-conflict-mobile.png');
  await editor(page).getByRole('button', { name: 'Скрыть редактор', exact: true }).click();
  state.onSummaryGet = (route) => fail(route, 503, 'SERVICE_UNAVAILABLE');
  await editButton(page).click();
  await expect(review).toBeEnabled();
  await expect(editorInput(page)).toHaveValue(draft);
  await expect(saveSummary(page)).toBeDisabled();
  await expect(editor(page).getByRole('button', { name: 'Продолжить с моим черновиком', exact: true })).toHaveCount(0);
  expect(state.patches).toHaveLength(1);
  state.onSummaryGet = null;
  await review.click();
  await expectEditorReview(page, draft, serverContent);
  await chooseEditorDraft(page);
  await expect(saveSummary(page)).toBeEnabled();
  expect(state.patches).toHaveLength(1);
  await saveSummary(page).click();
  await expect(editor(page)).toHaveCount(0);
  expect(state.patches[1].body).toEqual({ content: draft, version: 7 });
});

test('Редактирование конспекта: неизвестный PATCH проверяется GET; выбор сервера не отправляет PATCH', async ({ page }) => {
  await page.clock.install();
  const state = await mockSummaries(page, { summary: summary() });
  await openMaterials(page);
  await openSummary(page);
  await openEditor(page);
  const draft = 'Сохранённый текст, чей HTTP-ответ потерялся.';
  await editorInput(page).fill(draft);
  state.onSummaryPatch = async (route) => {
    state.summary = summary('ready', { version: 2, content: draft, origin: 'user', model: null,
      sourcePages: [], inputTokens: null, outputTokens: null });
    await route.abort('failed');
  };
  await saveSummary(page).click();
  await expect(editor(page).getByRole('button', { name: 'Проверить сохранение', exact: true })).toBeEnabled();
  await expect(saveSummary(page)).toBeDisabled();
  await editor(page).getByRole('button', { name: 'Скрыть редактор', exact: true }).click();
  await expect(regenerateButton(page)).toBeDisabled();
  await editButton(page).click();
  await expectEditorReview(page, draft, draft);
  await editor(page).getByRole('button', { name: 'Скрыть редактор', exact: true }).click();
  await expect(regenerateButton(page)).toBeDisabled();
  await editButton(page).click();
  await expectEditorReview(page, draft, draft);
  await page.clock.runFor(5000);
  expect(state.patches).toHaveLength(1);
  await editor(page).getByRole('button', { name: 'Использовать версию сервера', exact: true }).click();
  await expect(editorInput(page)).toHaveValue(draft);
  await expect(saveSummary(page)).toBeEnabled();
  expect(state.patches).toHaveLength(1);
  await editor(page).getByRole('button', { name: 'Скрыть редактор', exact: true }).click();
  await expect(regenerateButton(page)).toBeEnabled();
});

test('Редактирование конспекта: CSRF восстанавливает черновик без повторной отправки', async ({ page }) => {
  await page.clock.install();
  const state = await mockSummaries(page, { summary: summary() });
  await openMaterials(page);
  await openSummary(page);
  await openEditor(page);
  const draft = 'Правка после восстановления сессии.\nНе терять эту строку.';
  await editorInput(page).fill(draft);
  const before = state.csrfCount;
  state.onSummaryPatch = (route) => fail(route, 403, 'CSRF_INVALID');
  await saveSummary(page).click();
  await expect.poll(() => state.csrfCount).toBeGreaterThan(before);
  await expect(editorInput(page)).toHaveValue(draft);
  await expect(saveSummary(page)).toBeEnabled();
  await page.clock.runFor(3000);
  expect(state.patches).toHaveLength(1);
  state.onSummaryPatch = null;
  await saveSummary(page).click();
  await expect(editor(page)).toHaveCount(0);
  expect(state.patches).toHaveLength(2);
  expect(state.patches[1].headers['x-csrf-token']).not.toBe(state.patches[0].headers['x-csrf-token']);
});

test('Редактирование конспекта: поздний PATCH после закрытия и открытия удаления не меняет панель', async ({ page }) => {
  const state = await mockSummaries(page, { summary: summary() });
  await openMaterials(page);
  await openSummary(page);
  for (const [index, action] of ['close', 'delete'].entries()) {
    if (index === 0) await openEditor(page);
    else {
      await openSummary(page);
      await expectEditorReview(page, 'Поздний черновик 0', SOURCE_CONTENT);
      await chooseEditorDraft(page);
    }
    const gate = deferred();
    let responded = false;
    await editorInput(page).fill('Поздний черновик ' + index);
    state.onSummaryPatch = async (route) => {
      await gate.promise;
      await reply(route, summary('ready', { version: 2, content: 'Поздний черновик ' + index,
        origin: 'user', model: null, sourcePages: [], inputTokens: null, outputTokens: null })).catch(() => {});
      responded = true;
    };
    await saveSummary(page).click();
    try {
      await expect.poll(() => state.patches.length).toBe(index + 1);
      if (action === 'close') await closeSummary(page);
      else await materials(page).getByRole('button', {
        name: 'Удалить материал «' + material().title + '»', exact: true,
      }).click();
    } finally { gate.resolve(); }
    await expect.poll(() => responded).toBe(true);
    await expect(summaryPanel(page)).toHaveCount(0);
  }
  expect(state.posts).toHaveLength(0);
});

test('Редактирование конспекта: другой аккаунт не получает частный черновик после 401', async ({ page }) => {
  const state = await mockSummaries(page, { summary: summary() });
  await openMaterials(page);
  await openSummary(page);
  await openEditor(page);
  await editorInput(page).fill('Частный черновик первого аккаунта');
  state.onSummaryPatch = async (route) => {
    state.user = null;
    await fail(route, 401, 'AUTHENTICATION_REQUIRED');
  };
  await saveSummary(page).click();
  await expect(page.getByRole('heading', { name: 'С возвращением!', exact: true })).toBeVisible();
  state.loginUser = OTHER_USER;
  state.subjects = [OTHER_SUBJECT];
  const other = material({ id: SECOND_MATERIAL_ID, subjectId: OTHER_SUBJECT.id, title: 'Материал другого аккаунта' });
  state.files = [other];
  state.summary = summary('ready', { materialId: other.id, content: 'Конспект другого аккаунта' });
  state.onSummaryPatch = null;
  await login(page, OTHER_USER);
  await openMaterials(page, OTHER_SUBJECT);
  await openSummary(page, other);
  await expect(editor(page)).toHaveCount(0);
  await openEditor(page);
  await expect(editorInput(page)).toHaveValue('Конспект другого аккаунта');
  await expect(page.locator('body')).not.toContainText('Частный черновик первого аккаунта');
  expect(state.patches).toHaveLength(1);
});

test('Повторная генерация: согласие, новая UUID и старый ручной текст до успешной записи', async ({ page }, testInfo) => {
  await page.clock.install();
  const manual = summary('ready', { content: 'Ручная версия конспекта', version: 3, origin: 'user', model: null,
    sourcePages: [], inputTokens: null, outputTokens: null });
  const state = await mockSummaries(page, { summary: manual });
  state.onJob = async (route, id) => {
    if (id === SUMMARY_JOB_2) {
      if (state.jobGets.filter((value) => value === id).length === 1) await reply(route, job('running', { id }));
      else {
        state.summary = { ...manual, jobId: id, status: 'failed', error: { code: 'AI_INVALID_RESPONSE', message: 'Сырые подробности ИИ.' } };
        await reply(route, job('failed', { id }));
      }
    } else {
      state.summary = summary('ready', { jobId: id, version: 4, content: 'Успешно созданный новый конспект' });
      await reply(route, job('succeeded', { id }));
    }
  };
  await openMaterials(page);
  await openSummary(page);
  await regenerateButton(page).click();
  await expect(regenerateConsent(page)).toContainText('OpenAI');
  await expect(regenerateConsent(page)).toContainText(/баланс/i);
  await expect(regenerateConsent(page)).toContainText(/замен|предыдущ|текущ/i);
  await expect(regenerateConsent(page)).toContainText(/ручн/i);
  await page.screenshot({ path: testInfo.outputPath('summary-regenerate-consent-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await regenerateConsent(page).boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: testInfo.outputPath('summary-regenerate-consent-mobile.png') });
  await regenerateConsent(page).getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(state.posts).toHaveLength(0);
  await regenerateButton(page).click();
  await regenerateConfirm(page).evaluate((button) => { button.click(); button.click(); });
  await expect.poll(() => state.jobGets.length).toBe(1);
  await expect(summaryPanel(page).locator('.material-summary-content')).toHaveText(manual.content);
  await expect(editButton(page)).toBeDisabled();
  await page.clock.runFor(2100);
  await expect(regenerateButton(page)).toBeEnabled();
  await expect(summaryPanel(page).locator('.material-summary-content')).toHaveText(manual.content);
  await expect(summaryPanel(page)).not.toContainText('Сырые подробности ИИ.');
  expect(state.posts).toHaveLength(1);
  await regenerate(page);
  await expect(summaryPanel(page).locator('.material-summary-content')).toHaveText('Успешно созданный новый конспект');
  expect(state.posts).toHaveLength(2);
  expect(state.posts[0].key).toMatch(UUID);
  expect(state.posts[1].key).toMatch(UUID);
  expect(state.posts[1].key).not.toBe(state.posts[0].key);
  expect(state.jobGets).toContain(SUMMARY_JOB_2);
  expect(state.jobGets).toContain(SUMMARY_JOB_3);
});

test('Повторная генерация: неизвестный POST и старый GET сохраняют тот же ключ для явного повтора', async ({ page }) => {
  await page.clock.install();
  const old = summary();
  const state = await mockSummaries(page, { summary: old });
  state.onSummaryPost = (route) => route.abort('failed');
  state.onJob = async (route, id) => {
    state.summary = summary('ready', { jobId: id, version: 2, content: 'Новый результат прежней попытки' });
    await reply(route, job('succeeded', { id }));
  };
  await openMaterials(page);
  await openSummary(page);
  await regenerate(page);
  await expect(retryButton(page)).toBeEnabled();
  await expect(editButton(page)).toBeDisabled();
  await refreshButton(page).click();
  await expect(retryButton(page)).toBeEnabled();
  await expect(summaryPanel(page).locator('.material-summary-content')).toHaveText(old.content);
  await closeSummary(page);
  await openSummary(page);
  await expect(retryButton(page)).toBeEnabled();
  await page.clock.runFor(5000);
  expect(state.posts).toHaveLength(1);
  state.onSummaryPost = null;
  await confirmGeneration(page, true);
  await expect(summaryPanel(page).locator('.material-summary-content')).toHaveText('Новый результат прежней попытки');
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1].key).toBe(state.posts[0].key);
});

test('Повторная генерация: 202 и старый terminal GET наблюдают возвращённое новое задание', async ({ page }) => {
  await page.clock.install();
  const old = summary();
  const state = await mockSummaries(page, { summary: old });
  state.onSummaryPost = (route, id) => reply(route, { materialId: id, jobId: SUMMARY_JOB_2 }, 202);
  state.onJob = async (route, id) => {
    if (state.jobGets.length === 1) await reply(route, job('running', { id }));
    else {
      state.summary = summary('ready', { jobId: id, version: 2, content: 'Подтверждённая новая версия' });
      await reply(route, job('succeeded', { id }));
    }
  };
  await openMaterials(page);
  await openSummary(page);
  await regenerate(page);
  await expect.poll(() => state.jobGets.length).toBe(1);
  expect(state.jobGets[0]).toBe(SUMMARY_JOB_2);
  await expect(summaryPanel(page).locator('.material-summary-content')).toHaveText(old.content);
  await expect(editButton(page)).toBeDisabled();
  await expect(regenerateButton(page)).toBeDisabled();
  await page.clock.runFor(2100);
  await expect(summaryPanel(page).locator('.material-summary-content')).toHaveText('Подтверждённая новая версия');
  expect(state.posts).toHaveLength(1);
});

test('Повторная генерация: изменение версии или готовности между согласием и POST требует нового решения', async ({ page }) => {
  const state = await mockSummaries(page, { summary: summary() });
  await openMaterials(page);
  await openSummary(page);
  await regenerateButton(page).click();
  state.summary = summary('ready', { version: 2, content: 'Свежая ручная правка из другой вкладки',
    origin: 'user', model: null, sourcePages: [], inputTokens: null, outputTokens: null });
  await regenerateConfirm(page).click();
  await expect(summaryPanel(page).locator('.material-summary-content')).toHaveText(state.summary.content);
  expect(state.posts).toHaveLength(0);
  await regenerateButton(page).click();
  state.files = [material({ processingStatus: 'failed', pageCount: null, textCharacters: null,
    processingError: { code: 'PDF_INVALID', message: 'Сырые подробности.' } })];
  await regenerateConfirm(page).click();
  await expect(summaryPanel(page)).not.toContainText('Сырые подробности.');
  await expect(regenerateButton(page)).toBeDisabled();
  expect(state.posts).toHaveLength(0);
});

test('Повторная генерация: скрытый известный черновик сохраняется и сравнивается с новой версией', async ({ page }) => {
  const state = await mockSummaries(page, { summary: summary() });
  state.onJob = async (route, id) => {
    state.summary = summary('ready', { jobId: id, version: 2, content: 'Новая версия от ИИ' });
    await reply(route, job('succeeded', { id }));
  };
  await openMaterials(page);
  await openSummary(page);
  await openEditor(page);
  const draft = 'Несохранённый личный черновик.';
  await editorInput(page).fill(draft);
  await expect(regenerateButton(page)).toBeDisabled();
  await editor(page).getByRole('button', { name: 'Скрыть редактор', exact: true }).click();
  await regenerateButton(page).click();
  await expect(regenerateConsent(page)).toContainText(/черновик/i);
  await regenerateConfirm(page).click();
  await expect(summaryPanel(page).locator('.material-summary-content')).toHaveText('Новая версия от ИИ');
  await editButton(page).click();
  await expectEditorReview(page, draft, 'Новая версия от ИИ');
  expect(state.patches).toHaveLength(0);
  expect(state.posts).toHaveLength(1);
});

test('Повторная генерация: Retry-After и закрытие сохраняют ключ на фоне прежней версии', async ({ page }) => {
  await page.clock.install();
  const state = await mockSummaries(page, { summary: summary() });
  state.onSummaryPost = (route) => fail(route, 429, 'RATE_LIMITED', { 'Retry-After': '30' });
  state.onJob = async (route, id) => {
    state.summary = summary('ready', { jobId: id, version: 2, content: 'Конспект после явного повтора' });
    await reply(route, job('succeeded', { id }));
  };
  await openMaterials(page);
  await openSummary(page);
  await regenerate(page);
  await expect(retryButton(page)).toBeDisabled();
  await expect(summaryPanel(page).locator('.material-summary-content')).toHaveText(SOURCE_CONTENT);
  await closeSummary(page);
  await openSummary(page);
  await expect(refreshButton(page)).toBeDisabled();
  await page.clock.runFor(30_500);
  await expect(refreshButton(page)).toBeEnabled();
  expect(state.posts).toHaveLength(1);
  await refreshButton(page).click();
  await expect(retryButton(page)).toBeEnabled();
  state.onSummaryPost = null;
  await confirmGeneration(page, true);
  await expect(summaryPanel(page).locator('.material-summary-content')).toHaveText('Конспект после явного повтора');
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1].key).toBe(state.posts[0].key);
});

test('Повторная генерация: неизвестная попытка и новые ручные версии требуют свежего согласия с прежним ключом', async ({ page }) => {
  await page.clock.install();
  const state = await mockSummaries(page, { summary: summary() });
  state.onSummaryPost = (route) => route.abort('failed');
  state.onJob = async (route, id) => {
    if (state.jobGets.length === 1) await reply(route, job('running', { id }));
    else {
      state.summary = summary('ready', { jobId: id, version: 4, content: 'Новый конспект после явного согласия' });
      await reply(route, job('succeeded', { id }));
    }
  };
  await openMaterials(page);
  await openSummary(page);
  await regenerate(page);
  await expect(retryButton(page)).toBeEnabled();
  expect(state.posts).toHaveLength(1);

  // PATCH из другой вкладки изменил version, но оставил jobId прежней генерации.
  state.summary = summary('ready', {
    version: 2, content: 'Ручная версия 2 из другой вкладки', origin: 'user', model: null,
    sourcePages: [], inputTokens: null, outputTokens: null,
  });
  await refreshButton(page).click();
  await expect(summaryPanel(page).locator('.material-summary-content')).toHaveText(state.summary.content);
  await expect(editButton(page)).toBeDisabled();
  await expect(regenerateButton(page)).toHaveCount(0);
  await expect(retryButton(page)).toBeEnabled();
  await retryButton(page).click();
  await expect(consent(page, true)).toContainText(/ручн/i);
  await expect(consent(page, true)).toContainText(/замен/i);

  // Согласие с версией 2 не разрешает заменить появившуюся затем версию 3.
  state.summary = { ...state.summary, version: 3, content: 'Ещё одна ручная версия 3' };
  await confirmButton(page, true).click();
  await expect(consent(page, true)).toHaveCount(0);
  await expect(summaryPanel(page).locator('.material-summary-content')).toHaveText(state.summary.content);
  await expect(retryButton(page)).toBeEnabled();
  await expect(editButton(page)).toBeDisabled();
  await expect(regenerateButton(page)).toHaveCount(0);
  expect(state.posts).toHaveLength(1);
  await page.clock.runFor(3000);
  expect(state.posts).toHaveLength(1);

  state.onSummaryPost = null;
  await retryButton(page).click();
  await expect(consent(page, true)).toContainText(/ручн/i);
  await expect(consent(page, true)).toContainText(/замен/i);
  await confirmButton(page, true).click();
  await expect.poll(() => state.jobGets.length).toBe(1);
  expect(state.jobGets[0]).toBe(SUMMARY_JOB_2);
  await expect(summaryPanel(page).locator('.material-summary-content')).toHaveText('Ещё одна ручная версия 3');
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1].key).toBe(state.posts[0].key);
  await page.clock.runFor(2100);
  await expect(summaryPanel(page).locator('.material-summary-content')).toHaveText('Новый конспект после явного согласия');
  expect(state.posts).toHaveLength(2);
});
