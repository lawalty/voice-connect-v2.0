import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    decodeAudioData: vi.fn(async (data: ArrayBuffer) => {
      const wav = new DataView(data), sampleRate = wav.getUint32(24, true);
      const samples = Float32Array.from({ length: (data.byteLength - 44) / 2 }, (_, index) => wav.getInt16(44 + index * 2, true) / 32768);
      return { getChannelData: () => samples, sampleRate, numberOfChannels: 1, duration: samples.length / sampleRate };
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

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const name = url.includes('vc-cue-listening') ? 'vc-cue-listening.wav' : 'vc-cue-sent.wav';
    return new Response(readFileSync(`client/assets/cues/${name}`));
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('listening cue transitions', () => {
  it('sounds once on readiness and once on submission, without chiming during continued listening', () => {
    const transitions = new CueTransitions();
    expect(transitions.update(false, true)).toBeUndefined();
    expect(transitions.update(true, true)).toBe('on');
    expect(transitions.update(true, true)).toBeUndefined();
    expect(transitions.update(false, true, true)).toBe('off');
    expect(transitions.update(false, true)).toBeUndefined();
    expect(transitions.update(true, true)).toBe('on');
  });

  it('ends silently without a submission and still cues the next real listening turn', () => {
    const transitions = new CueTransitions();
    expect(transitions.update(true, true)).toBe('on');
    expect(transitions.update(false, true)).toBeUndefined();
    expect(transitions.update(false, true, true)).toBeUndefined();
    expect(transitions.update(true, true)).toBe('on');
    expect(transitions.update(false, true, true)).toBe('off');
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
  it('plays the supplied recordings without reshaping them and references exactly the scheduled PCM', async () => {
    const { cues, references, sources, context } = fixture();
    await cues.prepare();
    const on = cues.play('on');
    const off = cues.play('off');
    expect(on?.startTime).toBe(3.005); expect(on?.endTime).toBeCloseTo(3.485);
    expect(off?.endTime).toBeCloseTo(3.265);
    expect(references).toHaveLength(2);
    for (const [index, reference] of references.entries()) {
      expect(reference.startTime).toBe(3.005);
      expect(reference.sampleRate).toBe(44100);
      expect(reference.samples).toBe(sources[index]!.buffer!.getChannelData(0));
      expect(reference.samples.length / reference.sampleRate).toBe(index === 0 ? 0.48 : 0.26);
      const peak = Math.max(...reference.samples.map(Math.abs));
      expect(peak).toBe(index === 0 ? 0.12750244140625 : 0.1109619140625);
      expect(sources[index]!.start).toHaveBeenCalledExactlyOnceWith(reference.startTime);
      expect(sources[index]!.connect).toHaveBeenCalledExactlyOnceWith(context.destination);
    }
    await cues.prepare(); cues.play('on');
    expect(fetch).toHaveBeenCalledTimes(2); expect(context.decodeAudioData).toHaveBeenCalledTimes(2);
    expect(context.resume).not.toHaveBeenCalled();
  });

  it('cancels previous cues and disposes permanently without late callbacks detaching a newer cue', async () => {
    const { cues, sources } = fixture();
    await cues.prepare();
    cues.play('on'); const lateEnd = sources[0]!.onended!;
    cues.play('off');
    expect(sources[0]!.stop).toHaveBeenCalledOnce();
    expect(sources[0]!.disconnect).toHaveBeenCalledOnce();
    lateEnd(); cues.dispose(); cues.dispose();
    expect(sources[1]!.stop).toHaveBeenCalledOnce();
    expect(sources[1]!.disconnect).toHaveBeenCalledOnce();
    expect(cues.play('on')).toBeUndefined(); expect(sources).toHaveLength(2);
  });

  it('releases a naturally completed cue without stopping it again', async () => {
    const { cues, sources } = fixture(); await cues.prepare(); cues.play('on');
    sources[0]!.onended!(); cues.cancel();
    expect(sources[0]!.disconnect).toHaveBeenCalledOnce();
    expect(sources[0]!.stop).not.toHaveBeenCalled();
  });

  it('never creates or resumes audio on unavailable, suspended, or closed contexts', () => {
    expect(new ListeningCues(undefined).play('on')).toBeUndefined();
    for (const state of ['suspended', 'closed'] as const) {
      const { cues, context } = fixture(state);
      expect(cues.play('on')).toBeUndefined();
      expect(context.createBufferSource).not.toHaveBeenCalled(); expect(context.resume).not.toHaveBeenCalled();
    }
  });

  it('does not propagate output failure or publish audio that failed to start', async () => {
    const { context, references, sources, cues } = fixture();
    await cues.prepare();
    const create = context.createBufferSource.getMockImplementation()!;
    context.createBufferSource.mockImplementation(() => {
      const source = create(); source.start.mockImplementation(() => { throw new Error('Audio unavailable'); }); return source;
    });
    expect(cues.play('on')).toBeUndefined(); expect(references).toHaveLength(0);
    expect(sources[0]!.disconnect).toHaveBeenCalledOnce();
  });

  it('keeps playback safe when the optional reference observer fails', async () => {
    const { context, sources } = fixture();
    const cues = new ListeningCues(context as unknown as AudioContext, () => { throw new Error('Observer unavailable'); });
    await cues.prepare();
    expect(cues.play('on')).toBeDefined(); expect(sources[0]!.stop).not.toHaveBeenCalled();
    cues.dispose(); expect(sources[0]!.stop).toHaveBeenCalledOnce();
  });

  it('never replays transitions requested before preparation or after disposal', async () => {
    const { cues, sources, context } = fixture();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const decode = context.decodeAudioData.getMockImplementation()!;
    context.decodeAudioData.mockImplementation(async data => { await blocked; return decode(data); });
    const ready = cues.prepare();
    expect(cues.play('on')).toBeUndefined();
    cues.dispose(); release(); await ready;
    expect(cues.play('off')).toBeUndefined(); expect(sources).toHaveLength(0);
  });

  it('allows voice to continue when a cue fails to load or decode', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 404 }));
    const unavailable = fixture(); await expect(unavailable.cues.prepare()).resolves.toBeUndefined();
    expect(unavailable.cues.play('on')).toBeUndefined();
    vi.mocked(fetch).mockResolvedValue(new Response(new Uint8Array([1])));
    const invalid = fixture(); await expect(invalid.cues.prepare()).resolves.toBeUndefined();
    expect(invalid.cues.play('off')).toBeUndefined();
  });

  it('bounds a stalled asset request without playing a delayed cue', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }));
    const { cues, sources } = fixture(); const ready = cues.prepare();
    await vi.advanceTimersByTimeAsync(1500); await ready;
    expect(cues.play('on')).toBeUndefined(); expect(sources).toHaveLength(0);
  });
});
