import { Resampler } from './dsp';
import { CaptureQueue } from './capture-queue';

declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

/** All microphone-rate conversion runs off the UI thread, before bounded transfer. */
class VoiceCapture extends AudioWorkletProcessor {
  private resampler = new Resampler(sampleRate);
  private block = new Float32Array(512);
  private used = 0;
  private queue = new CaptureQueue(block => this.port.postMessage(block, [block.samples.buffer]),
    dropped => this.port.postMessage({ type: 'overflow', dropped }));
  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => { if (event.data === 'ack') this.queue.acknowledge(); };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const input = inputs[0]?.[0]; if (!input) return true;
    const samples = this.resampler.push(input);
    for (let offset = 0; offset < samples.length;) {
      const count = Math.min(samples.length - offset, this.block.length - this.used);
      this.block.set(samples.subarray(offset, offset + count), this.used); this.used += count; offset += count;
      if (this.used === this.block.length) {
        // Preserve the capture clock while a delayed consumer drains the queue.
        const endTime = currentTime + input.length / sampleRate - (samples.length - offset) / 16000;
        this.queue.push(this.block, endTime);
        this.block = new Float32Array(512); this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
