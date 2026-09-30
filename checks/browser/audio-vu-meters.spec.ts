import { test, expect, type Page } from '@playwright/test';
import { LUMINOUS_GLASS, type InstallationOrbs } from '../../contract/orb-packs';
import { installationFixture } from './installation-fixture';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);

async function enterWithInput(page: Page) {
  await page.context().grantPermissions(['microphone']);
  await installationFixture(page, { recognition: 'deepgram' });
  await page.addInitScript(() => {
    if (!localStorage.getItem('vc2:speech')) localStorage.setItem('vc2:speech', JSON.stringify({ audioCues: false, keepAwake: false }));
    const probe = { amplitude: 0, captures: 0, tracks: [] as MediaStreamTrack[] };
    Object.assign(window, { vuProbe: probe });
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      probe.captures++;
      const stream = await capture(constraints); probe.tracks.push(...stream.getAudioTracks()); return stream;
    };
    // Retain the real capture worklet, then control its PCM before the engine
    // reads it. The speech detector deliberately reports no speech at all.
    const NativeWorklet = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeWorklet {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if (name === 'voice-capture') this.port.addEventListener('message', event => {
          if (event.data.samples) event.data.samples.fill(probe.amplitude);
        });
      }
    };
    const NativeWorker = window.Worker;
    class QuietWorker {
      onmessage?: (event: MessageEvent) => void;
      stopped = false;
      postMessage(data: { type: string }) {
        if (this.stopped) return;
        if (data.type === 'init') queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: { type: 'ready' } })));
        if (data.type === 'frame') this.onmessage?.(new MessageEvent('message', { data: {
          ...data, type: 'signal', signal: { energy: 0, confidence: 0, speechProbability: 0, noiseFloor: .01, pitch: null }, transition: null, interruption: false,
        } }));
      }
      terminate() { this.stopped = true; }
    }
    Object.defineProperty(window, 'Worker', { value: function(url: string | URL, options?: WorkerOptions) {
      return String(url).includes('vad.worker') ? new QuietWorker() : new NativeWorker(url, options);
    } });
  });
  await page.routeWebSocket(url => url.pathname === '/api/audio' && url.searchParams.get('kind') === 'stt', socket => {
    socket.send(JSON.stringify({ type: 'ready', sampleRate: 16000 }));
  });
  await enterFixtureSession(page);
  await expect(page.getByRole('button', { name: 'Wake NorthPointe', exact: true })).toBeEnabled();
}

async function sound(page: Page, amplitude: number) {
  await page.evaluate(value => { (window as unknown as { vuProbe: { amplitude: number } }).vuProbe.amplitude = value; }, amplitude);
}
async function segments(page: Page, count: number) {
  await expect(page.locator('.voice-center .orb-ear-meter')).toHaveCount(2);
  for (const side of ['left', 'right']) await expect(page.locator(`.voice-center .orb-ear-${side}`)).toHaveAttribute('data-lit-segments', String(count));
}

async function observeEarMovement(page: Page) {
  await page.evaluate(() => {
    const stage = document.querySelector('.voice-center .orb-stage') as HTMLElement;
    const ears = stage.querySelector('.orb-ear-meters') as HTMLElement;
    const left = stage.querySelector('.orb-ear-left') as HTMLElement;
    const samples: { width: number; x: number; y: number }[] = [];
    Object.assign(window, { vuEarMovement: samples });
    const sample = () => {
      const bounds = stage.getBoundingClientRect(), ear = left.getBoundingClientRect();
      samples.push({ width: ear.width / bounds.width, x: (ear.x + ear.width / 2 - bounds.x) / bounds.width, y: (ear.y + ear.height / 2 - bounds.y) / bounds.height });
      if (samples.length > 200) samples.shift();
    };
    sample();
    new MutationObserver(sample).observe(stage, { attributes: true, attributeFilter: ['style'] });
    // Verify the renderer's transform reaches the visible ear layer.
    if (getComputedStyle(ears).transform === 'none') throw new Error('Ear motion is not attached');
  });
}

async function earMovement(page: Page, axis: 'width' | 'x' | 'y') {
  return page.evaluate(axis => {
    const samples = (window as unknown as { vuEarMovement: Record<string, number>[] }).vuEarMovement;
    const values = samples.map(value => value[axis]);
    return Math.max(...values) - Math.min(...values);
  }, axis);
}

