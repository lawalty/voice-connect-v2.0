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

export function reconcileMessages(current: Message[], view: ConversationView, keepEarlier: boolean, playbackTurnId?: string): Message[] {
  const earlier = keepEarlier && view.history?.start !== undefined ? current.filter(m => m.createdAt < view.history!.start!) : [];
  const incoming = mergeOlderMessages(earlier, view.messages);
  // Native persisted assistant rows may omit run/turn IDs. While that exact
  // reply is still audible, retain its transient presentation ownership across
  // history refreshes. Match only within the owned user's turn and only one
  // identical answer; never infer ownership from repeated text elsewhere.
  const playing = playbackTurnId && current.find(m => m.role === 'assistant' && m.turnId === playbackTurnId);
  if (playing) {
    const user = incoming.findIndex(m => m.role === 'user' && m.turnId === playbackTurnId);
    const followingUser = incoming.findIndex((m, index) => index > user && m.role === 'user');
    const candidates = user < 0 ? [] : incoming.slice(user + 1, followingUser < 0 ? undefined : followingUser)
      .filter(m => m.role === 'assistant' && (!m.turnId || m.turnId === playbackTurnId) &&
        (!m.runId || !playing.runId || m.runId === playing.runId) && m.text === playing.text);
    if (candidates.length === 1) {
      const matched = candidates[0]!;
      return incoming.map(m => m.id === matched.id ? { ...m, turnId: playbackTurnId, runId: m.runId ?? playing.runId } : m);
    }
  }
  // History can lag the active stream. Keep that one owned draft while allowing
  // authoritative completed history to replace stale local display state.
  const streaming = current.find(m => m.role === 'assistant' && m.turnId && m.turnId === view.activeTurn?.turnId);
  if (!streaming) return incoming;
  const found = incoming.find(m => m.role === 'assistant' && m.turnId === streaming.turnId);
  return found ? incoming.map(m => m.id === found.id ? { ...m, text: streaming.text } : m) : [...incoming, streaming];
}
