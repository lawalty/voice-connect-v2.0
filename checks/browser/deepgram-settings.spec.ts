import { test, expect } from '@playwright/test';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);

test('Deepgram credential verification preserves sign-in and the saved key without opening audio', async ({ page }, info) => {
  const rejected = 'Deepgram rejected the API key (401). Check the key and try again.';
  const originalKey = 'fixture-existing-deepgram-key';
  const acceptedKey = 'fixture-verified-replacement-key';
  const candidateKey = 'fixture-rejected-candidate-key';
  let savedKey = originalKey, rejectSavedCheck = true;
  const candidates: string[] = [], checkedKeys: string[] = [], turns: string[] = [], audio: string[] = [];
  await page.addInitScript(() => {
    const probe = { microphones: 0, expired: 0 };
    Object.assign(window, { vcDeepgramProbe: probe });
    window.addEventListener('vc-auth-expired', () => { ++probe.expired; });
    navigator.mediaDevices.getUserMedia = async () => {
      ++probe.microphones;
      throw new Error('Credential checks must not request microphone access');
    };
  });
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/turns')) turns.push(request.url());
  });
  await page.routeWebSocket(url => url.pathname === '/api/audio', socket => {
    audio.push(socket.url());
    socket.close();
  });
  // Auth and the application are real; only the provider boundary is simulated.
  // A provider's 401 is deliberately wrapped in 422, so it cannot expire VC auth.
  await page.route('**/api/settings', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), deepgramConfigured: Boolean(savedKey) } });
  });
  await page.route('**/api/settings/deepgram/check', async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-csrf-token']).toBeTruthy();
    checkedKeys.push(savedKey);
    await route.fulfill(rejectSavedCheck ? { status: 422, json: { error: rejected } } : { status: 200, json: { ok: true, verified: true } });
  });
  await page.route('**/api/settings/deepgram', async route => {
    expect(route.request().method()).toBe('PUT');
    expect(route.request().headers()['x-csrf-token']).toBeTruthy();
    const key = route.request().postDataJSON().apiKey;
    candidates.push(key);
    if (key !== acceptedKey) { await route.fulfill({ status: 422, json: { error: rejected } }); return; }
    savedKey = key;
    await route.fulfill({ status: 200, json: { ok: true, verified: true } });
  });

  await page.goto('/');
  await page.getByLabel('Password', { exact: true }).fill('browser-fixture-password-2026');
  await page.getByRole('button', { name: 'Enter your space', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Wake NorthPointe', exact: true })).toBeEnabled();
  const conversation = await page.evaluate(() => localStorage.getItem('vc2:conversation'));
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const section = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: 'Deepgram · STT', exact: true }) });
  // Password inputs have no implicit textbox role in accessibility APIs.
  const keyInput = section.getByLabel('Deepgram API key', { exact: true });
  const check = section.getByRole('button', { name: 'Test saved key', exact: true });
  const save = section.getByRole('button', { name: 'Save key', exact: true });
  await expect(section.getByText('Saved · not checked', { exact: true })).toBeVisible();
  await expect(check).toBeEnabled();
  expect(checkedKeys).toEqual([]);

  await check.click();
  await expect(section.getByText(rejected, { exact: true })).toBeVisible();
  await expect(section.getByText('Connection failed', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { vcDeepgramProbe: { expired: number } }).vcDeepgramProbe.expired)).toBe(0);
  await page.screenshot({ path: info.outputPath('deepgram-rejected.png'), fullPage: true });

  rejectSavedCheck = false;
  await check.click();
  await expect(section.getByText('Connection verified', { exact: true })).toBeVisible();
  await expect(section.getByText('Deepgram connection verified. Start talking to test transcription.', { exact: true })).toBeVisible();
  await keyInput.fill(`  ${candidateKey}  `);
  await expect(check).toBeDisabled();
  await save.click();
  await expect(section.getByText(rejected, { exact: true })).toBeVisible();
  await expect(section.getByText('Saved · not checked', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Remove Deepgram credential', exact: true })).toBeVisible();
  expect(savedKey).toBe(originalKey);
  await keyInput.fill('');
  await check.click();
  await expect(section.getByText('Connection verified', { exact: true })).toBeVisible();
  expect(checkedKeys).toEqual([originalKey, originalKey, originalKey]);

  await keyInput.fill(`  ${acceptedKey}  `);
  await save.click();
  await expect(keyInput).toHaveValue('');
  await expect(section.getByText('Connection verified', { exact: true })).toBeVisible();
  await expect(section.getByText('Deepgram connection verified. Credential saved on the server.', { exact: true })).toBeVisible();
  expect(candidates).toEqual([candidateKey, acceptedKey]);
  expect(savedKey).toBe(acceptedKey);
  const browserStorage = await page.evaluate(() => JSON.stringify(localStorage));
  for (const key of [originalKey, candidateKey, acceptedKey]) expect(browserStorage).not.toContain(key);
  await page.screenshot({ path: info.outputPath('deepgram-verified.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Wake NorthPointe', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem('vc2:conversation'))).toBe(conversation);
  expect(await page.evaluate(() => (window as unknown as { vcDeepgramProbe: { microphones: number } }).vcDeepgramProbe.microphones)).toBe(0);
  expect(audio).toEqual([]);
  expect(turns).toEqual([]);
});
