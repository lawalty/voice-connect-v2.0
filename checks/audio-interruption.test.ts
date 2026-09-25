import { describe, expect, it } from 'vitest';
import { InterruptionGate, isPlaybackEcho, PlaybackReference, type EchoEvidence } from '../client/audio/interruption';
import { rms } from '../client/audio/dsp';

// Deterministic broad-band reference, band-limited below the comparison Nyquist.
function voice(time: number, phase = 0): number {
  return 0.14 * Math.sin(time * Math.PI * 2 * 167 + phase)
    + 0.10 * Math.sin(time * Math.PI * 2 * 389 + phase * 2)
    + 0.08 * Math.sin(time * Math.PI * 2 * 713 + phase * 3);
}
function otherVoice(time: number): number {
  return 0.15 * Math.sin(time * Math.PI * 2 * 263 + 1)
    + 0.12 * Math.sin(time * Math.PI * 2 * 557 + 2)
    + 0.1 * Math.sin(time * Math.PI * 2 * 839 + 3);
}
function samples(length: number, rate: number, start: number, value = voice): Float32Array {
  return Float32Array.from({ length }, (_, i) => value(start + (i + 0.5) / rate));
}
const independent: EchoEvidence = { referencePresent: true, echoCorrelation: 0.2, residualRatio: 0.98 };
const echoOnly: EchoEvidence = { referencePresent: true, echoCorrelation: 0.998, residualRatio: 0.063,
  fullBandReferencePresent: true, fullBandCorrelation: 0.998, fullBandResidualRatio: 0.063 };

