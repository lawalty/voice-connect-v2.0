import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);

interface Probe { tracks: MediaStreamTrack[]; spoken: string[]; cancelled: number; current?: SpeechSynthesisUtterance }
async function setup(page: Page) {
  await page.context().grantPermissions(['microphone']);
  await page.addInitScript(() => {
    localStorage.setItem('vc2:speech', JSON.stringify({ recognition: 'deepgram', output: 'browser', handsFree: true, audioCues: false, keepAwake: false }));
    const p: Probe = { tracks: [], spoken: [], cancelled: 0 };
    Object.assign(window, { voiceRecovery: p });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class { constructor(readonly text: string) {} } });
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => { const stream = await capture(constraints); p.tracks.push(...stream.getAudioTracks()); return stream; };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [{ localService: true, lang: 'en-US', default: true }], addEventListener() {}, removeEventListener() {},
      cancel() { p.cancelled++; p.current = undefined; },
      speak(utterance: SpeechSynthesisUtterance) { p.current = utterance; p.spoken.push(utterance.text); queueMicrotask(() => utterance.onstart?.(new Event('start') as SpeechSynthesisEvent)); },
    } });
  });
  const recognition: WebSocketRoute[] = [], turns: string[] = [], aborts: string[] = [];
  await page.routeWebSocket(url => url.pathname === '/api/audio' && url.searchParams.get('kind') === 'stt', route => {
    recognition.push(route); route.send(JSON.stringify({ type: 'ready', sampleRate: 16000 }));
  });
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/turns')) turns.push(request.postDataJSON().id);
    if (request.url().endsWith('/abort')) aborts.push(request.url());
  });
  await enterFixtureSession(page);
  await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
  await page.getByRole('button', { name: 'NorthPointe', exact: true }).click();
  await page.getByRole('button', { name: 'Begin a new conversation' }).click();
  await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await page.getByRole('switch', { name: 'Auto mode' }).click();
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
  const state = () => page.evaluate(() => {
    const p = (window as unknown as { voiceRecovery: Probe }).voiceRecovery;
    return { captures: p.tracks.length, live: p.tracks.filter(t => t.readyState === 'live' && t.enabled).length, spoken: p.spoken, cancelled: p.cancelled };
  });
  return { recognition, turns, aborts, state, conversation: await page.evaluate(() => localStorage.getItem('vc2:conversation')) };
}

async function finishSentence(page: Page) {
  await page.evaluate(() => {
    const p = (window as unknown as { voiceRecovery: Probe }).voiceRecovery;
    const utterance = p.current; p.current = undefined;
    utterance?.onend?.(new Event('end') as SpeechSynthesisEvent);
  });
}

for (const fault of ['reply connection', 'recognition connection'] as const) {
  test(`${fault} retries during speech without ending auto mode, losing the audio queue, or repeating a turn`, async ({ page }) => {
    let armed = false, cut = false, connections = 0;
    await page.routeWebSocket(url => url.pathname === '/api/events', route => {
      connections++; const server = route.connectToServer();
      server.onMessage(message => {
        const event = JSON.parse(message.toString());
        // Let one coherent sentence arrive, then lose the final suffix/completion.
        if (armed && !cut && fault === 'reply connection' && event.type === 'assistant' && event.text?.includes('I’m here')) {
          cut = true; route.close(); return;
        }
        route.send(message);
      });
    });
    const p = await setup(page), before = await p.state(), initialConnections = connections;
    armed = true;
    p.recognition[0]!.send(JSON.stringify({ type: 'stt', text: 'Synthetic connection recovery check.', started: true, final: true, turnComplete: true }));
    await expect.poll(async () => (await p.state()).spoken.length).toBe(1);
    const during = await p.state();
    if (fault === 'recognition connection') {
      p.recognition[0]!.close();
      await expect.poll(() => p.recognition.length).toBe(2);
    } else await expect.poll(() => connections).toBe(initialConnections + 1);
    await expect(page.locator('.site-header .connection-pill')).toHaveText('Connected');
    await expect(page.getByRole('switch', { name: 'Auto mode' })).toBeChecked();
    await expect(page.getByRole('article', { name: 'NorthPointe', exact: true })).toContainText('I’m here with you.');
    const after = await p.state();
    expect(after.captures).toBe(before.captures); expect(after.live).toBe(1); expect(after.cancelled).toBe(during.cancelled);
    await finishSentence(page);
    await expect.poll(async () => (await p.state()).spoken.join(' ')).toBe('Your conversation stays together. I’m here with you.');
    await finishSentence(page);
    await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
    // The next normal voice turn is accepted exactly once on the same session.
    p.recognition.at(-1)!.send(JSON.stringify({ type: 'stt', text: 'A second synthetic message.', started: true, final: true, turnComplete: true }));
    await expect(page.getByRole('article', { name: 'NorthPointe', exact: true }).last()).toContainText('Your second message is in the same conversation.');
    expect(p.turns).toHaveLength(2); expect(new Set(p.turns).size).toBe(2); expect(p.aborts).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('vc2:conversation'))).toBe(p.conversation);
    await expect(page.getByText(/Voice paused during the connection loss|Premium recognition disconnected/)).toHaveCount(0);
  });
}
