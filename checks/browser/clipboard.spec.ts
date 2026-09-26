import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);

async function setup(page: Page) {
  await page.context().grantPermissions(['microphone']);
  await page.addInitScript(() => {
    localStorage.setItem('vc2:speech', JSON.stringify({ recognition: 'deepgram', output: 'browser', handsFree: true, audioCues: false, keepAwake: false }));
    const probe = { tracks: [] as MediaStreamTrack[], reads: 0, spoken: [] as string[], denied: false };
    Object.assign(window, { clipboardProbe: probe });
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => { const stream = await capture(constraints); probe.tracks.push(...stream.getTracks()); return stream; };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read: async () => {
      probe.reads++;
      if (probe.denied) throw new DOMException('Denied', 'NotAllowedError');
      return [{ types: ['text/plain', 'text/html'], getType: async (type: string) => new Blob([type === 'text/plain' ? 'Copied project notes.\nSecond line.' : '<b>ignored html</b>'], { type }) }];
    } } });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], addEventListener() {}, removeEventListener() {}, cancel() {},
      speak(utterance: SpeechSynthesisUtterance) { probe.spoken.push(utterance.text); queueMicrotask(() => { utterance.onstart?.(new Event('start') as SpeechSynthesisEvent); utterance.onend?.(new Event('end') as SpeechSynthesisEvent); }); },
    } });
  });
  const recognition: WebSocketRoute[] = [], turns: { id: string; text: string; attachments?: string[] }[] = [];
  await page.routeWebSocket(url => url.pathname === '/api/audio' && url.searchParams.get('kind') === 'stt', socket => {
    recognition.push(socket); socket.send(JSON.stringify({ type: 'ready', sampleRate: 16000 }));
  });
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/turns')) turns.push(request.postDataJSON()); });
  await enterFixtureSession(page);
  await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
  await page.getByRole('button', { name: 'NorthPointe', exact: true }).click();
  await page.getByRole('button', { name: 'Begin a new conversation' }).click();
  await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
  const state = () => page.evaluate(() => {
    const p = (window as unknown as { clipboardProbe: { tracks: MediaStreamTrack[]; reads: number; spoken: string[] } }).clipboardProbe;
    return { mic: p.tracks.filter(t => t.kind === 'audio' && t.readyState === 'live' && t.enabled).length, reads: p.reads, spoken: p.spoken.length };
  });
  return { recognition, turns, state };
}

async function paste(page: Page, kind: 'image' | 'text' | 'invalid' | 'large', composer = false) {
  return page.evaluate(async ({ kind, composer }) => {
    const data = new DataTransfer();
    if (kind === 'image') {
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 120;
      const drawing = canvas.getContext('2d')!; drawing.fillStyle = '#246ade'; drawing.fillRect(0, 0, 240, 120);
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
      data.items.add(new File([blob], 'clipboard.png', { type: 'image/png' })); data.setData('text/plain', 'alternate image representation');
    } else if (kind === 'invalid') data.items.add(new File(['invalid'], 'invalid.png', { type: 'image/png' }));
    else data.setData('text/plain', kind === 'large' ? 'x'.repeat(20001) : 'Pasted plain text.');
    const target = composer ? document.querySelector('textarea[aria-label="Message NorthPointe"]')! : document.body;
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    target.dispatchEvent(event); return event.defaultPrevented;
  }, { kind, composer });
}

