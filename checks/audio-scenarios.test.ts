import { describe, expect, it } from 'vitest';
import { NoiseFloor, Transcript, TurnDetector } from '../client/audio/dsp';

// Annotated acoustic-feature replays exercise the production boundary algorithm.
// Probabilities are supplied evidence, not claims about Silero's accuracy on cars.
const FRAME_MS = 32;
type Frame = { level: number; probability: number; turn?: number; insideTurn: boolean; finalSegment?: string };
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
}

function conversationFixture(): Frame[] {
  const next = random(0x564332), frames: Frame[] = [];
  const backgrounds = [0.006, 0.018, 0.065, 0.032, 0.085, 0.012, 0.046];
  for (let turn = 1; turn <= 100; turn++) {
    const floor = backgrounds[Math.floor((turn - 1) / 4) % backgrounds.length]!;
    const background = (count: number, insideTurn: boolean, spike = false) => {
      for (let i = 0; i < count; i++) {
        const transient = spike && (i === 8 || i === 9);
        frames.push({ turn, insideTurn, level: floor * (0.82 + next() * 0.36) * (transient ? 3 : 1), probability: transient ? 0.88 : 0.03 + next() * 0.16 });
      }
    };
    const speech = (count: number, segment: string) => {
      for (let i = 0; i < count; i++) {
        // Brief low-confidence phonemes remain inside otherwise probable speech.
        const uncertain = i > 5 && i % 19 === 0;
        frames.push({ turn, insideTurn: true, level: floor + 0.08 + next() * 0.07,
          probability: uncertain ? 0.21 : 0.77 + next() * 0.21,
          ...(i === count - 1 ? { finalSegment: segment } : {}) });
      }
    };
    background(35, false, true);
    speech(35 + Math.floor(next() * 36), `turn ${turn} first phrase`);
    // Annotated thinking pauses from 224 to 704 ms should remain one turn.
    background(7 + Math.floor(next() * 16), true);
    speech(25 + Math.floor(next() * 31), 'with its final detail');
    background(50, false, true);
  }
  return frames;
}

function replay(frames: Frame[]) {
  const noise = new NoiseFloor(), detector = new TurnDetector(), transcript = new Transcript();
  const submissions: { turn: number | undefined; text: string }[] = [];
  let starts = 0, falseStarts = 0, endpoints = 0, prematureEndpoints = 0;
  for (const frame of frames) {
    const floor = noise.observe(frame.level, frame.probability);
    if (frame.finalSegment) transcript.update(frame.finalSegment, true);
    const transition = detector.update(frame.probability, frame.level, floor, FRAME_MS);
    if (transition === 'start') { starts++; if (!frame.insideTurn) falseStarts++; }
    if (transition === 'end') {
      endpoints++; if (frame.insideTurn) prematureEndpoints++;
      const text = transcript.take();
      if (text) submissions.push({ turn: frame.turn, text });
    }
  }
  return { starts, falseStarts, endpoints, prematureEndpoints, submissions, durationMs: frames.length * FRAME_MS };
}

describe('annotated changing-noise audio acceptance', () => {
  it('keeps 100 annotated turns coherent through noise changes and brief thinking pauses', () => {
    const result = replay(conversationFixture());
    const counts = new Map<number, number>();
    for (const submission of result.submissions) if (submission.turn) counts.set(submission.turn, (counts.get(submission.turn) ?? 0) + 1);
    const missedTurns = Array.from({ length: 100 }, (_, i) => i + 1).filter((turn) => !counts.has(turn)).length;
    const duplicateSubmissions = Array.from(counts.values()).reduce((sum, count) => sum + Math.max(0, count - 1), 0);
    const report = { annotatedTurns: 100, durationMs: result.durationMs, starts: result.starts, falseStarts: result.falseStarts,
      endpoints: result.endpoints, prematureEndpoints: result.prematureEndpoints, submissions: result.submissions.length,
      missedTurns, duplicateSubmissions };
    console.info('Annotated changing-noise replay:', JSON.stringify(report));
    expect(report).toMatchObject({ starts: 100, falseStarts: 0, endpoints: 100, prematureEndpoints: 0, submissions: 100, missedTurns: 0, duplicateSubmissions: 0 });
    expect(result.submissions.map((submission) => submission.text)).toEqual(
      Array.from({ length: 100 }, (_, i) => `turn ${i + 1} first phrase with its final detail`),
    );
  });

  it('produces zero starts and submissions over ten minutes of nonspeech with isolated classifier spikes', () => {
    const next = random(0x4e4f4953), frames: Frame[] = [];
    const backgrounds = [0.004, 0.03, 0.09, 0.015, 0.055];
    for (let i = 0; i < 600_000 / FRAME_MS; i++) {
      const floor = backgrounds[Math.floor(i / 937) % backgrounds.length]!;
      const spike = i % 401 === 20 || i % 401 === 21;
      const thump = i % 193 === 0;
      frames.push({ insideTurn: false, level: floor * (0.75 + next() * 0.5) * (spike || thump ? 4 : 1),
        probability: spike ? 0.9 : 0.02 + next() * 0.2 });
    }
    const result = replay(frames);
    console.info('Ten-minute nonspeech replay:', JSON.stringify({ durationMs: result.durationMs, starts: result.starts, endpoints: result.endpoints, submissions: result.submissions.length }));
    expect(result.durationMs).toBe(600_000);
    expect(result.starts).toBe(0); expect(result.endpoints).toBe(0); expect(result.submissions).toHaveLength(0);
  });
});
