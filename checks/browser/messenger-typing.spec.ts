import { test, expect } from '@playwright/test';
import { installationFixture } from './installation-fixture';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);
async function setup(page: import('@playwright/test').Page) {
  await installationFixture(page, { output: 'fish', fishVoice: 'fixture' });
  await page.addInitScript(() => { localStorage.setItem('vc2:speaker-muted', 'false'); localStorage.setItem('vc2:speech', JSON.stringify({ audioCues: false, keepAwake: false })); });
  await page.routeWebSocket(url => url.pathname === '/api/audio' && url.searchParams.get('kind') === 'tts', socket => {
    socket.onMessage(raw => {
      const event = JSON.parse(String(raw));
      if (event.type === 'speak') {
        const words = event.text.match(/\S+/g) ?? [];
        socket.send(JSON.stringify({ type: 'speech-alignment', alignment: { chunk: 0, offset: 0, content: event.text, duration: 4,
          words: words.map((text: string, index: number) => ({ text, start: .2 + index * .6, end: .6 + index * .6 })) } }));
        socket.send(Buffer.alloc(192000));
      }
      if (event.type === 'flush') socket.send(JSON.stringify({ type: 'speech-done' }));
    });
    socket.send(JSON.stringify({ type: 'ready', sampleRate: 24000 }));
  });
  await enterFixtureSession(page); await expect(page.locator('.connection-pill')).toHaveText('Connected');
  await page.getByRole('button', { name: 'NorthPointe', exact: true }).click();
  await page.getByRole('button', { name: 'Begin a new conversation', exact: true }).click();
  await expect(page.locator('.connection-pill')).toHaveText('Connected');
  await page.getByRole('button', { name: /^Conversation/ }).click();
}

test('waiting dots exclude commentary; reply follows playback after native completion and across views', async ({ page }, info) => {
  await setup(page);
  const input = page.getByRole('textbox', { name: 'Message NorthPointe' });
  await input.fill('Progress commentary fixture'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const dots = page.getByRole('status', { name: 'NorthPointe is preparing a reply' });
  await expect(dots).toBeVisible(); expect(await dots.locator('span').count()).toBe(3);
  await input.fill('My next draft stays here.');
  await expect(page.locator('.messenger-messages')).not.toContainText('I will check the configuration.');
  await expect(page.locator('.activity')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('waiting-dots.png') });
  const reveal = page.locator('.reply-visible');
  await expect(reveal).toBeVisible(); await expect(dots).toHaveCount(0);
  await expect(page.getByRole('note', { name: 'The configuration is correct.', exact: true })).toHaveCount(1);
  await expect(reveal).toHaveText('The');
  await expect(reveal).toHaveText('The configuration');
  await page.screenshot({ path: info.outputPath('spoken-word-reveal.png') });
  await expect(input).toHaveValue('My next draft stays here.');
  await page.getByRole('button', { name: 'Back to orb', exact: true }).click();
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await expect(reveal).toContainText('The configuration');
  await expect(page.locator('.reply-revealing')).toHaveCount(0);
  await expect(page.locator('.message-assistant p')).toHaveText('The configuration is correct.');
  await page.reload(); await page.getByRole('button', { name: /^Conversation/ }).click();
  await expect(page.locator('.reply-revealing')).toHaveCount(0); await expect(dots).toHaveCount(0);
});

test('standby releases the complete readable reply without replaying its reveal', async ({ page }) => {
  await setup(page);
  await page.getByRole('textbox', { name: 'Message NorthPointe' }).fill('Progress commentary fixture');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.reply-visible')).toHaveText('The');
  await page.getByRole('button', { name: 'Enter standby mode', exact: true }).click();
  await expect(page.locator('.reply-revealing')).toHaveCount(0);
  await expect(page.locator('.message-assistant p')).toHaveText('The configuration is correct.');
  await expect(page.getByRole('button', { name: 'Resume conversation', exact: true })).toBeVisible();
  await expect(page.locator('.reply-revealing')).toHaveCount(0);
});

test('reduced motion shows the readable reply without animated text', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await setup(page);
  await page.getByRole('textbox', { name: 'Message NorthPointe' }).fill('Progress commentary fixture');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.typing-indicator')).toBeVisible();
  expect(await page.locator('.typing-indicator span').first().evaluate(node => getComputedStyle(node).animationName)).toBe('none');
  await expect(page.locator('.message-assistant p')).toHaveText('The configuration is correct.');
  await expect(page.locator('.reply-revealing')).toHaveCount(0);
});
