import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HistoryOptions, HistoryWindow } from '../contract/types.js';

type Json = Record<string, any>;
type Request = (method: string, params: Json) => Promise<Json>;
const pageSize = 200;
const cursorSchema = z.object({ conversation: z.string(), session: z.string().max(256), offset: z.number().int().positive(), total: z.number().int().nonnegative(), anchor: z.string().length(64), sync: z.string().max(8192).optional() }).strict();
const changed = () => Object.assign(new Error('Conversation history changed. Refreshing the latest messages; please load earlier messages again.'), { statusCode: 409 });
const anchor = (message: Json) => createHash('sha256').update(JSON.stringify([message.__openclaw?.id, message.__openclaw?.seq, message.id, message.messageId, message.role, message.timestamp, message.content])).digest('hex');

/** Offsets are short-lived page positions, not bookmarks. Fence an older page
 * with its session, delta cursor, and overlapping transcript record. */
export async function readHistoryPage(request: Request, conversation: string, target: Json, options: HistoryOptions = {}): Promise<{ raw: Json; window: HistoryWindow }> {
  let before: z.infer<typeof cursorSchema> | undefined;
  if (options.before) {
    try { before = cursorSchema.parse(JSON.parse(Buffer.from(options.before, 'base64url').toString())); }
    catch { throw Object.assign(new Error('Invalid history page.'), { statusCode: 400 }); }
    if (before.conversation !== conversation) throw Object.assign(new Error('This history page belongs to another conversation.'), { statusCode: 400 });
  }
  const since = options.since ?? before?.sync;
  const delta = since ? await request('chat.history', { ...target, cursor: since }) : undefined;
  if (before && delta?.kind === 'reset') throw changed();
  let raw: Json;
  if (!before) raw = await request('chat.history', { ...target, limit: pageSize, maxChars: 50000 });
  else {
    let page: Json | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = await request('chat.history', { ...target, limit: 1 });
      if (head.sessionId !== before.session || !Number.isSafeInteger(head.totalMessages) || head.totalMessages < before.total) throw changed();
      // Include one boundary record. Concurrent appends shift the offset; a
      // branch/reset or a mismatched boundary must never splice unrelated rows.
      const offset = before.offset + head.totalMessages - before.total - 1;
      page = await request('chat.history', { ...target, limit: pageSize + 1, offset, maxChars: 50000 });
      if (page.sessionId !== before.session) throw changed();
      if (page.totalMessages !== head.totalMessages) { page = undefined; continue; }
      if (!page.messages?.length || anchor(page.messages.at(-1)) !== before.anchor) throw changed();
      break;
    }
    if (!page) throw changed();
    raw = page;
  }
  const window: HistoryWindow = {
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    ...(typeof raw.deltaCursor === 'string' ? { sync: raw.deltaCursor } : {}),
    ...(delta?.kind === 'reset' ? { reset: true } : {}),
  };
  const times = (raw.messages ?? []).map((m: Json) => typeof m.timestamp === 'number' ? m.timestamp : Date.parse(m.timestamp ?? '')).filter(Number.isFinite);
  if (times.length) window.start = Math.min(...times);
  if (raw.hasMore === true) {
    if (!raw.messages?.length || !window.sessionId || !Number.isSafeInteger(raw.nextOffset) || raw.nextOffset <= 0 || !Number.isSafeInteger(raw.totalMessages)) throw new Error('OpenClaw did not supply a usable history page boundary.');
    window.before = Buffer.from(JSON.stringify({ conversation, session: window.sessionId, offset: raw.nextOffset, total: raw.totalMessages, anchor: anchor(raw.messages[0]), ...(window.sync ? { sync: window.sync } : {}) })).toString('base64url');
  }
  return { raw, window };
}

/** A transcript record can project to several display rows. Keep their stable
 * siblings distinct without using an array index that changes between pages. */
export function historyRowId(raw: Json, siblings: Map<string, number>): string {
  const native = raw.__openclaw?.id ?? raw.id ?? raw.messageId;
  const base = typeof native === 'string' ? `${native}:${raw.role}` : anchor(raw);
  const ordinal = siblings.get(base) ?? 0; siblings.set(base, ordinal + 1);
  if (!raw.__openclaw?.id && typeof (raw.id ?? raw.messageId) === 'string' && ordinal === 0) return raw.id ?? raw.messageId;
  return `native:${base}:${ordinal}`;
}
