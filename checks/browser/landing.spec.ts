import { test, expect } from '@playwright/test';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);

test('landing phrase fades once while authentication resolves without flashing sign-in', async ({ page }, info) => {
  let releaseStatus = () => {};
  let pendingStatus = new Promise<void>(resolve => { releaseStatus = resolve; });
  await page.route('**/api/status', async route => {
    const response = await route.fetch();
    await pendingStatus;
    await route.fulfill({ response });
  });
  try {
    await page.goto('/');
    await expect(page.locator('.landing-intro')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'A place to think out loud.' })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('landing.png'), fullPage: true });
    await expect(page.locator('.landing-intro')).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('Connecting…');
    await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  } finally { releaseStatus(); }

  await page.getByLabel('Password', { exact: true }).fill('browser-fixture-password-2026');
  await page.screenshot({ path: info.outputPath('sign-in.png'), fullPage: true });
  await page.getByRole('button', { name: 'Enter your space', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Wake NorthPointe', exact: true })).toBeEnabled();
  await expect(page.locator('.landing-intro')).toHaveCount(0);
  const conversation = await page.evaluate(() => localStorage.getItem('vc2:conversation'));
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.landing-intro')).toHaveCount(0);
  await page.keyboard.press('Escape');

  pendingStatus = new Promise<void>(resolve => { releaseStatus = resolve; });
  try {
    await page.reload();
    await expect(page.locator('.landing-intro')).toBeVisible();
    await expect(page.locator('.landing-intro')).toHaveCount(0);
    // A returning owner must not see a password form while their cookie is checked.
    await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('Connecting…');
  } finally { releaseStatus(); }
  await expect(page.getByRole('button', { name: 'Wake NorthPointe', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('vc2:conversation'))).toBe(conversation);
});

test('reduced-motion landing unmounts and a failed session check remains recoverable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/status', route => route.fulfill({ status: 503, json: { message: 'Connection is temporarily unavailable.' } }), { times: 1 });
  await page.goto('/');
  await expect(page.locator('.landing-intro')).toBeVisible();
  expect(await page.locator('.landing-intro').evaluate(node => getComputedStyle(node).animationName)).toBe('none');
  await expect(page.locator('.landing-intro')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveText('Connection is temporarily unavailable.');
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await expect(page.locator('.landing-intro')).toHaveCount(0);
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.locator('[inert]')).toHaveCount(0);
});
