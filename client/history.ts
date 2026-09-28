import type { ConversationView, Message } from '../contract/types';

/** Durable rows replace matching local placeholders, but never replay speech. */
export function mergeOlderMessages(older: Message[], current: Message[]): Message[] {
  const currentIds = new Set(current.map(m => m.id));
  const local = (m: Message) => m.id === m.turnId || m.id === `assistant-${m.turnId}`;
  const currentTurns = new Set(current.filter(m => m.turnId).map(m => `${m.role}:${m.turnId}`));
  const localTurns = new Set(current.filter(m => m.turnId && local(m)).map(m => `${m.role}:${m.turnId}`));
  // A run can persist multiple assistant rows. Turn identity only replaces a
  // local placeholder; distinct native transcript rows must remain distinct.
  return [...older.filter(m => !currentIds.has(m.id) && !(m.turnId && (local(m) ? currentTurns : localTurns).has(`${m.role}:${m.turnId}`))), ...current].sort((a, b) => a.createdAt - b.createdAt);
}

export function reconcileMessages(current: Message[], view: ConversationView, keepEarlier: boolean): Message[] {
  const earlier = keepEarlier && view.history?.start !== undefined ? current.filter(m => m.createdAt < view.history!.start!) : [];
  const incoming = mergeOlderMessages(earlier, view.messages);
  // History can lag the active stream. Keep that one owned draft while allowing
  // authoritative completed history to replace stale local display state.
  const streaming = current.find(m => m.role === 'assistant' && m.turnId && m.turnId === view.activeTurn?.turnId);
  if (!streaming) return incoming;
  const found = incoming.find(m => m.role === 'assistant' && m.turnId === streaming.turnId);
  return found ? incoming.map(m => m.id === found.id ? { ...m, text: streaming.text } : m) : [...incoming, streaming];
}
