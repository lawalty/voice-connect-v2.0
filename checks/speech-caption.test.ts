import { describe, expect, it } from 'vitest';
import { SpeechCaptionTimeline, replyPrefix } from '../client/audio/speech-caption';
import { speechAlignment, type SpeechAlignment } from '../contract/speech-alignment';

const first: SpeechAlignment = { chunk: 0, offset: 0, content: 'Hello there.', duration: 1,
  words: [{ text: 'Hello', start: .1, end: .4 }, { text: 'there', start: .5, end: .9 }] };
describe('spoken reply presentation', () => {
  it('uses word starts on the PCM clock, replaces snapshots, and never rewinds corrections', () => {
    const line = new SpeechCaptionTimeline(); line.append('Hello there.'); line.update(first);
    expect(line.sample(0)).toBeUndefined(); expect(line.sample(.1)).toBe('Hello');
    line.update({ ...first, words: first.words.map(word => ({ ...word, start: word.start + .2, end: word.end + .2 })) });
    expect(line.sample(.2)).toBeUndefined(); expect(line.sample(.6)).toBeUndefined(); expect(line.sample(.7)).toBe('Hello there');
    line.update(first); expect(line.sample(.8)).toBeUndefined();
  });
  it('maps repeated words across chunk boundaries and retains delivery-independent source text', () => {
    const line = new SpeechCaptionTimeline(); line.append('Hello there.'); line.append('Hello again.');
    line.update(first); line.update({ chunk: 1, offset: 2, content: 'Hello again.', duration: 1,
      words: [{ text: 'Hello', start: .1, end: .4 }, { text: 'again', start: .5, end: .9 }] });
    expect(line.sample(.5)).toBe('Hello there'); expect(line.sample(1.9)).toBeUndefined();
    expect(line.sample(2.1)).toBe('Hello there. Hello'); expect(line.sample(2.5)).toBe('Hello there. Hello again');
  });
  it('does not invent alignment for verbalized numbers and makes the completed chunk readable', () => {
    const line = new SpeechCaptionTimeline(); line.append('25.'); line.update({ chunk: 0, offset: 0, content: '25.', duration: 1, words: [{ text: 'twenty five', start: 0, end: .7 }] });
    expect(line.sample(.8)).toBeUndefined(); line.finish(); expect(line.sample(1)).toBe('25');
  });
  it('preserves raw Markdown and releases corrected text instead of revealing the wrong words', () => {
    expect(replyPrefix('**Hello there.** Next sentence.', 'Hello')).toBe('**Hello');
    expect(replyPrefix('**Hello there.** Next sentence.', 'Hello there')).toBe('**Hello there.**');
    expect(replyPrefix('### Here\n- **Your** next step', 'Here Your')).toBe('### Here\n- **Your**');
    expect(replyPrefix('A corrected answer.', 'The original')).toBe('A corrected answer.');
    expect(replyPrefix('Hello', '')).toBe('');
  });
  it('rejects unbounded or invalid provider metadata, including NaN and backwards words', () => {
    const raw = { chunk_seq: 0, chunk_audio_offset_sec: 0, content: first.content, alignment: { segments: first.words, audio_duration: 1 } };
    expect(speechAlignment(raw)).toEqual(first);
    expect(speechAlignment({ ...raw, alignment: null })).toBeUndefined();
    expect(speechAlignment({ ...raw, chunk_audio_offset_sec: NaN })).toBeUndefined();
    expect(speechAlignment({ ...raw, alignment: { audio_duration: 1, segments: [{ text: 'Hello', start: .9, end: .1 }] } })).toBeUndefined();
  });
});
