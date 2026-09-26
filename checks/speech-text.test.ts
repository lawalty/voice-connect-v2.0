import { describe, expect, it } from 'vitest';
import { SentenceStream } from '../client/audio/dsp';
import { speechText } from '../client/audio/speech-text';

describe('speech-only Markdown formatting', () => {
  it('speaks the words inside emphasis without its markers', () => {
    expect(speechText('**Good morning.** This is *important*, __clear__, _calm_, and ~~old~~.'))
      .toBe('Good morning. This is important, clear, calm, and old.');
    expect(speechText('***Very important!***')).toBe('Very important!');
    expect(speechText('## Summary\n> **Air quality**\n- **Good**\n* [x] Checked')).toBe('Summary\nAir quality\nGood\nChecked');
    expect(speechText('***')).toBe('');
    expect(speechText('Before\n***\nAfter')).toBe('Before\n\nAfter');
  });

  it('keeps meaningful numbers, arithmetic, identifiers, code and escaped symbols', () => {
    const text = 'AQI 42, PM2.5 at 3.2, -5°C, $20, 5 * 3, 2**3, file_name.';
    expect(speechText(text)).toBe(text);
    expect(speechText('Use `**kwargs` and `file_name`, or write \\*\\* literally.'))
      .toBe('Use **kwargs and file_name, or write ** literally.');
  });

  it('speaks a bold first sentence before the answer finishes', () => {
    const stream = new SentenceStream();
    expect(stream.append('**The air quality is good.** ')).toEqual(['The air quality is good.']);
    expect(stream.append('I am checking *another source*.')).toEqual(['I am checking another source.']);
    expect(stream.finish()).toEqual([]);
  });

  it('ignores emphasis split at every possible network boundary without replaying words', () => {
    const text = '**A complete first sentence.**\n**A complete second sentence.**';
    for (let cut = 0; cut <= text.length; cut++) {
      const stream = new SentenceStream();
      const chunks = [...stream.append(text.slice(0, cut)), ...stream.append(text.slice(cut)), ...stream.finish()];
      expect(chunks.join(' '), `split at ${cut}`).toBe('A complete first sentence. A complete second sentence.');
      expect(chunks.join(' ')).not.toContain('*');
    }
    const stream = new SentenceStream();
    expect([...Array.from(text).flatMap(character => stream.append(character)), ...stream.finish()].join(' '))
      .toBe('A complete first sentence. A complete second sentence.');
  });

  it('keeps raw offsets for cumulative Markdown snapshots and tail corrections', () => {
    const stream = new SentenceStream();
    const original = '**First sentence.** **Unfinished';
    expect(stream.append(original, true)).toEqual(['First sentence.']);
    expect(stream.append(original, true)).toEqual([]);
    expect(stream.append('**First sentence.** **Corrected tail.**', true)).toEqual(['Corrected tail.']);
    expect(stream.finish()).toEqual([]);
    stream.reset();
    expect(stream.append('**A fresh reply.**')).toEqual(['A fresh reply.']);
  });

  it('keeps emphasized abbreviations together and strips markers across long speech chunks', () => {
    const stream = new SentenceStream();
    expect(stream.append('**Dr. Smith measured 3.')).toEqual([]);
    expect(stream.append('14 particles.**')).toEqual(['Dr. Smith measured 3.14 particles.']);
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
    const chunks = [...stream.append(`**${words}**`), ...stream.finish()];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toBe(words);
  });
});
