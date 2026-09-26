import { test, expect } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);

for (const output of ['browser', 'fish'] as const) {
  test(`${output} streams clean speech while retaining the original Markdown in history`, async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await page.addInitScript(provider => {
      localStorage.setItem('vc2:speech', JSON.stringify({ recognition: 'browser', output: provider, fishVoice: 'fixture', handsFree: false, audioCues: false }));
      const probe = { spoken: [] as string[], emit: (_text: string) => {} };
      Object.assign(window, { vcMarkdownProbe: probe });
      class Recognition {
        onstart?: () => void; onend?: () => void; onresult?: (event: unknown) => void;
        start() { probe.emit = text => this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] }); queueMicrotask(() => this.onstart?.()); }
        stop() { this.onend?.(); } abort() {}
      }
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition });
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
        getVoices: () => [], cancel() {}, addEventListener() {}, removeEventListener() {},
        speak(utterance: SpeechSynthesisUtterance) { probe.spoken.push(utterance.text); queueMicrotask(() => { utterance.onstart?.(new Event('start') as SpeechSynthesisEvent); utterance.onend?.(new Event('end') as SpeechSynthesisEvent); }); },
      } });
    }, output);
    const speech: string[] = [];
    await page.routeWebSocket(url => url.pathname === '/api/audio' && url.searchParams.get('kind') === 'tts', socket => {
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (message.type === 'speak') { speech.push(message.text); socket.send(Buffer.alloc(4800)); }
        if (message.type === 'flush') socket.send(JSON.stringify({ type: 'speech-done' }));
      });
      socket.send(JSON.stringify({ type: 'ready', sampleRate: 24000 }));
    });
    let complete = false;
    page.on('websocket', socket => {
      if (new URL(socket.url()).pathname === '/api/events') socket.on('framereceived', frame => { if (JSON.parse(String(frame.payload)).type === 'complete') complete = true; });
    });
    await enterFixtureSession(page);
    await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
    await page.getByRole('button', { name: 'NorthPointe', exact: true }).click();
    await page.getByRole('button', { name: 'Begin a new conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Wake NorthPointe' }).click();
    await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
    await page.evaluate(() => (window as unknown as { vcMarkdownProbe: { emit(text: string): void } }).vcMarkdownProbe.emit('Markdown speech fixture slow'));
    await page.getByRole('button', { name: 'Finish thought', exact: true }).click();
    const spoken = async () => output === 'fish' ? speech : page.evaluate(() => (window as unknown as { vcMarkdownProbe: { spoken: string[] } }).vcMarkdownProbe.spoken);
    await expect.poll(spoken, { timeout: 5000 }).toEqual(['Your first sentence.']);
    expect(complete).toBe(false);
    await expect.poll(spoken).toEqual(['Your first sentence.', 'A second thought.']);
    await expect.poll(() => complete).toBe(true);
    // Read the actual persisted fixture conversation, independent of speech cleanup.
    const history = await page.evaluate(async () => {
      const conversations = await (await fetch('/api/conversations')).json();
      return await (await fetch(`/api/conversations/${conversations[0].id}`)).json();
    });
    expect(history.messages.some((message: { role: string; text: string }) => message.role === 'assistant' && message.text === '**Your first sentence.** A *second* thought.')).toBe(true);
  });
}
