import * as ort from 'onnxruntime-web/wasm';
import { acousticSignal, NoiseFloor, rms, TurnDetector } from './dsp';
import { InterruptionGate, PlaybackReference, isPlaybackEcho } from './interruption';

const worker = self as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage(value: unknown, transfer?: Transferable[]): void };
let session: ort.InferenceSession | undefined;
let state = new Float32Array(2 * 128);
let context = new Float32Array(64);
let floor = new NoiseFloor();
let detector = new TurnDetector();
const playback = new PlaybackReference();
let gate = new InterruptionGate();
let protecting = false;
let epoch = -1;
let running = Promise.resolve();
// Keep the package's matching embedded JS factory; override only its binary URL.
// A prefix override forces a dynamic public-module import that Vite cannot serve.
ort.env.wasm.wasmPaths = { wasm: '/runtime/ort-wasm-simd-threaded.wasm' };
ort.env.wasm.numThreads = 1;

worker.onmessage = (event) => {
  const message = event.data;
  running = running.then(async () => {
    if (message.type === 'init') {
      gate = new InterruptionGate(message.sensitivity);
      session = await ort.InferenceSession.create('/models/silero_vad.onnx', { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      worker.postMessage({ type: 'ready' });
    } else if (message.type === 'reset') {
      state = new Float32Array(256); context = new Float32Array(64);
      floor = new NoiseFloor(); detector = new TurnDetector();
      gate.reset();
    } else if (message.type === 'reference') {
      playback.add(message.samples, message.sampleRate, message.startTime);
    } else if (message.type === 'cancel-reference') {
      playback.cancelAfter(message.atTime);
    } else if (message.type === 'frame' && session) {
      const samples = message.samples as Float32Array;
      const processingStarted = performance.now();
      if (protecting !== message.protecting || epoch !== message.epoch) {
        protecting = message.protecting; epoch = message.epoch; gate.reset();
        // A prior echo onset must not swallow the next real onset or its endpoint.
        if (protecting || !message.turnActive) detector.reset();
      }
      const evidence = playback.analyze(samples, message.endTime);
      const level = rms(samples);
      const echo = isPlaybackEcho(evidence, level, floor.value);
      // Keep confirmed playback out of the recurrent speech model too; otherwise
      // its speech probability can linger over subsequent fan/noise frames.
      if (echo) samples.fill(0);
      const input = new Float32Array(576); input.set(context); input.set(samples, 64);
      const outputs = await session.run({
        input: new ort.Tensor('float32', input, [1, 576]),
        state: new ort.Tensor('float32', state, [2, 1, 128]),
        sr: new ort.Tensor('int64', BigInt64Array.of(16000n), [1]),
      });
      const probability = Number(outputs.output!.data[0]);
      state = Float32Array.from(outputs.stateN!.data as Float32Array);
      context.set(samples.subarray(samples.length - 64));
      const noise = echo ? floor.value : floor.observe(level, probability);
      const interruption = protecting && gate.update(probability, level, noise, evidence);
      // Suppress only high-confidence reference matches without a foreground
      // residual. Ambiguous overlap passes through; this is not speaker identity.
      const transition = detector.update(echo ? 0 : probability, echo ? 0 : level, noise);
      const signal = acousticSignal(samples, echo ? 0 : probability, noise);
      worker.postMessage({ type: 'signal', signal, samples, interruption, echoRejected: echo, gate: protecting ? gate.metrics : undefined,
        processingMs: performance.now() - processingStarted,
        transition, sequence: message.sequence, epoch: message.epoch }, [samples.buffer]);
      Object.values(outputs).forEach((tensor) => tensor.dispose());
    }
  }).catch((error: unknown) => worker.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }));
};
