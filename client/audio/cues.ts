export type ListeningCue = 'on' | 'off';
export interface CueReference { samples: Float32Array; sampleRate: number; startTime: number; }
export interface CueSchedule { startTime: number; endTime: number; }

/** Track readiness, not each visual phase: hearing someone is still listening. */
export class CueTransitions {
  private listening = false;
  update(listening: boolean, enabled: boolean): ListeningCue | undefined {
    const changed = listening !== this.listening;
    this.listening = listening;
    return changed && enabled ? listening ? 'on' : 'off' : undefined;
  }
}

/** Small local cues share the capture/playback clock and never resume audio themselves. */
export class ListeningCues {
  private source?: AudioBufferSourceNode;
  private disposed = false;
  constructor(private context: AudioContext | undefined, private onReference?: (reference: CueReference) => void) {}

  play(kind: ListeningCue): CueSchedule | undefined {
    this.cancel();
    const context = this.context;
    if (this.disposed || !context || context.state !== 'running' || !Number.isFinite(context.currentTime)
      || !Number.isFinite(context.sampleRate) || context.sampleRate < 8000 || context.sampleRate > 192000) return;
    let source: AudioBufferSourceNode | undefined;
    try {
      const duration = kind === 'on' ? 0.085 : 0.075;
      const length = Math.round(context.sampleRate * duration);
      const buffer = context.createBuffer(1, length, context.sampleRate);
      const samples = buffer.getChannelData(0);
      const firstHz = kind === 'on' ? 660 : 440;
      const lastHz = kind === 'on' ? 880 : 330;
      const amplitude = kind === 'on' ? 0.028 : 0.022;
      for (let index = 0; index < length; index++) {
        const position = index / (length - 1), time = index / context.sampleRate;
        const envelope = Math.sin(Math.PI * position) ** 2;
        const phase = 2 * Math.PI * (firstHz * time + (lastHz - firstHz) * time * time / (2 * duration));
        samples[index] = amplitude * envelope * Math.sin(phase);
      }
      samples[0] = 0; samples[length - 1] = 0;
      source = context.createBufferSource(); source.buffer = buffer;
      source.connect(context.destination);
      const scheduled = source;
      source.onended = () => {
        try { scheduled.disconnect(); } catch { /* already detached */ }
        if (this.source === scheduled) this.source = undefined;
      };
      const startTime = context.currentTime + 0.005;
      this.source = source; source.start(startTime);
      // An observer must not turn a harmless cue into a failed microphone session.
      try { this.onReference?.({ samples, sampleRate: context.sampleRate, startTime }); } catch { /* optional acoustic reference */ }
      return { startTime, endTime: startTime + length / context.sampleRate };
    } catch {
      if (this.source === source) this.source = undefined;
      if (source) {
        source.onended = null;
        try { source.stop(); } catch { /* scheduling may not have started */ }
        try { source.disconnect(); } catch { /* audio may be unavailable */ }
      }
      return;
    }
  }

  cancel() {
    const source = this.source; this.source = undefined;
    if (!source) return;
    source.onended = null;
    try { source.stop(); } catch { /* already ended */ }
    try { source.disconnect(); } catch { /* audio may be unavailable */ }
  }
  dispose() { this.disposed = true; this.cancel(); }
}
