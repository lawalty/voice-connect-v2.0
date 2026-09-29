import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { installationFixture } from './installation-fixture';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';

interface Probe { blocks: number; dropped: number; tracks: MediaStreamTrack[]; pending: SpeechSynthesisUtterance[]; cancellations: number; }
declare global { interface Window { vcMicProbe: Probe; } }
test.beforeEach(waitForFixtureBudget);

async function fixture(page: Page) {
  await page.context().grantPermissions(['microphone']);
  await installationFixture(page, { recognition: 'deepgram' });
  await page.addInitScript(() => {
    const probe: Probe = window.vcMicProbe = { blocks: 0, dropped: 0, tracks: [], pending: [], cancellations: 0 };
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await capture(constraints); probe.tracks.push(...stream.getAudioTracks()); return stream;
    };
    const Worklet = AudioWorkletNode;
    Object.defineProperty(window, 'AudioWorkletNode', { value: class extends Worklet {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if (name === 'voice-capture') this.port.addEventListener('message', event => {
          if (event.data.samples) { probe.blocks++; probe.dropped += event.data.dropped || 0; }
        });
      }
    } });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], addEventListener() {}, removeEventListener() {},
      cancel() { probe.cancellations++; probe.pending = []; },
      speak(utterance: SpeechSynthesisUtterance) {
        probe.pending.push(utterance); queueMicrotask(() => utterance.onstart?.(new Event('start') as SpeechSynthesisEvent));
      },
    } });
  });
  const sockets: WebSocketRoute[] = [], turns: string[] = [];
  await page.routeWebSocket(url => url.pathname === '/api/audio' && url.searchParams.get('kind') === 'stt', socket => {
    sockets.push(socket); socket.send(JSON.stringify({ type: 'ready', sampleRate: 16000 }));
  });
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/turns')) turns.push(request.postDataJSON().text);
  });
  await enterFixtureSession(page);
  await page.getByRole('button', { name: 'NorthPointe', exact: true }).click();
  await page.getByRole('button', { name: 'Begin a new conversation', exact: true }).click();
  return {
    sockets, turns,
    say(text: string) { sockets.at(-1)!.send(JSON.stringify({ type: 'stt', text, started: true, final: true, turnComplete: true })); },
    async wake() {
      await page.getByRole('button', { name: 'Wake NorthPointe', exact: true }).click();
      await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
    },
    async finishPlayback() {
      await page.evaluate(async () => { while (window.vcMicProbe.pending.length) {
        window.vcMicProbe.pending.shift()!.onend?.(new Event('end') as SpeechSynthesisEvent); await Promise.resolve();
      } });
      await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
    },
  };
}

test('interruption opt-out survives reload and retains automatic voice turns and the manual Interrupt button', async ({ page }, info) => {
  const voice = await fixture(page);
  const toggle = page.getByRole('checkbox', { name: 'Allow interruptions', exact: true });
  const slider = page.getByRole('slider', { name: 'Interruption sensitivity' });
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(toggle).toBeChecked(); await expect(slider).toBeEnabled();
  await slider.fill('20'); await toggle.uncheck();
  await expect(slider).toBeDisabled(); await expect(slider).toHaveValue('20');
  await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('interruptions-off.png') });
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(toggle).not.toBeChecked(); await expect(slider).toBeDisabled(); await expect(slider).toHaveValue('20');
  await page.getByRole('button', { name: 'Close Make yourself at home', exact: true }).click();
  await voice.wake(); voice.say('First full thought.');
  await expect(page.getByText('NorthPointe is speaking', { exact: true })).toBeVisible();
  voice.say('A provider event during playback must be ignored.');
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await expect(page.getByRole('switch', { name: 'Auto mode' })).toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Message NorthPointe' })).toHaveValue('');
  await voice.finishPlayback();
  expect(voice.turns).toEqual(['First full thought.']);
  voice.say('Second full thought.');
  await expect(page.getByText('NorthPointe is speaking', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Interrupt', exact: true }).click();
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
  expect(voice.turns).toEqual(['First full thought.', 'Second full thought.']);
  expect(await page.evaluate(() => window.vcMicProbe.tracks.every(track => track.readyState === 'live'))).toBe(true);
  await page.getByRole('button', { name: 'Open settings' }).click();
  await toggle.check(); await expect(slider).toBeEnabled(); await expect(slider).toHaveValue('20');
});

test('real worklet and VAD survive an 800ms UI stall while a reply plays', async ({ page }) => {
  const voice = await fixture(page); await voice.wake();
  voice.say('Keep this reply playing through a short UI stall.');
  await expect(page.getByText('NorthPointe is speaking', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.vcMicProbe.blocks)).toBeGreaterThan(12);
  const before = await page.evaluate(() => ({ blocks: window.vcMicProbe.blocks, cancellations: window.vcMicProbe.cancellations }));
  // Intentionally stall only the UI thread. The actual AudioWorklet keeps capturing.
  await page.evaluate(() => { const until = performance.now() + 800; while (performance.now() < until) { /* fault injection */ } });
  await expect.poll(() => page.evaluate(() => window.vcMicProbe.blocks)).toBeGreaterThan(before.blocks + 27);
  const after = await page.evaluate(() => ({ dropped: window.vcMicProbe.dropped, cancellations: window.vcMicProbe.cancellations,
    capturing: window.vcMicProbe.tracks.length === 1 && window.vcMicProbe.tracks[0]!.readyState === 'live' }));
  expect(after).toEqual({ dropped: 0, cancellations: before.cancellations, capturing: true });
  await expect(page.getByText(/Microphone processing fell behind|could not keep up with speech detection|unexpected gap/)).toHaveCount(0);
  await expect(page.getByText('NorthPointe is speaking', { exact: true })).toBeVisible();
  await voice.finishPlayback(); voice.say('A complete turn after recovery.');
  await expect.poll(() => voice.turns).toEqual(['Keep this reply playing through a short UI stall.', 'A complete turn after recovery.']);
  expect(voice.sockets).toHaveLength(1);
});

test('sustained overload still preserves an unfinished spoken turn instead of submitting it', async ({ page }) => {
  const voice = await fixture(page); await voice.wake();
  voice.sockets.at(-1)!.send(JSON.stringify({ type: 'stt', text: 'Keep my unfinished words', started: true, final: false, turnComplete: false }));
  await expect(page.getByText('I’m hearing you', { exact: true })).toBeVisible();
  await page.evaluate(() => { const until = performance.now() + 1700; while (performance.now() < until) { /* fault injection */ } });
  await expect(page.getByText('Microphone processing fell behind. Review your draft; incomplete audio was not sent.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await expect(page.getByRole('textbox', { name: 'Message NorthPointe' })).toHaveValue('Keep my unfinished words');
  expect(voice.turns).toEqual([]);
});
