import { describe, expect, it } from 'vitest';
import { VoiceMessageDraft } from '../client/voice-message-draft';

describe('one Messenger message with typed and recognized words', () => {
  it('replaces provisional hypotheses instead of appending duplicates', () => {
    const draft = new VoiceMessageDraft('');
    expect(draft.recognize('I went too')).toBe('I went too');
    expect(draft.recognize('I went to the park.')).toBe('I went to the park.');
    expect(draft.recognize('I went to the park.')).toBe('I went to the park.');
  });
  it('combines an existing typed draft with a complete spoken turn once', () => {
    const draft = new VoiceMessageDraft('Please remember this:');
    draft.recognize('bring');
    expect(draft.recognize('bring the blue notebook.')).toBe('Please remember this:\nbring the blue notebook.');
  });
  it('preserves typing after a live hypothesis while recognition corrects and extends it', () => {
    const draft = new VoiceMessageDraft('');
    draft.recognize('Take the read');
    draft.edit('Take the read and my keys.');
    expect(draft.recognize('Take the red bag')).toBe('Take the red bag and my keys.');
  });
  it('preserves typed corrections when recognition adds the rest of the sentence', () => {
    const draft = new VoiceMessageDraft('');
    draft.recognize('Hello Jon'); draft.edit('Hello John');
    expect(draft.recognize('Hello Jon, how are you?')).toBe('Hello John, how are you?');
  });
  it('keeps inserted words when the recognizer replaces the entire hypothesis', () => {
    const draft = new VoiceMessageDraft('');
    draft.recognize('cats'); draft.edit('cats and dogs');
    expect(draft.recognize('Birds')).toBe('Birds and dogs');
  });
  it('does not restore words the user removed when the unchanged final result arrives', () => {
    const draft = new VoiceMessageDraft('');
    draft.recognize('Do not send this'); draft.edit('');
    expect(draft.recognize('Do not send this')).toBe('');
  });
});
