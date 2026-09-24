import { useEffect, useRef, useState } from 'react';
import { Camera as CameraIcon, RotateCcw, Upload } from 'lucide-react';
import type { Attachment } from '../contract/types';
import { api } from './api';
import Dialog from './Dialog';

export default function Camera({ onClose, onAttach }: { onClose: () => void; onAttach: (attachment: Attachment) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<Blob | null>(null);
  const [preview, setPreview] = useState('');
  useEffect(() => {
    let alive = true;
    if (!navigator.mediaDevices?.getUserMedia) { setError('Camera access requires a supported browser and a secure connection.'); return; }
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false }).then(async media => {
      if (!alive) { media.getTracks().forEach(track => track.stop()); return; }
      stream.current = media;
      if (video.current) { video.current.srcObject = media; await video.current.play(); setReady(true); }
    }).catch(() => { if (alive) setError('The camera could not open. Check camera permission, then try again.'); });
    return () => { alive = false; stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; };
  }, []);
  useEffect(() => { if (!shot) { setPreview(''); return; } const url = URL.createObjectURL(shot); setPreview(url); return () => URL.revokeObjectURL(url); }, [shot]);
  async function capture() {
    const source = video.current;
    if (!source?.videoWidth) return;
    const canvas = document.createElement('canvas'); const ratio = Math.min(1, 1280 / Math.max(source.videoWidth, source.videoHeight));
    canvas.width = Math.round(source.videoWidth * ratio); canvas.height = Math.round(source.videoHeight * ratio);
    canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
    for (const quality of [.84, .68, .5, .35]) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size < 1024 * 1024) { setShot(blob); return; }
    }
    setError('This image is too large. Try a less detailed view.');
  }
  async function attach() {
    if (!shot) return; setBusy(true); setError('');
    try { const data = new FormData(); data.append('image', shot, 'camera.jpg'); const attachment = await api<Attachment>('/api/uploads', { method: 'POST', body: data }); onAttach(attachment); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The image could not be uploaded.'); }
    finally { setBusy(false); }
  }
  return <Dialog title="Share a moment" onClose={onClose}><p className="muted dialog-intro">Take one photo for your next message. The camera feed stays on this device.</p><div className="camera-preview"><video ref={video} muted playsInline className={shot ? 'hidden' : ''} />{preview && <img src={preview} alt="Photo to attach to your next message" />}{!ready && !error && <span>Opening camera…</span>}</div>{error && <p role="alert" className="error-text">{error}</p>}<div className="dialog-actions">{shot ? <><button className="button secondary" onClick={() => setShot(null)} disabled={busy}><RotateCcw size={17} />Retake</button><button className="button primary" onClick={() => void attach()} disabled={busy}><Upload size={17} />{busy ? 'Attaching…' : 'Attach photo'}</button></> : <button className="button primary" onClick={() => void capture()} disabled={!ready}><CameraIcon size={18} />Take photo</button>}</div><p className="fine-print">Closing this window stops the camera. A photo is sent to NorthPointe only when you send your message.</p></Dialog>;
}
