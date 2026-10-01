import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbSync } from '../client/orbs/sync';
import { LUMINOUS_GLASS, type InstallationOrbs } from '../contract/orb-packs';
const initial = (): InstallationOrbs => ({ revision: 0, configured: false, preferences: { packId: 'classic', motion: 1, phaseColors: true }, packs: [{ ...LUMINOUS_GLASS, id: 'shared-face', atlas: '/api/orbs/packs/shared-face/atlas.png?v=1' }] });
const clients: OrbSync[] = [];
afterEach(() => { clients.splice(0).forEach(c => c.dispose()); vi.useRealTimers(); });
function harness() {
  let state = initial();
  const calls: { path: string; options?: RequestInit }[] = [];
  let before: ((path: string, options?: RequestInit) => Promise<void>) | undefined;
  const request = async <T>(path: string, options?: RequestInit): Promise<T> => {
    calls.push({ path, options });
    const read = structuredClone(state);
    await before?.(path, options);
    if (options?.method === 'PATCH') {
      const { revision, patch } = JSON.parse(String(options.body));
      if (revision !== state.revision) throw new Error('Orb appearance changed on another device.');
      state = { ...state, revision: revision + 1, configured: true, preferences: { ...state.preferences, ...patch } };
      return structuredClone(state) as T;
    }
    return read as T;
  };
  const create = () => { const c = new OrbSync(() => {}, request); clients.push(c); return c; };
  return { create, calls, get state() { return state; }, set state(next) { state = next; }, set before(fn: typeof before) { before = fn; } };
}
const noLegacy = async () => undefined;
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe('shared orb client synchronization', () => {
  it('uses shared appearance on a fresh device and keeps artwork identity stable across refreshes', async () => {
    const run = harness(), phone = run.create(), pc = run.create();
    await Promise.all([phone.start(noLegacy), pc.start(noLegacy)]);
    const art = pc.view.packs[0];
    phone.choose({ packId: 'shared-face', phaseColors: false, motion: .55 }); await phone.flush();
    await pc.refresh();
    expect(pc.view.preferences).toEqual(phone.view.preferences);
    expect(pc.view.packs[0]).toBe(art); expect(pc.view.loaded).toBe(true);
  });
  it('ignores an old refresh that finishes after a local choice and serializes rapid edits', async () => {
    const run = harness(), client = run.create(); await client.start(noLegacy);
    const oldRead = gate(); run.before = async (_path, options) => { if (!options?.method) await oldRead.promise; };
    const refreshing = client.refresh();
    const firstWrite = gate(); let writes = 0;
    run.before = async (_path, options) => { if (options?.method === 'PATCH' && writes++ === 0) await firstWrite.promise; };
    client.choose({ phaseColors: false }); const saving = client.flush();
    client.choose({ motion: .4 }); client.choose({ motion: .7 });
    firstWrite.resolve(); await saving; oldRead.resolve(); await refreshing;
    expect(client.view.preferences).toEqual({ packId: 'classic', motion: .7, phaseColors: false });
    expect(run.calls.filter(c => c.options?.method === 'PATCH').map(c => JSON.parse(String(c.options!.body)).revision)).toEqual([0, 1]);
    expect(client.view.saving).toBe(false);
  });
  it('rolls back an unsaved optimistic change and shows the winning device on a revision conflict', async () => {
    const run = harness(), client = run.create(); await client.start(noLegacy);
    run.state = { ...run.state, revision: 1, configured: true, preferences: { packId: 'shared-face', motion: .8, phaseColors: true } };
    client.choose({ phaseColors: false }); await client.flush();
    expect(client.view.preferences).toEqual(run.state.preferences);
    expect(client.view.notice).toContain('another device'); expect(client.view.saving).toBe(false);
  });
  it('keeps legacy migration retryable after failure and does not read or upload legacy artwork after disposal', async () => {
    let online = false, migrated = 0;
    const complete = vi.fn();
    const request = async <T>(path: string): Promise<T> => {
      if (!online) throw new Error('offline');
      if (path.endsWith('migrate')) { migrated++; if (migrated === 1) throw new Error('Upload interrupted'); return { state: { ...initial(), revision: 1 } } as T; }
      return initial() as T;
    };
    const client = new OrbSync(() => {}, request); clients.push(client);
    const legacy = vi.fn(async () => ({ packs: [LUMINOUS_GLASS], preferences: initial().preferences, complete }));
    await client.start(legacy); expect(legacy).not.toHaveBeenCalled(); expect(client.view.loaded).toBe(false);
    online = true; await client.start(legacy); expect(complete).not.toHaveBeenCalled(); expect(client.view.notice).toContain('local copies are kept');
    await client.start(legacy); expect(complete).toHaveBeenCalledOnce(); expect(client.view.loaded).toBe(true);
    const held = gate(), late = new OrbSync(() => {}, request); clients.push(late);
    const starting = late.start(async () => { await held.promise; return { packs: [LUMINOUS_GLASS], preferences: initial().preferences, complete }; });
    await Promise.resolve(); late.dispose(); held.resolve(); await starting;
    expect(migrated).toBe(2);
  });
});
