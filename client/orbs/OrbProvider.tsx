import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { BUILTIN_PACKS, isBuiltinPack, MAX_PACK_BYTES, parseOrbPack, restoreOrbPreferences, type InstallationOrbs, type OrbPack, type OrbPreferences } from './packs';
import { loadOrbPacks, verifyPackImages } from './storage';
import { OrbSync, type LegacyOrbs } from './sync';

const KEY = 'vc2:orb', MIGRATED = 'vc2:orb-server-migration-v1';
interface Appearance {
  packs: OrbPack[]; pack?: OrbPack; preferences: OrbPreferences; notice: string; loaded: boolean; saving: boolean;
  choose(patch: Partial<OrbPreferences>): void; refresh(): void; retry(): void;
  importPack(file: File): Promise<void>; removePack(): Promise<void>; exportPack(): Promise<{ url: string; name: string }>;
}
const Context = createContext<Appearance | null>(null);
async function legacy(): Promise<LegacyOrbs | undefined> {
  try { if (localStorage.getItem(MIGRATED) === 'done') return; } catch {}
  const packs = await loadOrbPacks(); if (!packs.length) return;
  let preferences = restoreOrbPreferences(null);
  try { preferences = restoreOrbPreferences(localStorage.getItem(KEY)); } catch {}
  return { packs, preferences, complete: () => { try { localStorage.setItem(MIGRATED, 'done'); } catch {} } };
}
async function embedded(url: string): Promise<string> {
  if (url.startsWith('data:')) return url;
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('The orb artwork could not be exported.');
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The orb artwork could not be exported.')); reader.readAsDataURL(blob);
  });
}
/** Mounted after sign-in, once the authenticated API and CSRF token are ready. */
export function OrbProvider({ children }: { children: ReactNode }) {
  const sync = useRef<OrbSync | null>(null);
  const [view, setView] = useState(() => ({ packs: [] as OrbPack[], preferences: restoreOrbPreferences(null), loaded: false, saving: false, notice: '' }));
  const refresh = useCallback(() => { const current = sync.current; if (current) void (current.view.loaded ? current.refresh() : current.start(legacy)); }, []);
  const retry = useCallback(() => { void sync.current?.start(legacy); }, []);
  useEffect(() => {
    const current = sync.current = new OrbSync(setView);
    void current.start(legacy);
    const visibleRefresh = () => { if (!document.hidden) refresh(); };
    window.addEventListener('focus', visibleRefresh); window.addEventListener('online', visibleRefresh); document.addEventListener('visibilitychange', visibleRefresh);
    const timer = setInterval(visibleRefresh, 30000);
    return () => { current.dispose(); clearInterval(timer); window.removeEventListener('focus', visibleRefresh); window.removeEventListener('online', visibleRefresh); document.removeEventListener('visibilitychange', visibleRefresh); if (sync.current === current) sync.current = null; };
  }, [refresh]);
  const packs = [...BUILTIN_PACKS, ...view.packs], pack = packs.find(p => p.id === view.preferences.packId);
  async function importPack(file: File) {
    if (file.size > MAX_PACK_BYTES) throw new Error('Orb packs must be smaller than 6 MB.');
    const incoming = parseOrbPack(await file.text()); await verifyPackImages(incoming);
    if (!sync.current) throw new Error('Shared orb settings are unavailable.');
    await sync.current.mutate(async (_revision, send) => (await send<{ state: InstallationOrbs }>('/api/orbs/packs', { method: 'POST', body: JSON.stringify(incoming) })).state);
  }
  async function removePack() {
    if (!pack || isBuiltinPack(pack.id) || !sync.current) return;
    await sync.current.mutate((revision, send) => send<InstallationOrbs>(`/api/orbs/packs/${pack.id}`, { method: 'DELETE', body: JSON.stringify({ revision }) }));
  }
  async function exportPack() {
    if (!pack) throw new Error('Choose a face to export.');
    let artwork = {};
    if (pack.renderer === 'glass-face-v1') {
      const [atlas, flow] = await Promise.all([embedded(pack.atlas), pack.flow ? embedded(pack.flow) : Promise.resolve(undefined)]);
      artwork = { atlas, ...(flow ? { flow } : {}) };
    }
    const exported = { ...pack, ...artwork, id: isBuiltinPack(pack.id) ? `my-${pack.id}` : pack.id, name: isBuiltinPack(pack.id) ? `My ${pack.name}` : pack.name };
    return { url: URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' })), name: `${exported.id}.orb.json` };
  }
  return <Context.Provider value={{ ...view, packs, pack, choose: patch => sync.current?.choose(patch), refresh, retry, importPack, removePack, exportPack }}>{children}</Context.Provider>;
}
export function useOrbAppearance() { const value = useContext(Context); if (!value) throw new Error('OrbProvider is required.'); return value; }
