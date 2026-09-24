import { useEffect, useState } from 'react';
import { Check, Download, Mic, ShieldCheck } from 'lucide-react';
import { downloadModel, modelStatus } from './audio/model';
import Dialog from './Dialog';

export default function VoiceSetup({ automatic, onStart, onFallback, onClose }: { automatic: boolean; onStart: () => void; onFallback: () => void; onClose: () => void }) {
  const [installed, setInstalled] = useState(false), [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(0), [error, setError] = useState('');
  const browserAvailable = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
  useEffect(() => { let current = true; void modelStatus().then(value => { if (current) setInstalled(value.installed); }).catch(() => { if (current) setError('Local storage is unavailable. Check your browser settings or choose another voice option.'); }).finally(() => { if (current) setChecking(false); }); return () => { current = false; }; }, []);
  async function download() {
    setBusy(true); setError('');
    try { await downloadModel(value => setProgress(value.percent)); setInstalled(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The model could not be downloaded. Please try again.'); }
    finally { setBusy(false); }
  }
  return <Dialog title={automatic ? "A conversation that keeps listening" : "Set up local voice"} onClose={onClose}><div className="voice-setup"><span className="voice-setup-icon"><Mic size={27} strokeWidth={1.5} /></span><p>{automatic ? 'Start once, speak naturally, and pause to send your thought. NorthPointe replies, then the conversation listens again.' : 'Speak at your own pace and use Finish to send each thought. Your manual-turn preference stays selected.'}</p><div className="setup-model"><ShieldCheck size={21} /><div><strong>{installed ? 'Local English recognition is ready' : 'One download for this device'}</strong><p>{installed ? 'You choose when the microphone starts.' : 'About 40 MB. Speech recognition stays on this device. Downloading does not open your microphone.'}</p></div></div><p className="setting-detail">Keep this page open while talking. Finish is always available to send a thought yourself. NorthPointe needs a network connection.</p>{busy && <div className="setup-progress" role="status"><span>Downloading English model · {Math.round(progress)}%</span><progress max={100} value={progress} aria-label="Model download" /></div>}{error && <p className="error-text" role="alert">{error}</p>}<button className="button primary full-width" disabled={checking || busy} onClick={() => installed ? onStart() : void download()}>{installed ? <><Check size={18} />Start talking</> : <><Download size={18} />{checking ? 'Checking this device…' : busy ? 'Downloading…' : 'Download English model · 40 MB'}</>}</button>{browserAvailable && <button className="text-button setup-fallback" disabled={busy} onClick={onFallback}>Use browser tap-to-talk instead</button>}<p className="setup-footnote">You can keep typing in this same conversation.</p></div></Dialog>;
}
