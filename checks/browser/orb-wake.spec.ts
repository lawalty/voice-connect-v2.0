import { test, expect, type Page } from '@playwright/test';
import { waitForFixtureBudget } from './fixture-budget';
import { enterFixtureSession } from './fixture-session';

test.beforeEach(waitForFixtureBudget);

type WakeProbe = {
  starts: number;
  captures: number;
  aborts: number;
  ready(): void;
};

async function enterWithControlledSpeech(page: Page, recognition: 'browser' | 'vosk' = 'browser') {
  await page.addInitScript((recognition) => {
    localStorage.setItem('vc2:speech', JSON.stringify({ recognition, output: 'browser', handsFree: recognition === 'vosk', audioCues: false }));
    const probe = { starts: 0, captures: 0, aborts: 0, ready: () => {} };
    (window as unknown as { vcWakeProbe: typeof probe }).vcWakeProbe = probe;
    // Browser recognition owns capture. Disable its optional visualizer here so
    // these interaction checks need no microphone or external speech service.
    navigator.mediaDevices.getUserMedia = async () => {
      probe.captures++;
      throw new DOMException('Synthetic visualizer is unavailable', 'NotSupportedError');
    };
    class ControlledSpeech {
      onstart?: () => void;
      onend?: () => void;
      start() { probe.starts++; probe.ready = () => this.onstart?.(); }
      stop() { this.onend?.(); }
      abort() { probe.aborts++; }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: ControlledSpeech });
  }, recognition);
  await enterFixtureSession(page);
  await expect(page.getByRole('button', { name: 'Wake NorthPointe', exact: true })).toBeEnabled();
  await expect(page.locator('.orb-stage')).toHaveAttribute('data-presence', 'sleeping');
}

function probe(page: Page) {
  return page.evaluate(() => {
    const { starts, captures, aborts } = (window as unknown as { vcWakeProbe: WakeProbe }).vcWakeProbe;
    return { starts, captures, aborts };
  });
}

async function ready(page: Page) {
  await page.evaluate(() => (window as unknown as { vcWakeProbe: WakeProbe }).vcWakeProbe.ready());
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
  await expect(page.locator('.orb-stage')).toHaveAttribute('data-presence', 'awake');
}

async function canvasFingerprint(page: Page) {
  return page.locator('.orb-canvas').evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619);
    return hash >>> 0;
  });
}

test('the sleeping orb wakes once on repeated taps and preserves the current conversation and draft', async ({ page }, info) => {
  const submissions: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/turns')) submissions.push(request.url());
  });
  await enterWithControlledSpeech(page);
  const conversation = await page.evaluate(() => localStorage.getItem('vc2:conversation'));
  await page.getByLabel('Message NorthPointe').fill('Keep this thought while I wake the orb.');
  expect(await probe(page)).toEqual({ starts: 0, captures: 0, aborts: 0 });
  await expect(page.locator('.start-button')).toHaveCount(0);
  const restingFrame = await canvasFingerprint(page);
  await page.waitForTimeout(200);
  expect(await canvasFingerprint(page)).not.toBe(restingFrame);
  await page.screenshot({ path: info.outputPath('orb-sleeping.png'), fullPage: true });

  const bounds = await page.getByRole('button', { name: 'Wake NorthPointe', exact: true }).boundingBox();
  expect(bounds).not.toBeNull();
  const x = bounds!.x + bounds!.width / 2, y = bounds!.y + bounds!.height / 2;
  if (info.project.name === 'android-layout') {
    await page.touchscreen.tap(x, y);
    await page.touchscreen.tap(x, y);
  } else {
    await page.mouse.dblclick(x, y, { delay: 40 });
  }
  await expect.poll(() => probe(page)).toEqual({ starts: 1, captures: 1, aborts: 0 });
  await expect(page.locator('.orb-stage')).toHaveAttribute('data-presence', 'waking');
  await page.screenshot({ path: info.outputPath('orb-waking.png'), fullPage: true });
  await ready(page);
  await expect(page.getByLabel('Message NorthPointe')).toHaveValue('Keep this thought while I wake the orb.');
  await page.screenshot({ path: info.outputPath('orb-awake.png'), fullPage: true });
  await page.getByRole('button', { name: 'End voice session', exact: true }).click();
  await expect(page.locator('.orb-stage')).toHaveAttribute('data-presence', 'sleeping');
  await expect(page.getByRole('button', { name: 'Wake NorthPointe', exact: true })).toBeEnabled();
  expect(await probe(page)).toEqual({ starts: 1, captures: 1, aborts: 1 });
  expect(await page.evaluate(() => localStorage.getItem('vc2:conversation'))).toBe(conversation);
  await expect(page.getByLabel('Message NorthPointe')).toHaveValue('Keep this thought while I wake the orb.');
  expect(submissions).toEqual([]);
});

