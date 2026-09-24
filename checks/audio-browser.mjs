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
// These match service/main.ts; backend tests separately assert exact-route scoping.
const DOCUMENT_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const BROKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const server = await createServer({
  server: { host: '127.0.0.1', port: 5192, strictPort: true }, logLevel: 'error',
  plugins: [{ name: 'audio-production-csp', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = request.url?.split('?')[0];
      response.setHeader('Content-Security-Policy', path === '/audio/vosk.worker.js' ? BROKER_CSP : DOCUMENT_CSP);
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      if (path === '/audio-csp-probe.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end("try { Function('return 1')(); window.__documentEvalBlocked = false; } catch { window.__documentEvalBlocked = true; }");
      } else next();
    });
  } }],
});
await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
try {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.text().startsWith('AUDIO-CHECK')) console.log(message.text()); });
  await page.route('**/audio-harness', (route) => route.fulfill({ contentType: 'text/html',
    headers: { 'Content-Security-Policy': DOCUMENT_CSP, 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    body: '<!doctype html><title>Audio runtime acceptance</title>' }));
  await page.goto('http://127.0.0.1:5192/audio-harness');
  const policy = await page.evaluate(async () => {
    await new Promise((resolve, reject) => { const probe = document.createElement('script'); probe.src = '/audio-csp-probe.js'; probe.onload = resolve; probe.onerror = reject; document.head.append(probe); });
    const broker = await fetch('/audio/vosk.worker.js');
    await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Service worker did not claim the audio test.')), 5000);
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
    return { blocked: window.__documentEvalBlocked, brokerCsp: broker.headers.get('content-security-policy') };
  });
  assert.equal(policy.blocked, true, 'application document still blocks JavaScript string evaluation');
  assert.equal(policy.brokerCsp, BROKER_CSP);
  console.log('Production CSP: document eval blocked; exception confined to external Vosk broker.');
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
    return { phases, errors, turns, signals, documentVosk: typeof window.Vosk !== 'undefined' };
  });
  assert.deepEqual(startup.errors, []);
  assert.ok(startup.phases.includes('listening'), 'real Worklet, Vosk and Silero become ready');
  assert.ok(startup.signals > 5, 'real Silero inference emits acoustic evidence');
  assert.deepEqual(startup.turns, [], 'fake microphone silence does not submit a turn');
  assert.equal(startup.documentVosk, false, 'legacy Vosk binding never enters the application document');
  console.log('Real capture + Silero/Vosk startup passed', JSON.stringify(startup));

  // Real Vosk + Silero + capture Worklet exercise two automatic turns. Inject a
  // MediaStream from the public WAV rather than using a physical microphone.
  // Only synthesis is simulated: no claim about speakers, AEC or audible delay.
  const continuous = await page.evaluate(async (bytes) => {
    const { VoiceEngine } = await import('/audio/engine.ts');
    const sourceAudio = new AudioContext(), destination = sourceAudio.createMediaStreamDestination();
    const decoded = await sourceAudio.decodeAudioData(Uint8Array.from(bytes).buffer);
    const phrase = sourceAudio.createBuffer(1, Math.floor(3.5 * decoded.sampleRate), decoded.sampleRate);
    phrase.copyToChannel(decoded.getChannelData(0).subarray(0, phrase.length), 0);
    const originalCapture = Object.getOwnPropertyDescriptor(navigator.mediaDevices, 'getUserMedia');
    const originalSynthesis = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
    let captureCalls = 0, outputStarts = 0, outputEnds = 0, outputTimer;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { captureCalls++; return destination.stream; } });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], cancel: () => clearTimeout(outputTimer),
      speak: (utterance) => {
        outputStarts++; queueMicrotask(() => utterance.onstart?.(new Event('start')));
        outputTimer = setTimeout(() => { outputEnds++; utterance.onend?.(new Event('end')); }, 150);
      },
    } });
    const phases = [], turns = [], errors = [], notices = []; let signals = 0;
    const engine = new VoiceEngine({ onPhase: (phase) => phases.push(phase), onDraft() {}, onTurn: (text) => turns.push(text), onSignal: () => signals++, onError: (message) => errors.push(message), onInterrupt() {}, onNotice: (message) => notices.push(message) });
    const waitFor = async (predicate, label) => {
      const deadline = performance.now() + 15000;
      while (!predicate()) {
        if (performance.now() > deadline || errors.length || phases.at(-1) === 'paused') throw new Error(`${label}: ${JSON.stringify({ phases, turns, errors, notices })}`);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    };
    try {
      await sourceAudio.resume();
      await engine.start({ recognition: 'vosk', output: 'browser', browserVoice: '', premiumVoice: 'flux-haley-en', handsFree: true, keepAwake: false }, 'automatic-runtime-check');
      if (phases.at(-1) !== 'listening') throw new Error(`Automatic voice did not start: ${errors.join('; ')}`);
      for (let index = 0; index < 2; index++) {
        const source = sourceAudio.createBufferSource(); source.buffer = phrase; source.connect(destination); source.start();
        await waitFor(() => turns.length > index, 'Automatic silence endpoint did not submit');
        engine.speak('Synthetic streamed '); engine.speak('reply.'); engine.responseDone();
        await waitFor(() => outputEnds > index && phases.at(-1) === 'listening', 'Playback did not rearm listening');
        source.disconnect();
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return { phases: [...phases], turns: [...turns], errors: [...errors], captureCalls, outputStarts, outputEnds, signals };
    } finally {
      engine.dispose(); await sourceAudio.close();
      if (originalCapture) Object.defineProperty(navigator.mediaDevices, 'getUserMedia', originalCapture); else delete navigator.mediaDevices.getUserMedia;
      if (originalSynthesis) Object.defineProperty(window, 'speechSynthesis', originalSynthesis); else delete window.speechSynthesis;
    }
  }, Array.from(fixture));
  assert.deepEqual(continuous.errors, []);
  assert.deepEqual(continuous.turns, ['one zero zero zero one', 'one zero zero zero one']);
  assert.equal(continuous.captureCalls, 1, 'one capture session spans both automatic turns');
  assert.equal(continuous.outputStarts, 2); assert.equal(continuous.outputEnds, 2);
  assert.equal(continuous.phases.filter((phase) => phase === 'finalizing').length, 2);
  assert.equal(continuous.phases.at(-1), 'listening');
  console.log('Real automatic VAD two-turn capture + recognition passed; synthesis callbacks simulated:', JSON.stringify(continuous));

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
