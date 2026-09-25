import { test, expect, type BrowserContext, type Page } from '@playwright/test';

// Non-authentication scenarios reuse a real fixture session in fresh contexts.
// Keep the production login throttle intact, and keep these test cookies in memory.
const sessions = new Map<string, Awaited<ReturnType<BrowserContext['cookies']>>>();

export async function enterFixtureSession(page: Page) {
  const origin = test.info().project.use.baseURL;
  if (!origin) throw new Error('Fixture origin is required');
  const cookies = sessions.get(origin);
  if (cookies) await page.context().addCookies(cookies);
  await page.goto('/');
  if (cookies) return;
  await page.getByLabel('Password', { exact: true }).fill('browser-fixture-password-2026');
  const login = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Enter your space', exact: true }).click();
  expect((await login).status()).toBe(200);
  sessions.set(origin, await page.context().cookies());
}
