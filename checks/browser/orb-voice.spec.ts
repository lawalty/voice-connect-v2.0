import { test, expect, type Page } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);

async function enterWithMeter(page: Page) {
  await page.context().grantPermissions(['microphone']);
  await page.addInitScript(() => {
    localStorage.setItem('vc2:speech', JSON.stringify({ recognition: 'deepgram', output: 'browser', handsFree: true, audioCues: false, keepAwake: false }));
    const probe = { energy: 0, confidence: 0, speech: 0, frames: 0, captures: 0, tracks: [] as MediaStreamTrack[] };
    Object.assign(window, { vcOrbMeter: probe });
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      probe.captures++; const stream = await capture(constraints); probe.tracks.push(...stream.getAudioTracks()); return stream;
    };
    // Exercise the real capture -> engine -> React -> canvas path with controlled
    // acoustic evidence. Model accuracy is covered by the recorded-audio suite.
    const NativeWorker = window.Worker;
    class MeterWorker {
      onmessage?: (event: MessageEvent) => void;
      stopped = false;
      postMessage(data: { type: string; sequence?: number; epoch?: number; samples?: Float32Array }) {
        if (this.stopped) return;
        if (data.type === 'init') queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: { type: 'ready' } })));
        if (data.type === 'frame') {
          probe.frames++;
          const signal = { energy: probe.energy, confidence: probe.confidence, speechProbability: probe.speech, noiseFloor: .01, pitch: 160 };
          this.onmessage?.(new MessageEvent('message', { data: { ...data, type: 'signal', signal, transition: null, interruption: false } }));
        }
      }
      terminate() { this.stopped = true; }
    }
    Object.defineProperty(window, 'Worker', { value: function(url: string | URL, options?: WorkerOptions) {
      return String(url).includes('vad.worker') ? new MeterWorker() : new NativeWorker(url, options);
    } });
  });
  await page.routeWebSocket(url => url.pathname === '/api/audio' && url.searchParams.get('kind') === 'stt', socket => {
    socket.send(JSON.stringify({ type: 'ready', sampleRate: 16000 }));
  });
  await enterFixtureSession(page);
  await page.getByRole('button', { name: 'Wake NorthPointe', exact: true }).click();
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { vcOrbMeter: { frames: number } }).vcOrbMeter.frames)).toBeGreaterThan(5);
  await page.waitForTimeout(1700); // Let the separate wake animation settle.
}

async function input(page: Page, energy: number, confidence = .95, speech = .95) {
  await page.evaluate(values => Object.assign((window as unknown as { vcOrbMeter: object }).vcOrbMeter, values), { energy, confidence, speech });
}

async function canvasMetrics(page: Page) {
  return page.locator('.orb-canvas').evaluate(element => {
    const canvas = element as HTMLCanvasElement, width = canvas.width;
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, width, canvas.height).data;
    let light = 0, atmosphere = 0, hash = 2166136261;
    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3] / 255;
      const brightness = (pixels[index] + pixels[index + 1] + pixels[index + 2]) * alpha;
      light += brightness;
      const x = index / 4 % width - width / 2, y = Math.floor(index / 4 / width) - width / 2;
      if (Math.hypot(x, y) > width * .33) atmosphere += brightness;
      for (let channel = 0; channel < 4; channel++) hash = Math.imul(hash ^ pixels[index + channel], 16777619);
    }
    return { light: light / (width * width), atmosphere: atmosphere / (width * width), hash: hash >>> 0 };
  });
}

async function captureState(page: Page) {
  return page.evaluate(() => {
    const probe = (window as unknown as { vcOrbMeter: { captures: number; tracks: MediaStreamTrack[] } }).vcOrbMeter;
    return { captures: probe.captures, live: probe.tracks.filter(track => track.readyState === 'live').length };
  });
}

test('microphone evidence pulses the orb and atmosphere in both views; End stops capture before settling to sleep', async ({ page }, info) => {
  const turns: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/turns')) turns.push(request.url()); });
  await enterWithMeter(page);
  for (const view of ['orb', 'messenger']) {
    if (view === 'messenger') await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
    await input(page, 0, 0, 0); await page.waitForTimeout(1200);
    const resting = await canvasMetrics(page);
    await page.screenshot({ path: info.outputPath(`${view}-quiet.png`) });
    await input(page, .7); await page.waitForTimeout(250);
    const speaking = await canvasMetrics(page);
    expect(speaking.light).toBeGreaterThan(resting.light * 1.65);
    expect(speaking.atmosphere).toBeGreaterThan(resting.atmosphere * 3);
    await page.screenshot({ path: info.outputPath(`${view}-voice.png`) });
    // Loud background noise is not a spoken pulse.
    await input(page, 1, .2, .3); await page.waitForTimeout(1400);
    expect((await canvasMetrics(page)).light).toBeLessThan(speaking.light * .65);
    expect(await captureState(page)).toEqual({ captures: 1, live: 1 });
  }
  const awake = await canvasMetrics(page);
  await page.getByRole('button', { name: 'End voice session', exact: true }).click();
  expect(await captureState(page)).toEqual({ captures: 1, live: 0 });
  await expect(page.locator('.orb-stage')).toHaveAttribute('data-presence', 'sleeping');
  await page.waitForTimeout(300);
  const settling = await canvasMetrics(page);
  await page.screenshot({ path: info.outputPath('messenger-falling-asleep.png') });
  await page.waitForTimeout(1400);
  const asleep = await canvasMetrics(page);
  expect(asleep.light).toBeLessThan(awake.light * .75);
  expect(settling.atmosphere).toBeGreaterThan(asleep.atmosphere * 1.5);
  await page.screenshot({ path: info.outputPath('messenger-asleep.png') });
  // Waking again during the exhale must immediately reclaim the animation.
  await page.getByRole('button', { name: 'Wake NorthPointe', exact: true }).click();
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'End voice session', exact: true }).click();
  await page.getByRole('button', { name: 'Wake NorthPointe', exact: true }).click();
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
  await page.waitForTimeout(1700);
  await expect(page.locator('.orb-stage')).toHaveAttribute('data-presence', 'awake');
  expect(await captureState(page)).toEqual({ captures: 3, live: 1 });
  await page.getByRole('button', { name: 'Back to orb' }).click();
  const position = await page.locator('.orb-canvas').boundingBox();
  await page.getByRole('button', { name: 'End voice session', exact: true }).click();
  await page.waitForTimeout(300);
  expect(await page.locator('.orb-canvas').boundingBox()).toEqual(position);
  await page.screenshot({ path: info.outputPath('orb-falling-asleep.png') });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: info.outputPath('orb-asleep.png') });
  expect(turns).toEqual([]);
});

test('reduced motion stays static through voice input and settles immediately on End', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await enterWithMeter(page);
  const quiet = await canvasMetrics(page);
  await input(page, .9); await page.waitForTimeout(300);
  expect((await canvasMetrics(page)).hash).toBe(quiet.hash);
  await page.getByRole('button', { name: 'End voice session', exact: true }).click();
  expect((await captureState(page)).live).toBe(0);
  await page.waitForTimeout(150);
  const asleep = await canvasMetrics(page);
  expect(asleep.light).toBeLessThan(quiet.light);
  await page.waitForTimeout(350);
  expect((await canvasMetrics(page)).hash).toBe(asleep.hash);
});
