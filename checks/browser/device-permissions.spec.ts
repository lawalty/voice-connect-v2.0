import { test, expect, type Page } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';
import { installationFixture } from './installation-fixture';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);
const panel = (page: Page) => page.getByRole('dialog', { name: 'Access request' });
const card = (page: Page, name: string) => panel(page).getByRole('region', { name, exact: true });
async function openPermissions(page: Page) {
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Grant permissions' }).click();
  await expect(panel(page)).toBeVisible();
}

test('permission shortcut requests only on tap, releases media, and retains real approvals after reopening and reload', async ({ page, context }, info) => {
  await context.grantPermissions(['microphone', 'camera', 'clipboard-read', 'clipboard-write']);
  await installationFixture(page);
  await page.addInitScript(() => {
    const probe = { tracks: [] as MediaStreamTrack[], calls: [] as { kind: string; activated: boolean }[] };
    Object.assign(window, { permissionProbe: probe });
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      probe.calls.push({ kind: constraints?.audio ? 'microphone' : 'camera', activated: navigator.userActivation.isActive });
      const stream = await capture(constraints); probe.tracks.push(...stream.getTracks()); return stream;
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read: async () => {
      probe.calls.push({ kind: 'clipboard', activated: navigator.userActivation.isActive });
      return [new ClipboardItem({ 'text/plain': new Blob(['private clipboard sentinel'], { type: 'text/plain' }) })];
    } } });
  });
  const mutations: string[] = [];
  const probe = () => page.evaluate(() => {
    const p = (window as unknown as { permissionProbe: { calls: { kind: string; activated: boolean }[]; tracks: MediaStreamTrack[] } }).permissionProbe;
    return { calls: p.calls, live: p.tracks.filter(track => track.readyState === 'live').length };
  });
  await enterFixtureSession(page);
  await openPermissions(page);
  page.on('request', request => { if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method())) mutations.push(request.url()); });
  await expect(panel(page).getByText('Approved', { exact: true })).toHaveCount(3);
  expect((await probe()).calls).toEqual([]);
  for (const kind of ['microphone', 'camera', 'clipboard']) {
    await panel(page).getByRole('button', { name: `Check ${kind}`, exact: true }).click();
    await expect(panel(page).getByText('Approved', { exact: true })).toHaveCount(3);
    await expect(panel(page).getByRole('button', { name: `Check ${kind}`, exact: true })).toBeEnabled();
  }
  expect(await probe()).toEqual({ calls: ['microphone', 'camera', 'clipboard'].map(kind => ({ kind, activated: true })), live: 0 });
  await expect(page.getByText('private clipboard sentinel')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('permission-approved.png'), fullPage: true });
  await panel(page).getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Grant permissions' }).click();
  await expect(panel(page).getByText('Approved', { exact: true })).toHaveCount(3);
  expect((await probe()).calls).toHaveLength(3);
  await page.reload(); await openPermissions(page);
  await expect(panel(page).getByText('Approved', { exact: true })).toHaveCount(3);
  expect((await probe()).calls).toEqual([]);
  expect(mutations).toEqual([]);
  if (info.project.name === 'android-layout') await page.setViewportSize({ width: 320, height: 740 });
  expect(await panel(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('permission-narrow.png'), fullPage: true });
});

test('onboarding offers permission requests without opening devices and preserves unsaved choices', async ({ page }) => {
  await installationFixture(page, { setupComplete: false });
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => { throw Error('Must not open automatically'); };
    Object.defineProperty(navigator, 'clipboard', { value: { read: () => { throw Error('Must not read automatically'); } } });
  });
  await enterFixtureSession(page);
  const setup = page.getByRole('dialog', { name: 'Set up Voice Connect' });
  await expect(setup).toBeVisible();
  await setup.getByRole('button', { name: /^Deepgram/ }).click();
  await setup.getByRole('button', { name: 'Grant permissions' }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByText(/Required for voice/)).toBeVisible();
  await expect(panel(page).getByText('Needs attention', { exact: true })).toHaveCount(0);
  await panel(page).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(setup.getByRole('button', { name: /^Deepgram/ })).toHaveClass(/selected/);
  await expect(setup.getByRole('button', { name: 'Save setup' })).toBeEnabled();
});

