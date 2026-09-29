export interface CaptureBlock { samples: Float32Array; sampleRate: 16000; sequence: number; dropped: number; endTime: number; }

/** Send immediately when the consumer is ready. Only a stall uses the reserve;
 * it never adds a fixed delay to healthy capture or interruption detection. */
export class CaptureQueue {
  private pending = 0;
  private sequence = 0;
  private dropped = 0;
  private waiting: CaptureBlock[] = [];
  constructor(private send: (block: CaptureBlock) => void, private overflow: (dropped: number) => void = () => {}) {}
  push(samples: Float32Array, endTime: number) {
    const sequence = this.sequence++;
    // Eight in flight plus 32 reserved 32-ms blocks: bounded at 1.28 seconds.
    if (this.waiting.length >= 32) {
      const firstLoss = this.dropped === 0;
      this.dropped += samples.length;
      // Report loss ahead of the reserved frames, before they can endpoint an
      // incomplete turn. Retain the precise boundary on the next admitted frame.
      if (firstLoss) this.overflow(this.dropped);
      return;
    }
    this.waiting.push({ samples, sampleRate: 16000, sequence, dropped: this.dropped, endTime });
    this.dropped = 0; this.flush();
  }
  acknowledge() { this.pending = Math.max(0, this.pending - 1); this.flush(); }
  private flush() {
    while (this.pending < 8 && this.waiting.length) {
      const block = this.waiting.shift()!;
      ++this.pending; this.send(block);
    }
  }
}
