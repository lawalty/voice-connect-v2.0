/** Acoustic evidence only; this does not identify a speaker or infer intent. */
export interface EchoEvidence {
  referencePresent: boolean;
  /** Absolute, zero-mean waveform correlation at the best plausible acoustic delay. */
  echoCorrelation: number;
  /** Fraction of microphone RMS unexplained by a scaled copy of playback, 0..1. */
  residualRatio: number;
  matchedDelayMs?: number;
  /** Full microphone-band confirmation; low-band matching alone never masks input. */
  fullBandReferencePresent?: boolean;
  fullBandCorrelation?: number;
  fullBandResidualRatio?: number;
}

const REFERENCE_RATE = 2000;
const REFERENCE_SECONDS = 65;
const MAX_DELAY = REFERENCE_RATE / 2;
const MAX_FRAME = 64; // 32 ms. Never scan an unbounded microphone block.
const INTERPOLATION_PAD = 4;
const SEARCH_SAMPLES = MAX_DELAY + MAX_FRAME + INTERPOLATION_PAD * 2;
const MAX_PCM_SAMPLES = REFERENCE_SECONDS * 24000;
const MAX_PCM_CHUNKS = 2048;
interface PlaybackChunk { samples: Float32Array; sampleRate: number; startTime: number; endTime: number; }
const NO_REFERENCE: Readonly<EchoEvidence> = Object.freeze({ referencePresent: false, echoCorrelation: 0, residualRatio: 1 });

/**
 * A short-lived, bounded in-memory reference of scheduled mono playback. All times
 * use the same AudioContext clock as microphone capture, in seconds. 65 seconds
 * accommodates the output's 60-second queue while retaining its acoustic tail.
 *
 * A 2 kHz, zero-mean comparison finds candidate delay; ORIGINAL scheduled PCM
 * then verifies the entire 16 kHz microphone band so high-frequency user speech
 * cannot disappear in that downsample. Original PCM is separately capped at
 * 6.24 MB and played chunks are discarded after a roughly 600 ms echo tail.
 * This is an extra guard, not an echo canceller: nonlinear speakers, AEC
 * processing and clock errors can reduce correlation. It does not identify a
 * speaker; uncertain or incomplete full-band evidence leaves microphone intact.
 */
export class PlaybackReference {
  readonly capacitySamples = REFERENCE_RATE * REFERENCE_SECONDS;
  private values = new Float32Array(this.capacitySamples);
  private coverage = new Float32Array(this.capacitySamples);
  private indices = new Float64Array(this.capacitySamples).fill(Number.NaN);
  private newest = Number.NEGATIVE_INFINITY;
  private microphone = new Float64Array(MAX_FRAME);
  private reference = new Float64Array(SEARCH_SAMPLES);
  private totals = new Float64Array(SEARCH_SAMPLES + 1);
  private squares = new Float64Array(SEARCH_SAMPLES + 1);
  private adjacent = new Float64Array(SEARCH_SAMPLES + 1);
  private valid = new Uint16Array(SEARCH_SAMPLES + 1);
  private pcm: PlaybackChunk[] = [];
  private pcmSamples = 0;
  private microphoneTime = Number.NEGATIVE_INFINITY;
  private fullReference = new Float64Array(512);
  private fullCoverage = new Uint8Array(512);

  /** Original samples are bounded too; over-capacity reference fails open. */
  private prunePCM(before: number) {
    this.pcm = this.pcm.filter(chunk => {
      if (chunk.endTime > before) return true;
      this.pcmSamples -= chunk.samples.length; chunk.samples.fill(0); return false;
    });
    while (this.pcmSamples > MAX_PCM_SAMPLES || this.pcm.length > MAX_PCM_CHUNKS) {
      const chunk = this.pcm.shift()!;
      this.pcmSamples -= chunk.samples.length; chunk.samples.fill(0);
    }
  }

