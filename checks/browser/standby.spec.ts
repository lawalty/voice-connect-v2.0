import { test, expect, type Page } from '@playwright/test';
import { installationFixture } from './installation-fixture';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);

async function setup(page: Page, output: 'browser' | 'fish' = 'browser') {
  await page.context().grantPermissions(['microphone']);
  await installationFixture(page, { output, fishVoice: 'fixture' });
  await page.addInitScript(output => {
    localStorage.setItem('vc2:speech', JSON.stringify({ recognition: 'browser', output, fishVoice: 'fixture', handsFree: false, audioCues: false }));
    const probe = { starts: 0, stops: 0, spoken: [] as string[], cancels: 0, tracks: [] as MediaStreamTrack[], emit: (_text: string) => {}, fail: false };
    Object.assign(window, { standbyProbe: probe });
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await capture(constraints); probe.tracks.push(...stream.getAudioTracks()); return stream;
    };
    class Recognition {
      onstart?: () => void; onend?: () => void; onresult?: (event: unknown) => void;
      start() {
        if (probe.fail) throw new DOMException('Microphone unavailable', 'NotAllowedError');
        probe.starts++; probe.emit = text => this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] });
        queueMicrotask(() => this.onstart?.());
      }
      stop() { probe.stops++; this.onend?.(); } abort() { probe.stops++; }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], addEventListener() {}, removeEventListener() {},
      cancel() { probe.cancels++; },
      speak(utterance: SpeechSynthesisUtterance) {
        probe.spoken.push(utterance.text); queueMicrotask(() => utterance.onstart?.(new Event('start') as SpeechSynthesisEvent));
      },
    } });
  }, output);
  await enterFixtureSession(page);
  await page.getByRole('button', { name: 'NorthPointe', exact: true }).click();
  await page.getByRole('button', { name: 'Begin a new conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Wake NorthPointe', exact: true }).click();
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
}

async function state(page: Page) {
  return page.evaluate(() => {
    const p = (window as any).standbyProbe;
    return { starts: p.starts, stops: p.stops, spoken: p.spoken as string[], cancels: p.cancels, live: p.tracks.filter((t: MediaStreamTrack) => t.readyState === 'live').length };
  });
}
async function say(page: Page, text: string) { await page.evaluate(text => (window as any).standbyProbe.emit(text), text); }
const standby = (page: Page) => page.getByRole('button', { name: 'Enter standby mode', exact: true });
const resume = (page: Page) => page.getByRole('button', { name: 'Resume conversation', exact: true });

