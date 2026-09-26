// Real Chromium + Silero WASM checks with prerecorded/synthetic PCM only.
// No microphone, provider, agent, credential, or audible-output claims.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const fixturePath = resolve('.local/audio-check/test.wav');
const fixtureHash = 'dcfea5712c43a43ba7ae8083afb39d36993e5a69c46e88b68aaa72b65cb615bb';
await mkdir(resolve('.local/audio-check'), { recursive: true });
let fixture;
try { fixture = await readFile(fixturePath); }
catch {
  const response = await fetch('https://raw.githubusercontent.com/alphacep/vosk-api/master/python/example/test.wav');
  assert.ok(response.ok, 'public Vosk WAV fixture downloads');
  fixture = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(fixture).digest('hex'), fixtureHash, 'public fixture integrity');
  await writeFile(fixturePath, fixture);
}
assert.equal(createHash('sha256').update(fixture).digest('hex'), fixtureHash, 'cached public fixture integrity');
assert.equal(fixture.toString('ascii', 0, 4), 'RIFF');
assert.equal(fixture.toString('ascii', 8, 12), 'WAVE');
let format, data;
for (let offset = 12; offset + 8 <= fixture.length;) {
  const id = fixture.toString('ascii', offset, offset + 4), length = fixture.readUInt32LE(offset + 4);
  assert.ok(offset + 8 + length <= fixture.length, 'WAV chunks fit the fixture');
  if (id === 'fmt ') format = fixture.subarray(offset + 8, offset + 8 + length);
  if (id === 'data') data = fixture.subarray(offset + 8, offset + 8 + length);
  offset += 8 + length + length % 2;
}
assert.ok(format && data, 'PCM format and audio chunks exist');
assert.equal(format.readUInt16LE(0), 1); assert.equal(format.readUInt16LE(2), 1);
assert.equal(format.readUInt32LE(4), 16000); assert.equal(format.readUInt16LE(14), 16);
const samples = Array.from({ length: data.length / 2 }, (_, index) => data.readInt16LE(index * 2) / 32768);
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'";
const origin = 'http://127.0.0.1:5196';
const server = await createServer({
  server: { host: '127.0.0.1', port: 5196, strictPort: true }, logLevel: 'error',
  plugins: [{ name: 'barge-browser-policy', configureServer(vite) {
    vite.middlewares.use((_request, response, next) => {
      response.setHeader('Content-Security-Policy', CSP);
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext();
  const unexpectedRequests = [], pageErrors = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith('/api/')) {
      unexpectedRequests.push(url.origin + url.pathname); return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.text().startsWith('BARGE-CHECK ')) console.log(message.text()); });
  await page.route('**/barge-harness', route => route.fulfill({
    contentType: 'text/html', headers: { 'Content-Security-Policy': CSP,
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    body: '<!doctype html><title>Recorded barge-in worker checks</title>',
  }));
  await page.goto(origin + '/barge-harness');
  const cues = await page.evaluate(async () => {
    const { ListeningCues } = await import('/audio/cues.ts');
    const audio = new AudioContext({ sampleRate: 48000 }); await audio.resume();
    const references = [];
    const player = new ListeningCues(audio, reference => references.push(reference));
    try {
      await player.prepare();
      return ['on', 'off'].map(kind => {
        const clock = audio.currentTime, schedule = player.play(kind), reference = references.at(-1);
        if (!schedule || !reference) throw new Error(`Recording did not play: ${kind}`);
        return { kind, duration: schedule.endTime - schedule.startTime, startDelay: schedule.startTime - clock,
          sampleRate: reference.sampleRate, samples: reference.samples.length,
          peak: reference.samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0) };
      });
    } finally { player.dispose(); await audio.close(); }
  });
  for (const [index, cue] of cues.entries()) {
    const duration = index === 0 ? 0.48 : 0.26;
    assert.ok(Math.abs(cue.duration - duration) < 0.001, 'native decoder preserves recording duration');
    assert.equal(cue.sampleRate, 48000, 'native decoder follows the shared audio context');
    assert.equal(cue.samples, Math.round(duration * 48000));
    assert.ok(cue.startDelay >= 0.005 - 1e-9 && cue.startDelay < 0.025, 'no turn-boundary loading delay');
    assert.ok(cue.peak > 0.1 && cue.peak < 0.14, 'original recording level retained');
  }
  console.log('Supplied listening/sent recordings decode, schedule, and publish PCM references:', JSON.stringify(cues));
  const results = await page.evaluate(async recorded => {
    const { default: workerURL } = await import('/audio/vad.worker.ts?worker&url');
    const { PlaybackReference } = await import('/audio/interruption.ts');
    const rate = 16000, size = 512, calibration = 32 * size, baseTime = 2;
    const random = seed => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; };
    const makeNoise = (length, seed, fan = false) => {
      const next = random(seed), audio = new Float32Array(length); let low = 0;
      for (let index = 0; index < length; index++) {
        low = low * 0.88 + next() * 0.12;
        const time = index / rate;
        audio[index] = fan
          ? (0.035 + 0.018 * Math.sin(time * 0.9)) * (low + 0.3 * Math.sin(2 * Math.PI * 115 * time) + 0.14 * Math.sin(2 * Math.PI * 230 * time))
          : low * 0.0008;
      }
      return audio;
    };
    const speech = Float32Array.from(recorded);
    const syntheticPlayback = new Float32Array(speech.length);
    for (let index = 0; index < syntheticPlayback.length; index++) {
      const time = index / rate, envelope = 0.55 + 0.45 * Math.sin(time * 4) ** 2;
      syntheticPlayback[index] = 0.018 * envelope * (Math.sin(2 * Math.PI * 173 * time)
        + 0.55 * Math.sin(2 * Math.PI * 389 * time) + 0.35 * Math.sin(2 * Math.PI * 719 * time));
    }
    const scenarios = [
      { name: 'recorded-assistant-echo', reference: speech, scale: 0.45, delay: 1536, user: false, expectInterrupt: false },
      { name: 'synthetic-playback-without-user', reference: syntheticPlayback, scale: 0.65, delay: 1536, user: false, expectInterrupt: false },
      { name: 'changing-synthetic-fan', duration: rate * 10, fan: true, expectInterrupt: false },
      { name: 'recorded-independent-speech', user: true, expectInterrupt: true },
      { name: 'speech-over-synthetic-playback', reference: syntheticPlayback, scale: 0.65, delay: 1536, user: true, expectInterrupt: true },
    ];
    const all = [];
    const rms = audio => Math.sqrt(audio.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, audio.length));
    for (const scenario of scenarios) {
      const started = performance.now(), worker = new Worker(workerURL, { type: 'module' });
      let resolveReady, rejectReady, timeout;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject;
        timeout = setTimeout(() => reject(new Error(`${scenario.name}: worker init timeout`)), 20000); });
      const pending = new Map();
      worker.onmessage = event => {
        const message = event.data;
        if (message.type === 'ready') { clearTimeout(timeout); resolveReady(); }
        else if (message.type === 'signal') {
          const request = pending.get(message.sequence);
          if (request) { clearTimeout(request.timeout); pending.delete(message.sequence); request.resolve(message); }
        } else if (message.type === 'error') {
          clearTimeout(timeout); rejectReady(new Error(message.message));
          for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error(message.message)); }
          pending.clear();
        }
      };
      worker.onerror = event => {
        clearTimeout(timeout); rejectReady(new Error(event.message));
        for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error(event.message)); }
        pending.clear();
      };
      try {
        worker.postMessage({ type: 'init', sensitivity: 50 }); await ready;
        const startupMs = performance.now() - started;
        const localReference = new PlaybackReference();
        const total = calibration + (scenario.duration || speech.length + (scenario.delay || 0)) + rate;
        const audio = makeNoise(total, 924);
        if (scenario.fan) audio.set(makeNoise(total - calibration, 719, true), calibration);
        if (scenario.user) for (let index = 0; index < speech.length; index++) audio[calibration + index] += speech[index];
        if (scenario.reference) {
          localReference.add(scenario.reference, rate, baseTime + calibration / rate);
          const reference = scenario.reference.slice();
          worker.postMessage({ type: 'reference', samples: reference, sampleRate: rate, startTime: baseTime + calibration / rate }, [reference.buffer]);
          for (let index = 0; index < scenario.reference.length; index++) audio[calibration + scenario.delay + index] += scenario.reference[index] * scenario.scale;
        }
        const processingMs = [], erasedUserEvidence = []; let interruptions = 0, transitions = 0, suppressedReferenceFrames = 0, erasedUserFrames = 0;
        let firstInterruptionAtMs = null, triggerEvidenceMs = null, qualifiedFrames = 0, maxQualifiedFrames = 0, probabilityPeak = 0;
        const processStarted = performance.now();
        for (let offset = 0, sequence = 0; offset + size <= audio.length; offset += size, sequence++) {
          const samples = audio.slice(offset, offset + size), level = rms(samples), before = performance.now();
          const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { pending.delete(sequence); reject(new Error(`${scenario.name}: frame ${sequence} timeout`)); }, 10000);
            pending.set(sequence, { resolve, reject, timeout });
            worker.postMessage({ type: 'frame', samples, endTime: baseTime + (offset + size) / rate,
              sequence, protecting: true, epoch: 1, turnActive: false }, [samples.buffer]);
          });
          processingMs.push(performance.now() - before);
          const signal = result.signal;
          probabilityPeak = Math.max(probabilityPeak, signal.speechProbability);
          const qualifying = signal.speechProbability >= 0.8 && level > Math.max(0.003, signal.noiseFloor * 1.8);
          qualifiedFrames = qualifying ? qualifiedFrames + 1 : 0;
          maxQualifiedFrames = Math.max(maxQualifiedFrames, qualifiedFrames);
          if (result.interruption) { interruptions++; firstInterruptionAtMs ??= (offset + size - calibration) / rate * 1000; triggerEvidenceMs ??= qualifiedFrames * 32; }
          if (result.transition === 'start') transitions++;
          if (level > 0.003 && rms(result.samples) === 0) {
            suppressedReferenceFrames++;
            const userStart = Math.max(0, offset - calibration), userEnd = Math.max(0, offset + size - calibration);
            const userRms = rms(speech.subarray(userStart, userEnd));
            if (scenario.user && userRms > 0.003) {
              erasedUserFrames++; erasedUserEvidence.push({ atMs: (offset - calibration) / rate * 1000, userRms, combinedRms: level,
                noiseFloor: signal.noiseFloor, playbackEvidence: localReference.analyze(audio.subarray(offset, offset + size), baseTime + (offset + size) / rate) });
            }
          }
        }
        processingMs.sort((left, right) => left - right);
        const result = { name: scenario.name, expectInterrupt: scenario.expectInterrupt,
          frames: processingMs.length, audioMs: processingMs.length * 32, startupMs,
          processingTotalMs: performance.now() - processStarted,
          processingP95Ms: processingMs[Math.floor(processingMs.length * 0.95)],
          processingMaxMs: processingMs.at(-1), interruptions, firstInterruptionAtMs,
          defaultRequiredEvidenceMs: 128, triggerEvidenceMs, maxQualifiedFrames, probabilityPeak, transitions, suppressedReferenceFrames, erasedUserFrames, erasedUserEvidence };
        all.push(result); console.log('BARGE-CHECK ' + JSON.stringify(result));
      } finally {
        clearTimeout(timeout);
        for (const request of pending.values()) clearTimeout(request.timeout);
        worker.terminate();
      }
    }
    return all;
  }, samples);
  const evidence = { fixtureSha256: fixtureHash, runtime: 'Chromium + real Silero WASM worker', cues, results,
    limits: 'Prerecorded and synthetic PCM; accelerated frame delivery. Processing times exclude physical microphone, AEC, speaker, browser capture, provider transport and audible-stop latency. No Android or car qualification.' };
  await writeFile(resolve('.local/audio-check/barge-browser-results.json'), JSON.stringify(evidence, null, 2) + '\n');
  await mkdir(resolve('test-results'), { recursive: true });
  await writeFile(resolve('test-results/audio-barge-browser.json'), JSON.stringify(evidence, null, 2) + '\n');
  assert.deepEqual(pageErrors, [], 'real worker runtime has no document errors');
  assert.deepEqual(unexpectedRequests, [], 'no external service or app API contacted');
  for (const result of results) {
    assert.equal(result.interruptions, result.expectInterrupt ? 1 : 0, `${result.name}: expected one-shot interruption behavior`);
    if (result.expectInterrupt) {
      assert.ok(result.maxQualifiedFrames >= 4, `${result.name}: real Silero supplies sustained qualifying speech`);
      assert.equal(result.erasedUserFrames, 0, `${result.name}: known foreground PCM above RMS 0.003 is not removed as echo`);
    }
  }
  console.log('Real worker barge-in checks passed. Timing values measure processing only; physical speakerphone testing remains required.');
} finally {
  await browser?.close();
  await server.close();
}
