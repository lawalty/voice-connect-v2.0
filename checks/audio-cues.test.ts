import { describe, expect, it, vi } from 'vitest';
import { CueTransitions, ListeningCues, type CueReference } from '../client/audio/cues';

function fixture(state: AudioContextState = 'running') {
  const sources: {
    buffer?: { getChannelData(channel: number): Float32Array };
    onended: (() => void) | null;
    connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const context = {
    state, currentTime: 3, sampleRate: 48000, destination: {}, resume: vi.fn(),
    createBuffer: vi.fn((_channels: number, length: number, _sampleRate: number) => {
      const samples = new Float32Array(length);
      return { getChannelData: () => samples };
    }),
    createBufferSource: vi.fn(() => {
      const source = { onended: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      sources.push(source); return source;
    }),
  };
  const references: CueReference[] = [];
  const cues = new ListeningCues(context as unknown as AudioContext, reference => references.push(reference));
  return { context, cues, references, sources };
}

describe('listening cue transitions', () => {
  it('sounds once on readiness and once on departure, without chiming during continued listening', () => {
    const transitions = new CueTransitions();
    expect(transitions.update(false, true)).toBeUndefined();
    expect(transitions.update(true, true)).toBe('on');
    expect(transitions.update(true, true)).toBeUndefined();
    expect(transitions.update(false, true)).toBe('off');
    expect(transitions.update(false, true)).toBeUndefined();
    expect(transitions.update(true, true)).toBe('on');
  });

  it('tracks silent changes without replaying them when cues are enabled', () => {
    const transitions = new CueTransitions();
    expect(transitions.update(true, false)).toBeUndefined();
    expect(transitions.update(true, true)).toBeUndefined();
    expect(transitions.update(false, false)).toBeUndefined();
    expect(transitions.update(false, true)).toBeUndefined();
    expect(transitions.update(true, true)).toBe('on');
  });
});

describe('local listening cue playback', () => {
  it('schedules short quiet distinct PCM cues with click-free endpoints and exact playback references', () => {
    const { cues, references, sources, context } = fixture();
    const on = cues.play('on');
    const off = cues.play('off');
    expect(on).toEqual({ startTime: 3.005, endTime: 3.09 });
    expect(off?.endTime).toBeCloseTo(3.08);
    expect(references).toHaveLength(2);
    for (const [index, reference] of references.entries()) {
      expect(reference.startTime).toBe(3.005);
      expect(reference.sampleRate).toBe(48000);
      expect(reference.samples).toBe(sources[index]!.buffer!.getChannelData(0));
      expect(reference.samples.length / reference.sampleRate).toBeGreaterThanOrEqual(0.07);
      expect(reference.samples.length / reference.sampleRate).toBeLessThanOrEqual(0.1);
      expect(reference.samples[0]).toBe(0); expect(reference.samples.at(-1)).toBe(0);
      const peak = Math.max(...reference.samples.map(Math.abs));
      expect(peak).toBeGreaterThan(0.015); expect(peak).toBeLessThanOrEqual(0.035);
      expect(Math.max(...reference.samples.slice(0, 24).map(Math.abs))).toBeLessThan(0.0001);
      expect(sources[index]!.start).toHaveBeenCalledExactlyOnceWith(reference.startTime);
      expect(sources[index]!.connect).toHaveBeenCalledExactlyOnceWith(context.destination);
    }
    const crossings = (samples: Float32Array) => samples.reduce((count, value, index) => count + (index > 0 && value > 0 && samples[index - 1]! <= 0 ? 1 : 0), 0);
    const onSamples = references[0]!.samples, offSamples = references[1]!.samples;
    expect(crossings(onSamples.slice(onSamples.length / 2))).toBeGreaterThan(crossings(onSamples.slice(0, onSamples.length / 2)));
    expect(crossings(offSamples.slice(offSamples.length / 2))).toBeLessThan(crossings(offSamples.slice(0, offSamples.length / 2)));
    expect(context.resume).not.toHaveBeenCalled();
  });

  it('cancels previous cues and disposes permanently without late callbacks detaching a newer cue', () => {
    const { cues, sources } = fixture();
    cues.play('on'); const lateEnd = sources[0]!.onended!;
    cues.play('off');
    expect(sources[0]!.stop).toHaveBeenCalledOnce();
    expect(sources[0]!.disconnect).toHaveBeenCalledOnce();
    lateEnd(); cues.dispose(); cues.dispose();
    expect(sources[1]!.stop).toHaveBeenCalledOnce();
    expect(sources[1]!.disconnect).toHaveBeenCalledOnce();
    expect(cues.play('on')).toBeUndefined(); expect(sources).toHaveLength(2);
  });

  it('releases a naturally completed cue without stopping it again', () => {
    const { cues, sources } = fixture(); cues.play('on');
    sources[0]!.onended!(); cues.cancel();
    expect(sources[0]!.disconnect).toHaveBeenCalledOnce();
    expect(sources[0]!.stop).not.toHaveBeenCalled();
  });

  it('never creates or resumes audio on unavailable, suspended, or closed contexts', () => {
    expect(new ListeningCues(undefined).play('on')).toBeUndefined();
    for (const state of ['suspended', 'closed'] as const) {
      const { cues, context } = fixture(state);
      expect(cues.play('on')).toBeUndefined();
      expect(context.createBuffer).not.toHaveBeenCalled(); expect(context.resume).not.toHaveBeenCalled();
    }
  });

  it('does not propagate output failure or publish audio that failed to start', () => {
    const { context, references, sources, cues } = fixture();
    const create = context.createBufferSource.getMockImplementation()!;
    context.createBufferSource.mockImplementation(() => {
      const source = create(); source.start.mockImplementation(() => { throw new Error('Audio unavailable'); }); return source;
    });
    expect(cues.play('on')).toBeUndefined(); expect(references).toHaveLength(0);
    expect(sources[0]!.disconnect).toHaveBeenCalledOnce();
  });

  it('keeps playback safe when the optional reference observer fails', () => {
    const { context, sources } = fixture();
    const cues = new ListeningCues(context as unknown as AudioContext, () => { throw new Error('Observer unavailable'); });
    expect(cues.play('on')).toBeDefined(); expect(sources[0]!.stop).not.toHaveBeenCalled();
    cues.dispose(); expect(sources[0]!.stop).toHaveBeenCalledOnce();
  });
});
