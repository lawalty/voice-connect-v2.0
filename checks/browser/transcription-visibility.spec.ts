import { test, expect, type WebSocketRoute } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';
import { installationFixture } from './installation-fixture';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);
test('saved transcription visibility only controls the orb popup, never automatic turns or the messenger composer', async ({ page, context }, info) => {
  await context.grantPermissions(['microphone']);
  // Older installations omit the field and must default off.
  await installationFixture(page, { recognition: 'deepgram' });
  await page.addInitScript(() => {
    localStorage.setItem('vc2:speech', JSON.stringify({ showTranscriptions: true, audioCues: false }));
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], cancel() {}, addEventListener() {}, removeEventListener() {},
      speak(utterance: SpeechSynthesisUtterance) { queueMicrotask(() => {
        utterance.onstart?.(new Event('start') as SpeechSynthesisEvent);
        utterance.onend?.(new Event('end') as SpeechSynthesisEvent);
      }); },
    } });
  });
  const sockets: WebSocketRoute[] = [], turns: string[] = [];
  await page.routeWebSocket(url => url.pathname === '/api/audio' && url.searchParams.get('kind') === 'stt', socket => {
    sockets.push(socket); socket.send(JSON.stringify({ type: 'ready', sampleRate: 16000 }));
  });
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/turns')) turns.push(request.postDataJSON().text);
  });
  const partial = (text: string) => sockets.at(-1)!.send(JSON.stringify({ type: 'stt', text, started: true, final: false, turnComplete: false }));
  const finish = (text: string) => sockets.at(-1)!.send(JSON.stringify({ type: 'stt', text, final: true, turnComplete: true }));
  const toggle = page.getByRole('checkbox', { name: 'Show Transcriptions', exact: true });
  const openSettings = () => page.getByRole('button', { name: 'Open settings' }).click();
  const save = async (value: boolean) => {
    const response = page.waitForResponse(r => r.url().endsWith('/api/settings/speech') && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
    const saved = await response;
    expect(saved.ok()).toBe(true); expect((await saved.json()).showTranscriptions).toBe(value);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  };
  await enterFixtureSession(page);
  await page.getByRole('button', { name: 'NorthPointe', exact: true }).click();
  await page.getByRole('button', { name: 'Begin a new conversation', exact: true }).click();
  await openSettings();
  await expect(toggle).not.toBeChecked();
  await toggle.scrollIntoViewIfNeeded();
  const diagnostics = await page.getByText('Device diagnostics', { exact: true }).boundingBox();
  const bounds = await toggle.boundingBox();
  expect(bounds!.y).toBeGreaterThan(diagnostics!.y + diagnostics!.height);
  await page.screenshot({ path: info.outputPath('show-transcriptions-default-off.png') });
  await page.getByRole('button', { name: 'Close Make yourself at home', exact: true }).click();
  await page.getByRole('button', { name: 'Wake NorthPointe', exact: true }).click();
  await expect(page.locator('.orb-stage.phase-listening')).toBeVisible();
  partial('A complete thought without a popup.');
  await expect(page.locator('.orb-stage.phase-hearing')).toBeVisible();
  await expect(page.locator('.heard-draft')).toHaveCount(0);
  expect(turns).toEqual([]);
  finish('A complete thought without a popup.');
  await expect.poll(() => turns).toEqual(['A complete thought without a popup.']);
  await expect(page.locator('.orb-stage.phase-listening')).toBeVisible();

  await openSettings(); await toggle.check(); await save(true);
  await page.reload();
  await openSettings(); await expect(toggle).toBeChecked();
  await page.getByRole('button', { name: 'Close Make yourself at home', exact: true }).click();
  await page.getByRole('button', { name: 'Wake NorthPointe', exact: true }).click();
  await expect(page.locator('.orb-stage.phase-listening')).toBeVisible();
  partial('Words visible in the orb and composer.');
  await expect(page.locator('.heard-draft')).toContainText('Words visible in the orb and composer.');
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await expect(page.locator('.heard-draft')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message NorthPointe' })).toHaveValue('Words visible in the orb and composer.');
  finish('Words visible in the orb and composer.');
  await expect.poll(() => turns.at(-1)).toBe('Words visible in the orb and composer.');
  await expect(page.getByRole('textbox', { name: 'Message NorthPointe' })).toHaveValue('');
  await expect(page.locator('.orb-stage.phase-listening')).toBeVisible();

  await openSettings(); await toggle.uncheck(); await save(false);
  await page.reload(); await openSettings(); await expect(toggle).not.toBeChecked();
  await page.getByRole('button', { name: 'Close Make yourself at home', exact: true }).click();
  // Messenger transcription remains available even with the orb popup disabled.
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await page.getByRole('switch', { name: 'Auto mode' }).click();
  await expect(page.locator('.orb-stage.phase-listening')).toBeVisible();
  partial('Still visible in Messenger.');
  await expect(page.getByRole('textbox', { name: 'Message NorthPointe' })).toHaveValue('Still visible in Messenger.');
  await expect(page.locator('.heard-draft')).toHaveCount(0);
});
