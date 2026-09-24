import type { AcousticSignal } from '../../contract/types';

/** Stateful area resampling: low-pass box integration, with no block-boundary drift. */
export class Resampler {
  private area = 0;
  private width = 0;
  constructor(readonly sourceRate: number, readonly targetRate = 16000) {
    if (sourceRate < targetRate) throw new Error('Microphone sample rate is too low.');
  }
  push(input: Float32Array): Float32Array {
    const ratio = this.sourceRate / this.targetRate;
    const output: number[] = [];
    for (const sample of input) {
      let left = 1;
      while (left > 1e-8) {
        const take = Math.min(left, ratio - this.width);
        this.area += sample * take; this.width += take; left -= take;
        if (this.width >= ratio - 1e-8) {
          output.push(this.area / ratio); this.area = 0; this.width = 0;
        }
      }
    }
    return Float32Array.from(output);
  }
}

export function rms(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export class NoiseFloor {
  value = 0.008;
  private samples: number[] = [];
  observe(level: number, speechProbability: number) {
    // Never learn a foreground speaker as the noise floor.
    if (speechProbability >= 0.35) return this.value;
    this.samples.push(Math.max(0.0003, level));
    if (this.samples.length > 90) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a - b);
    const candidate = sorted[Math.floor(sorted.length * 0.3)]!;
    const speed = this.samples.length < 30 ? 0.15 : candidate > this.value ? 0.025 : 0.08;
    this.value += (candidate - this.value) * speed;
    return this.value;
  }
}

export type VadTransition = 'start' | 'end' | null;
export class TurnDetector {
  speaking = false;
  private onset = 0;
  private silence = 0;
  constructor(readonly hangoverMs = 900, readonly onsetMs = 96) {}
  update(probability: number, level: number, floor: number, durationMs = 32): VadTransition {
    const foreground = probability >= 0.65 && level > Math.max(0.0015, floor * 1.22);
    if (!this.speaking) {
      this.onset = foreground ? this.onset + durationMs : 0;
      if (this.onset >= this.onsetMs) { this.speaking = true; this.silence = 0; return 'start'; }
    } else {
      this.silence = probability < 0.38 || level < floor * 1.08 ? this.silence + durationMs : 0;
      if (this.silence >= this.hangoverMs) { this.reset(); return 'end'; }
    }
    return null;
  }
  reset() { this.speaking = false; this.onset = 0; this.silence = 0; }
}

export function pitchOf(samples: Float32Array, sampleRate = 16000): number | null {
  const level = rms(samples);
  if (level < 0.006 || samples.length < 400) return null;
  let best = 0, bestLag = 0;
  for (let lag = Math.floor(sampleRate / 350); lag <= Math.floor(sampleRate / 75); lag++) {
    let cross = 0, first = 0, second = 0;
    for (let i = 0; i < samples.length - lag; i++) {
      cross += samples[i]! * samples[i + lag]!;
      first += samples[i]! ** 2; second += samples[i + lag]! ** 2;
    }
    const correlation = cross / Math.sqrt(first * second + 1e-12);
    if (correlation > best) { best = correlation; bestLag = lag; }
  }
  return best > 0.75 ? sampleRate / bestLag : null;
}

export function acousticSignal(samples: Float32Array, probability: number, floor: number): AcousticSignal {
  const level = rms(samples);
  const snr = Math.max(0, (level - floor) / Math.max(floor, 0.003));
  return {
    energy: Math.min(1, Math.sqrt(level * 5)), speechProbability: probability,
    noiseFloor: floor, pitch: probability > 0.65 ? pitchOf(samples) : null,
    confidence: Math.min(1, snr / 5) * probability,
  };
}

/** Provider endpoint segments are not application turns. */
export class Transcript {
  private segments: string[] = [];
  private partial = '';
  update(text: string, final = false) {
    this.partial = text.trim();
    if (final) { if (this.partial) this.segments.push(this.partial); this.partial = ''; }
    return this.text;
  }
  get text() { return [...this.segments, this.partial].filter(Boolean).join(' ').trim(); }
  get stable() { return this.segments.join(' ').trim(); }
  clear() { this.segments = []; this.partial = ''; }
  take() {
    // A stable prefix plus an unresolved tail is still an incomplete turn.
    if (this.partial) return '';
    const text = this.stable; this.clear(); return text;
  }
}

/** Track cumulative server snapshots without replaying already emitted sentences. */
export class SentenceStream {
  private text = '';
  private emitted = 0;
  append(value: string, replace = false): string[] {
    if (replace) {
      if (value === this.text) return [];
      // A correction to spoken words cannot be played back honestly. Only update unsaid text.
      if (value.slice(0, this.emitted) !== this.text.slice(0, this.emitted)) return [];
      this.text = value;
    } else this.text += value;
    const pending = this.text.slice(this.emitted);
    const output: string[] = [];
    const matches = pending.matchAll(/[^.!?\n]+[.!?](?=\s|$)|[^\n]+\n/g);
    let consumed = 0;
    for (const match of matches) {
      const end = (match.index ?? 0) + match[0].length;
      output.push(pending.slice(consumed, end).trim()); consumed = end;
    }
    this.emitted += consumed;
    return output.filter(Boolean);
  }
  finish(): string[] {
    const rest = this.text.slice(this.emitted).trim(); this.emitted = this.text.length;
    return rest ? [rest] : [];
  }
  reset() { this.text = ''; this.emitted = 0; }
}

export class Generation {
  private value = 0;
  next() { return ++this.value; }
  get current() { return this.value; }
  is(value: number) { return this.value === value; }
}

export function pcm16(samples: Float32Array): ArrayBuffer {
  const bytes = new ArrayBuffer(samples.length * 2), view = new DataView(bytes);
  samples.forEach((sample, i) => view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)), true));
  return bytes;
}
