import { api } from '../api';
import { restoreOrbPreferences, type InstallationOrbs, type OrbPack, type OrbPreferences } from './packs';

export interface OrbView {
  packs: OrbPack[]; preferences: OrbPreferences; loaded: boolean; saving: boolean; notice: string;
}
export interface LegacyOrbs { packs: OrbPack[]; preferences: OrbPreferences; complete(): void; }
type Request = <T>(path: string, options?: RequestInit) => Promise<T>;

/** Serialize local edits; never silently overwrite a newer device's revision. */
export class OrbSync {
  view: OrbView = { packs: [], preferences: restoreOrbPreferences(null), loaded: false, saving: false, notice: '' };
  private remote?: InstallationOrbs;
  private pending: Partial<OrbPreferences> = {};
  private writing?: Promise<void>;
  private reading?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private disposed = false;
  private generation = 0;
  private abort = new AbortController();
  constructor(private changed: (view: OrbView) => void, private request: Request = api) {}
  private send<T>(path: string, options: RequestInit = {}) { return this.request<T>(path, { ...options, signal: this.abort.signal }); }
  private emit(patch: Partial<OrbView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch }; this.changed(this.view);
  }
  private apply(next: InstallationOrbs) {
    if (this.disposed || (this.remote && next.revision < this.remote.revision)) return;
    this.remote = next;
    // Stable references avoid rebuilding WebGL after a settings refresh.
    const packs = next.packs.map(pack => this.view.packs.find(old => old.id === pack.id && JSON.stringify(old) === JSON.stringify(pack)) ?? pack);
    this.emit({ packs, preferences: { ...next.preferences, ...this.pending } });
  }
  async refresh() {
    if (this.disposed || this.busy || this.writing || Object.keys(this.pending).length) return;
    if (this.reading) return this.reading;
    const generation = this.generation;
    this.reading = (async () => {
      try {
        const next = await this.send<InstallationOrbs>('/api/orbs');
        if (generation === this.generation) {
          this.apply(next);
          if (this.view.notice.startsWith('Shared orb settings are unavailable.')) this.emit({ notice: '' });
        }
      } catch { this.emit({ notice: 'Shared orb settings are unavailable. Reconnect and retry; your server packs are preserved.' }); }
      finally { this.reading = undefined; }
    })();
    return this.reading;
  }
  async start(legacy: () => Promise<LegacyOrbs | undefined>) {
    await this.refresh(); if (!this.remote || this.disposed || this.busy) return;
    this.busy = true; this.emit({ loaded: false, saving: true });
    try {
      const previous = await legacy(); if (this.disposed) return;
      if (previous) {
        this.emit({ notice: 'Copying this device’s orb packs to your VC installation…' });
        const packs = [...previous.packs].sort((a, b) => Number(b.id === previous.preferences.packId) - Number(a.id === previous.preferences.packId));
        for (const pack of packs) {
          if (this.disposed) return;
          const result = await this.send<{ state: InstallationOrbs }>('/api/orbs/migrate', { method: 'POST', body: JSON.stringify({ pack, appearance: previous.preferences }) });
          this.apply(result.state);
        }
        if (!this.disposed) previous.complete();
      }
      this.emit({ notice: '' });
    } catch (error) {
      this.emit({ notice: `Some older device packs could not be copied. Their local copies are kept. ${error instanceof Error ? error.message : 'Retry when connected.'}` });
    } finally { this.busy = false; this.emit({ loaded: true, saving: false }); }
  }
  choose(patch: Partial<OrbPreferences>) {
    if (!this.remote || !this.view.loaded || this.disposed || this.busy) return;
    ++this.generation; this.pending = { ...this.pending, ...patch };
    this.emit({ preferences: { ...this.view.preferences, ...patch }, saving: true, notice: '' });
    clearTimeout(this.timer); this.timer = setTimeout(() => void this.flush(), 180);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.writing) return this.writing;
    if (!this.remote || this.disposed || this.busy || !Object.keys(this.pending).length) return;
    this.writing = (async () => {
      try {
        while (Object.keys(this.pending).length && !this.disposed) {
          const patch = this.pending; this.pending = {};
          const next = await this.send<InstallationOrbs>('/api/orbs/preferences', { method: 'PATCH', body: JSON.stringify({ revision: this.remote!.revision, patch }) });
          this.apply(next);
        }
      } catch (error) {
        this.pending = {}; this.busy = true;
        try { this.apply(await this.send<InstallationOrbs>('/api/orbs')); }
        catch { if (this.remote) this.apply(this.remote); }
        this.emit({ notice: error instanceof Error ? error.message : 'Appearance was not saved. Reconnect and try again.' });
        this.busy = false;
      } finally { this.writing = undefined; this.emit({ saving: false }); }
    })();
    return this.writing;
  }
  async mutate(operation: (revision: number, send: Request) => Promise<InstallationOrbs>) {
    if (this.busy || !this.remote || !this.view.loaded) throw new Error('Wait for shared orb settings to finish loading.');
    await this.flush(); if (this.disposed) return;
    if (this.busy) throw new Error('Another orb change is still being saved.');
    this.busy = true; ++this.generation; this.emit({ saving: true });
    try { this.apply(await operation(this.remote.revision, (path, options) => this.send(path, options))); this.emit({ notice: '' }); }
    catch (error) { try { this.apply(await this.send<InstallationOrbs>('/api/orbs')); } catch {} throw error; }
    finally { this.busy = false; this.emit({ saving: false }); }
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.abort.abort(); }
}
