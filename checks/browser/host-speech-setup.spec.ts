import { test, expect } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';
import type { InstallationSpeech } from '../../contract/types';

test.beforeEach(waitForFixtureBudget);
test('onboarding installs on the host and independent provider choices survive a fresh device', async ({ page, context, browser }, info) => {
  let installed = false, installs = 0, removals = 0, microphones = 0;
  let speech: InstallationSpeech = { version: 1, revision: 0, setupComplete: false, recognition: 'vosk', output: 'browser', fishVoice: '' };
  const model = () => ({ id: 'vosk-model-en-us-0.22-lgraph', state: installed ? 'ready' : 'missing', installed, bytes: 130557655, received: installed ? 130557655 : 0 });
  const routes = async (target: typeof page) => {
    await target.route('**/api/settings', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), speech, vosk: model(), deepgramConfigured: true, fishConfigured: true } });
    });
    await target.route('**/api/settings/vosk', async route => {
      if (route.request().method() === 'POST') { installs++; installed = true; }
      if (route.request().method() === 'DELETE') { removals++; installed = false; }
      await route.fulfill({ json: model() });
    });
    await target.route('**/api/settings/speech', async route => {
      if (route.request().method() === 'GET') { await route.fulfill({ json: speech }); return; }
      const { revision, ...next } = route.request().postDataJSON();
      expect(revision).toBe(speech.revision);
      speech = { ...speech, ...next, setupComplete: true, revision: revision + 1 };
      await route.fulfill({ json: speech });
    });
  };
  await routes(page);
  await page.exposeFunction('captureAttempt', () => { microphones++; });
  await page.addInitScript(() => {
    localStorage.setItem('vc2:speech', JSON.stringify({ greeting: false, recognition: 'deepgram', output: 'fish', fishVoice: 'stale-device-voice' }));
    navigator.mediaDevices.getUserMedia = async () => { await (window as unknown as { captureAttempt(): Promise<void> }).captureAttempt(); throw Error('Setup must not open the microphone'); };
  });
  await enterFixtureSession(page);
  const setup = page.getByRole('dialog', { name: 'Set up Voice Connect' });
  await expect(setup).toBeVisible();
  await expect(setup.getByRole('button', { name: /^Vosk lgraph/ })).toHaveClass(/selected/);
  await expect(setup.getByRole('combobox', { name: 'Voice service', exact: true })).toHaveValue('browser');
  await expect(setup.getByRole('button', { name: 'Save setup' })).toBeDisabled();
  await setup.getByRole('button', { name: 'Install on server', exact: true }).click();
  await expect(setup.getByText('Vosk lgraph ready', { exact: true })).toBeVisible();
  await setup.getByRole('combobox', { name: 'Voice service', exact: true }).selectOption('fish');
  await setup.getByLabel('Fish Audio voice ID', { exact: true }).fill('shared-voice');
  await page.screenshot({ path: info.outputPath('host-onboarding.png'), fullPage: true });
  await setup.getByRole('button', { name: 'Save setup' }).click();
  await expect(setup).toHaveCount(0);
  const conversation = await page.evaluate(() => localStorage.getItem('vc2:conversation'));
  for (const provider of ['deepgram', 'vosk'] as const) {
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.getByRole('button', { name: provider === 'vosk' ? /^Vosk lgraph/ : /^Deepgram Premium/ }).click();
    await expect(page.getByLabel('Fish Audio voice ID', { exact: true })).toHaveValue('shared-voice');
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(speech.recognition).toBe(provider);
  }
  expect(installs).toBe(1); expect(removals).toBe(0); expect(microphones).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('vc2:conversation'))).toBe(conversation);
  const other = await browser.newContext({ baseURL: info.project.use.baseURL, storageState: { cookies: await context.cookies(), origins: [] } });
  try {
    const fresh = await other.newPage(); await routes(fresh); await fresh.goto('/');
    await expect(fresh.getByRole('button', { name: 'Open settings' })).toBeEnabled();
    await fresh.getByRole('button', { name: 'Open settings' }).click();
    await expect(fresh.getByRole('button', { name: /^Vosk lgraph/ })).toHaveClass(/selected/);
    await expect(fresh.getByRole('combobox', { name: 'Voice service', exact: true })).toHaveValue('fish');
    await expect(fresh.getByLabel('Fish Audio voice ID', { exact: true })).toHaveValue('shared-voice');
  } finally { await other.close(); }
});
