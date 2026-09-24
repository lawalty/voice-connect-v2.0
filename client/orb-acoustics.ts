import type { AcousticSignal } from '../contract/types';

export interface OrbAcoustics { energy: number; pitchVariation: number; pace: number; confidence: number; }
const neutral = (): OrbAcoustics => ({ energy: 0, pitchVariation: 0, pace: 0, confidence: 0 });
const unit = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

/** Visual evidence only: relative pitch movement and vocal-envelope rhythm, never emotion or words/minute. */
export class OrbAcousticMotion {
  private pitches: { at: number; value: number; weight: number }[] = [];
  private peaks: number[] = [];
  private previousEnergy = 0;
  private previousSlope = 0;
  private valley = 0;
  private observedAt = -Infinity;
  private steppedAt: number | undefined;
  private target = neutral();
  private current = neutral();

  observe(signal: AcousticSignal | null, now: number) {
    this.observedAt = now;
    const confidence = unit(signal?.confidence ?? 0);
    const speech = unit(signal?.speechProbability ?? 0);
    // High volume is not sufficient evidence. Uncertain/noisy frames contribute no expression.
    const gate = unit((confidence - .4) / .45) * unit((speech - .5) / .35);
    this.pitches = this.pitches.filter(point => now - point.at < 3000);
    this.peaks = this.peaks.filter(at => now - at < 3500);
    if (!signal || gate === 0) {
      this.target = neutral(); this.previousEnergy = 0; this.previousSlope = 0; this.valley = 0;
      return;
    }
    const energy = unit(signal.energy) * gate;
    let variation = 0;
    if (confidence >= .65 && speech >= .7 && signal.pitch !== null && Number.isFinite(signal.pitch) && signal.pitch > 0) {
      this.pitches.push({ at: now, value: Math.log2(signal.pitch), weight: gate });
      if (this.pitches.length > 100) this.pitches.shift();
      if (this.pitches.length >= 6 && now - this.pitches[0].at >= 160) {
        const weight = this.pitches.reduce((sum, point) => sum + point.weight, 0);
        const baseline = this.pitches.reduce((sum, point) => sum + point.value * point.weight, 0) / weight;
        const variance = this.pitches.reduce((sum, point) => sum + (point.value - baseline) ** 2 * point.weight, 0) / weight;
        variation = unit(Math.sqrt(variance) * 2.5) * gate;
      }
    }
    if (confidence < .65 || speech < .7) {
      this.previousEnergy = 0; this.previousSlope = 0; this.valley = 0;
      this.target = { energy, pitchVariation: 0, pace: 0, confidence: gate };
      return;
    }
    // Rhythm uses the vocal envelope itself, so changing confidence cannot manufacture a pulse.
    const envelope = unit(signal.energy);
    const slope = envelope - this.previousEnergy;
    if (slope > 0 && this.previousSlope <= 0) this.valley = this.previousEnergy;
    if (slope < 0 && this.previousSlope > 0 && this.previousEnergy - this.valley > .035 && now - (this.peaks.at(-1) ?? -Infinity) >= 160) this.peaks.push(now);
    this.previousEnergy = envelope; this.previousSlope = slope;
    let pace = 0;
    if (this.peaks.length >= 3) {
      const meanGap = (this.peaks.at(-1)! - this.peaks[0]) / (this.peaks.length - 1);
      pace = unit(1000 / meanGap / 6) * gate;
    }
    this.target = { energy, pitchVariation: variation, pace, confidence: gate };
  }

  sample(now: number): OrbAcoustics {
    const elapsed = this.steppedAt === undefined ? 33 : Math.max(0, Math.min(2000, now - this.steppedAt));
    this.steppedAt = now;
    const freshness = unit(1 - Math.max(0, now - this.observedAt - 180) / 470);
    const follow = 1 - Math.exp(-elapsed / 240);
    for (const key of ['energy', 'pitchVariation', 'pace', 'confidence'] as const) {
      this.current[key] += (this.target[key] * freshness - this.current[key]) * follow;
      if (Math.abs(this.current[key]) < .0001) this.current[key] = 0;
    }
    return { ...this.current };
  }
}

export function orbMotionShape(acoustics: OrbAcoustics, reducedMotion: boolean) {
  if (reducedMotion) return { expansion: 0, pitchCurl: 0, rhythm: 0, flowRate: 0 };
  return { expansion: unit(acoustics.energy) * .065, pitchCurl: unit(acoustics.pitchVariation) * 2.8, rhythm: unit(acoustics.pace) * 1.1, flowRate: .00035 * (1 + unit(acoustics.pace) * .42) };
}
