import { test, expect } from '@playwright/test';
import { installationFixture } from './installation-fixture';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);

test('Messenger receives partial native text and starts Fish before the answer is complete', async ({ page }) => {
  await installationFixture(page, { output: 'fish', fishVoice: 'fixture' });
  await page.addInitScript(() => localStorage.setItem('vc2:speech', JSON.stringify({ audioCues: false, keepAwake: false })));
  let submitted: string | undefined, complete = false, historyReads = 0;
  const speech: { text: string; beforeComplete: boolean }[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/turns')) submitted = request.postDataJSON().id;
    if (submitted && request.method() === 'GET' && /^\/api\/conversations\/[^/]+$/.test(path)) historyReads++;
  });
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/api/events') return;
    socket.on('framereceived', frame => {
      const event = JSON.parse(String(frame.payload));
      if (event.type === 'complete' && event.turnId === submitted) complete = true;
    });
  });
  await page.routeWebSocket(url => url.pathname === '/api/audio' && url.searchParams.get('kind') === 'tts', socket => {
    socket.onMessage(raw => {
      const event = JSON.parse(String(raw));
      if (event.type === 'speak') { speech.push({ text: event.text, beforeComplete: !complete }); socket.send(Buffer.alloc(4800)); }
      if (event.type === 'flush') socket.send(JSON.stringify({ type: 'speech-done' }));
    });
    socket.send(JSON.stringify({ type: 'ready', sampleRate: 24000 }));
  });
  await enterFixtureSession(page);
  await expect(page.locator('.connection-pill')).toHaveText('Connected');
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await page.getByRole('textbox', { name: 'Message NorthPointe' }).fill('Opening phrase fixture');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const log = page.getByRole('log', { name: 'Messages' });
  await expect(log.locator('.reply-accessible')).toHaveAttribute('aria-label', '**An imaginary garden is a peaceful place with col');
  await expect.poll(() => speech.length).toBeGreaterThan(0);
  expect(speech[0]).toEqual({ text: 'An imaginary garden is a peaceful place with', beforeComplete: true });
  await expect.poll(() => complete).toBe(true);
  expect(speech.map(item => item.text)).toEqual(['An imaginary garden is a peaceful place with', 'colorful flowers and winding paths.', 'More to follow.']);
  await expect(log.getByText('**An imaginary garden is a peaceful place with colorful flowers and winding paths.** More to follow.', { exact: true })).toBeVisible();
  expect(historyReads).toBeLessThan(4); expect(errors).toEqual([]);
  speech.length = 0; await page.reload();
  await expect(page.locator('.connection-pill')).toHaveText('Connected');
  expect(speech).toEqual([]);
});
