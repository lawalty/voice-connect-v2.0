import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Square, Volume2, VolumeX } from 'lucide-react';
import type { SpeechOutput, SpeechPreferences } from '../contract/types';
import { BrowserOutput, PremiumOutput, type OutputEvents } from './audio/output';
import './SpeechOutputCheck.css';

export interface SpeakerCheckResult {
  phase: 'idle' | 'requested' | 'playing' | 'ended' | 'stopped' | 'error';
  started: boolean;
  ended: boolean;
  heard: 'unconfirmed' | 'heard' | 'not-heard';
  provider: string;
  voice: string;
  error?: string;
}
const SAMPLE = 'This is Voice Connect. If you can hear this sentence, your speaker test is working.';
const REPORTS: Record<SpeakerCheckResult['phase'], string> = {
  idle: 'Not tested in this Settings session', requested: 'Playback requested; waiting for output',
  playing: 'The player reported playback starting', ended: 'The player reported playback ending',
  stopped: 'Test stopped', error: 'Speech output reported a problem',
};
function initialResult(provider: string, voice: string): SpeakerCheckResult {
  return { phase: 'idle', started: false, ended: false, heard: 'unconfirmed', provider, voice };
}

export default function SpeechOutputCheck({ preferences, voices, conversationId, deepgramConfigured, fishConfigured, onResult }: {
  preferences: SpeechPreferences; voices: SpeechSynthesisVoice[]; conversationId: string;
  deepgramConfigured: boolean; fishConfigured: boolean; onResult: (result: SpeakerCheckResult) => void;
}) {
  const provider = preferences.output === 'browser' ? 'Device voices' : preferences.output === 'fish' ? 'Fish Audio' : 'Deepgram';
  const fishVoice = (preferences.fishVoice || '').trim();
  const savedVoice = voices.find(voice => voice.voiceURI === preferences.browserVoice || voice.name === preferences.browserVoice);
  const voice = preferences.output === 'browser' ? (preferences.browserVoice ? savedVoice ? `${savedVoice.name} · ${savedVoice.lang}` : 'Saved voice is not yet listed' : 'Automatic · local English preferred')
    : preferences.output === 'fish' ? fishVoice || 'No voice ID entered' : preferences.premiumVoice;
  const [result, setResult] = useState(() => initialResult(provider, voice));
  const snapshot = useRef(result), generation = useRef(0), output = useRef<SpeechOutput | null>(null), context = useRef<AudioContext | null>(null);
  const premium = preferences.output !== 'browser';
  const available = premium ? typeof window.AudioContext === 'function' : typeof window.speechSynthesis === 'object' && typeof window.SpeechSynthesisUtterance === 'function';
  const configured = preferences.output === 'browser' || (preferences.output === 'fish' ? fishConfigured : deepgramConfigured);
  const validVoice = preferences.output !== 'fish' || /^[a-zA-Z0-9_-]{1,128}$/.test(fishVoice);
  const busy = result.phase === 'requested' || result.phase === 'playing';
  const update = useCallback((change: (previous: SpeakerCheckResult) => SpeakerCheckResult) => {
    const next = change(snapshot.current); snapshot.current = next; setResult(next); onResult(next);
  }, [onResult]);
  const release = useCallback(() => {
    ++generation.current;
    output.current?.dispose(); output.current = null;
    const oldContext = context.current; context.current = null;
    if (oldContext) void oldContext.close().catch(() => {});
  }, []);
  useEffect(() => {
    release(); update(() => initialResult(provider, voice));
    return release;
    // Inventory updates must not erase a listening confirmation for the completed test.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferences.output, preferences.browserVoice, preferences.premiumVoice, preferences.fishVoice, release, update]);

  function stop() { release(); update(previous => ({ ...previous, phase: previous.phase === 'error' ? 'error' : 'stopped' })); }
  function start() {
    if (!available || !configured || !validVoice || (premium && !conversationId)) return;
    release(); const attempt = generation.current;
    update(() => ({ ...initialResult(provider, voice), phase: 'requested' }));
    const current = () => generation.current === attempt;
    const events: OutputEvents = {
      started: () => { if (current()) update(previous => ({ ...previous, phase: previous.phase === 'error' ? 'error' : 'playing', started: true })); },
      ended: () => { if (current()) update(previous => ({ ...previous, phase: previous.phase === 'error' ? 'error' : 'ended', ended: previous.phase === 'error' ? previous.ended : true })); },
      error: message => { if (current()) update(previous => ({ ...previous, phase: 'error', error: message.slice(0, 500) })); },
    };
    try {
      if (preferences.output === 'browser') output.current = new BrowserOutput(preferences, events);
      else {
        const audio = context.current = new AudioContext({ latencyHint: 'interactive' });
        void audio.resume().catch(() => events.error('The browser could not activate speaker output. Tap Test speaker to retry.'));
        output.current = new PremiumOutput(audio, conversationId, preferences.output === 'fish' ? fishVoice : preferences.premiumVoice, events, preferences.output);
      }
      // Stay in the original tap event so Android can grant playback activation.
      output.current.enqueue(SAMPLE); output.current.finish();
    } catch { release(); update(previous => ({ ...previous, phase: 'error', error: 'Speech output could not be started on this browser. Check your voice selection and try again.' })); }
  }
  function confirm(heard: SpeakerCheckResult['heard']) {
    if (heard === 'not-heard' && busy) stop();
    update(previous => ({ ...previous, heard }));
  }
  return <section className="speaker-check" aria-label="Speaker check"><div className="speaker-check-heading"><Volume2 size={19} /><div><h4>Check your speaker</h4><p>A short, fixed sentence. No microphone or conversation request.</p></div></div><div className="speaker-check-actions"><button type="button" className="button secondary small" onClick={start} disabled={busy || !available || !configured || !validVoice || (premium && !conversationId)}><Volume2 size={16} />Test speaker</button>{busy && <button type="button" className="button secondary small" onClick={stop}><Square size={14} />Stop test</button>}</div><p className="setting-detail">{premium ? `This test sends only the sample sentence to ${provider}. Provider usage may incur charges.` : 'Uses your selected device voice. Some browser voices use online processing.'}</p>{!available && <p className="error-text">This browser does not expose the required speech output API.</p>}{!configured && <p className="setting-detail">Save a {provider} API key below before testing this provider.</p>}{!validVoice && <p className="setting-detail">Enter a valid Fish Audio voice ID before testing.</p>}{preferences.output === 'browser' && voices.length === 0 && <p className="setting-detail">The browser has not listed its voices yet. You can still test its default voice; available voices will appear above when reported.</p>}<div className="speaker-report" role="status" aria-live="polite"><strong>Playback report</strong><p>{REPORTS[result.phase]}</p>{result.error && <p className="error-text">{result.error}</p>}</div><p className="speaker-check-caution">Playback reports cannot prove sound was audible. Did you hear the sample?</p><div className="speaker-confirmation"><button type="button" className="button secondary small" disabled={result.phase === 'idle'} aria-pressed={result.heard === 'heard'} onClick={() => confirm('heard')}><Check size={15} />I heard it</button><button type="button" className="button secondary small" disabled={result.phase === 'idle'} aria-pressed={result.heard === 'not-heard'} onClick={() => confirm('not-heard')}><VolumeX size={15} />No sound</button></div><p className="speaker-confirmation-result">{result.heard === 'heard' ? 'You confirmed the sample was audible.' : result.heard === 'not-heard' ? 'You reported no sound. Check media volume, the selected speaker or Bluetooth route, and the installed system voice; then test again.' : 'Audibility has not been confirmed.'}</p></section>;
}
