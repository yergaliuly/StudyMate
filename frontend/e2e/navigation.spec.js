import { test, expect } from '@playwright/test';

// Only local HTTP fixtures; no server account or external service is used.
async function openAccount(page) {
  const unexpected = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/v1/auth/csrf') {
      return route.fulfill({ json: { data: { headerName: 'X-CSRF-TOKEN', token: 'navigation-fixture' } } });
    }
    if (request.method() === 'GET' && url.pathname === '/api/v1/auth/me') {
      return route.fulfill({ json: { data: {
        id: '4ea493e4-99f3-419b-9808-96c104f8b6b7',
        email: 'navigation-check@example.com',
        displayName: 'ДлинноеИмяСтудентаДляПроверкиУзкогоЭкрана',
      } } });
    }
    if (request.method() === 'GET' && ['/api/v1/subjects', '/api/v1/attempts'].includes(url.pathname)) {
      return route.fulfill({ json: { data: [], meta: {
        page: Number(url.searchParams.get('page')), pageSize: Number(url.searchParams.get('pageSize')), total: 0,
      } } });
    }
    unexpected.push(request.method() + ' ' + url.pathname);
    return route.fulfill({ status: 500, json: { error: { code: 'TEST_UNEXPECTED_REQUEST', message: 'Unexpected fixture request' } } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Мой кабинет', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Пока нет предметов', exact: true })).toBeVisible();
  return unexpected;
}

async function expectNoHorizontalScroll(page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

test('Навигация: skip-link и переход с клавиатуры переносят фокус к содержимому', async ({ page }) => {
  const unexpected = await openAccount(page);
  const skip = page.getByRole('link', { name: 'Перейти к содержимому' });
  await skip.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();

  const results = page.getByRole('button', { name: 'Результаты', exact: true });
  await results.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Результаты', exact: true })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Пока нет попыток', exact: true })).toBeVisible();
  await expect(results).toHaveAttribute('aria-current', 'page');
  await expectNoHorizontalScroll(page);
  expect(unexpected).toEqual([]);
});

test('Навигация: мобильное меню работает с клавиатуры, Escape возвращает фокус, переход открывает раздел', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const unexpected = await openAccount(page);
  const opener = page.getByRole('button', { name: 'Открыть меню', exact: true });
  const menu = page.getByRole('dialog', { name: 'Меню StudyMate' });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await expect(opener).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('button', { name: 'Закрыть меню' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu.getByRole('button', { name: 'Мой кабинет', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(menu.getByRole('button', { name: 'Закрыть меню' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(opener).toBeFocused();
  await expect(opener).toHaveAttribute('aria-expanded', 'false');

  await page.keyboard.press('Enter');
  // Follow the actual tab order from Close through the six navigation buttons.
  for (let step = 0; step < 5; step += 1) await page.keyboard.press('Tab');
  await expect(menu.getByRole('button', { name: 'Результаты', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Результаты', exact: true })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Пока нет попыток', exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(unexpected).toEqual([]);
});

test('Навигация: расширение экрана закрывает меню и оставляет доступный фокус', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await openAccount(page);
  const opener = page.getByRole('button', { name: 'Открыть меню', exact: true });
  await opener.click();
  await expect(page.getByRole('dialog', { name: 'Меню StudyMate' })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole('dialog', { name: 'Меню StudyMate' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Мой кабинет', exact: true })).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
  await expectNoHorizontalScroll(page);
});

test('Навигация: форма предмета при 320 px доступна с клавиатуры и возвращает фокус после Escape', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const unexpected = await openAccount(page);
  await expectNoHorizontalScroll(page);
  const add = page.getByRole('button', { name: 'Добавить предмет', exact: true });
  await add.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Новый предмет' });
  await expect(dialog.getByRole('textbox', { name: 'Название предмета *', exact: true })).toBeFocused();
  await expect.poll(() => dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  for (const option of await dialog.locator('.subject-color-option').all()) {
    await expect.poll(() => option.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: testInfo.outputPath('subject-form-320.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(add).toBeFocused();
  await expectNoHorizontalScroll(page);
  expect(unexpected).toEqual([]);
});
