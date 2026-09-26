import { useEffect, useRef, useState } from 'react';
import { Camera as CameraIcon, RotateCcw, Send } from 'lucide-react';
import type { Attachment } from '../contract/types';
import { api } from './api';
import Dialog from './Dialog';

export default function Camera({ onClose, onSend, voicePaused, canSend }: {
  onClose(): void;
  onSend(photo: Attachment, caption: string, turnId: string): Promise<void>;
  voicePaused: boolean;
  canSend: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null), stream = useRef<MediaStream | null>(null);
  const [error, setError] = useState(''), [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<Blob | null>(null), [preview, setPreview] = useState(''), [caption, setCaption] = useState('');
  const [attempted, setAttempted] = useState(false);
  const uploaded = useRef<Attachment | null>(null), submission = useRef<{ id: string; caption: string } | null>(null), sending = useRef(false);
  useEffect(() => {
    let alive = true;
    if (!navigator.mediaDevices?.getUserMedia) { setError('Camera access requires a supported browser and a secure connection.'); return; }
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false }).then(async media => {
      if (!alive) { media.getTracks().forEach(track => track.stop()); return; }
      stream.current = media;
      if (video.current) { video.current.srcObject = media; await video.current.play(); if (alive) setReady(true); }
    }).catch(() => { if (alive) setError('The camera could not open. Check camera permission, then try again.'); });
    return () => { alive = false; stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; };
  }, []);
  useEffect(() => { if (!shot) { setPreview(''); return; } const url = URL.createObjectURL(shot); setPreview(url); return () => URL.revokeObjectURL(url); }, [shot]);
  async function capture() {
    const source = video.current;
    if (!source?.videoWidth) return;
    setError('');
    const canvas = document.createElement('canvas'), ratio = Math.min(1, 1280 / Math.max(source.videoWidth, source.videoHeight));
    canvas.width = Math.round(source.videoWidth * ratio); canvas.height = Math.round(source.videoHeight * ratio);
    canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
    for (const quality of [.84, .68, .5, .35]) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size < 1024 * 1024) { setShot(blob); return; }
    }
    setError('This image is too large. Try a less detailed view.');
  }
  async function send() {
    if (!shot || sending.current || !canSend) return;
    sending.current = true; setBusy(true); setError('');
    try {
      if (!uploaded.current) {
        const data = new FormData(); data.append('image', shot, 'camera.jpg');
        uploaded.current = await api<Attachment>('/api/uploads', { method: 'POST', body: data });
      }
      // A retry keeps the same turn and caption, even if its acknowledgement was lost.
      submission.current ??= { id: crypto.randomUUID(), caption: caption.trim() };
      setAttempted(true);
      await onSend(uploaded.current, submission.current.caption, submission.current.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The photo could not be sent.'); }
    finally { sending.current = false; setBusy(false); }
  }
  return <Dialog title="Share a moment" onClose={onClose} closeDisabled={busy}>
    <p className="muted dialog-intro">{voicePaused ? 'Listening is paused while you take and caption your photo.' : 'Take a photo and add an optional caption.'}</p>
    <div className="camera-preview"><video ref={video} muted playsInline className={shot ? 'hidden' : ''} />{preview && <img src={preview} alt="Photo to send" />}{!ready && !error && <span>Opening camera…</span>}</div>
    {shot && <label className="camera-caption">Caption (optional)<textarea rows={3} maxLength={20000} placeholder="What would you like NorthPointe to know?" value={caption} disabled={busy || attempted} onChange={event => setCaption(event.target.value)} /></label>}
    {error && <p role="alert" className="error-text">{error}</p>}
    {!canSend && !busy && shot && <p role="status" className="muted">Waiting for the conversation to reconnect. Your photo and caption are kept here.</p>}
    <div className="dialog-actions">{shot ? <>
      <button className="button secondary" onClick={() => { setShot(null); uploaded.current = null; setError(''); }} disabled={busy || attempted}><RotateCcw size={17} />Retake</button>
      <button className="button primary" onClick={() => void send()} disabled={busy || !canSend}><Send size={17} />{busy ? 'Sending…' : attempted ? 'Check delivery' : 'Send photo'}</button>
    </> : <button className="button primary" onClick={() => void capture()} disabled={!ready}><CameraIcon size={18} />Take photo</button>}</div>
    <p className="fine-print">{attempted ? 'If delivery is uncertain, check it here or review the conversation before sending another photo.' : 'Your photo stays on this device until you send it.'}</p>
  </Dialog>;
}
