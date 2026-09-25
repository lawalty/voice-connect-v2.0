import { Resampler } from './dsp';

declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

/** All microphone-rate conversion runs off the UI thread, before bounded transfer. */
class VoiceCapture extends AudioWorkletProcessor {
  private resampler = new Resampler(sampleRate);
  private block = new Float32Array(512);
  private used = 0;
  private pending = 0;
  private sequence = 0;
  private dropped = 0;
  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => { if (event.data === 'ack') this.pending = Math.max(0, this.pending - 1); };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const input = inputs[0]?.[0]; if (!input) return true;
    const samples = this.resampler.push(input);
    for (let offset = 0; offset < samples.length;) {
      const count = Math.min(samples.length - offset, this.block.length - this.used);
      this.block.set(samples.subarray(offset, offset + count), this.used); this.used += count; offset += count;
      if (this.used === this.block.length) {
        if (this.pending < 8) {
          // Timestamp the end of this block on the SAME clock as scheduled TTS.
          const endTime = currentTime + input.length / sampleRate - (samples.length - offset) / 16000;
          this.port.postMessage({ samples: this.block, sampleRate: 16000, sequence: this.sequence, dropped: this.dropped, endTime }, [this.block.buffer]);
          this.pending++; this.dropped = 0;
        } else this.dropped += this.block.length;
        this.sequence++; this.block = new Float32Array(512); this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
