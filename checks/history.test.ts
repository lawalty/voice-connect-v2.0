import { describe, expect, it } from 'vitest';
import { historyRowId, readHistoryPage } from '../service/history-page.js';
import { mergeOlderMessages, reconcileMessages } from '../client/history.js';
import type { Message } from '../contract/types.js';

function fixture(count = 501) {
  const rows: any[] = Array.from({ length: count }, (_, i) => ({ role: i % 3 ? 'assistant' : 'user', content: `entry ${i}`, timestamp: 1000 + i, __openclaw: { id: `entry-${i}`, seq: i + 1 } }));
  let session = 'native-session', reset = false;
  const calls: any[] = [];
  let duringPage: (() => void) | undefined;
  const request = async (_method: string, p: any) => {
    calls.push(p);
    if (p.cursor) return { kind: reset ? 'reset' : 'delta', messages: [] };
    if (p.offset && duringPage) { const fn = duringPage; duringPage = undefined; fn(); }
    const end = rows.length - (p.offset ?? 0), messages = rows.slice(Math.max(0, end - p.limit), end);
    return { sessionId: session, messages, totalMessages: rows.length, hasMore: end - messages.length > 0, nextOffset: (p.offset ?? 0) + messages.length, deltaCursor: 'native-delta-cursor' };
  };
  return { rows, calls, request, setSession: (s: string) => { session = s; }, reset: () => { reset = true; }, race: (fn: () => void) => { duringPage = fn; } };
}
const target = { sessionKey: 'agent:northpointe:vc2:conversation', agentId: 'northpointe' };