describe('bounded scheduled playback comparison', () => {
  it('finds delayed, scaled playback at arbitrary output chunk boundaries and clock phase', () => {
    const reference = new PlaybackReference(), rate = 24000, start = 0.025137;
    const output = samples(rate, rate, start);
    for (let i = 0; i < output.length; i += 769) reference.add(output.subarray(i, i + 769), rate, start + i / rate);
    const end = 0.732137, delay = 0.1175;
    const microphone = samples(512, 16000, end - 0.032, time => voice(time - delay) * 0.37 + 0.04);
    const evidence = reference.analyze(microphone, end);
    expect(evidence.referencePresent).toBe(true);
    expect(evidence.echoCorrelation).toBeGreaterThan(0.99);
    expect(evidence.matchedDelayMs).toBe(117.5);
    expect(isPlaybackEcho(evidence)).toBe(true);
  });

  it.each([0.0000625, 0.1170625, 0.11725, 0.117375, 0.49975])('recognizes changing speech-like playback at off-grid delay %s seconds', (delay) => {
    const richVoice = (time: number) => 0.12 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 2.3 * time) ** 2) * Math.sin(2 * Math.PI * (137 * time + 61 * time ** 2))
      + 0.09 * Math.sin(2 * Math.PI * (319 * time + 47 * time ** 2))
      + 0.06 * Math.sin(2 * Math.PI * (611 * time + 31 * time ** 2));
    const reference = new PlaybackReference(), rate = 24000, start = 0.025123;
    const output = samples(rate, rate, start, richVoice);
    for (let i = 0; i < output.length; i += 769) reference.add(output.subarray(i, i + 769), rate, start + i / rate);
    const end = 0.832137;
    const microphone = samples(512, 16000, end - 0.032, time => richVoice(time - delay) * 0.6 + 0.015);
    const evidence = reference.analyze(microphone, end);
    expect(evidence.echoCorrelation).toBeGreaterThan(0.995);
    expect(evidence.matchedDelayMs).toBeCloseTo(delay * 1000, 1);
    expect(isPlaybackEcho(evidence, rms(microphone), 0.003)).toBe(true);
  });

  it('allows a substantial independent near voice mixed with delayed playback', () => {
    const reference = new PlaybackReference();
    reference.add(samples(24000, 24000, 0), 24000, 0);
    const end = 0.8;
    const microphone = samples(512, 16000, end - 0.032, time => voice(time - 0.07) * 0.6 + otherVoice(time));
    const evidence = reference.analyze(microphone, end);
    expect(evidence.referencePresent).toBe(true);
    expect(evidence.residualRatio).toBeGreaterThan(0.53);
    expect(isPlaybackEcho(evidence)).toBe(false);
  });

  it.each([0.014, 0.0018])('preserves high-frequency independent phonemes at amplitude %s despite a matching low band', (amplitude) => {
    const reference = new PlaybackReference(), end = 0.832, delay = 0.096;
    const lowVoice = (time: number) => 0.03 * Math.sin(2 * Math.PI * 200 * time) + 0.015 * Math.sin(2 * Math.PI * 400 * time);
    reference.add(samples(24000, 24000, 0, lowVoice), 24000, 0);
    const microphone = samples(512, 16000, end - 0.032, time => lowVoice(time - delay) * 0.6 + amplitude * Math.sin(2 * Math.PI * 4000 * time));
    const evidence = reference.analyze(microphone, end);
    expect(evidence.echoCorrelation).toBeGreaterThan(0.995);
    expect(evidence.fullBandReferencePresent).toBe(true);
    expect(rms(microphone) * evidence.fullBandResidualRatio!).toBeGreaterThan(0.0005);
    expect(isPlaybackEcho(evidence, rms(microphone), 0.00034)).toBe(false);
  });

  it.each([0.5, 0.25])('preserves independent speech at %s of echo RMS above the noise floor', (nearRatio) => {
    const reference = new PlaybackReference(), end = 0.8;
    reference.add(samples(24000, 24000, 0), 24000, 0);
    const echo = samples(512, 16000, end - 0.032, time => voice(time - 0.07));
    const near = samples(512, 16000, end - 0.032, otherVoice);
    const nearScale = rms(echo) * nearRatio / rms(near);
    const microphone = Float32Array.from(echo, (value, i) => value + near[i] * nearScale);
    const evidence = reference.analyze(microphone, end);
    expect(evidence.referencePresent).toBe(true);
    expect(rms(microphone) * evidence.residualRatio).toBeGreaterThan(0.003);
    expect(isPlaybackEcho(evidence, rms(microphone), 0.001)).toBe(false);
    const gate = new InterruptionGate();
    for (let i = 0; i < 3; i++) expect(gate.update(0.99, rms(microphone), 0.001, evidence)).toBe(false);
    expect(gate.update(0.99, rms(microphone), 0.001, evidence)).toBe(true);
  });

  it('compares the audible sum when a cue overlaps speech', () => {
    const reference = new PlaybackReference();
    reference.add(samples(24000, 24000, 0), 24000, 0);
    const cueStart = 0.6, cue = (time: number) => 0.08 * Math.sin(2 * Math.PI * (660 * (time - cueStart) + 110 / 0.085 * (time - cueStart) ** 2));
    reference.add(samples(2040, 24000, cueStart, cue), 24000, cueStart);
    const end = 0.70, delay = 0.04;
    const microphone = samples(512, 16000, end - 0.032, time => 0.5 * (voice(time - delay) + cue(time - delay)));
    expect(isPlaybackEcho(reference.analyze(microphone, end), rms(microphone), 0.002)).toBe(true);
  });

  it('still recognizes playback over a moderate steady fan hum', () => {
    const reference = new PlaybackReference();
    reference.add(samples(24000, 24000, 0), 24000, 0);
    const end = 0.8, delay = 0.12;
    const microphone = samples(512, 16000, end - 0.032, time => voice(time - delay) * 0.6 + 0.025 * Math.sin(time * 2 * Math.PI * 90));
    expect(isPlaybackEcho(reference.analyze(microphone, end), rms(microphone), 0.02)).toBe(true);
  });

  it('does not invent correlation for independent speech, DC, silence, missing reference or nonfinite input', () => {
    const reference = new PlaybackReference();
    expect(reference.analyze(samples(512, 16000, 0.8, otherVoice), 0.832).referencePresent).toBe(false);
    reference.add(samples(24000, 24000, 0), 24000, 0);
    expect(isPlaybackEcho(reference.analyze(samples(512, 16000, 0.8, otherVoice), 0.832))).toBe(false);
    for (const value of [0, 0.4, Number.NaN]) {
      const result = reference.analyze(new Float32Array(512).fill(value), 0.832);
      expect(result.echoCorrelation).toBe(0); expect(result.residualRatio).toBe(1);
    }
    reference.reset();
    reference.add(new Float32Array(24000).fill(0.5), 24000, 0);
    expect(reference.analyze(new Float32Array(512).fill(0.5), 0.832).referencePresent).toBe(false);
  });

  it('retains already audible tail but discards cancelled future playback', () => {
    const reference = new PlaybackReference();
    reference.add(samples(48000, 24000, 0), 24000, 0);
    reference.cancelAfter(1);
    expect(isPlaybackEcho(reference.analyze(samples(512, 16000, 1.03, time => voice(time - 0.1)), 1.062))).toBe(true);
    expect(reference.analyze(samples(512, 16000, 1.7), 1.732).referencePresent).toBe(false);
    reference.reset();
    expect(reference.analyze(samples(512, 16000, 0.8), 0.832).referencePresent).toBe(false);
  });

  it('uses fixed storage and expires old samples even after large clock jumps', () => {
    const reference = new PlaybackReference();
    reference.add(samples(24000, 24000, 0), 24000, 0);
    reference.add(samples(24000, 24000, 70), 24000, 70);
    expect(reference.capacitySamples).toBe(130000);
    expect(reference.analyze(samples(512, 16000, 0.7), 0.732).referencePresent).toBe(false);
    expect(isPlaybackEcho(reference.analyze(samples(512, 16000, 70.7), 70.732))).toBe(true);
  });
});

