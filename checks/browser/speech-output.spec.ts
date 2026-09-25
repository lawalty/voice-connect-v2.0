import { test, expect } from '@playwright/test';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);

test('speaker checks distinguish playback reports from audibility and keep paid tests explicit', async ({ page }, info) => {
  await page.addInitScript(() => {
    const synthesis = new EventTarget();
    const probe = {
      calls: [] as { text: string; onstart?: () => void; onend?: () => void; onerror?: (event: { error: string }) => void }[],
      cancellations: 0, microphones: 0, voices: [] as SpeechSynthesisVoice[],
      start() { this.calls.at(-1)?.onstart?.(); },
      end() { this.calls.at(-1)?.onend?.(); },
      error() { this.calls.at(-1)?.onerror?.({ error: 'not-allowed' }); },
      publishVoices() {
        this.voices = [{ name: 'Fixture English voice', voiceURI: 'fixture-english', lang: 'en-US', localService: true, default: true } as SpeechSynthesisVoice];
        synthesis.dispatchEvent(new Event('voiceschanged'));
      },
    };
    Object.assign(synthesis, { getVoices: () => probe.voices, speak: (utterance: typeof probe.calls[number]) => probe.calls.push(utterance), cancel: () => { ++probe.cancellations; }, resume: () => {}, pause: () => {}, pending: false, speaking: false, paused: false });
    class Utterance { onstart?: () => void; onend?: () => void; onerror?: (event: { error: string }) => void; constructor(public text: string) {} }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synthesis });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: Utterance });
    Object.assign(window, { vcSpeakerProbe: probe });
    navigator.mediaDevices.getUserMedia = async () => { ++probe.microphones; throw new Error('Speaker checks must not request microphone access'); };
  });
  const turns: string[] = [], paid: { provider: string | null; voice: string | null; texts: string[] }[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/turns')) turns.push(request.url()); });
  await page.routeWebSocket(url => url.pathname === '/api/audio', socket => {
    const url = new URL(socket.url());
    const attempt = { provider: url.searchParams.get('provider'), voice: url.searchParams.get('voice'), texts: [] as string[] };
    paid.push(attempt);
    socket.onMessage(message => {
      const event = JSON.parse(String(message));
      if (event.type === 'speak') attempt.texts.push(event.text);
      if (event.type === 'flush') { socket.send(Buffer.alloc(4800)); socket.send(JSON.stringify({ type: 'speech-done' })); }
    });
    socket.send(JSON.stringify({ type: 'ready', sampleRate: 24000 }));
  });
  await page.goto('/');
  await page.getByLabel('Password', { exact: true }).fill('browser-fixture-password-2026');
  await page.getByRole('button', { name: 'Enter your space' }).click();
  await expect(page.getByRole('button', { name: 'Start talking' })).toBeEnabled();
  await page.getByRole('button', { name: 'Open settings' }).click();
  const speaker = page.getByRole('region', { name: 'Speaker check' });
  const testSpeaker = speaker.getByRole('button', { name: 'Test speaker', exact: true });
  await expect(speaker.getByText('Audibility has not been confirmed.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { vcSpeakerProbe: { calls: unknown[] } }).vcSpeakerProbe.calls.length)).toBe(0);
  await testSpeaker.click();
  await expect(speaker.getByText('Playback requested; waiting for output', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { vcSpeakerProbe: { calls: { text: string }[] } }).vcSpeakerProbe.calls.map(call => call.text))).toEqual(['This is Voice Connect. If you can hear this sentence, your speaker test is working.']);
  await page.evaluate(() => (window as unknown as { vcSpeakerProbe: { publishVoices(): void; start(): void } }).vcSpeakerProbe.publishVoices());
  await expect(page.getByRole('option', { name: 'Fixture English voice · en-US' })).toBeAttached();
  await page.evaluate(() => (window as unknown as { vcSpeakerProbe: { start(): void } }).vcSpeakerProbe.start());
  await expect(speaker.getByText('The player reported playback starting', { exact: true })).toBeVisible();
  await expect(speaker.getByText('Audibility has not been confirmed.', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { vcSpeakerProbe: { end(): void } }).vcSpeakerProbe.end());
  await expect(speaker.getByText('The player reported playback ending', { exact: true })).toBeVisible();
  await speaker.getByRole('button', { name: 'I heard it', exact: true }).click();
  await page.getByText('Device diagnostics', { exact: true }).click();
  await expect(page.getByText('You confirmed hearing the sample', { exact: true })).toBeVisible();
  await speaker.getByRole('button', { name: 'No sound', exact: true }).click();
  await expect(page.getByText('You reported no sound', { exact: true })).toBeVisible();
  await testSpeaker.click();
  await page.evaluate(() => (window as unknown as { vcSpeakerProbe: { error(): void } }).vcSpeakerProbe.error());
  await expect(speaker.getByText(/The browser blocked speech playback \(not-allowed\)/)).toBeVisible();
  await expect(speaker.getByText('Speech output reported a problem', { exact: true })).toBeVisible();
  await expect(speaker.getByText('Audibility has not been confirmed.', { exact: true })).toBeVisible();
  await testSpeaker.click();
  await speaker.getByRole('button', { name: 'Stop test', exact: true }).click();
  await page.evaluate(() => { const probe = (window as unknown as { vcSpeakerProbe: { start(): void; end(): void } }).vcSpeakerProbe; probe.start(); probe.end(); });
  await expect(speaker.getByText('Test stopped', { exact: true })).toBeVisible();
  await testSpeaker.click();
  const cancelledBeforeProviderChange = await page.evaluate(() => (window as unknown as { vcSpeakerProbe: { cancellations: number } }).vcSpeakerProbe.cancellations);
  await page.getByRole('combobox', { name: 'Voice service', exact: true }).selectOption('fish');
  expect(await page.evaluate(() => (window as unknown as { vcSpeakerProbe: { cancellations: number } }).vcSpeakerProbe.cancellations)).toBeGreaterThan(cancelledBeforeProviderChange);
  await expect(testSpeaker).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Vosk/ })).toHaveClass(/selected/);
  await page.getByLabel('Fish Audio voice ID', { exact: true }).fill('speaker_fixture_voice');
  await expect(testSpeaker).toBeDisabled();
  await page.getByLabel('Fish Audio API key', { exact: true }).fill('fixture-fish-api-key-for-ui-check');
  await page.getByRole('button', { name: 'Save Fish key', exact: true }).click();
  await expect(page.getByLabel('Fish Audio API key', { exact: true })).toHaveValue('');
  await expect(testSpeaker).toBeEnabled();
  expect(paid).toHaveLength(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('fixture-fish-api-key-for-ui-check');
  await expect(speaker.getByText(/This test sends only the sample sentence to Fish Audio/)).toBeVisible();
  await testSpeaker.click();
  await expect(speaker.getByText('The player reported playback ending', { exact: true })).toBeVisible();
  expect(paid).toEqual([{ provider: 'fish', voice: 'speaker_fixture_voice', texts: ['This is Voice Connect. If you can hear this sentence, your speaker test is working.'] }]);
  await expect(speaker.getByText('Audibility has not been confirmed.', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('speaker-check.png'), fullPage: true });
  await page.getByRole('button', { name: 'Remove Fish Audio credential', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove Fish Audio credential', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Voice service', exact: true }).selectOption('browser');
  await testSpeaker.click();
  const cancellationsBeforeClose = await page.evaluate(() => (window as unknown as { vcSpeakerProbe: { cancellations: number } }).vcSpeakerProbe.cancellations);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { vcSpeakerProbe: { cancellations: number } }).vcSpeakerProbe.cancellations)).toBeGreaterThan(cancellationsBeforeClose);
  expect(await page.evaluate(() => (window as unknown as { vcSpeakerProbe: { microphones: number } }).vcSpeakerProbe.microphones)).toBe(0);
  expect(turns).toEqual([]);
});