  add(samples: Float32Array, sampleRate: number, startTime: number): void {
    if (!samples.length || !Number.isFinite(startTime) || startTime < 0 || !Number.isFinite(sampleRate) || sampleRate < REFERENCE_RATE) return;
    const endTime = startTime + samples.length / sampleRate;
    const cutoff = Math.max(endTime - REFERENCE_SECONDS, this.microphoneTime - 0.6);
    // Small owned chunks allow pruning played history without copying a large
    // queued reply on every frame. No microphone samples enter this storage.
    const chunkSize = Math.min(4096, Math.ceil(sampleRate * 0.128));
    const pcmFirst = Math.max(0, Math.floor((cutoff - startTime) * sampleRate));
    for (let offset = pcmFirst; offset < samples.length; offset += chunkSize) {
      const saved = samples.slice(offset, offset + chunkSize);
      this.pcm.push({ samples: saved, sampleRate, startTime: startTime + offset / sampleRate, endTime: startTime + (offset + saved.length) / sampleRate });
      this.pcmSamples += saved.length;
    }
    this.pcm.sort((a, b) => a.startTime - b.startTime);
    this.prunePCM(cutoff);
    this.newest = Math.max(this.newest, Math.ceil(endTime * REFERENCE_RATE - 1e-7) - 1);
    const oldest = this.newest - this.capacitySamples + 1;
    // Ignore any part of an oversized/late block already outside the bounded ring.
    const first = Math.max(0, Math.floor((oldest / REFERENCE_RATE - startTime) * sampleRate));
    const width = REFERENCE_RATE / sampleRate;
    for (let i = first; i < samples.length; i++) {
      const start = (startTime + i / sampleRate) * REFERENCE_RATE;
      const end = start + width;
      const sample = Number.isFinite(samples[i]) ? samples[i] : 0;
      for (let index = Math.floor(start + 1e-7); index < Math.ceil(end - 1e-7); index++) {
        if (index < oldest) continue;
        const slot = index % this.capacitySamples;
        if (this.indices[slot] !== index) { this.indices[slot] = index; this.values[slot] = 0; this.coverage[slot] = 0; }
        const overlap = Math.max(0, Math.min(end, index + 1) - Math.max(start, index));
        // Summation also represents deliberately overlapping scheduled sources.
        this.values[slot] += sample * overlap;
        this.coverage[slot] += overlap;
      }
    }
  }

  /** Discard queued, unheard audio; retain already-played audio for its echo tail. */
  cancelAfter(time: number): void {
    if (!Number.isFinite(time)) return;
    const cutoff = Math.floor(Math.max(0, time) * REFERENCE_RATE);
    for (let i = 0; i < this.capacitySamples; i++) {
      if (this.indices[i] >= cutoff) { this.indices[i] = Number.NaN; this.values[i] = 0; this.coverage[i] = 0; }
    }
    this.newest = Math.min(this.newest, cutoff - 1);
    this.pcm = this.pcm.filter(chunk => {
      if (chunk.endTime <= time) return true;
      const length = Math.max(0, Math.floor((time - chunk.startTime) * chunk.sampleRate));
      const old = chunk.samples;
      chunk.samples = old.slice(0, length); old.fill(0);
      this.pcmSamples -= old.length - chunk.samples.length;
      chunk.endTime = chunk.startTime + chunk.samples.length / chunk.sampleRate;
      return chunk.samples.length > 0;
    });
  }

