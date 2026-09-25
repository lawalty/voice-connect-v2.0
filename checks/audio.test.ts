import { describe, expect, it } from 'vitest';
import { acousticSignal, Generation, NoiseFloor, pcm16, Resampler, SentenceStream, Transcript, TurnDetector } from '../client/audio/dsp';

describe('audio streaming math', () => {
  it('preserves sample count and signal across arbitrary microphone block boundaries', () => {
    const source = Float32Array.from({ length: 44100 }, (_, i) => Math.sin(i * Math.PI / 200));
    const whole = new Resampler(44100).push(source);
    const streaming = new Resampler(44100), values: number[] = [];
    for (let i = 0; i < source.length; i += 127) values.push(...streaming.push(source.subarray(i, i + 127)));
    expect(whole.length).toBe(16000); expect(values.length).toBe(16000);
    expect(values).toEqual(Array.from(whole));
  });
  it('outputs signed little-endian PCM16 with bounded values', () => {
    const view = new DataView(pcm16(Float32Array.of(-2, -1, 0, 1, 2)));
    expect(Array.from({ length: 5 }, (_, i) => view.getInt16(i * 2, true))).toEqual([-32768, -32768, 0, 32767, 32767]);
  });
});

describe('noise-aware turn detection', () => {
  it('adapts to car noise but never learns a probable foreground speaker as noise', () => {
    const floor = new NoiseFloor();
    for (let i = 0; i < 120; i++) floor.observe(0.06, 0.08);
    expect(floor.value).toBeGreaterThan(0.05);
    const before = floor.value;
    for (let i = 0; i < 200; i++) floor.observe(0.25, 0.95);
    expect(floor.value).toBe(before);
  });
  it('rejects noise transients and requires sustained onset and endpoint silence', () => {
    const detector = new TurnDetector(900, 96);
    expect(detector.update(0.9, 0.2, 0.04)).toBeNull();
    expect(detector.update(0.1, 0.2, 0.04)).toBeNull();
    expect(detector.update(0.9, 0.2, 0.04)).toBeNull();
    expect(detector.update(0.9, 0.2, 0.04)).toBeNull();
    expect(detector.update(0.9, 0.2, 0.04)).toBe('start');
    for (let i = 0; i < 20; i++) expect(detector.update(0.1, 0.04, 0.04)).toBeNull();
    expect(detector.update(0.95, 0.2, 0.04)).toBeNull();
    for (let i = 0; i < 28; i++) expect(detector.update(0.1, 0.04, 0.04)).toBeNull();
    expect(detector.update(0.1, 0.04, 0.04)).toBe('end');
  });
  it('reports acoustic evidence without emotion labels or confidence on noise', () => {
    const result = acousticSignal(new Float32Array(512).fill(0.03), 0.05, 0.03);
    expect(result.pitch).toBeNull(); expect(result.confidence).toBe(0);
    expect(Object.keys(result).sort()).toEqual(['confidence', 'energy', 'noiseFloor', 'pitch', 'speechProbability']);
  });
});

describe('coherent turn and speech output boundaries', () => {
  it('accumulates endpoint segments and refuses a turn containing an unresolved tail', () => {
    const transcript = new Transcript();
    transcript.update('please find', false); transcript.update('please find my notes', true);
    transcript.update('from yes', false); transcript.update('from yesterday', true);
    transcript.update('unconfirmed fragment', false);
    expect(transcript.text).toBe('please find my notes from yesterday unconfirmed fragment');
    expect(transcript.take()).toBe('');
    expect(transcript.text).toBe('please find my notes from yesterday unconfirmed fragment');
    transcript.update('with the final detail', true);
    expect(transcript.take()).toBe('please find my notes from yesterday with the final detail');
    expect(transcript.text).toBe('');
  });
  it('reconciles cumulative snapshots without repeating speech', () => {
    const stream = new SentenceStream();
    expect(stream.append('Hello')).toEqual([]);
    expect(stream.append('Hello there. More', true)).toEqual(['Hello there.']);
    expect(stream.append('Hello there. More', true)).toEqual([]);
    expect(stream.append('Hello there. More words.', true)).toEqual(['More words.']);
    expect(stream.finish()).toEqual([]);
    expect(stream.append('Changed already spoken words.', true)).toEqual([]);
  });
  it('flushes the final unfinished sentence once', () => {
    const stream = new SentenceStream();
    stream.append('A short'); stream.append(' response');
    expect(stream.finish()).toEqual(['A short response']); expect(stream.finish()).toEqual([]);
  });
  it('streams coherent sentences while preserving split decimals, abbreviations, and closing quotes', () => {
    const stream = new SentenceStream();
    expect(stream.append('Dr. Smith measured 3.')).toEqual([]);
    expect(stream.append('14 particles. She said, “Here is the result.” More')).toEqual(['Dr. Smith measured 3.14 particles.', 'She said, “Here is the result.”']);
    expect(stream.append(' detail follows.')).toEqual(['More detail follows.']);
    expect(stream.finish()).toEqual([]);
  });
  it('starts long unpunctuated passages before completion and preserves all words', () => {
    const stream = new SentenceStream();
    const words = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ');
    const first = stream.append(words);
    expect(first.length).toBeGreaterThan(0); expect(first.every(piece => piece.length <= 280)).toBe(true);
    expect([...first, ...stream.finish()].join(' ')).toBe(words);
    expect(stream.finish()).toEqual([]);
  });
  it('invalidates late playback and transport callbacks after interruption', () => {
    const generation = new Generation(), before = generation.current;
    const after = generation.next();
    expect(generation.is(before)).toBe(false); expect(generation.is(after)).toBe(true);
  });
});
