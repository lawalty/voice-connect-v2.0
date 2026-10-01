import type { FastifyInstance, FastifyReply } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { digest, type Store } from './store.js';
import { LUMINOUS_GLASS, MAX_CUSTOM_PACKS, MAX_PACK_BYTES, orbPreferencesSchema, parseOrbPack, restoreOrbPreferences, type InstallationOrbs, type OrbPack, type OrbPreferences } from '../contract/orb-packs.js';

class OrbError extends Error { constructor(message: string, readonly statusCode: number) { super(message); } }
const savedSchema = z.object({ revision: z.number().int().nonnegative(), configured: z.boolean(), preferences: orbPreferencesSchema }).strict();
const packId = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/);
interface PackRow { id: string; hash: string; manifest: string; body: string; }

/** Artwork and preferences share the backed-up VC database, never a public directory. */
export class OrbSettings {
  constructor(private store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS orb_packs (id TEXT PRIMARY KEY, hash TEXT NOT NULL, manifest TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orb_migrations (hash TEXT PRIMARY KEY, pack_id TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);`);
  }
  private config() {
    const raw = this.store.get('orb-appearance');
    // A damaged record must fail, not silently erase a shared choice.
    return raw ? savedSchema.parse(JSON.parse(raw)) : { revision: 0, configured: false, preferences: restoreOrbPreferences(null) };
  }
  read(): InstallationOrbs {
    const packs = (this.store.db.prepare('SELECT id, hash, manifest FROM orb_packs ORDER BY rowid').all() as unknown as PackRow[]).map(row => {
      const manifest = JSON.parse(row.manifest) as Omit<OrbPack, 'atlas' | 'flow'> & { hasFlow: boolean };
      const { hasFlow, ...pack } = manifest, root = `/api/orbs/packs/${row.id}`;
      return { ...pack, atlas: `${root}/atlas.png?v=${row.hash}`, ...(hasFlow ? { flow: `${root}/flow.png?v=${row.hash}` } : {}) };
    });
    return { ...this.config(), packs };
  }
  private row(id: string) { return this.store.db.prepare('SELECT * FROM orb_packs WHERE id=?').get(id) as unknown as PackRow | undefined; }
  private exists(id: string) { return id === 'classic' || id === LUMINOUS_GLASS.id || Boolean(this.row(id)); }
  private transaction<T>(fn: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.store.db.exec('COMMIT'); return value; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  private write(preferences: OrbPreferences, configured: boolean) {
    const next = { revision: this.config().revision + 1, configured, preferences };
    this.store.set('orb-appearance', JSON.stringify(next));
  }
  save(revision: number, patch: Partial<OrbPreferences>): InstallationOrbs {
    return this.transaction(() => {
      const before = this.config();
      if (revision !== before.revision) throw new OrbError('Orb appearance changed on another device. Your view has been refreshed; choose again to replace it.', 409);
      const next = orbPreferencesSchema.parse({ ...before.preferences, ...patch });
      if (!this.exists(next.packId)) throw new OrbError('This orb is no longer installed. Choose another face.', 409);
      this.write(next, true); return this.read();
    });
  }
  async import(value: unknown, migration = false, appearance?: OrbPreferences): Promise<{ id: string | null; state: InstallationOrbs }> {
    let pack: OrbPack;
    try { pack = parseOrbPack(JSON.stringify(value)); }
    catch (error) { throw new OrbError(error instanceof Error ? error.message : 'Invalid orb pack.', 400); }
    const hash = digest(JSON.stringify(pack));
    // Bound actual decoder work too. Flow pixels are validated, never re-encoded.
    try {
      for (const uri of [pack.atlas, pack.flow].filter((v): v is string => Boolean(v))) {
        const bytes = Buffer.from(uri.slice('data:image/png;base64,'.length), 'base64');
        await sharp(bytes, { limitInputPixels: 1536 * 1536, failOn: 'warning' }).raw().toBuffer();
      }
    } catch { throw new OrbError('The orb artwork could not be decoded as a valid PNG.', 400); }
    return this.transaction(() => {
      const prior = migration ? this.store.db.prepare('SELECT pack_id, deleted FROM orb_migrations WHERE hash=?').get(hash) as { pack_id: string; deleted: number } | undefined : undefined;
      // A stale browser must not resurrect a pack deliberately removed elsewhere.
      if (prior && (prior.deleted || !this.row(prior.pack_id))) return { id: null, state: this.read() };
      let id = prior?.pack_id ?? pack.id;
      let existing = this.row(id);
      if (existing && existing.hash !== hash) {
        if (!migration) throw new OrbError('A different pack already uses this ID. Give your pack a new ID before importing.', 409);
        for (let n = 0; n <= MAX_CUSTOM_PACKS; n++) {
          id = `${pack.id.slice(0, 30)}-${hash.slice(0, 12)}${n ? `-${n}` : ''}`;
          existing = this.row(id); if (!existing || existing.hash === hash) break;
        }
      }
      if (!existing) {
        const count = (this.store.db.prepare('SELECT count(*) AS n FROM orb_packs').get() as { n: number }).n;
        if (count >= MAX_CUSTOM_PACKS) throw new OrbError('This installation already has eight imported orbs. Export and remove one before adding another. Device copies are kept.', 409);
        const { atlas, flow, ...manifest } = { ...pack, id };
        this.store.db.prepare('INSERT INTO orb_packs VALUES (?,?,?,?)').run(id, hash, JSON.stringify({ ...manifest, hasFlow: Boolean(flow) }), JSON.stringify({ ...pack, id }));
      }
      if (migration) this.store.db.prepare('INSERT OR IGNORE INTO orb_migrations (hash,pack_id) VALUES (?,?)').run(hash, id);
      const before = this.config();
      const seed = migration && !before.configured && appearance?.packId === pack.id;
      if (!migration || seed) this.write({ ...(seed ? appearance! : before.preferences), packId: id }, true);
      else if (!existing) this.write(before.preferences, before.configured);
      return { id, state: this.read() };
    });
  }
  remove(id: string, revision: number): InstallationOrbs {
    return this.transaction(() => {
      const before = this.config();
      if (revision !== before.revision) throw new OrbError('Orb appearance changed elsewhere. Refresh before removing a shared pack.', 409);
      const row = this.row(id);
      if (!row) throw new OrbError('This imported orb is no longer installed.', 404);
      // Remember even manually imported packs so legacy migration cannot undo deletion.
      this.store.db.prepare('INSERT OR IGNORE INTO orb_migrations (hash,pack_id,deleted) VALUES (?,?,1)').run(row.hash, id);
      this.store.db.prepare('UPDATE orb_migrations SET deleted=1 WHERE pack_id=?').run(id);
      this.store.db.prepare('DELETE FROM orb_packs WHERE id=?').run(id);
      this.write({ ...before.preferences, ...(before.preferences.packId === id ? { packId: 'classic' } : {}) }, before.configured);
      return this.read();
    });
  }
  asset(id: string, kind: 'atlas' | 'flow'): Buffer {
    const row = this.row(id); if (!row) throw new OrbError('This orb is no longer installed.', 404);
    const uri = (JSON.parse(row.body) as OrbPack)[kind];
    if (!uri) throw new OrbError('This artwork is unavailable.', 404);
    return Buffer.from(uri.slice('data:image/png;base64,'.length), 'base64');
  }
}

export function registerOrbRoutes(app: FastifyInstance, store: Store) {
  const orbs = new OrbSettings(store);
  const run = async (reply: FastifyReply, fn: () => unknown) => {
    try { return await fn(); }
    catch (error) { if (error instanceof OrbError) return reply.code(error.statusCode).send({ error: error.message }); throw error; }
  };
  app.get('/api/orbs', async () => orbs.read());
  app.patch('/api/orbs/preferences', async (req, reply) => run(reply, () => {
    const body = z.object({ revision: z.number().int().nonnegative(), patch: orbPreferencesSchema.partial().refine(p => Object.keys(p).length > 0) }).strict().parse(req.body);
    return orbs.save(body.revision, body.patch);
  }));
  const upload = { bodyLimit: MAX_PACK_BYTES + 1024, config: { rateLimit: { max: 24, timeWindow: 60000 } } };
  app.post('/api/orbs/packs', upload, async (req, reply) => run(reply, () => orbs.import(req.body)));
  app.post('/api/orbs/migrate', upload, async (req, reply) => run(reply, () => {
    const body = z.object({ pack: z.unknown(), appearance: orbPreferencesSchema.optional() }).strict().parse(req.body);
    return orbs.import(body.pack, true, body.appearance);
  }));
  app.delete('/api/orbs/packs/:id', async (req, reply) => run(reply, () => {
    const { id } = z.object({ id: packId }).parse(req.params);
    const { revision } = z.object({ revision: z.number().int().nonnegative() }).strict().parse(req.body);
    return orbs.remove(id, revision);
  }));
  app.get('/api/orbs/packs/:id/:asset', async (req, reply) => run(reply, () => {
    const { id, asset } = z.object({ id: packId, asset: z.enum(['atlas.png', 'flow.png']) }).parse(req.params);
    const bytes = orbs.asset(id, asset === 'atlas.png' ? 'atlas' : 'flow');
    return reply.type('image/png').send(bytes);
  }));
}