  analyze(mic16k: Float32Array, endTime: number): EchoEvidence {
    if (!Number.isFinite(endTime) || endTime < 0 || mic16k.length < 256 || !Number.isFinite(this.newest)) return { ...NO_REFERENCE };
    this.microphoneTime = Math.max(this.microphoneTime, endTime);
    this.prunePCM(this.microphoneTime - 0.6);
    const count16k = Math.min(mic16k.length, MAX_FRAME * 8);
    const input = mic16k.subarray(mic16k.length - count16k);
    const startTime = endTime - count16k / 16000;
    const first = Math.ceil(startTime * REFERENCE_RATE - 1e-7);
    const last = Math.floor(endTime * REFERENCE_RATE + 1e-7) - 1;
    const count = Math.min(MAX_FRAME, last - first + 1);
    if (count < 24) return { ...NO_REFERENCE };
    let micSum = 0, micSquares = 0;
    for (let i = 0; i < count; i++) {
      // Integrate microphone samples onto the same absolute grid as playback.
      const start = ((first + i) / REFERENCE_RATE - startTime) * 16000;
      const end = start + 8;
      let value = 0;
      for (let j = Math.max(0, Math.floor(start + 1e-7)); j < Math.min(input.length, Math.ceil(end - 1e-7)); j++) {
        const sample = Number.isFinite(input[j]) ? input[j] : 0;
        value += sample * Math.max(0, Math.min(end, j + 1) - Math.max(start, j)) / 8;
      }
      this.microphone[i] = value; micSum += value; micSquares += value * value;
    }
    const micEnergy = Math.max(0, micSquares - micSum * micSum / count);
    const oldest = this.newest - this.capacitySamples + 1;
    this.totals[0] = 0; this.squares[0] = 0; this.adjacent[0] = 0; this.valid[0] = 0;
    for (let i = 0; i < MAX_DELAY + count + INTERPOLATION_PAD * 2; i++) {
      const index = first - MAX_DELAY - INTERPOLATION_PAD + i;
      const slot = ((index % this.capacitySamples) + this.capacitySamples) % this.capacitySamples;
      const valid = index >= oldest && this.indices[slot] === index && this.coverage[slot] >= 0.95;
      const value = valid ? this.values[slot] : 0;
      this.reference[i] = value;
      this.totals[i + 1] = this.totals[i] + value;
      this.squares[i + 1] = this.squares[i] + value * value;
      this.adjacent[i + 1] = this.adjacent[i] + (i > 0 ? this.reference[i - 1] * value : 0);
      this.valid[i + 1] = this.valid[i] + (valid ? 1 : 0);
    }
    let best = 0, bestDelay = 0, present = false;
    let previous: { cross: number; sum: number; energy: number } | undefined;
    const candidates: { offset: number; score: number }[] = [];
    const offer = (offset: number, score: number) => {
      if (score < 0.65) return;
      // Refine only six distinct correlation peaks, not every possible delay.
      const close = candidates.findIndex(candidate => Math.abs(candidate.offset - offset) < 2);
      if (close >= 0) { if (candidates[close].score >= score) return; candidates.splice(close, 1); }
      candidates.push({ offset, score }); candidates.sort((a, b) => b.score - a.score);
      if (candidates.length > 6) candidates.pop();
    };
    for (let delay = 0; delay <= MAX_DELAY; delay++) {
      const start = MAX_DELAY + INTERPOLATION_PAD - delay, end = start + count;
      if (this.valid[end] - this.valid[start] !== count) { previous = undefined; continue; }
      const sum = this.totals[end] - this.totals[start];
      const energy = Math.max(0, this.squares[end] - this.squares[start] - sum * sum / count);
      if (energy / count < 1e-6) { previous = undefined; continue; } // Silence/DC is not a reliable reference.
      present = true;
      if (micEnergy / count < 2.5e-7) continue;
      let cross = 0;
      for (let i = 0; i < count; i++) cross += this.microphone[i] * this.reference[start + i];
      cross -= micSum * sum / count;
      const correlation = Math.min(1, Math.abs(cross) / Math.sqrt(micEnergy * energy));
      if (correlation > best) { best = correlation; bestDelay = delay; }
      offer(start, correlation);
      if (previous) {
        // Adjacent-window sufficient statistics cheaply locate a fractional peak.
        // A later window is a smaller acoustic delay, hence start + fraction.
        const covariance = this.adjacent[end + 1] - this.adjacent[start + 1] - sum * previous.sum / count;
        const deltaCross = previous.cross - cross, mixed = covariance - energy;
        const deltaEnergy = previous.energy + energy - 2 * covariance;
        const denominator = deltaCross * mixed - cross * deltaEnergy;
        const fraction = (cross * mixed - deltaCross * energy) / denominator;
        if (Number.isFinite(fraction) && fraction > 0 && fraction < 1) {
          const mixedEnergy = energy + 2 * fraction * mixed + fraction * fraction * deltaEnergy;
          const score = Math.abs(cross + fraction * deltaCross) / Math.sqrt(micEnergy * mixedEnergy);
          if (Number.isFinite(score)) offer(start + fraction, Math.min(1, score));
        }
      }
      previous = { cross, sum, energy };
    }
    // Integer 2 kHz lags are 0.5 ms apart: using only them misses ordinary echo
    // between grid points. A bounded eight-tap Lanczos refinement preserves the
    // independent residual, unlike simply relaxing the echo-only threshold.
    const interpolate = (offset: number) => {
      const start = Math.floor(offset), fraction = offset - start;
      if (offset < INTERPOLATION_PAD || offset > MAX_DELAY + INTERPOLATION_PAD
        || this.valid[start + count + 4] - this.valid[start - 3] !== count + 7) return 0;
      const weights: number[] = [];
      let weightSum = 0;
      for (let tap = -3; tap <= 4; tap++) {
        const distance = fraction - tap, pi = Math.PI * distance;
        const weight = Math.abs(distance) < 1e-8 ? 1 : Math.sin(pi) / pi * Math.sin(pi / 4) / (pi / 4);
        weights.push(weight); weightSum += weight;
      }
      let sum = 0, squares = 0, cross = 0;
      for (let i = 0; i < count; i++) {
        let value = 0;
        for (let tap = 0; tap < 8; tap++) value += this.reference[start + i + tap - 3] * weights[tap];
        value /= weightSum;
        sum += value; squares += value * value; cross += this.microphone[i] * value;
      }
      const energy = squares - sum * sum / count;
      return energy / count >= 1e-6 ? Math.min(1, Math.abs(cross - micSum * sum / count) / Math.sqrt(micEnergy * energy)) : 0;
    };
    for (const candidate of candidates) {
      let offset = candidate.offset, correlation = interpolate(offset), step = 0.125;
      for (let i = 0; i < 6; i++, step /= 2) {
        const lower = interpolate(offset - step), upper = interpolate(offset + step);
        if (lower > correlation && lower >= upper) { offset -= step; correlation = lower; }
        else if (upper > correlation) { offset += step; correlation = upper; }
      }
      if (correlation > best) { best = correlation; bestDelay = MAX_DELAY + INTERPOLATION_PAD - offset; }
    }
    if (!present) return { ...NO_REFERENCE };
    const fullBand = this.compareFullBand(input, endTime, bestDelay / REFERENCE_RATE);
    return { referencePresent: true, echoCorrelation: best, residualRatio: Math.sqrt(Math.max(0, 1 - best * best)), matchedDelayMs: bestDelay / 2, ...fullBand };
  }

