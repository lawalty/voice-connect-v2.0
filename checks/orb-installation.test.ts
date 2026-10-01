import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../service/main';
import { LUMINOUS_GLASS, VOICE_CONNECT_V1, MAX_PACK_BYTES } from '../contract/orb-packs';

const atlas = readFileSync('client/public/orb-packs/luminous-glass/atlas.png');
const flow = readFileSync('client/public/orb-packs/luminous-glass/flow.png');
const pack = { ...LUMINOUS_GLASS, id: 'my-avatar', name: 'My avatar', atlas: `data:image/png;base64,${atlas.toString('base64')}`, flow: `data:image/png;base64,${flow.toString('base64')}` };
const origin = 'http://127.0.0.1:5173';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'vc-orb-shared-'));
  const config = { stateDir: dir, masterKey: randomBytes(32), gatewayEnabled: false, bootstrapToken: 'bootstrap-orb-fixture-only', origin, secureCookie: false, staticDir: join(dir, 'absent') };
  let app = await buildApp({ config });
  cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const first = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin }, payload: { password: 'shared orb fixture password', bootstrapToken: config.bootstrapToken } });
  const second = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password: 'shared orb fixture password' } });
  const headers = (response: typeof first) => ({ origin, cookie: `${response.cookies[0]!.name}=${response.cookies[0]!.value}`, 'x-csrf-token': response.json().csrfToken as string });
  return { get app() { return app; }, phone: headers(first), pc: headers(second), async restart() { await app.close(); app = await buildApp({ config }); } };
}

