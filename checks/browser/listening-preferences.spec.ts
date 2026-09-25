import { test, expect } from '@playwright/test';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);

test('interruption sensitivity and listening cues persist on this device without changing the conversation', async ({ page }, info) => {
  const preferenceWrites: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && request.url().includes('/api/settings')) preferenceWrites.push(request.url());
  });
  // This scenario saves only device choices. A configured provider is simulated;
  // no microphone, provider connection, or credential write is needed.
  await page.route('**/api/settings', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), deepgramConfigured: true } });
  });
  await page.goto('/');
  await page.getByLabel('Password', { exact: true }).fill('browser-fixture-password-2026');
  await page.getByRole('button', { name: 'Enter your space', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Wake NorthPointe', exact: true })).toBeEnabled();
  const conversation = await page.evaluate(() => localStorage.getItem('vc2:conversation'));

  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const sensitivity = page.getByRole('slider', { name: 'Interruption sensitivity', exact: true });
  const cues = page.getByRole('checkbox', { name: 'Subtle Audio Cues', exact: true });
  await expect(sensitivity).toHaveValue('50');
  await expect(cues).toBeChecked();
  await sensitivity.focus();
  await sensitivity.press('Home');
  await expect(sensitivity).toHaveValue('0');
  await sensitivity.press('End');
  await expect(sensitivity).toHaveValue('100');
  await sensitivity.press('Home');
  for (let i = 0; i < 25; ++i) await sensitivity.press('ArrowRight');
  await expect(sensitivity).toHaveValue('25');
  await cues.uncheck();
  await page.getByRole('button', { name: /^Deepgram Premium/ }).click();
  await expect(sensitivity).toHaveValue('25');
  await expect(cues).not.toBeChecked();
  await sensitivity.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('listening-preferences.png'), fullPage: true });
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Wake NorthPointe', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await expect(sensitivity).toHaveValue('25');
  await expect(cues).not.toBeChecked();
  await expect(page.getByRole('button', { name: /^Deepgram Premium/ })).toHaveClass(/selected/);
  await cues.check();
  await sensitivity.press('End');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await expect(sensitivity).toHaveValue('25');
  await expect(cues).not.toBeChecked();
  await cues.check();
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Wake NorthPointe', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await expect(sensitivity).toHaveValue('25');
  await expect(cues).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('vc2:conversation'))).toBe(conversation);
  expect(preferenceWrites).toEqual([]);
});
