import { DEFAULT_SPEECH, type RecognizerKind, type SpeechPreferences } from '../contract/types';

export function restoreSpeechPreferences(raw: string | null): SpeechPreferences {
  try {
    const saved = JSON.parse(raw || '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { ...DEFAULT_SPEECH };
    const recognition: RecognizerKind = ['browser', 'vosk', 'deepgram'].includes(saved.recognition) ? saved.recognition : DEFAULT_SPEECH.recognition;
    // Older browser defaults cannot prove a manual opt-out for a continuous recognizer.
    // An existing local/premium manual choice, however, must remain manual.
    const turnMode = saved.turnMode === 'manual' || saved.turnMode === 'automatic' ? saved.turnMode
      : recognition !== 'browser' && saved.handsFree === false ? 'manual' : 'automatic';
    return {
      ...DEFAULT_SPEECH,
      recognition,
      // A retired Deepgram voice never opts the owner into paid Fish processing.
      output: ['browser', 'fish'].includes(saved.output) ? saved.output : DEFAULT_SPEECH.output,
      browserVoice: typeof saved.browserVoice === 'string' ? saved.browserVoice : DEFAULT_SPEECH.browserVoice,
      fishVoice: typeof saved.fishVoice === 'string' ? saved.fishVoice : '',
      keepAwake: typeof saved.keepAwake === 'boolean' ? saved.keepAwake : DEFAULT_SPEECH.keepAwake,
      handsFree: recognition !== 'browser' && (typeof saved.handsFree === 'boolean' ? saved.handsFree : turnMode !== 'manual'),
      turnMode,
    };
  } catch { return { ...DEFAULT_SPEECH }; }
}

export function selectRecognizer(prefs: SpeechPreferences, recognition: RecognizerKind): SpeechPreferences {
  return { ...prefs, recognition, handsFree: recognition !== 'browser' && prefs.turnMode !== 'manual' };
}