test('standby is grey, releases capture, keeps the draft and session, and resumes by tap after reconnect', async ({ page }, info) => {
  const turns: string[] = [];
  await setup(page);
  // Give the native transcript context to record the status against. This
  // external send has no playback ownership in this page.
  await page.evaluate(async () => {
    const status = await (await fetch('/api/status')).json();
    await fetch(`/api/conversations/${localStorage.getItem('vc2:conversation')}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': status.csrfToken }, body: JSON.stringify({ id: crypto.randomUUID(), text: 'Pre-standby context' }) });
  });
  await expect.poll(() => page.evaluate(async () => (await (await fetch(`/api/conversations/${localStorage.getItem('vc2:conversation')}`)).json()).messages.filter((m: any) => m.role === 'assistant').length)).toBe(1);
  const generated: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/presence')) turns.push(request.postDataJSON().mode);
    if (request.url().endsWith('/turns')) generated.push(request.postDataJSON().text);
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const id = await page.evaluate(() => localStorage.getItem('vc2:conversation'));
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await page.getByRole('textbox', { name: 'Message NorthPointe' }).fill('Keep my draft.');
  await say(page, 'An unfinished thought');
  await page.getByRole('button', { name: 'Back to orb' }).click();
  await standby(page).click();
  await expect(resume(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.orb-stage')).toHaveAttribute('data-presence', 'standby');
  expect((await state(page)).live).toBe(0);
  expect((await state(page)).stops).toBeGreaterThan(0);
  await say(page, 'A bystander must never be submitted');
  await expect.poll(() => turns).toEqual(['standby']);
  await expect(page.getByRole('button', { name: /Mute agent|Mute microphone/ })).toHaveCount(0);
  await expect.poll(() => page.locator('.orb-canvas').evaluate(element => {
    const c = element as HTMLCanvasElement, pixels = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < pixels.length; i += 4) { r += pixels[i] * pixels[i + 3]; g += pixels[i + 1] * pixels[i + 3]; b += pixels[i + 2] * pixels[i + 3]; }
    return r > 0 && Math.max(r, g, b) / Math.min(r, g, b) < 1.06;
  })).toBe(true);
  await page.screenshot({ path: info.outputPath('standby-grey.png'), fullPage: true });
  await page.context().setOffline(true);
  await expect(resume(page)).toBeDisabled();
  await expect(page.locator('.orb-stage')).toHaveClass(/phase-standby/);
  await page.context().setOffline(false);
  await expect(resume(page)).toBeEnabled();
  expect((await state(page)).starts).toBe(1);
  await resume(page).click();
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
  await expect.poll(() => turns).toEqual(['standby', 'resume']);
  expect((await state(page)).starts).toBe(2);
  expect((await state(page)).live).toBeGreaterThan(0);
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await expect(page.getByRole('textbox', { name: 'Message NorthPointe' })).toHaveValue('Keep my draft.\nAn unfinished thought');
  await expect(page.getByText('Listening resumed', { exact: true })).toBeVisible();
  const history = await page.evaluate(async id => (await fetch(`/api/conversations/${id}`)).json(), id);
  expect(history.messages.filter((m: any) => m.role === 'notice').map((m: any) => m.text)).toEqual(['Standby · conversation paused', 'Listening resumed']);
  expect(history.messages.filter((m: any) => m.role === 'assistant')).toHaveLength(1);
  expect(history.activeTurn).toBeUndefined();
  expect(generated).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('vc2:conversation'))).toBe(id);
  expect((await state(page)).spoken).toEqual([]);
  await page.getByRole('button', { name: 'End voice session' }).click();
});

for (const output of ['browser', 'fish'] as const) test(`${output}: standby cancels active playback and late answers stay silent after resuming`, async ({ page }) => {
  const fish: string[] = [], closed: boolean[] = [];
  await page.routeWebSocket(url => url.pathname === '/api/audio' && url.searchParams.get('kind') === 'tts', socket => {
    socket.onMessage(raw => { const m = JSON.parse(String(raw)); if (m.type === 'speak') { fish.push(m.text); socket.send(Buffer.alloc(480000)); } });
    socket.onClose(() => closed.push(true));
    socket.send(JSON.stringify({ type: 'ready', sampleRate: 24000 }));
  });
  await setup(page, output);
  const spoken = async () => output === 'fish' ? fish.length : (await state(page)).spoken.length;
  await say(page, 'A slow answer for the standby fixture');
  await page.getByRole('button', { name: 'Finish thought', exact: true }).click();
  await expect.poll(spoken).toBeGreaterThan(0);
  const count = await spoken(), cancelled = (await state(page)).cancels;
  await standby(page).click();
  expect((await state(page)).live).toBe(0);
  if (output === 'fish') await expect.poll(() => closed.length).toBeGreaterThan(0);
  else expect((await state(page)).cancels).toBeGreaterThan(cancelled);
  await resume(page).click();
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
  await page.waitForTimeout(650);
  expect(await spoken()).toBe(count);
  await say(page, 'A second message after returning');
  await page.getByRole('button', { name: 'Finish thought', exact: true }).click();
  await expect.poll(spoken).toBeGreaterThan(count);
  await page.getByRole('button', { name: 'End voice session' }).click();
});

test('a pending send cannot overtake standby and resume notices or restart old speech', async ({ page }) => {
  let release!: () => void, pending = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const turns: string[] = [], aborts: string[] = [];
  await page.route('**/api/conversations/*/turns', async route => {
    const text = route.request().postDataJSON().text as string;
    turns.push(text);
    if (text === 'Receipt delayed fixture') { pending = true; await gate; }
    await route.continue();
  });
  page.on('request', r => { if (r.url().endsWith('/abort')) aborts.push(r.url()); });
  page.on('request', r => { if (r.url().endsWith('/presence')) turns.push(r.postDataJSON().mode); });
  await setup(page);
  await say(page, 'Receipt delayed fixture');
  await page.getByRole('button', { name: 'Finish thought', exact: true }).click();
  await expect.poll(() => pending).toBe(true);
  await standby(page).click();
  expect((await state(page)).live).toBe(0);
  expect(aborts).toHaveLength(0);
  await resume(page).click();
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
  release();
  await expect.poll(() => turns).toEqual(['Receipt delayed fixture', 'standby', 'resume']);
  await expect.poll(() => aborts.length).toBeGreaterThan(0);
  await page.waitForTimeout(600);
  expect((await state(page)).spoken).toEqual([]);
  await page.getByRole('button', { name: 'End voice session' }).click();
});

test('notification or microphone failure leaves standby private and keyboard resume remains available', async ({ page }) => {
  const turns: string[] = [];
  await page.route('**/api/conversations/*/presence', async route => {
    turns.push(route.request().postDataJSON().mode);
    await route.fulfill({ status: 503, json: { error: 'Fixture connection unavailable' } });
  });
  await setup(page);
  await standby(page).focus(); await page.keyboard.press('Space');
  await expect(page.getByText(/Standby is on: microphone and playback are paused/)).toBeVisible();
  expect((await state(page)).live).toBe(0);
  await page.evaluate(() => { (window as any).standbyProbe.fail = true; });
  await resume(page).focus(); await page.keyboard.press('Enter');
  await expect(page.getByText(/Microphone unavailable/)).toBeVisible();
  await expect(page.locator('.orb-stage')).toHaveAttribute('data-presence', 'standby');
  await expect(resume(page)).toBeEnabled();
  expect((await state(page)).live).toBe(0);
  expect(turns).toEqual(['standby']);
  await page.evaluate(() => { (window as any).standbyProbe.fail = false; });
  await resume(page).focus(); await page.keyboard.press('Enter');
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
  await expect.poll(() => turns).toEqual(['standby', 'resume']);
  await page.getByRole('button', { name: 'End voice session' }).click();
});

test('a typed message queued during standby stays silent even if listening resumes before delivery', async ({ page }) => {
  let release!: () => void, pending = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const turns: string[] = [];
  await page.route('**/api/conversations/*/presence', async route => {
    const mode = route.request().postDataJSON().mode;
    turns.push(mode);
    if (mode === 'standby') { pending = true; await gate; }
    await route.continue();
  });
  await page.route('**/api/conversations/*/turns', async route => {
    const text = route.request().postDataJSON().text as string;
    turns.push(text);
    if (text === 'A quiet typed message') {
      const response = await route.fetch();
      // Let real reply frames arrive before the receipt releases the next
      // queued action. Cancellation of the resume notice cannot hide a leak.
      await new Promise(resolve => setTimeout(resolve, 700));
      await route.fulfill({ response }); return;
    }
    await route.continue();
  });
  await setup(page);
  await standby(page).click();
  await expect.poll(() => pending).toBe(true);
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await page.getByRole('textbox', { name: 'Message NorthPointe' }).fill('A quiet typed message');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await resume(page).click();
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
  release();
  await expect.poll(() => turns).toEqual(['standby', 'A quiet typed message', 'resume']);
  await page.waitForTimeout(650);
  expect((await state(page)).spoken).toEqual([]);
  await expect(page.getByRole('textbox', { name: 'Message NorthPointe' })).toHaveValue('');
  await page.getByRole('button', { name: 'End voice session' }).click();
});

test('standby stops progress commentary and late progress never wakes it', async ({ page }) => {
  await setup(page);
  await say(page, 'Progress commentary fixture');
  await page.getByRole('button', { name: 'Finish thought', exact: true }).click();
  await expect(page.locator('.orb-stage')).toHaveClass(/phase-(thinking|working)-commentary/);
  const before = (await state(page)).spoken.length;
  await standby(page).click();
  await page.waitForTimeout(1700);
  expect((await state(page)).spoken).toHaveLength(before);
  expect((await state(page)).live).toBe(0);
  await expect(page.locator('.orb-stage')).toHaveClass(/phase-standby/);
  await page.getByRole('button', { name: 'End voice session' }).click();
  await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
});
