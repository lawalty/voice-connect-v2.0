import { test, expect, type WebSocketRoute } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);
test('automatic turns keep cue order and one capture session across orb, messenger, and typing', async ({ page, context }, info) => {
  await context.grantPermissions(['microphone']);
  await page.addInitScript(() => {
    localStorage.setItem('vc2:speech', JSON.stringify({ recognition: 'deepgram', output: 'browser', handsFree: true, turnMode: 'automatic', audioCues: true }));
    const probe = { cues: [] as string[], captures: 0, tracks: [] as MediaStreamTrack[], spoken: [] as string[], pending: [] as SpeechSynthesisUtterance[], cancellations: 0 };
    Object.assign(window, { vcCadence: probe });
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => { probe.captures++; const stream = await capture(constraints); probe.tracks.push(...stream.getAudioTracks()); return stream; };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args) {
      if (Math.abs((this.buffer?.duration || 0) - .48) < .001) probe.cues.push('listening');
      if (Math.abs((this.buffer?.duration || 0) - .26) < .001) probe.cues.push('sent');
      return start.apply(this, args);
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], addEventListener() {}, removeEventListener() {},
      cancel() { probe.cancellations++; probe.pending = []; },
      speak(utterance: SpeechSynthesisUtterance) { probe.spoken.push(utterance.text); probe.pending.push(utterance); queueMicrotask(() => utterance.onstart?.(new Event('start') as SpeechSynthesisEvent)); },
    } });
  });
  const sockets: WebSocketRoute[] = [], turns: string[] = [], aborts: string[] = [];
  await page.routeWebSocket(url => url.pathname === '/api/audio' && url.searchParams.get('kind') === 'stt', socket => {
    sockets.push(socket); socket.send(JSON.stringify({ type: 'ready', sampleRate: 16000 }));
  });
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/turns')) turns.push(request.postDataJSON().text);
    if (request.url().endsWith('/abort')) aborts.push(request.url());
  });
  const subscribed = new Set<string>(), completed = new Set<string>();
  page.on('websocket', socket => {
    const url = new URL(socket.url());
    if (url.pathname === '/api/events') socket.on('framereceived', frame => {
      const event = JSON.parse(String(frame.payload));
      if (event.type === 'hello') subscribed.add(url.searchParams.get('conversationId')!);
      if (event.type === 'complete') completed.add(event.turnId);
    });
  });
  const state = () => page.evaluate(() => {
    const p = (window as unknown as { vcCadence: { cues: string[]; captures: number; tracks: MediaStreamTrack[]; spoken: string[]; cancellations: number } }).vcCadence;
    return { cues: p.cues, captures: p.captures, capturing: p.tracks.some(track => track.readyState === 'live' && track.enabled), spoken: p.spoken.length, cancellations: p.cancellations };
  });
  const endPlayback = async () => {
    await expect(page.getByText('NorthPointe is speaking', { exact: true })).toBeVisible();
    await page.evaluate(async () => { const p = (window as unknown as { vcCadence: { pending: SpeechSynthesisUtterance[] } }).vcCadence; while (p.pending.length) { await Promise.resolve(); p.pending.shift()!.onend?.(new Event('end') as SpeechSynthesisEvent); } });
  };
  const speak = (text: string) => {
    sockets.at(-1)!.send(JSON.stringify({ type: 'stt', text: '', started: true, final: false, turnComplete: false }));
    sockets.at(-1)!.send(JSON.stringify({ type: 'stt', text, final: true, turnComplete: true }));
  };
  await enterFixtureSession(page);
  await page.getByRole('button', { name: 'NorthPointe', exact: true }).click();
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/conversations');
  await page.getByRole('button', { name: 'Begin a new conversation', exact: true }).click();
  const id = (await (await created).json()).id as string;
  await expect.poll(() => subscribed.has(id)).toBe(true);
  await page.getByRole('button', { name: 'Wake NorthPointe' }).click();
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible({ timeout: 30000 });
  const expected = ['listening'];
  expect((await state()).cues).toEqual(expected);
  for (const text of ['First automatic thought.', 'A second automatic thought.']) {
    const count = completed.size; speak(text); expected.push('sent');
    await expect.poll(() => completed.size).toBe(count + 1);
    expect((await state()).cues).toEqual(expected);
    await endPlayback(); expected.push('listening');
    await expect.poll(async () => (await state()).cues).toEqual(expected);
  }
  expect(aborts).toEqual([]); expect(turns).toEqual(['First automatic thought.', 'A second automatic thought.']);
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await expect(page.getByRole('switch', { name: 'Auto mode' })).toBeChecked();
  const composer = page.getByRole('textbox', { name: 'Message NorthPointe' });
  await composer.fill('An unfinished typed thought.');
  expect((await state()).capturing).toBe(true); expect(sockets).toHaveLength(1);
  let count = completed.size; speak('A voice thought while I type.');
  await expect.poll(() => completed.size).toBe(count + 1); await endPlayback();
  await expect(composer).toHaveValue('An unfinished typed thought.');
  expect((await state()).cues).toEqual(expected);
  count = completed.size; await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => completed.size).toBe(count + 1);
  expect((await state()).captures).toBe(1); expect((await state()).capturing).toBe(true);
  const cancels = (await state()).cancellations;
  await page.getByRole('switch', { name: 'Auto mode' }).click();
  await expect(page.getByRole('switch', { name: 'Auto mode' })).not.toBeChecked();
  expect((await state()).capturing).toBe(false); expect((await state()).cancellations).toBe(cancels);
  await endPlayback(); expect((await state()).cues).toEqual(expected);
  await page.getByRole('switch', { name: 'Auto mode' }).click();
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('switch', { name: 'Auto mode' })).toBeChecked();
  expect((await state()).captures).toBe(2); expect(sockets).toHaveLength(2); expect((await state()).cues).toEqual(expected);
  await page.screenshot({ path: info.outputPath('messenger-auto-mode.png') });
  await page.getByRole('button', { name: 'Back to orb' }).click();
  count = completed.size; speak('Back in the orb without restarting.'); expected.push('sent');
  await expect.poll(() => completed.size).toBe(count + 1); expect((await state()).cues).toEqual(expected);
  await endPlayback(); expected.push('listening');
  await expect.poll(async () => (await state()).cues).toEqual(expected);
  expect((await state()).captures).toBe(2); expect(sockets).toHaveLength(2); expect(aborts).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('vc2:conversation'))).toBe(id);
});
