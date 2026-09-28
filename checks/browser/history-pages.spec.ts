import { test, expect } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';
import type { Message } from '../../contract/types';

test.beforeEach(waitForFixtureBudget);
test('Messenger loads older messages silently, retains drafts and reading position, and keeps new replies', async ({ page }, info) => {
  const start = Date.UTC(2026, 8, 24);
  const row = (n: number): Message => ({ id: `entry-${n}`, role: n % 2 ? 'assistant' : 'user', text: `History message ${n}. This is a synthetic conversation for paging verification.`, createdAt: start + n * 10000 });
  const older = Array.from({ length: 40 }, (_, n) => row(n));
  older[10] = { ...older[10], text: 'Historical failed turn.', delivery: 'failed' };
  const tail = Array.from({ length: 40 }, (_, n) => row(n + 40));
  let newReply = false, olderRead = false, release: (() => void) | undefined;
  const posts: string[] = [], errors: string[] = [];
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/turns')) posts.push(r.url()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    Object.assign(window, { historySpoken: [] as string[] });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], addEventListener() {}, removeEventListener() {}, cancel() {},
      speak(utterance: SpeechSynthesisUtterance) { (window as unknown as { historySpoken: string[] }).historySpoken.push(utterance.text); },
    } });
  });
  await page.route(url => /^\/api\/conversations\/[^/]+$/.test(url.pathname), async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const url = new URL(route.request().url()), before = url.searchParams.get('before');
    // The fixture supplies its own cursors; do not send them to the real API.
    url.search = '';
    const response = await route.fetch({ url: url.toString() }), view = await response.json();
    expect(response.ok()).toBe(true);
    if (before) {
      olderRead = true; await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ response, json: { ...view, messages: [...older, tail[0]], history: { sessionId: 'paging-session', sync: 'current', start: start } } });
    } else await route.fulfill({ response, json: { ...view, messages: newReply ? [...tail, row(80)] : tail, history: { sessionId: 'paging-session', sync: 'current', start: tail[0].createdAt, before: 'older-page' } } });
  });
  await enterFixtureSession(page);
  await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await expect(page.locator('.message').last()).toContainText('History message 79.');
  await page.getByLabel('Message NorthPointe').fill('Keep my unsent draft.');
  await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
  await expect.poll(() => olderRead).toBe(true);
  const anchor = page.locator('[data-message-id="entry-40"]');
  const top = await anchor.evaluate(node => node.getBoundingClientRect().top);
  release?.();
  await expect(page.locator('.message')).toHaveCount(80);
  expect(Math.abs(await anchor.evaluate(node => node.getBoundingClientRect().top) - top)).toBeLessThan(4);
  await expect(page.getByRole('button', { name: 'Load earlier messages', exact: true })).toHaveCount(0);
  const ids = await page.locator('.message').evaluateAll(nodes => nodes.map(n => (n as HTMLElement).dataset.messageId));
  expect(new Set(ids).size).toBe(80); expect(ids[10]).toBe('entry-10'); expect(ids.at(-1)).toBe('entry-79');
  newReply = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.message')).toHaveCount(81);
  await expect(page.locator('.message').last()).toContainText('History message 80.');
  await expect(page.getByLabel('Message NorthPointe')).toHaveValue('Keep my unsent draft.');
  await page.getByRole('button', { name: 'Latest messages', exact: true }).click();
  await page.screenshot({ path: info.outputPath('paged-messenger.png'), fullPage: true });
  expect(await page.evaluate(() => (window as unknown as { historySpoken: string[] }).historySpoken)).toEqual([]);
  expect(posts).toHaveLength(0); expect(errors).toEqual([]);
});