describe('low latency interruption qualification', () => {
  it('keeps an above-noise independent residual even when echo dominates the correlation', () => {
    const evidence = { referencePresent: true, echoCorrelation: 0.98, residualRatio: 0.199,
      fullBandReferencePresent: true, fullBandCorrelation: 0.98, fullBandResidualRatio: 0.199 };
    expect(isPlaybackEcho(evidence, 0.2, 0.005)).toBe(false);
    expect(isPlaybackEcho(evidence, 0.2, 0.03)).toBe(true);
    expect(isPlaybackEcho(evidence)).toBe(false);
    expect(isPlaybackEcho({ ...evidence, residualRatio: Number.NaN }, 0.2, 0.03)).toBe(false);
    expect(isPlaybackEcho({ ...echoOnly, fullBandReferencePresent: false }, 0.2, 0.03)).toBe(false);
    expect(isPlaybackEcho({ ...echoOnly, fullBandResidualRatio: Number.NaN }, 0.2, 0.03)).toBe(false);
  });
  it('requires sustained local speech and emits once until reset', () => {
    const gate = new InterruptionGate();
    for (let i = 0; i < 3; i++) expect(gate.update(0.96, 0.1, 0.01, independent)).toBe(false);
    expect(gate.update(0.96, 0.1, 0.01, independent)).toBe(true);
    expect(gate.metrics.requiredMs).toBe(128);
    expect(gate.metrics.reason).toBe('interrupted');
    expect(gate.update(0.96, 0.1, 0.01, independent)).toBe(false);
    gate.reset();
    expect(gate.update(0.96, 0.1, 0.01, independent)).toBe(false);
  });

  it('rejects even high VAD confidence when the microphone is explained by playback', () => {
    const gate = new InterruptionGate(100);
    for (let i = 0; i < 300; i++) expect(gate.update(0.99, 0.2, 0.01, echoOnly)).toBe(false);
    expect(gate.metrics.reason).toBe('playback-echo');
    expect(gate.metrics.accumulatedMs).toBe(0);
    expect(gate.update(0.99, 0.2, 0.01, independent)).toBe(false);
    expect(gate.update(0.99, 0.2, 0.01, independent)).toBe(false);
    expect(gate.update(0.99, 0.2, 0.01, independent)).toBe(true);
  });

  it('rejects steady fan-level input and loud non-speech without inferring speech from volume', () => {
    const gate = new InterruptionGate(100);
    for (let i = 0; i < 300; i++) expect(gate.update(0.98, 0.031, 0.03, independent)).toBe(false);
    expect(gate.metrics.reason).toBe('background');
    for (let i = 0; i < 300; i++) expect(gate.update(0.2, 0.5, 0.03, independent)).toBe(false);
    expect(gate.metrics.reason).toBe('low-confidence');
  });

  it('orders slider thresholds and onset without adding a network wait', () => {
    const low = new InterruptionGate(0), normal = new InterruptionGate(50), high = new InterruptionGate(100);
    expect([low, normal, high].map(gate => gate.metrics.requiredMs)).toEqual([224, 128, 96]);
    expect(low.metrics.probabilityThreshold).toBeGreaterThan(normal.metrics.probabilityThreshold);
    expect(normal.metrics.probabilityThreshold).toBeGreaterThan(high.metrics.probabilityThreshold);
    expect(low.metrics.snrThreshold).toBeGreaterThan(normal.metrics.snrThreshold);
    expect(normal.metrics.snrThreshold).toBeGreaterThan(high.metrics.snrThreshold);
    for (let i = 0; i < 7; i++) expect(low.update(0.85, 0.1, 0.01, independent)).toBe(false);
    for (let i = 0; i < 3; i++) expect(normal.update(0.85, 0.1, 0.01, independent)).toBe(false);
    expect(normal.update(0.85, 0.1, 0.01, independent)).toBe(true);
    for (let i = 0; i < 2; i++) expect(high.update(0.75, 0.1, 0.01, independent)).toBe(false);
    expect(high.update(0.75, 0.1, 0.01, independent)).toBe(true);
  });

  it('resets onset on interrupted evidence and cannot advance from one delayed worker result', () => {
    const gate = new InterruptionGate();
    expect(gate.update(0.95, 0.1, 0.01, independent)).toBe(false);
    expect(gate.update(0.95, 0.1, 0.01, echoOnly)).toBe(false);
    expect(gate.metrics.accumulatedMs).toBe(0);
    expect(gate.update(0.95, 0.1, 0.01, independent, 10000)).toBe(false);
    expect(gate.metrics.accumulatedMs).toBe(64);
    gate.setSensitivity(Number.NaN);
    expect(gate.metrics.requiredMs).toBe(128);
    expect(gate.metrics.accumulatedMs).toBe(0);
  });
});