for (const style of ['classic', LUMINOUS_GLASS.id]) test(`${style} ears mirror all microphone sounds in Orb and Messenger; standby and End clear them`, async ({ page }, info) => {
  const errors: string[] = [], turns: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/turns')) turns.push(request.url()); });
  await enterWithInput(page);
  const original = await (await page.request.get('/api/orbs')).json() as InstallationOrbs;
  try {
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByText('Orb appearance', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Orb style', exact: true }).selectOption(style);
  await expect(page.getByText('Saving shared appearance…', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close Make yourself at home', exact: true }).click();
  if (style !== 'classic') await expect(page.locator('.voice-center [data-face-ready="true"]')).toBeVisible();
  await segments(page, 0);
  const inactive = page.locator('.voice-center .orb-ear-bar').first();
  await expect(inactive).toHaveCSS('background-color', 'rgb(83, 97, 107)');
  await page.screenshot({ path: info.outputPath('vu-quiet-orb.png') });
  await observeEarMovement(page);
  await page.getByRole('button', { name: 'Wake NorthPointe', exact: true }).click();
  await expect(page.locator('.orb-stage.phase-listening')).toBeVisible();
  if (style === 'classic') await expect.poll(() => earMovement(page, 'width')).toBeGreaterThan(.004);
  else await expect.poll(async () => Math.max(await earMovement(page, 'x'), await earMovement(page, 'y'))).toBeGreaterThan(.002);
  await sound(page, .05); await segments(page, 8);
  await sound(page, .2); await segments(page, 16);
  await expect(page.locator('.voice-center .orb-ear-left .orb-ear-bar').first()).toHaveCSS('background-color', 'rgb(255, 50, 29)');
  await expect(page.locator('.voice-center .orb-ear-left .orb-ear-bar').last()).toHaveCSS('background-color', 'rgb(64, 247, 0)');
  await page.screenshot({ path: info.outputPath('vu-full-orb.png') });
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await segments(page, 16);
  const stage = await page.locator('.voice-center .orb-stage').boundingBox();
  for (const side of ['left', 'right']) {
    const ear = await page.locator(`.voice-center .orb-ear-${side}`).boundingBox();
    expect(ear!.x).toBeGreaterThanOrEqual(stage!.x);
    expect(ear!.x + ear!.width).toBeLessThanOrEqual(stage!.x + stage!.width + 1);
  }
  await page.screenshot({ path: info.outputPath('vu-full-messenger.png') });
  await sound(page, 0); await segments(page, 0);
  await sound(page, .2); await segments(page, 16);
  expect(await page.evaluate(() => (window as unknown as { vuProbe: { captures: number } }).vuProbe.captures)).toBe(1);
  await page.getByRole('button', { name: 'Enter standby mode', exact: true }).click();
  await segments(page, 0);
  await expect(page.locator('.voice-center .orb-stage')).toHaveAttribute('data-presence', 'standby');
  await page.getByRole('button', { name: 'Resume conversation', exact: true }).click();
  await segments(page, 16);
  await page.getByRole('button', { name: 'End voice session', exact: true }).click();
  await segments(page, 0);
  expect(await page.evaluate(() => (window as unknown as { vuProbe: { tracks: MediaStreamTrack[] } }).vuProbe.tracks.filter(track => track.readyState === 'live').length)).toBe(0);
  expect(turns).toEqual([]);
  expect(errors).toEqual([]);
  } finally {
    // These browser scenarios share a fixture installation. Restore its style
    // even on failure so later classic-canvas checks remain independent.
    const current = await (await page.request.get('/api/orbs')).json() as InstallationOrbs;
    if (current.preferences.packId !== original.preferences.packId) {
      const status = await (await page.request.get('/api/status')).json();
      const restored = await page.request.patch('/api/orbs/preferences', {
        headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': status.csrfToken },
        data: { revision: current.revision, patch: original.preferences },
      });
      expect(restored.status()).toBe(200);
    }
  }
});

test('VU toggle saves on this device, survives reload, and closing unsaved settings preserves the choice', async ({ page }, info) => {
  const writes: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/settings')) writes.push(request.url()); });
  await enterWithInput(page);
  await segments(page, 0);
  await page.screenshot({ path: info.outputPath('vu-quiet.png') });
  const open = () => page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const toggle = page.getByRole('checkbox', { name: 'Audio VU meters', exact: true });
  await open(); await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.screenshot({ path: info.outputPath('vu-settings.png') });
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.voice-center .orb-ear-meter')).toHaveCount(0);
  await page.reload(); await open(); await expect(toggle).not.toBeChecked();
  await toggle.check(); await page.keyboard.press('Escape');
  await open(); await expect(toggle).not.toBeChecked();
  await toggle.check(); await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await page.reload(); await segments(page, 0);
  await open(); await expect(toggle).toBeChecked();
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { vuProbe: { captures: number } }).vuProbe.captures)).toBe(0);
});
