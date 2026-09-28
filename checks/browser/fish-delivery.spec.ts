import { test, expect, type Page } from '@playwright/test';
import type { InstallationSpeech } from '../../contract/types';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);

test('Fish delivery defaults, unsaved previews, delivery-only saves and fresh-device settings', async ({ page, browser, context }, info) => {
  // Auth/app are real. Installation storage and paid synthesis are isolated fixtures.
  let speech: InstallationSpeech = { version: 1, revision: 1, setupComplete: true, recognition: 'browser', output: 'fish', fishVoice: 'delivery-fixture' };
  let model: string | undefined = 's2.1-pro';
  const saves: InstallationSpeech[] = [], previews: { cue: string | null; texts: string[] }[] = [], turns: string[] = [];
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const routes = async (target: Page) => {
    await target.route('**/api/settings', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), fishConfigured: true, fishModel: model, speech } });
    });
    await target.route('**/api/settings/speech', async route => {
      if (route.request().method() === 'GET') { await route.fulfill({ json: speech }); return; }
      const value = route.request().postDataJSON();
      expect(route.request().headers()['x-csrf-token']).toBeTruthy();
      expect(value.revision).toBe(speech.revision);
      speech = { ...speech, ...value, revision: value.revision + 1 }; saves.push(speech);
      await route.fulfill({ json: speech });
    });
  };
  await routes(page);
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/turns')) turns.push(request.url()); });
  await page.routeWebSocket(url => url.pathname === '/api/audio', socket => {
    const preview = { cue: new URL(socket.url()).searchParams.get('fishDelivery'), texts: [] as string[] }; previews.push(preview);
    socket.onMessage(message => {
      const event = JSON.parse(String(message));
      if (event.type === 'speak') preview.texts.push(event.text);
      if (event.type === 'flush') { socket.send(Buffer.alloc(4800)); socket.send(JSON.stringify({ type: 'speech-done' })); }
    });
    socket.send(JSON.stringify({ type: 'ready', sampleRate: 24000 }));
  });
  await enterFixtureSession(page);
  const open = () => page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await open();
  const delivery = page.getByRole('combobox', { name: 'Emotion & delivery', exact: true });
  await expect(delivery).toHaveValue('restrained');
  await expect(page.getByText('[calm, warm, measured voice]', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Fish Audio voice ID', { exact: true })).toHaveValue('delivery-fixture');
  const speaker = page.getByRole('region', { name: 'Speaker check' });
  await delivery.selectOption('soft');
  await speaker.getByRole('button', { name: 'Test speaker', exact: true }).click();
  await expect(speaker.getByText('The player reported playback ending', { exact: true })).toBeVisible();
  expect(previews).toEqual([{ cue: 'soft', texts: ['This is Voice Connect. If you can hear this sentence, your speaker test is working.'] }]);
  expect(saves).toHaveLength(0); expect(speech.fishDelivery).toBeUndefined();
  await speaker.getByRole('button', { name: 'I heard it', exact: true }).click();
  await delivery.selectOption('off');
  await expect(speaker.getByText('Audibility has not been confirmed.', { exact: true })).toBeVisible();
  await expect(speaker.getByText('Not tested in this Settings session', { exact: true })).toBeVisible();
  await expect(page.getByText(/No delivery cue is added/)).toBeVisible();
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(saves).toHaveLength(1); expect(speech.fishDelivery).toBe('off');
  await page.reload(); await open(); await expect(delivery).toHaveValue('off');
  await delivery.selectOption('restrained');
  await delivery.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('fish-delivery.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(saves).toHaveLength(2);
  const other = await browser.newContext({ baseURL: info.project.use.baseURL, storageState: { cookies: await context.cookies(), origins: [] } });
  try {
    const fresh = await other.newPage(); await routes(fresh); await fresh.goto('/');
    await fresh.getByRole('button', { name: 'Open settings', exact: true }).click();
    await expect(fresh.getByRole('combobox', { name: 'Emotion & delivery', exact: true })).toHaveValue('restrained');
  } finally { await other.close(); }
  // Capability rendering follows the server-reported model, never the voice ID.
  model = 's1'; await page.reload(); await open();
  await expect(page.getByText('(calm)', { exact: true })).toBeVisible();
  model = 'future-unknown'; await page.reload(); await open();
  await expect(delivery).toBeDisabled(); await expect(page.getByText(/Delivery cues are unavailable for Fish model/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Voice service', exact: true }).selectOption('browser');
  await expect(delivery).toHaveCount(0);
  expect(turns).toEqual([]); expect(errors).toEqual([]);
});
