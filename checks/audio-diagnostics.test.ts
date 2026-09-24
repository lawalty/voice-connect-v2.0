import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioDiagnostics, type AudioDiagnosticEvent, type AudioDiagnosticValues } from '../client/audio/diagnostics';

afterEach(() => vi.restoreAllMocks());

describe('local audio diagnostics', () => {
  it('keeps only the newest entries in chronological order and bounds all capacities', () => {
    const diagnostics = new AudioDiagnostics(3);
    for (let i = 0; i < 8; i++) diagnostics.record('endpoint-ready', { durationMs: i });
    expect(diagnostics.snapshot().map(entry => entry.values.durationMs)).toEqual([5, 6, 7]);
    const huge = new AudioDiagnostics(Number.MAX_VALUE);
    const invalid = new AudioDiagnostics(NaN);
    const zero = new AudioDiagnostics(0);
    for (let i = 0; i < 2200; i++) {
      huge.record('phase'); invalid.record('phase'); zero.record('phase');
    }
    expect(huge.snapshot()).toHaveLength(2048);
    expect(invalid.snapshot()).toHaveLength(160);
    expect(zero.snapshot()).toHaveLength(1);
  });

  it('keeps only approved primitive settings and fixed strings even across an unsafe cast', () => {
    const diagnostics = new AudioDiagnostics();
    diagnostics.record('capture-settings', {
      provider: 'vosk', phase: 'listening', sampleRate: 48_000, channelCount: 1,
      echoCancellation: true, noiseSuppression: false, autoGainControl: true,
      durationMs: 5, bufferedMs: 20, pendingFrames: 2, reason: 'manual',
      deviceId: 'private-device', label: 'Private microphone', id: 'private-id',
      text: 'private transcript', token: 'secret', audio: new Float32Array([0.5]),
    } as unknown as AudioDiagnosticValues);
    expect(diagnostics.snapshot()[0].values).toEqual({
      provider: 'vosk', phase: 'listening', sampleRate: 48_000, channelCount: 1,
      echoCancellation: true, noiseSuppression: false, autoGainControl: true,
      durationMs: 5, bufferedMs: 20, pendingFrames: 2, reason: 'manual',
    });
    diagnostics.record('phase', {
      provider: 'secret provider', phase: 'private transcript', reason: 'raw provider error',
      echoCancellation: 'true', noiseSuppression: {}, autoGainControl: 1,
    } as unknown as AudioDiagnosticValues);
    diagnostics.record('private transcript' as AudioDiagnosticEvent);
    diagnostics.record('phase', null as unknown as AudioDiagnosticValues);
    expect(diagnostics.snapshot()).toHaveLength(3);
    expect(diagnostics.snapshot()[1].values).toEqual({});
    expect(diagnostics.snapshot()[2].values).toEqual({});
    expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/private|secret|raw provider|token|deviceId/);
  });

  it('ignores inherited fields and accessor values without invoking them', () => {
    const readSecret = vi.fn(() => 'secret');
    const values = Object.create({ provider: 'browser' }) as AudioDiagnosticValues;
    Object.defineProperty(values, 'reason', { get: readSecret });
    Object.defineProperty(values, 'transcript', { get: readSecret });
    values.channelCount = 1;
    const diagnostics = new AudioDiagnostics();
    diagnostics.record('capture-settings', values);
    expect(diagnostics.snapshot()[0].values).toEqual({ channelCount: 1 });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it('omits nonfinite numbers and clamps finite numeric evidence', () => {
    const diagnostics = new AudioDiagnostics();
    diagnostics.record('backpressure', {
      durationMs: Infinity, sampleRate: NaN, pendingFrames: -Infinity,
      bufferedMs: -100, channelCount: 100,
    });
    expect(diagnostics.snapshot()[0].values).toEqual({ bufferedMs: 0, channelCount: 32 });
    diagnostics.record('backpressure', { durationMs: Number.MAX_VALUE, sampleRate: Number.MAX_VALUE, pendingFrames: Number.MAX_VALUE });
    expect(diagnostics.snapshot()[1].values).toEqual({ durationMs: 86_400_000, sampleRate: 384_000, pendingFrames: 1_000_000 });
  });

  it('copies both inputs and snapshots so callers cannot alter stored evidence', () => {
    const diagnostics = new AudioDiagnostics();
    const values: AudioDiagnosticValues = { provider: 'browser', phase: 'starting' };
    diagnostics.record('phase', values);
    values.phase = 'error';
    const snapshot = diagnostics.snapshot();
    snapshot[0].event = 'output-end';
    snapshot[0].values.phase = 'paused';
    snapshot.length = 0;
    expect(diagnostics.snapshot()[0]).toMatchObject({ event: 'phase', values: { provider: 'browser', phase: 'starting' } });
  });

  it('records elapsed monotonic time and starts a fresh timeline after clear', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(10_000);
    const diagnostics = new AudioDiagnostics();
    now.mockReturnValue(10_025); diagnostics.record('provider-starting');
    now.mockReturnValue(10_075); diagnostics.record('provider-ready');
    now.mockReturnValue(10_060); diagnostics.record('phase');
    expect(diagnostics.snapshot().map(entry => entry.atMs)).toEqual([25, 75, 75]);
    now.mockReturnValue(20_000); diagnostics.clear();
    expect(diagnostics.snapshot()).toEqual([]);
    now.mockReturnValue(20_008); diagnostics.record('phase');
    expect(diagnostics.snapshot()[0].atMs).toBe(8);
  });
});
