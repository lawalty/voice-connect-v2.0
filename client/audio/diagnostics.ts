import type { VoicePhase } from '../../contract/types';

export type AudioDiagnosticEvent =
  | 'phase' | 'capture-settings' | 'provider-starting' | 'provider-ready'
  | 'endpoint-request' | 'endpoint-ready' | 'output-start' | 'output-end'
  | 'output-interrupt' | 'capture-gap' | 'backpressure';

export type AudioDiagnosticReason =
  | 'mic-ended' | 'mic-muted' | 'capture-gap' | 'vad-backlog' | 'capture-backlog'
  | 'suspended' | 'provider-error' | 'manual' | 'speech-onset';

export interface AudioDiagnosticValues {
  provider?: 'browser' | 'vosk' | 'deepgram';
  phase?: VoicePhase;
  durationMs?: number;
  sampleRate?: number;
  channelCount?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  bufferedMs?: number;
  pendingFrames?: number;
  reason?: AudioDiagnosticReason;
}

export interface AudioDiagnosticEntry {
  atMs: number;
  event: AudioDiagnosticEvent;
  values: AudioDiagnosticValues;
}

const EVENTS = new Set<AudioDiagnosticEvent>([
  'phase', 'capture-settings', 'provider-starting', 'provider-ready',
  'endpoint-request', 'endpoint-ready', 'output-start', 'output-end',
  'output-interrupt', 'capture-gap', 'backpressure',
]);
const PHASES = new Set<VoicePhase>([
  'off', 'starting', 'listening', 'hearing', 'finalizing', 'thinking',
  'speaking', 'reconnecting', 'paused', 'error',
]);
const REASONS = new Set<AudioDiagnosticReason>([
  'mic-ended', 'mic-muted', 'capture-gap', 'vad-backlog', 'capture-backlog',
  'suspended', 'provider-error', 'manual', 'speech-onset',
]);
const NUMERIC_LIMITS = {
  durationMs: 86_400_000,
  sampleRate: 384_000,
  channelCount: 32,
  bufferedMs: 86_400_000,
  pendingFrames: 1_000_000,
} as const;

function safeValues(values: AudioDiagnosticValues): AudioDiagnosticValues {
  const safe: AudioDiagnosticValues = {};
  if (!values || typeof values !== 'object') return safe;
  // Read only own data properties. In particular, never enumerate or retain
  // capture devices, provider messages, transcripts, or caller-supplied getters.
  const own = (key: keyof AudioDiagnosticValues): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(values, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  };
  const provider = own('provider');
  if (provider === 'browser' || provider === 'vosk' || provider === 'deepgram') safe.provider = provider;
  const phase = own('phase');
  if (typeof phase === 'string' && PHASES.has(phase as VoicePhase)) safe.phase = phase as VoicePhase;
  const reason = own('reason');
  if (typeof reason === 'string' && REASONS.has(reason as AudioDiagnosticReason)) safe.reason = reason as AudioDiagnosticReason;
  for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const) {
    const value = own(key);
    if (typeof value === 'boolean') safe[key] = value;
  }
  for (const key of Object.keys(NUMERIC_LIMITS) as (keyof typeof NUMERIC_LIMITS)[]) {
    const value = own(key);
    if (typeof value === 'number' && Number.isFinite(value)) {
      safe[key] = Math.min(NUMERIC_LIMITS[key], Math.max(0, value));
    }
  }
  return safe;
}

/** Local, bounded operational evidence. Nothing is persisted or transmitted. */
export class AudioDiagnostics {
  private readonly capacity: number;
  private readonly entries: AudioDiagnosticEntry[] = [];
  private next = 0;
  private origin = performance.now();
  private elapsed = 0;

  constructor(capacity = 160) {
    this.capacity = Number.isFinite(capacity) ? Math.min(2048, Math.max(1, Math.floor(capacity))) : 160;
  }

  record(event: AudioDiagnosticEvent, values: AudioDiagnosticValues = {}): void {
    // The TypeScript boundary is not a privacy boundary: validate even when
    // called from JavaScript or with an incorrectly asserted external object.
    if (!EVENTS.has(event)) return;
    const now = performance.now() - this.origin;
    if (Number.isFinite(now)) this.elapsed = Math.max(this.elapsed, now, 0);
    this.entries[this.next] = { atMs: this.elapsed, event, values: safeValues(values) };
    this.next = (this.next + 1) % this.capacity;
  }

  snapshot(): AudioDiagnosticEntry[] {
    const chronological = this.entries.length < this.capacity
      ? this.entries
      : [...this.entries.slice(this.next), ...this.entries.slice(0, this.next)];
    return chronological.map(entry => ({ ...entry, values: { ...entry.values } }));
  }

  clear(): void {
    this.entries.length = 0;
    this.next = 0;
    this.origin = performance.now();
    this.elapsed = 0;
  }
}
