import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, MessageSquare, Plus } from 'lucide-react';
import type { Message } from '../contract/types';

export default function ConversationLog({ messages, activity, onClose, onNew, creating }: {
  messages: Message[]; activity: string; onClose(): void; onNew(): void; creating: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null), follow = useRef(true), back = useRef<HTMLButtonElement>(null);
  const [showLatest, setShowLatest] = useState(false);
  const latestText = messages.at(-1)?.text;
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages.length, latestText, activity]);
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
      <h2>Conversation <span>{messages.length}</span></h2>
      <button className="icon-button" onClick={onNew} disabled={creating} aria-label="Start a new conversation" title="New conversation"><Plus size={20} /></button>
    </header>
    <div ref={scroll} className="messenger-messages" role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions text"
      onScroll={() => { const node = scroll.current!; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; setShowLatest(!follow.current); }}>
      {messages.length === 0 ? <div className="messenger-empty"><MessageSquare size={28} strokeWidth={1.25} /><p>Your conversation starts here.</p></div> : messages.map(message =>
        <article className={`message message-${message.role}`} key={message.id} aria-label={message.role === 'user' ? 'You' : 'NorthPointe'}>
          <div className="message-bubble">
            {message.attachments?.map(photo => photo.previewUrl && <img className="message-photo" key={photo.id} src={photo.previewUrl} alt={photo.name || 'Shared photo'} />)}
            {message.text && <p>{message.text}</p>}
          </div>
          <div className="message-meta"><span>{message.role === 'user' ? 'You' : 'NorthPointe'}</span><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div>
          {message.role === 'user' && message.delivery && ['pending', 'uncertain', 'failed', 'cancelled'].includes(message.delivery) && <span className="delivery-status">{message.delivery === 'uncertain' ? 'Delivery uncertain · check before resending' : message.delivery}</span>}
        </article>)}
      {activity && <div className="activity"><span className="activity-pulse" />{activity}</div>}
    </div>
    {showLatest && <button className="latest-message-button" onClick={() => { follow.current = true; scroll.current!.scrollTop = scroll.current!.scrollHeight; setShowLatest(false); }}><ArrowDown size={15} />Latest messages</button>}
  </section>;
}
