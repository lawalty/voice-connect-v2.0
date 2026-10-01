import { useAgentName } from './agent-name';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, AudioLines, MessageSquare, Plus } from 'lucide-react';
import type { Message } from '../contract/types';
import { replyPrefix } from './audio/speech-caption';

export default function ConversationLog({ messages, typing, speechReveal, onClose, onNew, creating, automatic, preparing, autoDisabled, onToggleAuto, hasEarlier, loadingEarlier, historyError, onEarlier }: {
  messages: Message[]; typing: boolean; speechReveal: { turnId: string; text: string } | null; onClose(): void; onNew(): void; creating: boolean;
  automatic: boolean; preparing: boolean; autoDisabled: boolean; onToggleAuto(): void;
  hasEarlier?: boolean; loadingEarlier?: boolean; historyError?: string; onEarlier?(): Promise<void>;
}) {
  const agentName = useAgentName();
  const scroll = useRef<HTMLDivElement>(null), follow = useRef(true), back = useRef<HTMLButtonElement>(null);
  const [showLatest, setShowLatest] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)'), change = () => setReducedMotion(media.matches);
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor.current || !scroll.current) return;
    const saved = anchor.current;
    const row = [...scroll.current.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.dataset.messageId === saved.id);
    if (row) scroll.current.scrollTop += row.getBoundingClientRect().top - saved.top;
    if (!loadingEarlier) anchor.current = null;
  }, [messages, loadingEarlier]);
  const earlier = () => {
    const node = scroll.current;
    const row = node && [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.getBoundingClientRect().bottom > node.getBoundingClientRect().top);
    if (row) anchor.current = { id: row.dataset.messageId!, top: row.getBoundingClientRect().top };
    follow.current = false; setShowLatest(true); void onEarlier?.();
  };
  const latestText = messages.at(-1)?.text;
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages.length, latestText, typing, speechReveal?.text, reducedMotion]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  return <section className="messenger-panel" aria-label="Conversation transcript">
    <header className="messenger-header">
      <button ref={back} className="icon-button" onClick={onClose} aria-label="Back to orb" title="Back to orb"><ArrowLeft size={20} /></button>
      <h2>Conversation <span title="Messages loaded">{messages.length}{hasEarlier ? '+' : ''}</span></h2>
      <button className="auto-mode-toggle" role="switch" aria-label="Auto mode" aria-checked={automatic} aria-busy={preparing} disabled={autoDisabled} onClick={onToggleAuto}
        title={automatic ? 'Stop hands-free listening; keep hearing replies' : preparing ? 'Cancel voice startup' : 'Start hands-free voice with silent cues'}><AudioLines size={16} /><span>Auto mode</span><small>{preparing ? 'Starting' : automatic ? 'On' : 'Off'}</small></button>
      <button className="icon-button" onClick={onNew} disabled={creating} aria-label="Start a new conversation" title="New conversation"><Plus size={20} /></button>
    </header>
    <div ref={scroll} className="messenger-messages" role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions text"
      onScroll={() => { const node = scroll.current!; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; setShowLatest(!follow.current); }}>
      {hasEarlier && <button className="text-button history-earlier" disabled={loadingEarlier} onClick={earlier}>{loadingEarlier ? 'Loading earlier messages…' : 'Load earlier messages'}</button>}
      {historyError && <p className="history-error" role="status">{historyError}</p>}
      {messages.length === 0 && !typing ? <div className="messenger-empty"><MessageSquare size={28} strokeWidth={1.25} /><p>Your conversation starts here.</p></div> : messages.map(message =>
        <article className={`message message-${message.role}`} key={message.id} data-message-id={message.id} aria-label={message.role === 'notice' ? 'Voice Connect status' : message.role === 'user' ? 'You' : agentName}>
          <div className="message-bubble">
            {message.attachments?.map(photo => photo.previewUrl && <img className="message-photo" key={photo.id} src={photo.previewUrl} alt="Shared photo" onLoad={() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }} />)}
            {message.text && (speechReveal && message.role === 'assistant' && message.turnId === speechReveal.turnId && !reducedMotion
              ? <p className="reply-revealing"><span aria-hidden="true" className="reply-visible">{replyPrefix(message.text, speechReveal.text)}<span className="reply-caret" /></span><span className="reply-accessible" role="note" aria-label={message.text} /></p>
              : <p>{message.text}</p>)}
          </div>
          <div className="message-meta"><span>{message.role === 'notice' ? 'Voice Connect' : message.role === 'user' ? 'You' : agentName}</span><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div>
          {message.role === 'user' && message.delivery && ['pending', 'uncertain', 'failed', 'cancelled'].includes(message.delivery) && <span className="delivery-status">{message.delivery === 'uncertain' ? 'Delivery uncertain · check before resending' : message.delivery}</span>}
        </article>)}
      {typing && <div className="typing-indicator" role="status" aria-label={`${agentName} is preparing a reply`}><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></div>}
    </div>
    {showLatest && <button className="latest-message-button" onClick={() => { follow.current = true; scroll.current!.scrollTop = scroll.current!.scrollHeight; setShowLatest(false); }}><ArrowDown size={15} />Latest messages</button>}
  </section>;
}
