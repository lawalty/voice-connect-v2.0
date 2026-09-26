import { test, expect, type WebSocketRoute } from '@playwright/test';
import { waitForFixtureBudget } from './fixture-budget';
import { enterFixtureSession } from './fixture-session';

test.beforeEach(waitForFixtureBudget);

for (const endpoint of ['settings', 'conversations']) {
  test(`a failed initial ${endpoint} read recovers in the header without a stale notice`, async ({ page }) => {
    let failing = true;
    await page.route(`**/api/${endpoint}`, route => failing ? route.abort('failed') : route.continue());
    await enterFixtureSession(page);
    const connection = page.locator('.site-header .connection-pill');
    await expect(connection).toHaveText('Reconnecting');
    await expect(page.locator('.notice')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeDisabled();
    failing = false;
    await expect(connection).toHaveText('Connected');
    await expect(connection).not.toHaveAttribute('title');
    await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
    await expect(page.locator('.notice')).toHaveCount(0);
    await expect(page.getByText('Failed to fetch', { exact: true })).toHaveCount(0);
  });
}

test('history and gateway recovery clear only connection errors after the subscription is ready', async ({ page }, info) => {
  let failing = true, holdHello = true;
  let socket: WebSocketRoute | undefined, hello: string | Buffer | undefined;
  await page.route(/\/api\/conversations\/[^/]+$/, route => failing ? route.abort('failed') : route.continue());
  await page.routeWebSocket(url => url.pathname === '/api/events', route => {
    socket = route;
    const server = route.connectToServer();
    server.onMessage(message => {
      if (holdHello && JSON.parse(message.toString()).type === 'hello') hello = message;
      else route.send(message);
    });
  });
  await enterFixtureSession(page);
  const connection = page.locator('.site-header .connection-pill');
  await expect(connection).toHaveText('Reconnecting');
  await expect(page.locator('.notice')).toHaveCount(0);
  failing = false;
  await expect.poll(() => Boolean(hello)).toBe(true);
  // An open WebSocket must not turn the indicator green before its hello arrives.
  await expect(connection).toHaveText('Reconnecting');
  await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeDisabled();
  holdHello = false; socket!.send(hello!);
  await expect(connection).toHaveText('Connected');
  const conversation = await page.evaluate(() => localStorage.getItem('vc2:conversation'));

  socket!.send(JSON.stringify({ type: 'connection', connected: false, reason: 'NorthPointe is reconnecting.' }));
  await expect(connection).toHaveText('Reconnecting');
  await expect(connection).not.toHaveClass(/is-connected/);
  await expect(page.locator('.notice')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('reconnecting.png'), fullPage: true });
  const bounds = await connection.boundingBox();
  expect(bounds!.y).toBeLessThan(100);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  socket!.send(JSON.stringify({ type: 'connection', connected: true }));
  await expect(connection).toHaveText('Connected');
  await expect(connection).not.toHaveAttribute('title');

  // Keep an unresolved delivery warning even when an unrelated connection recovers.
  let submissions = 0;
  await page.route('**/turns', async route => {
    ++submissions;
    await route.fulfill({ json: { turnId: route.request().postDataJSON().id, delivery: 'uncertain' } });
  });
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await page.getByLabel('Message NorthPointe').fill('Preserve this uncertain delivery.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.notice')).toContainText('Delivery is uncertain.');
  failing = true;
  socket!.send(JSON.stringify({ type: 'reconcile', conversationId: conversation }));
  await expect(connection).toHaveText('Reconnecting');
  failing = false;
  await expect(connection).toHaveText('Connected');
  await expect(page.locator('.notice')).toContainText('Delivery is uncertain.');
  await expect(page.locator('.notice')).not.toContainText('Failed to fetch');
  await expect(page.getByLabel('Message NorthPointe')).toHaveValue('Preserve this uncertain delivery.');
  expect(await page.evaluate(() => localStorage.getItem('vc2:conversation'))).toBe(conversation);
  expect(submissions).toBe(1);
});