describe('native history pages', () => {
  it('loads every older entry and adjusts offsets for new replies without gaps', async () => {
    const f = fixture();
    let page = await readHistoryPage(f.request, 'conversation', target);
    const ids = new Set(page.raw.messages.map((m: any) => m.__openclaw.id));
    expect(ids.size).toBe(200);
    f.rows.push({ role: 'assistant', content: 'new while reading', timestamp: 1600, __openclaw: { id: 'new', seq: 502 } });
    page = await readHistoryPage(f.request, 'conversation', target, { before: page.window.before });
    expect(f.calls.at(-1).offset).toBe(200); // 200 prior + one appended - one overlap.
    for (const m of page.raw.messages) ids.add(m.__openclaw.id);
    while (page.window.before) {
      page = await readHistoryPage(f.request, 'conversation', target, { before: page.window.before });
      for (const m of page.raw.messages) ids.add(m.__openclaw.id);
    }
    expect(ids.size).toBe(501); expect(ids.has('entry-0')).toBe(true); expect(ids.has('entry-500')).toBe(true);
    expect(f.calls.every(p => !p.sessionId)).toBe(true);
  });
  it('retries a concurrent append between the head read and older page', async () => {
    const f = fixture(), first = await readHistoryPage(f.request, 'conversation', target);
    f.race(() => f.rows.push({ role: 'user', content: 'racing append', timestamp: 1800, __openclaw: { id: 'race', seq: 502 } }));
    const next = await readHistoryPage(f.request, 'conversation', target, { before: first.window.before });
    expect(next.raw.messages.at(-1).__openclaw.id).toBe('entry-301');
    expect(f.calls.filter(p => p.offset)).toHaveLength(2);
  });
  for (const change of ['session', 'branch', 'cursor', 'compaction'] as const) it(`refuses to mix an older page across a ${change} change`, async () => {
    const f = fixture(), first = await readHistoryPage(f.request, 'conversation', target);
    if (change === 'session') f.setSession('replacement');
    if (change === 'branch') f.rows[301] = { ...f.rows[301], content: 'different branch' };
    if (change === 'cursor') f.reset();
    if (change === 'compaction') f.rows.splice(0, 20);
    await expect(readHistoryPage(f.request, 'conversation', target, { before: first.window.before })).rejects.toMatchObject({ statusCode: 409 });
  });
  it('marks a reset tail so the UI discards stale earlier pages', async () => {
    const f = fixture(); f.reset();
    expect((await readHistoryPage(f.request, 'conversation', target, { since: 'old-cursor' })).window.reset).toBe(true);
  });
  it('does not accept another conversation cursor or silently truncate a broken page', async () => {
    const f = fixture(), first = await readHistoryPage(f.request, 'conversation', target);
    await expect(readHistoryPage(f.request, 'another', target, { before: first.window.before })).rejects.toMatchObject({ statusCode: 400 });
    await expect(readHistoryPage(f.request, 'conversation', target, { before: 'invalid' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(readHistoryPage(async () => ({ messages: [], hasMore: true }), 'conversation', target)).rejects.toThrow('usable history page boundary');
  });
  it('uses stable native identities while keeping sibling projections separate', () => {
    const raw = { role: 'assistant', timestamp: 123, content: 'Same words', __openclaw: { id: 'native-entry', seq: 1 } };
    const siblings = new Map<string, number>();
    const a = historyRowId(raw, siblings), b = historyRowId(raw, siblings);
    expect(a).not.toBe(b); expect(historyRowId(raw, new Map())).toBe(a);
    expect(historyRowId({ ...raw, role: 'user' }, new Map())).not.toBe(a);
  });
});

const message = (id: string, createdAt: number, text = id, extra: Partial<Message> = {}): Message => ({ id, createdAt, text, role: 'assistant', ...extra });
describe('history display reconciliation', () => {
  it('preserves the audible reply association when native history omits assistant turn IDs', () => {
    const current = [message('assistant-owned', 300, 'The final reply.', { turnId: 'owned', runId: 'run' })];
    const rows = [message('prior', 100, 'The final reply.'), message('native:user', 200, 'Question', { role: 'user', turnId: 'owned' }), message('native:answer', 300, 'The final reply.')];
    const view = { conversation: { id: 'c', title: '', createdAt: 0, updatedAt: 0 }, messages: rows };
    const synced = reconcileMessages(current, view, false, 'owned');
    expect(synced.map(m => m.id)).toEqual(rows.map(m => m.id));
    expect(synced.at(-1)).toMatchObject({ id: 'native:answer', turnId: 'owned', runId: 'run' });
    expect(synced[0]!.turnId).toBeUndefined();
    expect(reconcileMessages(current, { ...view, messages: [rows[0]!, rows[1]!, { ...rows[2]!, runId: 'different-run' }] }, false, 'owned').at(-1)?.turnId).toBeUndefined();
    expect(reconcileMessages(synced, view, false)).toEqual(rows); // completed/reloaded history is unmodified
    expect(reconcileMessages(current, { ...view, messages: [...rows, message('duplicate', 301, 'The final reply.')] }, false, 'owned').at(-1)?.turnId).toBeUndefined();
    const anotherUser = message('next:user', 250, 'Next question', { role: 'user', turnId: 'next' });
    expect(reconcileMessages(current, { ...view, messages: [rows[0]!, rows[1]!, anotherUser, rows[2]!] }, false, 'owned').at(-1)?.turnId).toBeUndefined();
  });
  it('keeps the latest stream when an older page overlaps it and sorts failed turns correctly', () => {
    const current = [message('assistant-owned', 300, 'latest stream', { turnId: 'owned' })];
    const older = [message('failed', 100, 'old question', { role: 'user', delivery: 'failed' }), message('native', 300, 'older snapshot', { turnId: 'owned' }), message('middle', 200)];
    expect(mergeOlderMessages(older, current).map(m => m.id)).toEqual(['failed', 'middle', 'assistant-owned']);
    expect(mergeOlderMessages(older, current).at(-1)?.text).toBe('latest stream');
  });
  it('keeps distinct native assistant rows from the same run across pages', () => {
    const first = message('native:first:assistant:0', 100, 'First answer', { turnId: 'owned' });
    const second = message('native:second:assistant:0', 200, 'Follow-up answer', { turnId: 'owned' });
    expect(mergeOlderMessages([first, second], [second])).toEqual([first, second]);
    const nativeUser = message('native:input:user:0', 90, 'Question', { role: 'user', turnId: 'owned' });
    const localUser = { ...nativeUser, id: 'owned' };
    expect(mergeOlderMessages([localUser], [nativeUser])).toEqual([nativeUser]);
  });
  it('refreshes the tail without deleting loaded earlier history or retaining replaced tail rows', () => {
    const current = [message('older', 100), message('stale', 200), message('stream', 300, 'in progress', { turnId: 'owned' })];
    const view = { conversation: { id: 'c', title: '', createdAt: 0, updatedAt: 0 }, messages: [message('new', 220)], history: { sessionId: 's', start: 200 }, activeTurn: { turnId: 'owned', delivery: 'accepted' as const } };
    expect(reconcileMessages(current, view, true).map(m => m.id)).toEqual(['older', 'new', 'stream']);
    expect(reconcileMessages(current, { ...view, activeTurn: undefined }, false).map(m => m.id)).toEqual(['new']);
  });
});
