// Real WASM acceptance without contacting OpenClaw or a paid speech service.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const fixturePath = resolve('.local/audio-check/test.wav');
await mkdir(resolve('.local/audio-check'), { recursive: true });
try { await readFile(fixturePath); }
catch {
  const response = await fetch('https://raw.githubusercontent.com/alphacep/vosk-api/master/python/example/test.wav');
  assert.ok(response.ok, 'official Vosk audio fixture downloads');
  await writeFile(fixturePath, new Uint8Array(await response.arrayBuffer()));
}
const fixture = await readFile(fixturePath);
console.log(`Vosk official WAV fixture: ${fixture.length} bytes; SHA256 ${createHash('sha256').update(fixture).digest('hex')}`);
const server = await createServer({ server: { host: '127.0.0.1', port: 5192, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
try {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.text().startsWith('AUDIO-CHECK')) console.log(message.text()); });
  await page.route('**/audio-harness', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Audio runtime acceptance</title>' }));
  await page.goto('http://127.0.0.1:5192/audio-harness');
  const download = await page.evaluate(async () => {
    const model = await import('/audio/model.ts');
    await model.downloadModel();
    return model.modelStatus();
  });
  assert.equal(download.installed, true);
  console.log(`Verified model cached: ${download.bytes} bytes`);
  const startup = await page.evaluate(async () => {
    const { VoiceEngine } = await import('/audio/engine.ts');
    const phases = [], errors = [], turns = []; let signals = 0;
    const engine = new VoiceEngine({ onPhase: (phase) => { phases.push(phase); console.log('AUDIO-CHECK phase', phase); }, onDraft() {}, onTurn: (text) => turns.push(text), onSignal: () => signals++, onError: (message) => errors.push(message), onInterrupt() {}, onNotice: (message) => console.log('AUDIO-CHECK', message) });
    await engine.start({ recognition: 'vosk', output: 'browser', browserVoice: '', premiumVoice: 'flux-haley-en', handsFree: false, keepAwake: false }, 'local-runtime-check');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await engine.finish(); engine.dispose();
    return { phases, errors, turns, signals };
  });
  assert.deepEqual(startup.errors, []);
  assert.ok(startup.phases.includes('listening'), 'real Worklet, Vosk and Silero become ready');
  assert.ok(startup.signals > 5, 'real Silero inference emits acoustic evidence');
  assert.deepEqual(startup.turns, [], 'fake microphone silence does not submit a turn');
  console.log('Real capture + Silero/Vosk startup passed', JSON.stringify(startup));

  // The runtime has already been loaded; prove recognizer reinitialization uses cached
  // archive bytes without downloading audio or depending on a network speech API.
  await context.setOffline(true);
  const recognized = await page.evaluate(async (bytes) => {
    const { LocalRecognizer } = await import('/audio/vosk.ts');
    const { Transcript, Resampler } = await import('/audio/dsp.ts');
    const audio = new AudioContext();
    const buffer = await audio.decodeAudioData(Uint8Array.from(bytes).buffer);
    const samples = new Resampler(buffer.sampleRate).push(buffer.getChannelData(0));
    const transcript = new Transcript(), errors = [];
    const recognizer = new LocalRecognizer({ result: ({ text, final }) => transcript.update(text, final), error: (error) => errors.push(error.message), ended() {} });
    await recognizer.start();
    for (let offset = 0; offset < samples.length; offset += 1600) {
      recognizer.push(samples.subarray(offset, offset + 1600));
      // Feed at recording speed. A synthetic 3x upload tests overload, not speech.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await recognizer.finish();
    const result = transcript.take(); recognizer.stop(); await audio.close();
    return { result, errors };
  }, Array.from(fixture));
  assert.deepEqual(recognized.errors, []);
  assert.match(recognized.result, /^one zero zero zero one\b/);
  assert.match(recognized.result, /zero one eight zero three$/);
  assert.deepEqual(errors, []);
  console.log('Offline WAV recognition passed:', recognized.result);
  await context.setOffline(false);
  const removed = await page.evaluate(async () => { const model = await import('/audio/model.ts'); await model.removeModel(); return model.modelStatus(); });
  assert.equal(removed.installed, false);
  console.log('Cached archive and extracted IDB removal passed.');
} finally { await browser.close(); await server.close(); }
