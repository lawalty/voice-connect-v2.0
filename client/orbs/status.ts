import type { VoicePhase } from '../../contract/types';
import type { OrbState } from './packs';

/** Present the eight original states using the existing voice lifecycle. */
export function statusOrbState(phase: VoicePhase, asleep = false, waking = false): OrbState {
  if (phase === 'error') return 'error';
  if (phase === 'standby' || phase === 'paused') return 'standby';
  if (waking) return 'connecting';
  if (asleep) return 'idle';
  switch (phase) {
    case 'starting': case 'reconnecting': return 'connecting';
    case 'listening': case 'hearing': return 'listening';
    case 'finalizing': case 'thinking': return 'thinking';
    case 'working': return 'working';
    // Spoken progress is still speech; the status caption retains the tool context.
    case 'thinking-commentary': case 'working-commentary': case 'speaking': return 'speaking';
    default: return 'idle';
  }
}

export const STATUS_METER_COLORS = Array.from({ length: 12 }, (_, i) => i < 3 ? '#34d399' : i < 7 ? '#a3e635' : i < 10 ? '#fbbf24' : '#ef4444');
export function statusMeterSegments(level: number): number {
  return !Number.isFinite(level) || level <= .015 ? 0 : Math.ceil(Math.min(1, level * 1.6) * 12);
}
