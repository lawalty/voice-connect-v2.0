import { test, expect, type WebSocketRoute } from '@playwright/test';
import { installationFixture } from './installation-fixture';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);
test('an OpenClaw display-name change updates both views without resetting voice, session, or draft', async ({ page, context }) => {
  await context.grantPermissions(['microphone', 'camera']);
  await installationFixture(page, { recognition: 'deepgram' });
  await page.addInitScript(() => {
    localStorage.setItem('vc2:speaker-muted', 'true');
    localStorage.setItem('vc2:speech', JSON.stringify({ handsFree: true, audioCues: false, keepAwake: false }));
  });
  let name = 'NorthPointe', unavailable = false, identityReads = 0;
  await page.route('**/api/conversations/*/agent', async route => {
    identityReads++;
    if (unavailable) { await route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }); return; }
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), name } });
  });
  const recognition: WebSocketRoute[] = [], closed: WebSocketRoute[] = [], sends: unknown[] = [];
  await page.routeWebSocket(url => url.pathname === '/api/audio' && url.searchParams.get('kind') === 'stt', socket => {
    recognition.push(socket); socket.onClose(() => closed.push(socket)); socket.send(JSON.stringify({ type: 'ready', sampleRate: 16000 }));
  });
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/turns')) sends.push(r.postDataJSON()); });
  await enterFixtureSession(page);
  await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
  await page.getByRole('button', { name: 'NorthPointe', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Your conversations' })).toBeVisible();
  await page.getByRole('button', { name: 'Begin a new conversation' }).click();
  await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
  const conversation = await page.evaluate(() => localStorage.getItem('vc2:conversation'));
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await page.getByLabel('Message NorthPointe').fill('Name sync fixture.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('article', { name: 'NorthPointe', exact: true })).toBeVisible();
  await page.getByLabel('Message NorthPointe').fill('Preserve this unsent draft.');
  await page.getByRole('switch', { name: 'Auto mode' }).click();
  await expect.poll(() => recognition.length).toBe(1);

  name = 'Digital Lloyd';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Digital Lloyd', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Digital Lloyd', exact: true })).toBeVisible();
  await expect(page.getByLabel('Message Digital Lloyd')).toHaveValue('Preserve this unsent draft.');
  await expect(page.getByRole('switch', { name: 'Auto mode' })).toBeChecked();
  expect(recognition).toHaveLength(1); expect(closed).toHaveLength(0); expect(sends).toHaveLength(1);

  unavailable = true;
  const reads = identityReads;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => identityReads).toBeGreaterThan(reads);
  await expect(page.getByRole('button', { name: 'Digital Lloyd', exact: true })).toBeVisible();
  unavailable = false;
  // A visible tab also discovers a rename without a focus event or page reload.
  name = 'Digital Lloyd Updated';
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 40000 });
  await page.getByRole('button', { name: 'Back to orb' }).click();
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('vc2:conversation'))).toBe(conversation);
  expect(recognition).toHaveLength(1); expect(closed).toHaveLength(0); expect(sends).toHaveLength(1);
  await page.getByRole('button', { name: 'Attach a camera photo' }).click();
  await page.getByRole('button', { name: 'Take photo', exact: true }).click();
  await expect(page.getByPlaceholder(`What would you like ${name} to know?`)).toBeVisible();
  await page.getByRole('button', { name: 'Close Share a moment' }).click();
  await page.getByRole('button', { name: 'End voice session' }).click();
  await expect(page.getByRole('button', { name: `Wake ${name}` })).toBeVisible();
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByRole('heading', { name: `${name}’s voice · TTS` })).toBeVisible();
  await expect(page.getByRole('dialog')).not.toContainText('NorthPointe');
});
