import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Send, X } from 'lucide-react';
import type { Attachment } from '../contract/types';
import { api } from './api';
import { clipboardMessage, pastedContent, validateClipboard, type ClipboardContent } from './clipboard';
import Dialog from './Dialog';

export interface ClipboardShareHandle { send(): Promise<void>; }
export interface ClipboardShareState { ready: boolean; locked: boolean; }

export default function ClipboardShare({ source, inline, composerCaption, onCaption, canSend, imagesAllowed, voicePaused, onClose, onSend, onState, ref }: {
  source: Promise<ClipboardContent>;
  inline: boolean;
  composerCaption?: string;
  onCaption(value: string): void;
  canSend: boolean;
  imagesAllowed: boolean;
  voicePaused: boolean;
  onClose(): void;
  onSend(photo: Attachment | undefined, text: string, turnId: string): Promise<void>;
  onState(state: ClipboardShareState): void;
  ref?: Ref<ClipboardShareHandle>;
}) {
  const [content, setContent] = useState<ClipboardContent | null>(null), [preview, setPreview] = useState('');
  const [caption, setCaption] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [fallbackText, setFallbackText] = useState('');
  const [busy, setBusy] = useState(false), [attempted, setAttempted] = useState(false);
  const uploaded = useRef<Attachment | undefined>(undefined), submission = useRef<{ id: string; text: string } | null>(null), sending = useRef(false);
  const loadEpoch = useRef(0);
  const currentCaption = composerCaption ?? caption;
  const ready = Boolean(content && !loading && (content.kind !== 'image' || imagesAllowed));
  useEffect(() => { onState({ ready, locked: busy || attempted }); }, [ready, busy, attempted, onState]);
  async function load(input: Promise<ClipboardContent>) {
    const epoch = ++loadEpoch.current; setLoading(true); setError('');
    try { const value = await validateClipboard(await input); if (epoch === loadEpoch.current) setContent(value); }
    catch (reason) {
      if (epoch === loadEpoch.current) setError(reason instanceof DOMException && reason.name === 'NotAllowedError'
        ? 'Clipboard access was not allowed. Paste into the field below instead.'
        : reason instanceof Error ? reason.message : 'Clipboard access failed. Paste below instead.');
    } finally { if (epoch === loadEpoch.current) setLoading(false); }
  }
  useEffect(() => { void load(source); return () => { ++loadEpoch.current; }; }, [source]);
  useEffect(() => {
    if (content?.kind !== 'image') { setPreview(''); return; }
    const url = URL.createObjectURL(content.blob); setPreview(url); return () => URL.revokeObjectURL(url);
  }, [content]);
  async function send() {
    if (!content || !ready || sending.current || !canSend) return;
    sending.current = true; setBusy(true); setError('');
    try {
      const text = submission.current?.text ?? clipboardMessage(content, currentCaption);
      if (content.kind === 'image' && !uploaded.current) {
        const data = new FormData();
        const extension = content.blob.type === 'image/png' ? 'png' : content.blob.type === 'image/webp' ? 'webp' : 'jpg';
        data.append('image', content.blob, `clipboard.${extension}`);
        uploaded.current = await api<Attachment>('/api/uploads', { method: 'POST', body: data });
      }
      // An uncertain retry must retain the exact payload and turn ID.
      submission.current ??= { id: crypto.randomUUID(), text };
      setAttempted(true);
      await onSend(uploaded.current, submission.current.text, submission.current.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'This message could not be sent.'); }
    finally { sending.current = false; setBusy(false); }
  }
  useImperativeHandle(ref, () => ({ send }));
  const body = <>
    {!inline && <p className="muted dialog-intro">{voicePaused ? 'Listening is paused while you review and caption your clipboard.' : 'Review your clipboard and add an optional caption.'}</p>}
    {loading && <p role="status" className="muted">Reading clipboard…</p>}
    {content?.kind === 'image' && <div className={inline ? 'clipboard-thumbnail' : 'camera-preview'}>{preview && <img src={preview} alt="Clipboard image to send" />}</div>}
    {content?.kind === 'text' && <div className="clipboard-text" aria-label="Copied text">{content.text}</div>}
    {!content && <><label className="camera-caption">Paste here<textarea rows={3} value={fallbackText} placeholder="Press Ctrl+V, or touch and hold to paste" onPaste={event => {
      event.preventDefault();
      try { void load(Promise.resolve(pastedContent(event.clipboardData))); } catch (reason) { setError((reason as Error).message); }
    }} onChange={event => setFallbackText(event.target.value)} /></label>{fallbackText.trim() && <button className="button secondary" onClick={() => void load(Promise.resolve({ kind: 'text', text: fallbackText }))}>Preview text</button>}</>}
    {content && !inline && <label className="camera-caption">Caption (optional)<textarea rows={3} maxLength={20000} value={currentCaption} disabled={busy || attempted} placeholder="What would you like NorthPointe to know?" onChange={event => composerCaption === undefined ? setCaption(event.target.value) : onCaption(event.target.value)} /></label>}
    {content?.kind === 'image' && !imagesAllowed && <p role="alert" className="error-text">Image input is unavailable for this connection.</p>}
    {error && <p role="alert" className="error-text">{error}</p>}
    {!canSend && content && <p role="status" className="muted">Waiting for the conversation to reconnect. Your clipboard is kept here.</p>}
    {inline ? <div className="clipboard-inline-actions"><span className="muted">{attempted ? 'Delivery needs checking. Send again to check the same message.' : voicePaused ? 'Listening paused · add a caption below, then send.' : 'Add a caption below, then send.'}</span><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Remove clipboard image"><X size={18} /></button></div>
      : <><div className="dialog-actions"><button className="button primary" onClick={() => void send()} disabled={!ready || busy || !canSend}><Send size={17} />{busy ? 'Sending…' : attempted ? 'Check delivery' : 'Send clipboard'}</button></div><p className="fine-print">{attempted ? 'If delivery is uncertain, check it here or review the conversation before sending again.' : 'Your clipboard stays on this device until you send it.'}</p></>}
  </>;
  return inline ? <section className="clipboard-inline" aria-label="Clipboard attachment">{body}</section>
    : <Dialog title="Share from clipboard" onClose={onClose} closeDisabled={busy}>{body}</Dialog>;
}
