import { test, expect, type WebSocketRoute } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);
for (const mode of ['orb-auto', 'messenger', 'messenger-auto'] as const) {
  test(`${mode}: pause for a captioned photo, send once, and retain it across views and refresh`, async ({ page, context }, info) => {
    const auto = mode !== 'messenger';
    await context.grantPermissions(['camera', 'microphone']);
    await page.addInitScript(() => {
      localStorage.setItem('vc2:speech', JSON.stringify({ recognition: 'deepgram', output: 'browser', handsFree: true, audioCues: false, keepAwake: false }));
      const probe = { tracks: [] as MediaStreamTrack[], spoken: [] as string[], end: () => {}, cancels: 0 };
      Object.assign(window, { cameraProbe: probe });
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => { const stream = await capture(constraints); probe.tracks.push(...stream.getTracks()); return stream; };
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
        getVoices: () => [], addEventListener() {}, removeEventListener() {}, cancel() { probe.cancels++; },
        speak(utterance: SpeechSynthesisUtterance) { probe.spoken.push(utterance.text); probe.end = () => utterance.onend?.(new Event('end') as SpeechSynthesisEvent); queueMicrotask(() => utterance.onstart?.(new Event('start') as SpeechSynthesisEvent)); },
      } });
    });
    const recognition: WebSocketRoute[] = [], closed: WebSocketRoute[] = [], turns: { id: string; text: string; attachments?: string[] }[] = [];
    await page.routeWebSocket(url => url.pathname === '/api/audio' && url.searchParams.get('kind') === 'stt', socket => {
      recognition.push(socket); socket.onClose(() => closed.push(socket)); socket.send(JSON.stringify({ type: 'ready', sampleRate: 16000 }));
    });
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/turns')) turns.push(request.postDataJSON()); });
    const state = () => page.evaluate(() => {
      const p = (window as unknown as { cameraProbe: { tracks: MediaStreamTrack[]; spoken: string[]; cancels: number } }).cameraProbe;
      return { mic: p.tracks.filter(t => t.kind === 'audio' && t.readyState === 'live' && t.enabled).length, video: p.tracks.filter(t => t.kind === 'video' && t.readyState === 'live').length, spoken: p.spoken, cancels: p.cancels };
    });
    await enterFixtureSession(page);
    await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
    await page.getByRole('button', { name: 'NorthPointe', exact: true }).click();
    await page.getByRole('button', { name: 'Begin a new conversation' }).click();
    await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
    const conversation = await page.evaluate(() => localStorage.getItem('vc2:conversation'));
    await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
    await page.getByLabel('Message NorthPointe').fill('Keep this separate text draft.');
    if (mode === 'orb-auto') await page.getByRole('button', { name: 'Back to orb' }).click();
    if (auto) {
      if (mode === 'messenger-auto') await page.getByRole('switch', { name: 'Auto mode' }).click();
      else await page.getByRole('button', { name: 'Wake NorthPointe' }).click();
      await expect.poll(() => recognition.length).toBe(1);
      await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
    }
    const before = await state();
    await page.getByRole('button', { name: 'Attach a camera photo' }).click();
    await expect(page.getByRole('button', { name: 'Take photo', exact: true })).toBeEnabled();
    if (auto) { await expect.poll(() => closed.length).toBe(1); expect((await state()).mic).toBe(0); }
    // Cancelling resumes only the voice session that was already active.
    await page.getByRole('button', { name: 'Close Share a moment' }).click();
    if (auto) { await expect.poll(() => recognition.length).toBe(2); await expect.poll(async () => (await state()).mic).toBe(1); }
    else expect((await state()).mic).toBe(0);
    expect(turns).toHaveLength(0);
    await page.getByRole('button', { name: 'Attach a camera photo' }).click();
    await expect(page.getByRole('button', { name: 'Take photo', exact: true })).toBeEnabled();
    if (auto) { await expect.poll(() => closed.length).toBe(2); expect((await state()).mic).toBe(0); }
    await page.getByRole('button', { name: 'Take photo', exact: true }).click();
    await expect(page.getByAltText('Photo to send')).toBeVisible();
    await page.getByLabel('Caption (optional)').fill('Look at the patterns in this photo.');
    expect(turns).toHaveLength(0); expect((await state()).cancels).toBe(before.cancels);
    if (info.project.name === 'android-layout') await page.setViewportSize({ width: 320, height: 740 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('camera-caption.png'), fullPage: true });
    await page.getByRole('button', { name: 'Send photo', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Share a moment' })).toHaveCount(0);
    expect(turns).toHaveLength(1); expect(turns[0]!.text).toBe('Look at the patterns in this photo.'); expect(turns[0]!.attachments).toHaveLength(1);
    expect((await state()).video).toBe(0);
    if (auto) { await expect.poll(() => recognition.length).toBe(3); await expect.poll(async () => (await state()).mic).toBe(1); }
    else expect((await state()).mic).toBe(0);
    await expect.poll(async () => (await state()).spoken.length).toBeGreaterThan(0);
    if (mode === 'orb-auto') { await expect(page.locator('.composer-area')).toHaveCount(0); await page.getByRole('button', { name: /Conversation\s*\d/ }).click(); }
    const bubble = page.getByRole('article', { name: 'You', exact: true }).filter({ hasText: 'Look at the patterns in this photo.' });
    await expect(bubble.locator('img')).toBeVisible();
    await expect(page.getByLabel('Message NorthPointe')).toHaveValue('Keep this separate text draft.');
    expect(await page.evaluate(() => localStorage.getItem('vc2:conversation'))).toBe(conversation);
    await page.screenshot({ path: info.outputPath('inline-photo.png'), fullPage: true });
    if (auto) await page.getByRole('button', { name: 'End voice session' }).click();
    await page.reload(); await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
    await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
    await expect(bubble.locator('img')).toBeVisible(); expect(turns).toHaveLength(1);
  });
}

test('an image-only send with a lost acknowledgement reuses its upload and turn without cancelling the reply', async ({ page, context }) => {
  await context.grantPermissions(['camera']);
  await page.addInitScript(() => localStorage.setItem('vc2:speaker-muted', 'true'));
  await enterFixtureSession(page); await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
  await page.getByRole('button', { name: 'NorthPointe', exact: true }).click();
  await page.getByRole('button', { name: 'Begin a new conversation' }).click();
  await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  const requests: { id: string; text: string; attachments: string[] }[] = [], aborts: string[] = [], uploads: string[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/abort')) aborts.push(request.url());
    if (request.url().endsWith('/api/uploads')) uploads.push(request.url());
    if (request.method() === 'POST' && request.url().endsWith('/turns')) requests.push(request.postDataJSON());
  });
  await page.route('**/turns', async route => { await route.fetch(); await route.abort('failed'); }, { times: 1 });
  await page.getByRole('button', { name: 'Attach a camera photo' }).click();
  await expect(page.getByRole('button', { name: 'Take photo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Take photo', exact: true }).click();
  await page.getByRole('button', { name: 'Send photo', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Caption (optional)')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Check delivery', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Share a moment' })).toHaveCount(0);
  expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]); expect(requests[0]!.text).toBe('');
  expect(uploads).toHaveLength(1); expect(aborts).toHaveLength(0);
  await expect(page.getByRole('log').getByAltText('Shared photo')).toHaveCount(1);
  await expect(page.getByRole('log').getByText('Your conversation stays together. I’m here with you.', { exact: true })).toHaveCount(1);
});
