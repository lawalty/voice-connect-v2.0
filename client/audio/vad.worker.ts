import * as ort from 'onnxruntime-web/wasm';
import { acousticSignal, NoiseFloor, rms, TurnDetector } from './dsp';

const worker = self as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage(value: unknown): void };
let session: ort.InferenceSession | undefined;
let state = new Float32Array(2 * 128);
let context = new Float32Array(64);
let floor = new NoiseFloor();
let detector = new TurnDetector();
let running = Promise.resolve();
// Keep the package's matching embedded JS factory; override only its binary URL.
// A prefix override forces a dynamic public-module import that Vite cannot serve.
ort.env.wasm.wasmPaths = { wasm: '/runtime/ort-wasm-simd-threaded.wasm' };
ort.env.wasm.numThreads = 1;

worker.onmessage = (event) => {
  const message = event.data;
  running = running.then(async () => {
    if (message.type === 'init') {
      session = await ort.InferenceSession.create('/models/silero_vad.onnx', { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      worker.postMessage({ type: 'ready' });
    } else if (message.type === 'reset') {
      state = new Float32Array(256); context = new Float32Array(64);
      floor = new NoiseFloor(); detector = new TurnDetector();
    } else if (message.type === 'frame' && session) {
      const samples = message.samples as Float32Array;
      const input = new Float32Array(576); input.set(context); input.set(samples, 64);
      const outputs = await session.run({
        input: new ort.Tensor('float32', input, [1, 576]),
        state: new ort.Tensor('float32', state, [2, 1, 128]),
        sr: new ort.Tensor('int64', BigInt64Array.of(16000n), [1]),
      });
      const probability = Number(outputs.output!.data[0]);
      state = Float32Array.from(outputs.stateN!.data as Float32Array);
      context.set(samples.subarray(samples.length - 64));
      const level = rms(samples), noise = floor.observe(level, probability);
      worker.postMessage({ type: 'signal', signal: acousticSignal(samples, probability, noise),
        transition: detector.update(probability, level, noise), sequence: message.sequence });
      Object.values(outputs).forEach((tensor) => tensor.dispose());
    }
  }).catch((error: unknown) => worker.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }));
};
