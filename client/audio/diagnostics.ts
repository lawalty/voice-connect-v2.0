import type { VoicePhase } from '../../contract/types';

export type AudioDiagnosticEvent =
  | 'voice-start' | 'voice-stop' | 'input-failure'
  | 'page-hidden' | 'page-visible'
  | 'phase' | 'capture-settings' | 'provider-starting' | 'provider-ready' | 'provider-reconnecting' | 'provider-restored' | 'connection-retry'
  | 'endpoint-request' | 'endpoint-ready' | 'output-start' | 'output-end'
  | 'output-interrupt' | 'output-request' | 'output-error' | 'capture-gap' | 'backpressure' | 'barge-in' | 'barge-in-blocked';

export type VoiceStopReason =
  | 'manual' | 'restart' | 'end-session' | 'standby' | 'settings' | 'library' | 'edit-as-text'
  | 'auto-off' | 'delivery-pending' | 'conversation-change' | 'logout' | 'auth-expired'
  | 'start-error' | 'resume-error' | 'capture-error' | 'disposed';

export type AudioDiagnosticReason = VoiceStopReason
  | 'mic-ended' | 'mic-muted' | 'capture-gap' | 'vad-backlog' | 'capture-backlog'
  | 'suspended' | 'provider-error' | 'speech-onset' | 'playback-echo' | 'background' | 'low-confidence' | 'reply-timeout' | 'reply-close'
  | 'vad-error' | 'endpoint-error' | 'turn-limit' | 'page-hidden' | 'network-offline' | 'provider-mid-turn';

export interface AudioDiagnosticValues {
  provider?: 'browser' | 'vosk' | 'deepgram' | 'fish';
  phase?: VoicePhase;
  durationMs?: number;
  sampleRate?: number;
  channelCount?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  bufferedMs?: number;
  pendingFrames?: number;
  attempt?: number;
  closeCode?: number;
  reason?: AudioDiagnosticReason;
}

export interface AudioDiagnosticEntry {
  atMs: number;
  event: AudioDiagnosticEvent;
  values: AudioDiagnosticValues;
}

const EVENTS = new Set<AudioDiagnosticEvent>([
  'voice-start', 'voice-stop', 'input-failure',
  'page-hidden', 'page-visible',
  'phase', 'capture-settings', 'provider-starting', 'provider-ready', 'provider-reconnecting', 'provider-restored', 'connection-retry',
  'endpoint-request', 'endpoint-ready', 'output-start', 'output-end',
  'output-interrupt', 'output-request', 'output-error', 'capture-gap', 'backpressure', 'barge-in', 'barge-in-blocked',
]);
const PHASES = new Set<VoicePhase>([
  'off', 'starting', 'listening', 'hearing', 'finalizing', 'thinking', 'working', 'thinking-commentary', 'working-commentary',
  'speaking', 'reconnecting', 'paused', 'standby', 'error',
]);
const REASONS = new Set<AudioDiagnosticReason>([
  'restart', 'end-session', 'standby', 'settings', 'library', 'edit-as-text', 'auto-off', 'delivery-pending',
  'conversation-change', 'logout', 'auth-expired', 'start-error', 'resume-error', 'capture-error', 'disposed',
  'vad-error', 'endpoint-error', 'turn-limit', 'page-hidden', 'network-offline', 'provider-mid-turn',
  'mic-ended', 'mic-muted', 'capture-gap', 'vad-backlog', 'capture-backlog',
  'suspended', 'provider-error', 'manual', 'speech-onset', 'playback-echo', 'background', 'low-confidence', 'reply-timeout', 'reply-close',
]);
const LIFECYCLE = new Set<AudioDiagnosticEvent>(['voice-start', 'voice-stop', 'input-failure']);

export function audioReasonLabel(reason?: AudioDiagnosticReason): string {
  if (!reason) return 'No reason recorded';
  const labels: Partial<Record<AudioDiagnosticReason, string>> = {
    'mic-ended': 'Microphone disconnected', 'mic-muted': 'Microphone interrupted',
    'capture-gap': 'Microphone frames delayed', 'capture-backlog': 'Microphone processing fell behind',
    'vad-backlog': 'Speech detection fell behind', 'suspended': 'Browser audio suspended',
    'page-hidden': 'Page became hidden', 'network-offline': 'Network went offline',
    'provider-error': 'Recognition provider error', 'provider-mid-turn': 'Recognition lost during a turn',
    'vad-error': 'Speech detector failed', 'endpoint-error': 'Turn finalization failed',
    'turn-limit': 'Two-minute turn limit', 'settings': 'Opened settings', 'library': 'Opened library',
    'end-session': 'End voice pressed', 'standby': 'Orb standby selected', 'edit-as-text': 'Edit as text selected', 'auto-off': 'Auto mode turned off',
    'delivery-pending': 'Previous message still being delivered', 'conversation-change': 'Conversation changed',
    'auth-expired': 'Login session expired', 'capture-error': 'Input stopped after a capture failure',
    'start-error': 'Voice startup failed', 'resume-error': 'Voice resume failed', 'restart': 'Voice restarted',
    'disposed': 'Voice engine closed', 'logout': 'Signed out', 'manual': 'Voice stopped',
  };
  return labels[reason] || reason.replaceAll('-', ' ');
}
const NUMERIC_LIMITS = {
  durationMs: 86_400_000,
  sampleRate: 384_000,
  channelCount: 32,
  bufferedMs: 86_400_000,
  pendingFrames: 1_000_000,
  attempt: 100,
  closeCode: 4999,
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
  if (provider === 'browser' || provider === 'vosk' || provider === 'deepgram' || provider === 'fish') safe.provider = provider;
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
  // Keep a small independent stop/start history so noisy playback measurements
  // cannot erase the cause before the user opens diagnostics or wakes again.
  private readonly lifecycle: AudioDiagnosticEntry[] = [];
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
    const entry = { atMs: this.elapsed, event, values: safeValues(values) };
    this.entries[this.next] = entry;
    if (LIFECYCLE.has(event)) {
      this.lifecycle.push(entry);
      if (this.lifecycle.length > Math.min(32, this.capacity)) this.lifecycle.shift();
    }
    this.next = (this.next + 1) % this.capacity;
  }

  snapshot(): AudioDiagnosticEntry[] {
    const chronological = this.entries.length < this.capacity
      ? this.entries
      : [...this.entries.slice(this.next), ...this.entries.slice(0, this.next)];
    const retained = this.lifecycle.filter(entry => !chronological.includes(entry));
    return [...retained, ...chronological].sort((a, b) => a.atMs - b.atMs)
      .map(entry => ({ ...entry, values: { ...entry.values } }));
  }

  clear(): void {
    this.entries.length = 0;
    this.lifecycle.length = 0;
    this.next = 0;
    this.origin = performance.now();
    this.elapsed = 0;
  }
}
