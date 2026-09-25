import { describe, expect, it } from 'vitest';
import { restoreSpeechPreferences, selectRecognizer } from '../client/speech-preferences';

describe('device speech preference compatibility', () => {
  it('starts new or malformed devices with local automatic turns and browser output', () => {
    for (const value of [null, '{broken', 'null', '[]']) {
      expect(restoreSpeechPreferences(value)).toMatchObject({ recognition: 'vosk', handsFree: true, turnMode: 'automatic', output: 'browser' });
    }
  });
  it('keeps legacy browser selection but enables automatic turns when the user selects local speech', () => {
    const legacy = restoreSpeechPreferences(JSON.stringify({ recognition: 'browser', handsFree: false, browserVoice: 'saved-voice' }));
    expect(legacy).toMatchObject({ recognition: 'browser', handsFree: false, browserVoice: 'saved-voice' });
    expect(selectRecognizer(legacy, 'vosk')).toMatchObject({ recognition: 'vosk', handsFree: true });
  });
  it('preserves an existing local or premium manual-turn choice across recognizer switches', () => {
    for (const recognition of ['vosk', 'deepgram']) {
      const saved = restoreSpeechPreferences(JSON.stringify({ recognition, handsFree: false }));
      expect(saved).toMatchObject({ recognition, handsFree: false, turnMode: 'manual' });
      expect(selectRecognizer(selectRecognizer(saved, 'browser'), 'deepgram')).toMatchObject({ handsFree: false, turnMode: 'manual' });
    }
  });
  it('retains explicit premium selections without opting fresh devices into paid services', () => {
    expect(restoreSpeechPreferences(JSON.stringify({ recognition: 'deepgram', output: 'deepgram', handsFree: true, premiumVoice: 'saved-premium', keepAwake: false }))).toMatchObject({ recognition: 'deepgram', output: 'deepgram', handsFree: true, premiumVoice: 'saved-premium', keepAwake: false });
    expect(restoreSpeechPreferences(null)).toMatchObject({ recognition: 'vosk', output: 'browser' });
  });
  it('never advertises browser fallback as automatic even with an old true setting', () => {
    expect(restoreSpeechPreferences(JSON.stringify({ recognition: 'browser', handsFree: true }))).toMatchObject({ recognition: 'browser', handsFree: false });
    expect(selectRecognizer(restoreSpeechPreferences(null), 'browser').handsFree).toBe(false);
  });
  it('preserves an explicitly selected Fish voice without changing recognition or opting other devices into Fish', () => {
    expect(restoreSpeechPreferences(JSON.stringify({recognition:'vosk',output:'fish',fishVoice:'my-voice-id',handsFree:true})))
      .toMatchObject({recognition:'vosk',output:'fish',fishVoice:'my-voice-id',handsFree:true});
    expect(restoreSpeechPreferences(null).output).toBe('browser');
  });
});