  private compareFullBand(input: Float32Array, endTime: number, delay: number): Pick<EchoEvidence, 'fullBandReferencePresent' | 'fullBandCorrelation' | 'fullBandResidualRatio'> {
    const absent = { fullBandReferencePresent: false, fullBandCorrelation: 0, fullBandResidualRatio: 1 };
    const count = input.length, start = endTime - count / 16000 - delay, end = endTime - delay;
    // Select overlaps once, then fill the bounded window; never search all chunks
    // for every microphone sample. Overlapping cue and voice references sum.
    const chunks = this.pcm.filter(chunk => chunk.startTime < end && chunk.endTime > start);
    if (!chunks.length) return absent;
    this.fullReference.fill(0); this.fullCoverage.fill(0);
    for (const chunk of chunks) {
      const first = Math.max(0, Math.ceil((chunk.startTime - start) * 16000 - 0.5));
      const last = Math.min(count, Math.ceil((chunk.endTime - start) * 16000 - 0.5));
      for (let index = first; index < last; index++) {
        const position = Math.max(0, Math.min(chunk.samples.length - 1, (start + (index + 0.5) / 16000 - chunk.startTime) * chunk.sampleRate - 0.5));
        const lower = Math.floor(position), fraction = position - lower;
        const value = chunk.samples[lower] * (1 - fraction) + chunk.samples[Math.min(lower + 1, chunk.samples.length - 1)] * fraction;
        if (!Number.isFinite(value)) return absent;
        this.fullReference[index] += value; this.fullCoverage[index] = 1;
      }
    }
    let micSum = 0, refSum = 0, micSquares = 0, refSquares = 0, cross = 0;
    for (let index = 0; index < count; index++) {
      if (!this.fullCoverage[index] || !Number.isFinite(input[index])) return absent;
      const mic = input[index], ref = this.fullReference[index];
      micSum += mic; refSum += ref; micSquares += mic * mic; refSquares += ref * ref; cross += mic * ref;
    }
    const micEnergy = micSquares - micSum * micSum / count, refEnergy = refSquares - refSum * refSum / count;
    if (micEnergy / count < 2.5e-7 || refEnergy / count < 1e-6) return absent;
    const correlation = Math.min(1, Math.abs(cross - micSum * refSum / count) / Math.sqrt(micEnergy * refEnergy));
    return { fullBandReferencePresent: true, fullBandCorrelation: correlation, fullBandResidualRatio: Math.sqrt(Math.max(0, 1 - correlation * correlation)) };
  }

  reset(): void {
    this.values.fill(0); this.coverage.fill(0); this.indices.fill(Number.NaN);
    this.microphone.fill(0); this.reference.fill(0); this.totals.fill(0); this.squares.fill(0); this.adjacent.fill(0); this.valid.fill(0);
    for (const chunk of this.pcm) chunk.samples.fill(0);
    this.pcm = []; this.pcmSamples = 0; this.microphoneTime = Number.NEGATIVE_INFINITY;
    this.fullReference.fill(0); this.fullCoverage.fill(0);
    this.newest = Number.NEGATIVE_INFINITY;
  }
}