test('keyboard wake respects reduced motion and a cancelled startup cannot wake later', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await enterWithControlledSpeech(page);
  await page.waitForTimeout(100);
  const sleeping = await canvasFingerprint(page);
  await page.waitForTimeout(350);
  expect(await canvasFingerprint(page)).toBe(sleeping);

  const wake = page.getByRole('button', { name: 'Wake NorthPointe', exact: true });
  await wake.focus();
  await expect(wake).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => probe(page)).toEqual({ starts: 1, captures: 1, aborts: 0 });
  await expect(page.locator('.orb-stage')).toHaveAttribute('data-presence', 'waking');
  await ready(page);
  await page.waitForTimeout(100);
  const awake = await canvasFingerprint(page);
  expect(awake).not.toBe(sleeping);
  await page.waitForTimeout(350);
  expect(await canvasFingerprint(page)).toBe(awake);
  await page.screenshot({ path: info.outputPath('orb-reduced-motion.png'), fullPage: true });

  await page.getByRole('button', { name: 'End voice session', exact: true }).click();
  await expect(wake).toBeEnabled();
  await wake.focus();
  await page.keyboard.press('Space');
  await expect.poll(() => probe(page)).toEqual({ starts: 2, captures: 2, aborts: 1 });
  await expect(page.locator('.orb-stage')).toHaveAttribute('data-presence', 'waking');
  await page.getByRole('button', { name: 'End voice session', exact: true }).click();
  // A recognizer's late readiness event must not undo the user's End action.
  await page.evaluate(() => (window as unknown as { vcWakeProbe: WakeProbe }).vcWakeProbe.ready());
  await expect(page.locator('.orb-stage')).toHaveAttribute('data-presence', 'sleeping');
  await expect(wake).toBeEnabled();
  expect(await probe(page)).toEqual({ starts: 2, captures: 2, aborts: 2 });
  await wake.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => probe(page)).toEqual({ starts: 3, captures: 3, aborts: 2 });
  await ready(page);
  await page.getByRole('button', { name: 'End voice session', exact: true }).click();
  await expect(page.locator('.orb-stage')).toHaveAttribute('data-presence', 'sleeping');
  expect(await probe(page)).toEqual({ starts: 3, captures: 3, aborts: 3 });
});

test('cancelling a pending local-model check cannot open setup or capture audio later', async ({ page }) => {
  await page.addInitScript(() => {
    const state = { opens: 0, matches: 0, release: () => {} };
    (window as unknown as { vcWakeCache: typeof state }).vcWakeCache = state;
    const pending = new Promise<void>(resolve => { state.release = resolve; });
    const open = caches.open.bind(caches);
    caches.open = async name => {
      if (name !== 'voice-connect-model-v1') return open(name);
      state.opens++;
      await pending;
      // Simulate a slow cache returning a missing model manifest. A cancelled
      // wake must ignore this result instead of opening first-time setup.
      return { match: async () => { state.matches++; return undefined; } } as unknown as Cache;
    };
  });
  await enterWithControlledSpeech(page, 'vosk');
  await page.getByRole('button', { name: 'Wake NorthPointe', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { vcWakeCache: { opens: number } }).vcWakeCache.opens)).toBe(1);
  await expect(page.locator('.orb-stage')).toHaveAttribute('data-presence', 'waking');
  await expect(page.getByRole('button', { name: 'Cancel wake', exact: true })).toBeVisible();
  expect(await probe(page)).toEqual({ starts: 0, captures: 0, aborts: 0 });
  await page.getByRole('button', { name: 'Cancel wake', exact: true }).click();
  await expect(page.locator('.orb-stage')).toHaveAttribute('data-presence', 'sleeping');
  await expect(page.getByRole('button', { name: 'Wake NorthPointe', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { vcWakeCache: { release(): void } }).vcWakeCache.release());
  await expect.poll(() => page.evaluate(() => (window as unknown as { vcWakeCache: { matches: number } }).vcWakeCache.matches)).toBe(1);
  await expect(page.getByRole('dialog', { name: 'A conversation that keeps listening' })).toHaveCount(0);
  await expect(page.locator('.orb-stage')).toHaveAttribute('data-presence', 'sleeping');
  expect(await probe(page)).toEqual({ starts: 0, captures: 0, aborts: 0 });
});
