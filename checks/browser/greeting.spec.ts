import { test, expect, type Page } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';
import { installationFixture } from './installation-fixture';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);
async function setup(page: Page, greeting?: boolean) {
  await page.context().grantPermissions(['microphone']);
  await installationFixture(page);
  await page.addInitScript(greeting => {
    localStorage.setItem('vc2:speech', JSON.stringify({ recognition: 'browser', handsFree: false, audioCues: false, keepAwake: false, ...(greeting === undefined ? {} : { greeting }) }));
    const probe = { starts: 0, spoken: [] as string[], end: () => {}, tracks: [] as MediaStreamTrack[] };
    Object.assign(window, { greetingProbe: probe });
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => { const stream = await capture(constraints); probe.tracks.push(...stream.getTracks()); return stream; };
    class Recognition {
      onstart?: () => void;
      start() { probe.starts++; queueMicrotask(() => this.onstart?.()); }
      stop() {} abort() {}
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], addEventListener() {}, removeEventListener() {}, cancel() {},
      speak(utterance: SpeechSynthesisUtterance) {
        probe.spoken.push(utterance.text);
        probe.end = () => utterance.onend?.(new Event('end') as SpeechSynthesisEvent);
        queueMicrotask(() => utterance.onstart?.(new Event('start') as SpeechSynthesisEvent));
      },
    } });
  }, greeting);
  await enterFixtureSession(page);
  await page.getByRole('button', { name: 'NorthPointe', exact: true }).click();
  await page.getByRole('button', { name: 'Begin a new conversation', exact: true }).click();
}
const wake = (page: Page) => page.getByRole('button', { name: 'Wake NorthPointe', exact: true });
const state = (page: Page) => page.evaluate(() => {
  const p = (window as any).greetingProbe;
  return { starts: p.starts, spoken: p.spoken as string[], live: p.tracks.filter((t: MediaStreamTrack) => t.readyState === 'live').length, enabled: p.tracks.some((t: MediaStreamTrack) => t.readyState === 'live' && t.enabled) };
});
test('default greeting precedes listening, resumes quietly, and repeats only after End', async ({ page }, info) => {
  const greetings: string[] = []; page.on('request', req => { if (req.url().endsWith('/greeting')) greetings.push(req.postDataJSON().id); });
  await setup(page); await wake(page).click();
  await expect.poll(async () => (await state(page)).spoken).toEqual(['What is on your mind today?']);
  await expect(page.locator('.orb-stage.phase-speaking')).toBeVisible();
  expect((await state(page)).starts).toBe(0); expect((await state(page)).enabled).toBe(false);
  await page.screenshot({ path: info.outputPath('greeting-before-listening.png') });
  await page.evaluate(() => (window as any).greetingProbe.end());
  await expect(page.locator('.orb-stage.phase-listening')).toBeVisible();
  expect((await state(page)).starts).toBe(1);
  await page.getByRole('button', { name: 'Enter standby mode', exact: true }).click();
  expect((await state(page)).live).toBe(0);
  await page.getByRole('button', { name: 'Resume conversation', exact: true }).click();
  await expect(page.locator('.orb-stage.phase-listening')).toBeVisible();
  expect(greetings).toHaveLength(1); expect((await state(page)).spoken).toHaveLength(1);
  await page.getByRole('button', { name: 'End voice session', exact: true }).click();
  await wake(page).click();
  await expect.poll(() => greetings.length).toBe(2);
  await expect.poll(async () => (await state(page)).spoken.length).toBe(2);
  await page.getByRole('button', { name: 'End voice session', exact: true }).click();
  await page.evaluate(() => (window as any).greetingProbe.end());
  await expect(wake(page)).toBeVisible(); expect((await state(page)).live).toBe(0);
  expect((await state(page)).starts).toBe(2);
});
test('Greeting toggle persists off and skips generation and playback', async ({ page }, info) => {
  let requests = 0; page.on('request', req => { if (req.url().endsWith('/greeting')) requests++; });
  await setup(page);
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const toggle = page.getByRole('checkbox', { name: 'Greeting', exact: true });
  await expect(toggle).toBeChecked(); await toggle.uncheck();
  await page.screenshot({ path: info.outputPath('greeting-setting.png') });
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await wake(page).click(); await expect(page.locator('.orb-stage.phase-listening')).toBeVisible();
  expect(requests).toBe(0); expect((await state(page)).spoken).toEqual([]);
  await page.getByRole('button', { name: 'End voice session', exact: true }).click();
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vc2:speech') || '{}').greeting)).toBe(false);
});
test('standby during greeting cancels playback and resumes without another invitation', async ({ page }) => {
  let requests = 0; page.on('request', req => { if (req.url().endsWith('/greeting')) requests++; });
  await setup(page); await wake(page).click();
  await expect.poll(async () => (await state(page)).spoken.length).toBe(1);
  await page.getByRole('button', { name: 'Enter standby mode', exact: true }).click();
  await page.evaluate(() => (window as any).greetingProbe.end());
  await expect(page.locator('.orb-stage.phase-standby')).toBeVisible();
  expect((await state(page)).starts).toBe(0); expect((await state(page)).live).toBe(0);
  await page.getByRole('button', { name: 'Resume conversation', exact: true }).click();
  await expect(page.locator('.orb-stage.phase-listening')).toBeVisible();
  expect(requests).toBe(1); expect((await state(page)).spoken).toHaveLength(1);
});
test('an unavailable greeting still opens listening without a scripted fallback', async ({ page }) => {
  await setup(page);
  await page.route('**/greeting', route => route.fulfill({ status: 503, json: { error: 'Greeting unavailable' } }));
  await wake(page).click(); await expect(page.locator('.orb-stage.phase-listening')).toBeVisible();
  expect((await state(page)).spoken).toEqual([]);
  await expect(page.getByText('The greeting was unavailable. You can begin speaking.', { exact: true })).toBeVisible();
});