test('Orb clipboard button previews text and caption, pauses input, and retries the exact turn after a lost acknowledgement', async ({ page }) => {
  const p = await setup(page);
  expect((await p.state()).reads).toBe(0);
  await expect(page.getByRole('button', { name: 'Paste from clipboard' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Wake NorthPointe' }).click();
  await expect.poll(async () => (await p.state()).mic).toBe(1);
  await page.getByRole('button', { name: 'Paste from clipboard' }).click();
  await expect(page.getByLabel('Copied text')).toHaveText('Copied project notes.\nSecond line.');
  expect((await p.state()).reads).toBe(1); expect((await p.state()).mic).toBe(0);
  // Keep the native run active through reconciliation and the immediate retry.
  await page.getByLabel('Caption (optional)').fill('Summarize these notes (slow fixture).');
  expect(p.turns).toHaveLength(0);
  await page.route('**/turns', async route => { await route.fetch(); await route.abort('failed'); }, { times: 1 });
  await page.getByRole('button', { name: 'Send clipboard', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Caption (optional)')).toBeDisabled();
  await page.getByRole('button', { name: 'Check delivery', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => (await p.state()).mic).toBe(1);
  expect(p.turns).toHaveLength(2); expect(p.turns[0]).toEqual(p.turns[1]);
  expect(p.turns[0]!.text).toBe('Summarize these notes (slow fixture).\n\nCopied project notes.\nSecond line.');
  expect(p.turns[0]!.attachments).toBeUndefined();
  await expect.poll(async () => (await p.state()).spoken).toBeGreaterThan(0);
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await expect(page.getByRole('article', { name: 'You', exact: true }).filter({ hasText: 'Copied project notes.' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Paste from clipboard' })).toHaveCount(0);
});

test('Orb paste previews an image with caption, preserves its text draft, and keeps the image after refresh', async ({ page }, info) => {
  const p = await setup(page);
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await page.getByLabel('Message NorthPointe').fill('Keep this separate draft.');
  await page.getByRole('button', { name: 'Back to orb' }).click();
  expect(await paste(page, 'image')).toBe(true);
  await expect(page.getByAltText('Clipboard image to send')).toBeVisible();
  expect((await p.state()).reads).toBe(0); expect((await p.state()).mic).toBe(0);
  await page.getByLabel('Caption (optional)').fill('Describe the pasted picture.');
  if (info.project.name === 'android-layout') await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('clipboard-preview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Send clipboard', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(p.turns).toHaveLength(1); expect(p.turns[0]!.text).toBe('Describe the pasted picture.'); expect(p.turns[0]!.attachments).toHaveLength(1);
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await expect(page.getByAltText('Shared photo')).toBeVisible();
  await expect(page.getByLabel('Message NorthPointe')).toHaveValue('Keep this separate draft.');
  await page.reload(); await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await expect(page.getByAltText('Shared photo')).toBeVisible(); expect(p.turns).toHaveLength(1);
});

for (const auto of [false, true]) test(`Messenger paste with auto ${auto}: text stays native, image waits above the composer until sent`, async ({ page }, info) => {
  const p = await setup(page);
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await expect(page.getByRole('button', { name: 'Paste from clipboard' })).toHaveCount(0);
  await page.getByLabel('Message NorthPointe').fill('Use this as the caption.');
  expect(await paste(page, 'text', true)).toBe(false);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  if (auto) {
    await page.getByRole('switch', { name: 'Auto mode' }).click();
    await expect.poll(async () => (await p.state()).mic).toBe(1);
    await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
  }
  expect(await paste(page, 'image', true)).toBe(true);
  await expect(page.getByRole('region', { name: 'Clipboard attachment' })).toBeVisible();
  await expect(page.getByAltText('Clipboard image to send')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await p.state()).mic).toBe(0); expect(p.turns).toHaveLength(0);
  await page.getByRole('button', { name: 'Remove clipboard image' }).click();
  if (auto) await expect.poll(async () => (await p.state()).mic).toBe(1);
  await paste(page, 'image', true);
  await expect(page.getByAltText('Clipboard image to send')).toBeVisible();
  // Switching views keeps the pending attachment and caption together.
  await page.getByRole('button', { name: 'Back to orb' }).click();
  await expect(page.getByLabel('Caption (optional)')).toHaveValue('Use this as the caption.');
  await page.getByRole('button', { name: 'Close Share from clipboard' }).click();
  if (auto) await expect.poll(async () => (await p.state()).mic).toBe(1);
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await paste(page, 'image', true);
  await expect(page.getByAltText('Clipboard image to send')).toBeVisible();
  if (info.project.name === 'android-layout') await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('clipboard-composer.png'), fullPage: true });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Clipboard attachment' })).toHaveCount(0);
  await expect(page.getByAltText('Shared photo')).toBeVisible();
  expect(p.turns).toHaveLength(1); expect(p.turns[0]!.text).toBe('Use this as the caption.'); expect(p.turns[0]!.attachments).toHaveLength(1);
  await expect(page.getByLabel('Message NorthPointe')).toHaveValue('');
  if (auto) await expect.poll(async () => (await p.state()).mic).toBe(1);
  else expect((await p.state()).mic).toBe(0);
});

test('permission denial offers paste fallback; invalid and oversized clipboard content never sends', async ({ page }) => {
  const p = await setup(page);
  await page.getByRole('button', { name: 'Wake NorthPointe' }).click();
  await expect.poll(async () => (await p.state()).mic).toBe(1);
  await page.evaluate(() => { (window as unknown as { clipboardProbe: { denied: boolean } }).clipboardProbe.denied = true; });
  await page.getByRole('button', { name: 'Paste from clipboard' }).click();
  await expect(page.getByRole('alert')).toContainText('not allowed');
  await page.getByLabel('Paste here').fill('Fallback pasted text.');
  await page.getByRole('button', { name: 'Preview text', exact: true }).click();
  await expect(page.getByLabel('Copied text')).toHaveText('Fallback pasted text.');
  await page.getByRole('button', { name: 'Close Share from clipboard' }).click();
  await expect.poll(async () => (await p.state()).mic).toBe(1);
  for (const kind of ['invalid', 'large'] as const) {
    await paste(page, kind);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send clipboard', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Close Share from clipboard' }).click();
  }
  expect(p.turns).toHaveLength(0);
});
