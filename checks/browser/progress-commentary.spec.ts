import { test, expect } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);

for (const [mode, output] of [['voice-orb', 'browser'], ['voice-messenger', 'browser'], ['text-messenger', 'browser'], ['voice-messenger', 'fish']] as const) {
  test(`${output} ${mode} keeps progress audio ephemeral and shows its speaking gradient`, async ({ page, context }, info) => {
    await context.grantPermissions(['microphone']);
    await page.addInitScript(provider => {
      localStorage.setItem('vc2:speech', JSON.stringify({ recognition: 'browser', output: provider, fishVoice: 'fixture', handsFree: false, audioCues: false }));
      localStorage.setItem('vc2:speaker-muted', 'false');
      const probe = { spoken: [] as string[], phases: [] as string[], emit: (_text: string) => {}, generation: 0 };
      Object.assign(window, { vcProgressProbe: probe });
      class Recognition {
        onstart?: () => void; onend?: () => void; onresult?: (event: unknown) => void;
        start() { probe.emit = text => this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] }); queueMicrotask(() => this.onstart?.()); }
        stop() { this.onend?.(); } abort() {}
      }
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition });
      class Utterance { onstart?: (event: Event) => void; onend?: (event: Event) => void; onerror?: (event: Event) => void; constructor(public text: string) {} }
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: Utterance });
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
        getVoices: () => [{ name: 'Fixture', voiceURI: 'fixture', lang: 'en-US', localService: true, default: true }],
        cancel() { probe.generation++; }, addEventListener() {}, removeEventListener() {},
        speak(utterance: SpeechSynthesisUtterance) {
          const generation = probe.generation; probe.spoken.push(utterance.text);
          queueMicrotask(() => utterance.onstart?.(new Event('start') as SpeechSynthesisEvent));
          setTimeout(() => { if (generation === probe.generation) utterance.onend?.(new Event('end') as SpeechSynthesisEvent); }, 900);
        },
      } });
      new MutationObserver(() => {
        const phase = document.querySelector('.orb-stage')?.className;
        if (phase && probe.phases.at(-1) !== phase) probe.phases.push(phase);
      }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }, output);
    const fishSpeech: string[] = [];
    await page.routeWebSocket(url => url.pathname === '/api/audio' && url.searchParams.get('kind') === 'tts', socket => {
      socket.onMessage(raw => {
        if (typeof raw !== 'string') return;
        const message = JSON.parse(raw);
        if (message.type === 'speak') { fishSpeech.push(message.text); socket.send(Buffer.alloc(43200)); }
        if (message.type === 'flush') socket.send(JSON.stringify({ type: 'speech-done' }));
      });
      socket.send(JSON.stringify({ type: 'ready', sampleRate: 24000 }));
    });
    const subscribed = new Set<string>();
    page.on('websocket', socket => {
      const url = new URL(socket.url());
      if (url.pathname === '/api/events') socket.on('framereceived', frame => {
        if (JSON.parse(String(frame.payload)).type === 'hello') subscribed.add(url.searchParams.get('conversationId')!);
      });
    });
    await enterFixtureSession(page);
    await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
    await page.getByRole('button', { name: 'NorthPointe', exact: true }).click();
    const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/conversations');
    await page.getByRole('button', { name: 'Begin a new conversation', exact: true }).click();
    const conversationId = (await (await created).json()).id as string;
    await expect.poll(() => subscribed.has(conversationId)).toBe(true);
    if (mode !== 'text-messenger') {
      await page.getByRole('button', { name: 'Wake NorthPointe' }).click();
      await expect(page.getByText('Listening to you', { exact: true })).toBeVisible();
    }
    if (mode !== 'voice-orb') await page.getByRole('button', { name: /^Conversation/ }).click();
    if (mode === 'text-messenger') {
      await page.getByRole('textbox', { name: 'Message NorthPointe' }).fill('Progress commentary fixture');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
    } else {
      await page.evaluate(() => (window as any).vcProgressProbe.emit('Progress commentary fixture'));
      await page.getByRole('button', { name: 'Finish thought', exact: true }).click();
      await expect(page.locator('.orb-stage')).toHaveClass(/phase-working-commentary/);
      await page.screenshot({ path: info.outputPath(`${mode}-progress.png`), fullPage: true });
    }
    const spoken = () => output === 'fish' ? Promise.resolve(fishSpeech) : page.evaluate(() => (window as any).vcProgressProbe.spoken as string[]);
    await expect.poll(spoken).toEqual(mode === 'text-messenger'
      ? ['The configuration is correct.']
      : ['I will check the configuration.', 'I found the setting.', 'The configuration is correct.']);
    if (mode !== 'text-messenger') {
      const phases = await page.evaluate(() => (window as any).vcProgressProbe.phases as string[]);
      expect(phases.some(phase => phase.includes('phase-thinking-commentary'))).toBe(true);
      expect(phases.some(phase => /phase-working$/.test(phase))).toBe(true);
    }
    if (mode === 'voice-orb') await page.getByRole('button', { name: /^Conversation/ }).click();
    const log = page.getByRole('log', { name: 'Messages' });
    await expect(log.getByText('The configuration is correct.', { exact: true })).toBeVisible();
    await expect(log.getByText('I will check the configuration.', { exact: true })).toHaveCount(0);
    await expect(log.getByText('I found the setting.', { exact: true })).toHaveCount(0);
    fishSpeech.length = 0;
    await page.reload();
    await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
    await expect.poll(spoken).toEqual([]);
    const history = await page.evaluate(async id => (await fetch(`/api/conversations/${id}`)).json(), conversationId);
    expect(history.messages.filter((message: any) => message.role === 'assistant').map((message: any) => message.text)).toEqual(['The configuration is correct.']);
  });
}
