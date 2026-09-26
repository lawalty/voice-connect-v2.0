import { test, expect, type Page } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);

async function messenger(page: Page) {
  await page.setViewportSize({ width: 800, height: 1100 });
  await page.addInitScript(() => {
    localStorage.setItem('vc2:speech', JSON.stringify({ recognition: 'browser', output: 'browser', audioCues: false }));
    Object.assign(window, { recoverySpeech: [] as string[] });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], addEventListener() {}, removeEventListener() {}, cancel() {},
      speak(utterance: SpeechSynthesisUtterance) {
        (window as unknown as { recoverySpeech: string[] }).recoverySpeech.push(utterance.text);
        queueMicrotask(() => { utterance.onstart?.(new Event('start') as SpeechSynthesisEvent); utterance.onend?.(new Event('end') as SpeechSynthesisEvent); });
      },
    } });
  });
  const submissions: string[] = [], aborts: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/turns')) submissions.push(request.postDataJSON().id);
    if (request.url().endsWith('/abort')) aborts.push(request.url());
  });
  await enterFixtureSession(page);
  await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
  await page.getByRole('button', { name: 'NorthPointe', exact: true }).click();
  await page.getByRole('button', { name: 'Begin a new conversation' }).click();
  await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  return { submissions, aborts, conversation: await page.evaluate(() => localStorage.getItem('vc2:conversation')) };
}

for (const fault of ['silent socket', 'missing events'] as const) {
  test(`${fault}: foreground recovery restores a completed reply without refresh, resend, or speech replay`, async ({ page }) => {
    let faulty = false, brokenSocket = 0, connections = 0, dropped = 0;
    await page.routeWebSocket(url => url.pathname === '/api/events', route => {
      const connection = ++connections, server = route.connectToServer();
      server.onMessage(message => {
        const event = JSON.parse(message.toString());
        if (faulty && connection === brokenSocket && event.type !== 'hello' && (fault === 'silent socket' || event.type !== 'pong')) { dropped++; return; }
        route.send(message);
      });
    });
    const p = await messenger(page);
    faulty = true; brokenSocket = connections;
    await page.getByLabel('Message NorthPointe').fill('Synthetic lost reply check.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByText('NorthPointe is thinking', { exact: true })).toBeVisible();
    await expect.poll(() => dropped).toBeGreaterThanOrEqual(4);
    await page.getByLabel('Message NorthPointe').fill('Keep this unfinished thought.');
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('resume'));
    });
    await expect(page.getByRole('article', { name: 'NorthPointe', exact: true })).toContainText('Your conversation stays together.', { timeout: 8000 });
    await expect(page.getByText('NorthPointe is thinking', { exact: true })).toHaveCount(0);
    await expect(page.locator('.site-header .connection-pill')).toHaveText('Connected');
    await expect(page.getByLabel('Message NorthPointe')).toHaveValue('Keep this unfinished thought.');
    expect(await page.evaluate(() => localStorage.getItem('vc2:conversation'))).toBe(p.conversation);
    expect(await page.evaluate(() => (window as unknown as { recoverySpeech: string[] }).recoverySpeech)).toEqual([]);
    expect(p.submissions).toHaveLength(1); expect(p.aborts).toHaveLength(0);
    expect(connections).toBe(fault === 'silent socket' ? brokenSocket + 1 : brokenSocket);
    // The next turn must still stream and speak normally after recovery.
    faulty = false;
    await page.getByLabel('Message NorthPointe').fill('A second synthetic message.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('article', { name: 'NorthPointe', exact: true }).last()).toContainText('Your second message is in the same conversation.');
    await expect.poll(() => page.evaluate(() => (window as unknown as { recoverySpeech: string[] }).recoverySpeech.join(''))).toContain('Your second message');
    expect(p.submissions).toHaveLength(2); expect(new Set(p.submissions).size).toBe(2);
  });
}

test('a delayed foreground history snapshot cannot erase a newer streamed reply', async ({ page }) => {
  const p = await messenger(page);
  let release: (() => void) | undefined, captured = false, returned = false, hold = true;
  await page.route(/\/api\/conversations\/[^/]+$/, async route => {
    if (!hold) { await route.continue(); return; }
    hold = false;
    const snapshot = await route.fetch();
    await new Promise<void>(resolve => { release = resolve; captured = true; });
    await route.fulfill({ response: snapshot }); returned = true;
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => captured).toBe(true);
  try {
    await page.getByLabel('Message NorthPointe').fill('Synthetic history race check.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('article', { name: 'NorthPointe', exact: true })).toContainText('I’m here with you.');
    await expect(page.getByText('NorthPointe is thinking', { exact: true })).toHaveCount(0);
    await page.getByLabel('Message NorthPointe').fill('Draft survives reconciliation.');
  } finally { release?.(); }
  await expect.poll(() => returned).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { recoverySpeech: string[] }).recoverySpeech.join(''))).toContain('I’m here with you.');
  await expect(page.getByRole('article', { name: 'NorthPointe', exact: true })).toContainText('I’m here with you.');
  await expect(page.getByLabel('Message NorthPointe')).toHaveValue('Draft survives reconciliation.');
  expect(p.submissions).toHaveLength(1); expect(p.aborts).toHaveLength(0);
});

test('foreground checks preserve an unfinished streamed answer and recover a missing completion', async ({ page }) => {
  let droppedCompletion = false;
  await page.routeWebSocket(url => url.pathname === '/api/events', route => {
    const server = route.connectToServer();
    server.onMessage(message => {
      if (JSON.parse(message.toString()).type === 'complete') { droppedCompletion = true; return; }
      route.send(message);
    });
  });
  const p = await messenger(page);
  await page.getByLabel('Message NorthPointe').fill('A slow synthetic response.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const answer = page.getByRole('article', { name: 'NorthPointe', exact: true });
  await expect(answer).toContainText('Your conversation stays together.');
  const history = page.waitForResponse(response => new URL(response.url()).pathname === `/api/conversations/${p.conversation}`);
  await page.evaluate(() => document.dispatchEvent(new Event('resume')));
  await history;
  await expect(answer).toContainText('Your conversation stays together.');
  await expect.poll(() => droppedCompletion, { timeout: 16000 }).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(answer).toContainText('I’m here with you.');
  await expect(page.getByText('NorthPointe is thinking', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Interrupt', exact: true })).toHaveCount(0);
  expect(p.submissions).toHaveLength(1); expect(p.aborts).toHaveLength(0);
});