/**
 * Mask only high-confidence echo with no above-noise independent residual. Quiet
 * voices below the measured noise floor remain ambiguous; nonlinear echo can
 * escape. Neither outcome identifies a speaker. Keep the fallback stricter when
 * a caller cannot supply the contemporaneous microphone level and noise floor.
 */
export function isPlaybackEcho(evidence: EchoEvidence, level?: number, floor?: number): boolean {
  if (!evidence.referencePresent || evidence.echoCorrelation < 0.97 || evidence.residualRatio > 0.25
    || !Number.isFinite(evidence.echoCorrelation) || !Number.isFinite(evidence.residualRatio) || evidence.residualRatio < 0) return false;
  const fullCorrelation = evidence.fullBandCorrelation, fullResidual = evidence.fullBandResidualRatio;
  if (evidence.fullBandReferencePresent !== true || fullCorrelation === undefined || fullResidual === undefined
    || !Number.isFinite(fullCorrelation) || !Number.isFinite(fullResidual) || fullCorrelation < 0.97 || fullResidual < 0 || fullResidual > 0.25) return false;
  if (level === undefined || floor === undefined) return evidence.echoCorrelation >= 0.995 && evidence.residualRatio <= 0.1 && fullCorrelation >= 0.995 && fullResidual <= 0.1;
  return Number.isFinite(level) && Number.isFinite(floor) && level >= 0 && floor >= 0
    && level * evidence.residualRatio <= Math.max(0.003, floor * 1.5)
    // A .003 absolute allowance can erase quiet phonemes many times louder than
    // a quiet room's floor. Masking is stricter than the barge-in onset threshold.
    && level * fullResidual <= Math.max(0.0005, floor * 1.5);
}

export type InterruptionReason = 'waiting' | 'low-confidence' | 'background' | 'playback-echo' | 'accumulating' | 'interrupted';
export interface InterruptionMetrics {
  reason: InterruptionReason;
  probabilityThreshold: number;
  snrThreshold: number;
  requiredMs: number;
  accumulatedMs: number;
}

/** Local, one-shot barge-in qualification; no transport/provider acknowledgement. */
export class InterruptionGate {
  private sensitivity = 50;
  private onset = 0;
  private triggered = false;
  private state: InterruptionMetrics = { reason: 'waiting', probabilityThreshold: 0.8, snrThreshold: 1.8, requiredMs: 128, accumulatedMs: 0 };
  constructor(sensitivity = 50) { this.setSensitivity(sensitivity); }
  get metrics(): Readonly<InterruptionMetrics> { return this.state; }

  setSensitivity(value: number): void {
    this.sensitivity = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 50;
    const onset = this.sensitivity <= 50 ? 224 - this.sensitivity * 1.92 : 128 - (this.sensitivity - 50) * 0.64;
    this.state = { reason: 'waiting', probabilityThreshold: 0.9 - this.sensitivity * 0.002,
      snrThreshold: 2.2 - this.sensitivity * 0.008, requiredMs: Math.round(onset / 32) * 32, accumulatedMs: 0 };
    this.reset();
  }

  update(probability: number, level: number, floor: number, evidence: EchoEvidence, durationMs = 32): boolean {
    if (this.triggered) return false;
    let reason: InterruptionReason;
    if (!Number.isFinite(probability) || probability < this.state.probabilityThreshold) reason = 'low-confidence';
    else if (!Number.isFinite(level) || !Number.isFinite(floor) || level <= Math.max(0.003, Math.max(0, floor) * this.state.snrThreshold)) reason = 'background';
    else if (isPlaybackEcho(evidence, level, floor)) reason = 'playback-echo';
    else reason = 'accumulating';
    // A delayed/batched worker result cannot count as arbitrarily long evidence.
    const elapsed = Number.isFinite(durationMs) ? Math.max(0, Math.min(64, durationMs)) : 0;
    this.onset = reason === 'accumulating' ? this.onset + elapsed : 0;
    if (this.onset >= this.state.requiredMs) { reason = 'interrupted'; this.triggered = true; }
    this.state = { ...this.state, reason, accumulatedMs: this.onset };
    return this.triggered;
  }

  reset(): void { this.onset = 0; this.triggered = false; this.state = { ...this.state, reason: 'waiting', accumulatedMs: 0 }; }
}
