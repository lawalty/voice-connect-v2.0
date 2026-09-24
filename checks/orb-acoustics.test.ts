import { describe, expect, it } from 'vitest';
import { OrbAcousticMotion, orbMotionShape } from '../client/orb-acoustics';
import type { AcousticSignal } from '../contract/types';

const signal = (pitch = 160, energy = .5): AcousticSignal => ({ pitch, energy, confidence: .95, speechProbability: .95, noiseFloor: .01 });
function run(pitchBase: number, cyclesPerSecond = 0) {
  const model = new OrbAcousticMotion();
  for (let time = 0; time <= 4500; time += 32) {
    const energy = .35 + Math.sin(time / 1000 * Math.PI * 2 * cyclesPerSecond) * .22;
    model.observe(signal(pitchBase * 2 ** (Math.sin(time / 300) * .22), energy), time); model.sample(time);
  }
  return model.sample(4512);
}
describe('uncertainty-aware orb motion', () => {
  it('does not turn loud uncertain noise into vocal expression', () => {
    const model = new OrbAcousticMotion();
    for (let time = 0; time < 2000; time += 32) { model.observe({ ...signal(300, 1), confidence: .2, speechProbability: .3 }, time); model.sample(time); }
    expect(model.sample(2000)).toEqual({ energy: 0, pitchVariation: 0, pace: 0, confidence: 0 });
  });
  it('uses pitch movement relative to recent baseline, independent of absolute pitch', () => {
    const lower = run(110), higher = run(220);
    expect(lower.pitchVariation).toBeGreaterThan(.2);
    expect(lower.pitchVariation).toBeCloseTo(higher.pitchVariation, 8);
    const steady = new OrbAcousticMotion();
    for (let time = 0; time < 3000; time += 32) { steady.observe(signal(220), time); steady.sample(time); }
    expect(steady.sample(3000).pitchVariation).toBeLessThan(.001);
  });
  it('responds to vocal-envelope rhythm without treating steady energy as pace', () => {
    expect(run(160, 4).pace).toBeGreaterThan(run(160, 2).pace);
    expect(run(160, 0).pace).toBe(0);
    const confidenceChanges = new OrbAcousticMotion();
    for (let time = 0; time < 4000; time += 32) { confidenceChanges.observe({ ...signal(), confidence: .8 + Math.sin(time / 80) * .1 }, time); confidenceChanges.sample(time); }
    expect(confidenceChanges.sample(4000).pace).toBe(0);
  });
  it('fades missing or newly uncertain evidence back to neutral', () => {
    const model = new OrbAcousticMotion();
    for (let time = 0; time < 1000; time += 32) { model.observe(signal(), time); model.sample(time); }
    expect(model.sample(1000).energy).toBeGreaterThan(.4);
    for (let time = 1000; time <= 3500; time += 32) model.sample(time);
    expect(model.sample(3500).energy).toBeLessThan(.001);
    model.observe({ ...signal(300, 1), confidence: .1 }, 3510);
    expect(model.sample(4000).pitchVariation).toBe(0);
  });
  it('keeps every acoustic shape parameter static in reduced motion', () => {
    const quiet = orbMotionShape({ energy: 0, pitchVariation: 0, pace: 0, confidence: 0 }, true);
    const expressive = orbMotionShape({ energy: 1, pitchVariation: 1, pace: 1, confidence: 1 }, true);
    expect(expressive).toEqual(quiet);
    expect(expressive).toEqual({ expansion: 0, pitchCurl: 0, rhythm: 0, flowRate: 0 });
    expect(orbMotionShape({ energy: 0, pitchVariation: 0, pace: 0, confidence: 0 }, false).flowRate).toBeGreaterThan(0);
  });
});
