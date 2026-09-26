import { test, expect } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);
for (const provider of ['browser', 'fish'] as const) {
  test(`${provider}: orb and messenger share typed speech, draft, voice capture, and agent mute`, async ({ page, context }, info) => {
    await context.grantPermissions(['microphone']);
    await page.addInitScript(output => {
      localStorage.setItem('vc2:speech', JSON.stringify({ recognition: 'browser', output, fishVoice: 'fixture', handsFree: false, audioCues: false }));
      const probe = { spoken: [] as string[], cancelled: 0, captures: 0, tracks: [] as MediaStreamTrack[], emit: (_text: string) => {} };
      Object.assign(window, { vcMessengerProbe: probe });
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => { probe.captures++; const stream = await capture(constraints); probe.tracks.push(...stream.getAudioTracks()); return stream; };
      class Recognition {
        onstart?: () => void; onend?: () => void; onresult?: (event: unknown) => void;
        start() { probe.emit = text => this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] }); queueMicrotask(() => this.onstart?.()); }
        stop() { this.onend?.(); } abort() {}
      }
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition });
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
        getVoices: () => [], addEventListener() {}, removeEventListener() {}, cancel() { probe.cancelled++; },
        speak(utterance: SpeechSynthesisUtterance) { probe.spoken.push(utterance.text); queueMicrotask(() => utterance.onstart?.(new Event('start') as SpeechSynthesisEvent)); },
      } });
    }, provider);
    const premium: string[] = [], aborts: string[] = [];
    await page.routeWebSocket(url => url.pathname === '/api/audio' && url.searchParams.get('kind') === 'tts', socket => {
      socket.onMessage(raw => { const message = JSON.parse(String(raw)); if (message.type === 'speak') { premium.push(message.text); socket.send(Buffer.alloc(48000)); } if (message.type === 'flush') socket.send(JSON.stringify({ type: 'speech-done' })); });
      socket.send(JSON.stringify({ type: 'ready', sampleRate: 24000 }));
    });
    page.on('request', request => { if (request.url().endsWith('/abort')) aborts.push(request.url()); });
    const state = () => page.evaluate(() => {
      const p = (window as unknown as { vcMessengerProbe: { spoken: string[]; cancelled: number; captures: number; tracks: MediaStreamTrack[] } }).vcMessengerProbe;
      return { spoken: p.spoken, cancelled: p.cancelled, captures: p.captures, capturing: p.tracks.some(t => t.readyState === 'live' && t.enabled) };
    });
    const count = async () => provider === 'fish' ? premium.length : (await state()).spoken.length;
    const subscribed = new Set<string>();
    page.on('websocket', socket => { const url = new URL(socket.url()); if (url.pathname === '/api/events') socket.on('framereceived', frame => { if (JSON.parse(String(frame.payload)).type === 'hello') subscribed.add(url.searchParams.get('conversationId')!); }); });
    await enterFixtureSession(page);
    await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
    await page.getByRole('button', { name: 'NorthPointe', exact: true }).click();
    const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/conversations');
    await page.getByRole('button', { name: 'Begin a new conversation', exact: true }).click();
    const conversation = (await (await created).json()).id as string;
    await expect.poll(() => subscribed.has(conversation)).toBe(true);
    await expect(page.getByRole('log')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Conversation\s*\d/ })).toBeVisible();
    const composer = page.getByRole('textbox', { name: 'Message NorthPointe' });
    await composer.fill('A typed reply from the orb.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(count).toBeGreaterThan(0); expect((await state()).captures).toBe(0);
    const cancelled = (await state()).cancelled;
    await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
    await expect(page.getByRole('log')).toBeVisible();
    await expect(page.getByRole('log').getByText('A typed reply from the orb.', { exact: true })).toBeVisible();
    await composer.fill('A draft shared by both views.');
    expect((await state()).cancelled).toBe(cancelled);
    await page.getByRole('button', { name: 'Back to orb' }).click();
    await expect(composer).toHaveValue('A draft shared by both views.');
    await expect(page.getByRole('log')).toHaveCount(0);
    await page.getByRole('button', { name: 'Mute agent', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Unmute agent', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(aborts).toEqual([]);
    const quietCount = await count();
    await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
    await composer.fill('A second typed reply while muted.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('log').getByText('Your second message is in the same conversation.', { exact: true })).toBeVisible();
    expect(await count()).toBe(quietCount);
    await page.screenshot({ path: info.outputPath(`messenger-${provider}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Unmute agent', exact: true }).click();
    await composer.fill('Another typed reply in messenger.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(count).toBeGreaterThan(quietCount);
    await page.getByRole('button', { name: 'Wake NorthPointe' }).click();
    await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
    if (info.project.name === 'android-layout') {
      await page.setViewportSize({ width: 320, height: 740 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const controls = await page.locator('.voice-controls button').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
      for (let index = 1; index < controls.length; index++) expect(controls[index].left).toBeGreaterThanOrEqual(controls[index - 1].right - 1);
      await page.screenshot({ path: info.outputPath(`messenger-active-320-${provider}.png`), fullPage: true });
    }
    const beforeMute = aborts.length;
    await page.getByRole('button', { name: 'Mute agent', exact: true }).click();
    expect((await state()).capturing).toBe(true); expect(aborts).toHaveLength(beforeMute);
    await expect(page.getByRole('button', { name: 'Mute microphone' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Unmute agent', exact: true }).click();
    const beforeVoice = await count();
    await page.evaluate(() => (window as unknown as { vcMessengerProbe: { emit(text: string): void } }).vcMessengerProbe.emit('A voice reply from messenger.'));
    await page.getByRole('button', { name: 'Finish thought', exact: true }).click();
    await expect.poll(count).toBeGreaterThan(beforeVoice);
    await expect(page.getByRole('log').getByText('A voice reply from messenger.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('vc2:conversation'))).toBe(conversation);
    await page.getByRole('button', { name: 'End voice session' }).click();
    await page.getByRole('button', { name: 'Mute agent', exact: true }).click();
    const beforeReload = await count();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Unmute agent', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
    expect(await count()).toBe(provider === 'browser' ? 0 : beforeReload);
  });
}
