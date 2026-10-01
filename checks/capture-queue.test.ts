import { describe, expect, it } from 'vitest';
import { CaptureQueue, type CaptureBlock } from '../client/audio/capture-queue';

describe('bounded microphone transport', () => {
  it('delivers healthy frames immediately without prebuffering or timestamp changes', () => {
    const sent: CaptureBlock[] = [], queue = new CaptureQueue(block => sent.push(block));
    for (let i = 0; i < 100; i++) {
      queue.push(new Float32Array(512).fill(i), (i + 1) * .032);
      expect(sent).toHaveLength(i + 1);
      expect(sent[i]).toMatchObject({ sequence: i, dropped: 0, endTime: (i + 1) * .032 });
      queue.acknowledge();
    }
  });
  it('survives a 960ms consumer stall and drains every sample in order at the consumer pace', () => {
    const sent: CaptureBlock[] = [], queue = new CaptureQueue(block => sent.push(block));
    for (let i = 0; i < 30; i++) queue.push(new Float32Array(512).fill(i), (i + 1) * .032);
    expect(sent).toHaveLength(8);
    for (let i = 0; i < 22; i++) { queue.acknowledge(); expect(sent).toHaveLength(9 + i); }
    expect(sent.map(block => block.sequence)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(sent.every((block, i) => block.dropped === 0 && block.endTime === (i + 1) * .032 && block.samples.every(sample => sample === i))).toBe(true);
  });
  it('bounds sustained overload and marks the precise missing-audio boundary', () => {
    const sent: CaptureBlock[] = [], losses: number[] = [];
    const queue = new CaptureQueue(block => sent.push(block), dropped => losses.push(dropped));
    for (let i = 0; i < 1000; i++) queue.push(new Float32Array(512), (i + 1) * .032);
    expect(sent).toHaveLength(8);
    expect(losses).toEqual([512]);
    for (let i = 0; i < 40; i++) queue.acknowledge();
    expect(sent).toHaveLength(40);
    expect(sent.every(block => block.dropped === 0)).toBe(true);
    queue.push(new Float32Array(512), 1001 * .032);
    expect(sent.at(-1)).toMatchObject({ sequence: 1000, dropped: 960 * 512, endTime: 1001 * .032 });
  });
});
