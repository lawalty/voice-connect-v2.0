import { describe, expect, it } from 'vitest';
import { parseOrbPack, VOICE_CONNECT_V1 } from '../contract/orb-packs';
import { statusMeterSegments, statusOrbState, STATUS_METER_COLORS } from '../client/orbs/status';
import type { VoicePhase } from '../contract/types';

describe('portable Voice Connect v1 status packs', () => {
  const pack = { ...VOICE_CONNECT_V1, id: 'my-original-orb' };
  it('round-trips a data-only palette without face artwork or audio', () => {
    expect(parseOrbPack(JSON.stringify(pack))).toEqual(pack);
    expect(pack).not.toHaveProperty('atlas'); expect(pack).not.toHaveProperty('audio');
  });
  it('rejects missing states, unsafe CSS, executable fields and reserved IDs', () => {
    const { working, ...incomplete } = pack.colors;
    for (const invalid of [{ ...pack, id: VOICE_CONNECT_V1.id }, { ...pack, colors: incomplete },
      { ...pack, colors: { ...pack.colors, working: 'url(https://example.org)' } },
      { ...pack, script: 'alert(1)' }, { ...pack, audio: 'https://example.org/music.mp3' }, { ...pack, atlas: 'https://example.org/art.png' }])
      expect(() => parseOrbPack(JSON.stringify(invalid))).toThrow();
  });
  it('maps actual lifecycle and spoken progress into the eight visible states', () => {
    const expected: Record<VoicePhase, string> = { off: 'idle', starting: 'connecting', reconnecting: 'connecting', listening: 'listening', hearing: 'listening', finalizing: 'thinking', thinking: 'thinking', working: 'working', speaking: 'speaking', 'thinking-commentary': 'speaking', 'working-commentary': 'speaking', standby: 'standby', paused: 'standby', error: 'error' };
    for (const [phase, state] of Object.entries(expected)) expect(statusOrbState(phase as VoicePhase)).toBe(state);
    expect(statusOrbState('off', true, true)).toBe('connecting');
    expect(statusOrbState('reconnecting', true)).toBe('idle');
    expect(statusOrbState('error', true)).toBe('error');
    expect(statusOrbState('standby', true)).toBe('standby');
  });
  it('fills twelve segments from emerald through lime and amber to red, with a noise floor', () => {
    expect([0, .01, .015, NaN, -1].map(statusMeterSegments)).toEqual([0, 0, 0, 0, 0]);
    expect(statusMeterSegments(.1)).toBe(2); expect(statusMeterSegments(.5)).toBe(10); expect(statusMeterSegments(2)).toBe(12);
    expect(STATUS_METER_COLORS).toEqual([...Array(3).fill('#34d399'), ...Array(4).fill('#a3e635'), ...Array(3).fill('#fbbf24'), ...Array(2).fill('#ef4444')]);
  });
});
