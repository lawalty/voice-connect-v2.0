// Keep the real-time audio thread bounded. The application acknowledges each block.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.block = new Float32Array(1024); this.used = 0;
    this.pending = 0; this.sequence = 0; this.dropped = 0;
    this.port.onmessage = (event) => { if (event.data === 'ack') this.pending = Math.max(0, this.pending - 1); };
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (!input) return true;
    for (let offset = 0; offset < input.length;) {
      const count = Math.min(input.length - offset, this.block.length - this.used);
      this.block.set(input.subarray(offset, offset + count), this.used);
      this.used += count; offset += count;
      if (this.used === this.block.length) {
        if (this.pending < 8) {
          this.port.postMessage({ samples: this.block, sequence: this.sequence, dropped: this.dropped }, [this.block.buffer]);
          this.pending++; this.dropped = 0;
        } else this.dropped += this.block.length;
        this.sequence++; this.block = new Float32Array(1024); this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
