import type { PlaybackSamples } from '../audio/output';

export interface MouthPose { open: number; round: number; wide: number; source: 'audio' | 'estimated' | 'silent'; }
export const SILENT_MOUTH: MouthPose = Object.freeze({ open: 0, round: 0, wide: 0, source: 'silent' });
interface Frame { start: number; end: number; pose: MouthPose; }

/** Bounded visual features on the same clock as scheduled PCM. No audio is retained. */
export class SpeechFaceTimeline {
  private frames: Frame[] = [];
  private peak = .08;
  private nativeAt: number | null = null;
  schedule({ samples, sampleRate, startTime }: PlaybackSamples, playedThrough?: number) {
    if (!Number.isFinite(startTime) || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 96000) return;
    // Audio keeps advancing while the face is offscreen or the classic orb is selected.
    if (playedThrough !== undefined) this.prune(playedThrough);
    this.nativeAt = null;
    const step = Math.round(sampleRate * .02);
    for (let offset = 0; offset < samples.length; offset += step) {
      const count = Math.min(step, samples.length - offset);
      let power = 0, crossings = 0;
      for (let i = offset; i < offset + count; i++) {
        const s = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
        power += s * s;
        if (i > offset && (s >= 0) !== (samples[i - 1] >= 0)) crossings++;
      }
      const rms = Math.sqrt(power / count);
      this.peak = Math.max(.045, rms, this.peak - .003);
      const open = rms < .007 ? 0 : Math.min(1, ((rms - .007) / this.peak) ** .7);
      const brightness = Math.min(1, crossings / count * 18);
      this.frames.push({ start: startTime + offset / sampleRate, end: startTime + (offset + count) / sampleRate,
        pose: { open, round: (1 - brightness) * .4, wide: brightness * .45, source: 'audio' } });
    }
    // The playback transport normally schedules at most four seconds. Bound an
    // unexpected producer without retaining any speech samples or growing forever.
    if (this.frames.length > 1200) this.frames.splice(1200);
  }
  nativeStarted(now: number) { this.nativeAt = now; }
  sample(audioTime: number, now: number): MouthPose {
    if (this.nativeAt !== null) {
      const t = (now - this.nativeAt) / 1000;
      return { open: Math.max(0, Math.sin(t * 18) * .35 + Math.sin(t * 31) * .2 + .22), round: .2, wide: .3, source: 'estimated' };
    }
    this.prune(audioTime);
    const frame = this.frames[0];
    return frame && audioTime >= frame.start && audioTime < frame.end ? frame.pose : SILENT_MOUTH;
  }
  private prune(time:number) { while (this.frames.length && this.frames[0].end <= time) this.frames.shift(); }
  clear() { this.frames = []; this.peak = .08; this.nativeAt = null; }
}
