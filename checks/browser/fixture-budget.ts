import type { APIRequestContext, TestInfo } from '@playwright/test';

// The real service counts shell assets as well as API calls. Reserve enough for
// one complete scenario, including a reload, instead of racing its shared limit.
const minimumRemaining = 60;
const maximumWaitMs = 61_000;

export async function waitForFixtureBudget({ request }: { request: APIRequestContext }, info: TestInfo): Promise<void> {
  info.setTimeout(Math.max(info.timeout, 120_000));
  const deadline = Date.now() + maximumWaitMs;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request.get('/api/status', { timeout: Math.min(5_000, Math.max(1, deadline - Date.now())) });
    const status = response.status(), headers = response.headers();
    await response.dispose();
    if (status !== 200 && status !== 429) throw new Error(`Fixture budget check failed with HTTP ${status}`);
    const remaining = Number(headers['x-ratelimit-remaining']);
    // Fastify emits the remaining window in seconds, not a Unix timestamp.
    const resetSeconds = Number(headers['x-ratelimit-reset']);
    if (!Number.isInteger(remaining) || remaining < 0 || !Number.isInteger(resetSeconds) || resetSeconds < 0 || resetSeconds > 60) {
      throw new Error('Fixture budget check did not return valid rate-limit headers');
    }
    if (status === 200 && remaining >= minimumRemaining) return;
    const waitMs = resetSeconds * 1_000 + 250;
    if (attempt > 0 || waitMs > deadline - Date.now()) throw new Error('Fixture request budget did not recover within one rate-limit window');
    info.annotations.push({ type: 'fixture-budget', description: `Waiting ${waitMs} ms for the production request window to reset (${remaining} requests remain).` });
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}