test('denied requests give recovery steps and returning from settings updates grants and revocations', async ({ page }) => {
  await installationFixture(page);
  await page.addInitScript(() => {
    const statuses = new Map<string, EventTarget & { state: PermissionState }>();
    for (const name of ['microphone', 'camera', 'clipboard-read']) statuses.set(name, Object.assign(new EventTarget(), { state: 'denied' as PermissionState }));
    navigator.permissions.query = async descriptor => statuses.get(descriptor.name)! as PermissionStatus;
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
    Object.defineProperty(navigator, 'clipboard', { value: { read: async () => { throw new DOMException('Denied', 'NotAllowedError'); } } });
    Object.assign(window, { changePermission: (name: string, state: PermissionState, notify: boolean) => {
      const status = statuses.get(name)!; status.state = state; if (notify) status.dispatchEvent(new Event('change'));
    } });
  });
  await enterFixtureSession(page); await openPermissions(page);
  await expect(panel(page).getByText('Blocked', { exact: true })).toHaveCount(3);
  await panel(page).getByRole('button', { name: 'Retry microphone' }).click();
  await expect(card(page, 'Microphone').getByText(/Access was not allowed/)).toBeVisible();
  await panel(page).getByRole('button', { name: 'Retry clipboard' }).click();
  await expect(card(page, 'Clipboard').getByText(/Clipboard access was not allowed/)).toBeVisible();
  await panel(page).getByText('Blocked or no prompt? Fix Chrome on Android', { exact: true }).click();
  await expect(panel(page).getByText(/Android Settings → Apps → Chrome/)).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { changePermission(name: string, state: PermissionState, notify: boolean): void }).changePermission('microphone', 'granted', false);
    window.dispatchEvent(new Event('focus'));
  });
  await expect(card(page, 'Microphone').getByText('Approved', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { changePermission(name: string, state: PermissionState, notify: boolean): void }).changePermission('microphone', 'denied', true));
  await expect(card(page, 'Microphone').getByText('Blocked', { exact: true })).toBeVisible();
});

test('unsupported permission queries do not block requests, and late media is stopped after leaving', async ({ page }) => {
  await installationFixture(page);
  await page.addInitScript(() => {
    navigator.permissions.query = async () => { throw new TypeError('Not supported'); };
    const probe = { stopped: 0, resolve: () => {} };
    Object.assign(window, { latePermission: probe });
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { probe.resolve = () => resolve({ getTracks: () => [{ stop() { probe.stopped++; } }] } as unknown as MediaStream); });
    Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => '' } });
  });
  await enterFixtureSession(page); await openPermissions(page);
  await panel(page).getByRole('button', { name: 'Allow clipboard' }).click();
  await expect(card(page, 'Clipboard').getByText('Allowed this time', { exact: true })).toBeVisible();
  await panel(page).getByRole('button', { name: 'Allow microphone' }).click();
  await expect(card(page, 'Microphone').getByText('Waiting for Chrome…')).toBeVisible();
  await panel(page).getByRole('button', { name: 'Done', exact: true }).click();
  await page.evaluate(() => (window as unknown as { latePermission: { resolve(): void } }).latePermission.resolve());
  await expect.poll(() => page.evaluate(() => (window as unknown as { latePermission: { stopped: number } }).latePermission.stopped)).toBe(1);
  await expect(page.getByRole('dialog', { name: 'Make yourself at home' })).toBeVisible();
});

test('unanswered prompts time out without claiming approval and late streams are released', async ({ page }) => {
  await installationFixture(page);
  await page.addInitScript(() => {
    navigator.permissions.query = async () => { throw new TypeError('Not supported'); };
    const probe = { stopped: 0, resolve: () => {} }; Object.assign(window, { latePermission: probe });
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { probe.resolve = () => resolve({ getTracks: () => [{ stop() { probe.stopped++; } }] } as unknown as MediaStream); });
  });
  await enterFixtureSession(page); await openPermissions(page);
  await page.clock.install();
  await panel(page).getByRole('button', { name: 'Allow camera' }).click();
  await page.clock.fastForward(21_000);
  await expect(card(page, 'Camera').getByText(/Chrome has not finished/)).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Retry camera' })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { latePermission: { resolve(): void } }).latePermission.resolve());
  await expect.poll(() => page.evaluate(() => (window as unknown as { latePermission: { stopped: number } }).latePermission.stopped)).toBe(1);
  await expect(card(page, 'Camera').getByText('Needs attention', { exact: true })).toBeVisible();
});

test('missing clipboard and insecure contexts explain recovery without requesting devices', async ({ page }) => {
  await installationFixture(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  });
  await enterFixtureSession(page); await openPermissions(page);
  await expect(card(page, 'Clipboard').getByText('Unavailable', { exact: true })).toBeVisible();
  await expect(card(page, 'Clipboard').getByRole('button')).toBeDisabled();
  await expect(card(page, 'Clipboard').getByText(/Use touch and hold/)).toBeVisible();
  await page.evaluate(() => Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false }));
  await panel(page).getByRole('button', { name: 'Refresh status' }).click();
  await expect(panel(page).getByText('HTTPS required', { exact: true })).toHaveCount(3);
  for (const name of ['Microphone', 'Camera', 'Clipboard']) await expect(card(page, name).getByRole('button')).toBeDisabled();
});
