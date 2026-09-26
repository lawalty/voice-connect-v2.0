import listeningURL from '../assets/cues/vc-cue-listening.wav?url';
import sentURL from '../assets/cues/vc-cue-sent.wav?url';
import sleepURL from '../assets/cues/vc-cue-sleep.wav?url';

export type ListeningCue = 'on' | 'off';
export type VoiceCue = ListeningCue | 'sleep';
export interface CueReference { samples: Float32Array; sampleRate: number; startTime: number; }
export interface CueSchedule { startTime: number; endTime: number; }

/** Readiness opens a turn; only submission sounds sent, never stopping capture. */
export class CueTransitions {
  private listening = false;
  update(listening: boolean, enabled: boolean, turnSubmitted = false): ListeningCue | undefined {
    const changed = listening !== this.listening;
    this.listening = listening;
    if (!changed || !enabled) return;
    return listening ? 'on' : turnSubmitted ? 'off' : undefined;
  }
}

/** Small local cues share the capture/playback clock and never resume audio themselves. */
export class ListeningCues {
  private source?: AudioBufferSourceNode;
  private disposed = false;
  private buffers?: Record<VoiceCue, AudioBuffer>;
  private preparation?: Promise<void>;
  private loading = new AbortController();
  constructor(private context: AudioContext | undefined, private onReference?: (reference: CueReference) => void) {}

  /** Decode once alongside recognizer startup, never at a turn boundary. */
  prepare(): Promise<void> {
    return this.preparation ??= this.load();
  }
  private async load() {
    const context = this.context;
    if (this.disposed || !context || context.state === 'closed') return;
    const timeout = setTimeout(() => this.loading.abort(), 1500);
    try {
      const [on, off, sleep] = await Promise.all([listeningURL, sentURL, sleepURL].map(async url => {
        const response = await fetch(url, { signal: this.loading.signal });
        if (!response.ok) throw new Error('Cue unavailable');
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        // The supplied recordings are short mono PCM; keep the reference exact.
        if (buffer.numberOfChannels !== 1 || buffer.duration <= 0 || buffer.duration > 2) throw new Error('Invalid cue');
        return buffer;
      }));
      if (!this.disposed && !this.loading.signal.aborted) this.buffers = { on: on!, off: off!, sleep: sleep! };
    } catch { this.loading.abort(); /* Optional cues must never fail voice startup or play late. */ }
    finally { clearTimeout(timeout); }
  }

  play(kind: VoiceCue): CueSchedule | undefined {
    this.cancel();
    const context = this.context;
    const buffer = this.buffers?.[kind];
    if (this.disposed || !context || context.state !== 'running' || !Number.isFinite(context.currentTime)
      || !buffer) return;
    let source: AudioBufferSourceNode | undefined;
    try {
      const samples = buffer.getChannelData(0);
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
      try { this.onReference?.({ samples, sampleRate: buffer.sampleRate, startTime }); } catch { /* optional acoustic reference */ }
      return { startTime, endTime: startTime + buffer.duration };
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
  dispose() { this.disposed = true; this.loading.abort(); this.buffers = undefined; this.cancel(); }
}