describe('installation-wide orb packs', () => {
  it('shares the built-in status selection and imported palettes across devices and restart', async () => {
    const run = await fixture();
    const selected = await run.app.inject({ method: 'PATCH', url: '/api/orbs/preferences', headers: run.phone, payload: { revision: 0, patch: { packId: VOICE_CONNECT_V1.id } } });
    expect(selected.statusCode).toBe(200);
    const palette = { ...VOICE_CONNECT_V1, id: 'my-status-orb', name: 'My status orb' };
    const imported = await run.app.inject({ method: 'POST', url: '/api/orbs/packs', headers: run.phone, payload: palette });
    expect(imported.statusCode).toBe(200); expect(imported.json().state.packs).toEqual([palette]);
    await run.restart();
    const state = (await run.app.inject({ url: '/api/orbs', headers: run.pc })).json();
    expect(state.preferences.packId).toBe(palette.id); expect(state.packs).toEqual([palette]);
    expect((await run.app.inject({ url: `/api/orbs/packs/${palette.id}/atlas.png`, headers: run.pc })).statusCode).toBe(404);
    expect((await run.app.inject({ method: 'DELETE', url: `/api/orbs/packs/${palette.id}`, headers: run.pc, payload: { revision: state.revision } })).statusCode).toBe(200);
  });
  it('copies a phone avatar to a fresh PC, preserving artwork, selection, colors and motion across server restart', async () => {
    const run = await fixture();
    expect((await run.app.inject({ url: '/api/orbs', headers: run.pc })).json()).toMatchObject({ revision: 0, configured: false, packs: [] });
    const appearance = { packId: pack.id, phaseColors: false, motion: .65 };
    const copied = await run.app.inject({ method: 'POST', url: '/api/orbs/migrate', headers: run.phone, payload: { pack, appearance } });
    expect(copied.statusCode).toBe(200);
    const state = copied.json().state;
    expect(state.preferences).toEqual(appearance); expect(state.configured).toBe(true);
    expect(JSON.stringify(state).length).toBeLessThan(2000); expect(JSON.stringify(state)).not.toContain('base64');
    const repeated = await run.app.inject({ method: 'POST', url: '/api/orbs/migrate', headers: run.phone, payload: { pack, appearance } });
    expect(repeated.json().state).toEqual(state);
    await run.restart();
    expect((await run.app.inject({ url: '/api/orbs', headers: run.pc })).json()).toEqual(state);
    for (const [name, bytes] of [['atlas', atlas], ['flow', flow]] as const) {
      const image = await run.app.inject({ url: state.packs[0][name], headers: run.pc });
      expect(image.statusCode).toBe(200); expect(image.headers['content-type']).toContain('image/png');
      expect(image.headers['cache-control']).toBe('no-store'); expect(image.rawPayload).toEqual(bytes);
    }
  });
  it('requires authentication, origin and CSRF for private pack data and writes; bounds upload size', async () => {
    const run = await fixture();
    for (const url of ['/api/orbs', '/api/orbs/packs/my-avatar/atlas.png', '/%61pi/orbs']) expect((await run.app.inject(url)).statusCode).toBe(401);
    for (const url of ['/api/orbs/packs', '/api/orbs/migrate']) {
      expect((await run.app.inject({ method: 'POST', url, headers: { origin, cookie: run.phone.cookie }, payload: {} })).statusCode).toBe(403);
      expect((await run.app.inject({ method: 'POST', url, headers: { ...run.phone, origin: 'https://other.test' }, payload: {} })).statusCode).toBe(403);
    }
    expect((await run.app.inject({ method: 'PATCH', url: '/api/orbs/preferences', headers: { origin, cookie: run.phone.cookie }, payload: {} })).statusCode).toBe(403);
    expect((await run.app.inject({ method: 'DELETE', url: '/api/orbs/packs/my-avatar', headers: { origin, cookie: run.phone.cookie }, payload: {} })).statusCode).toBe(403);
    expect((await run.app.inject({ method: 'POST', url: '/api/orbs/packs', headers: run.phone, payload: { ...pack, atlas: 'https://other.test/private.png' } })).statusCode).toBe(400);
    expect((await run.app.inject({ method: 'POST', url: '/api/orbs/packs', headers: run.phone, payload: { ...pack, motion: { yaw: 99, pitch: 1, roll: 1 } } })).statusCode).toBe(400);
    expect((await run.app.inject({ method: 'POST', url: '/api/orbs/packs', headers: { ...run.phone, 'content-type': 'application/json' }, payload: ' '.repeat(MAX_PACK_BYTES + 2048) })).statusCode).toBe(413);
  });
  it('keeps both conflicting legacy IDs without replacing a shared selection, and rejects stale preference/deletion writes', async () => {
    const run = await fixture();
    const imported = (await run.app.inject({ method: 'POST', url: '/api/orbs/packs', headers: run.pc, payload: pack })).json().state;
    const different = { ...pack, name: 'Different avatar', motion: { yaw: 5, pitch: 3, roll: 2 } };
    expect((await run.app.inject({ method: 'POST', url: '/api/orbs/packs', headers: run.phone, payload: different })).statusCode).toBe(409);
    const result = (await run.app.inject({ method: 'POST', url: '/api/orbs/migrate', headers: run.phone, payload: { pack: different, appearance: { packId: pack.id, motion: 0, phaseColors: false } } })).json();
    expect(result.id).not.toBe(pack.id); expect(result.state.packs).toHaveLength(2);
    expect(result.state.preferences).toEqual(imported.preferences);
    const retry = (await run.app.inject({ method: 'POST', url: '/api/orbs/migrate', headers: run.phone, payload: { pack: different } })).json();
    expect(retry).toEqual(result);
    const stale = { revision: imported.revision, patch: { phaseColors: false } };
    expect((await run.app.inject({ method: 'PATCH', url: '/api/orbs/preferences', headers: run.pc, payload: stale })).statusCode).toBe(409);
    expect((await run.app.inject({ method: 'DELETE', url: `/api/orbs/packs/${pack.id}`, headers: run.pc, payload: { revision: imported.revision } })).statusCode).toBe(409);
    const changed = await run.app.inject({ method: 'PATCH', url: '/api/orbs/preferences', headers: run.pc, payload: { ...stale, revision: result.state.revision, patch: { phaseColors: false, motion: .3 } } });
    expect(changed.json().preferences).toEqual({ packId: pack.id, phaseColors: false, motion: .3 });
  });
  it('does not resurrect deleted packs from an old phone, even after their IDs are reused', async () => {
    const run = await fixture();
    const first = (await run.app.inject({ method: 'POST', url: '/api/orbs/migrate', headers: run.phone, payload: { pack, appearance: { packId: pack.id, phaseColors: false, motion: 1 } } })).json();
    const deleted = await run.app.inject({ method: 'DELETE', url: `/api/orbs/packs/${pack.id}`, headers: run.pc, payload: { revision: first.state.revision } });
    expect(deleted.json().preferences.packId).toBe('classic');
    expect((await run.app.inject({ url: first.state.packs[0].atlas, headers: run.phone })).statusCode).toBe(404);
    const replacement = { ...pack, name: 'Replacement' };
    await run.app.inject({ method: 'POST', url: '/api/orbs/packs', headers: run.pc, payload: replacement });
    const stale = (await run.app.inject({ method: 'POST', url: '/api/orbs/migrate', headers: run.phone, payload: { pack } })).json();
    expect(stale.id).toBeNull(); expect(stale.state.packs).toHaveLength(1); expect(stale.state.packs[0].name).toBe('Replacement');
  });
  it('enforces the eight-pack limit under concurrent uploads without losing existing packs', async () => {
    const run = await fixture();
    const uploads = await Promise.all(Array.from({ length: 9 }, (_, i) => run.app.inject({ method: 'POST', url: '/api/orbs/packs', headers: run.phone, payload: { ...pack, id: `avatar-${i}` } })));
    expect(uploads.filter(r => r.statusCode === 200)).toHaveLength(8);
    expect(uploads.filter(r => r.statusCode === 409)).toHaveLength(1);
    expect((await run.app.inject({ url: '/api/orbs', headers: run.pc })).json().packs).toHaveLength(8);
  });
});
