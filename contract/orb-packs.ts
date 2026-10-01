import { z } from 'zod';

export const MAX_PACK_BYTES = 6 * 1024 * 1024;
export const MAX_CUSTOM_PACKS = 8;
export const PACK_RENDERER = 'glass-face-v1';
export const packSchema = z.object({
  version: z.literal(1), renderer: z.literal(PACK_RENDERER),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/), name: z.string().trim().min(1).max(48),
  atlas: z.string().max(MAX_PACK_BYTES), flow: z.string().max(MAX_PACK_BYTES).optional(),
  motion: z.object({ yaw: z.number().min(0).max(20), pitch: z.number().min(0).max(12), roll: z.number().min(0).max(12) }).strict(),
}).strict();
export type OrbPack = z.infer<typeof packSchema>;
export const LUMINOUS_GLASS: OrbPack = Object.freeze({ version: 1, renderer: PACK_RENDERER, id: 'luminous-glass', name: 'Luminous Glass',
  atlas: '/orb-packs/luminous-glass/atlas.png', flow: '/orb-packs/luminous-glass/flow.png', motion: { yaw: 14, pitch: 7, roll: 7 } });
export interface OrbPreferences { packId: string; motion: number; phaseColors: boolean; }
export const orbPreferencesSchema = z.object({
  packId: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/),
  motion: z.number().min(0).max(1.5), phaseColors: z.boolean(),
}).strict();
export interface InstallationOrbs {
  revision: number; configured: boolean; preferences: OrbPreferences;
  /** Authenticated artwork URLs; embedded PNGs stay out of the settings response. */
  packs: OrbPack[];
}
export function restoreOrbPreferences(raw: string | null): OrbPreferences {
  try { const value = JSON.parse(raw || '{}'); return { packId: typeof value?.packId === 'string' && value.packId.length < 60 ? value.packId : 'classic',
    motion: typeof value?.motion === 'number' && Number.isFinite(value.motion) ? Math.max(0, Math.min(1.5, value.motion)) : 1,
    phaseColors: typeof value?.phaseColors === 'boolean' ? value.phaseColors : true }; }
  catch { return { packId: 'classic', motion: 1, phaseColors: true }; }
}

/** Check dimensions before invoking an image decoder; imported packs never fetch URLs. */
export function pngDimensions(uri: string): number {
  const prefix = 'data:image/png;base64,';
  if (!uri.startsWith(prefix) || uri.length > MAX_PACK_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(uri.slice(prefix.length))) throw new Error('Pack artwork must be an embedded PNG.');
  let raw: string;
  try { raw = atob(uri.slice(prefix.length)); } catch { throw new Error('Pack artwork is not valid PNG data.'); }
  if (raw.length < 33 || raw.slice(0, 8) !== '\x89PNG\r\n\x1a\n' || raw.slice(12,16) !== 'IHDR') throw new Error('Pack artwork is not a PNG.');
  const uint = (at: number) => (raw.charCodeAt(at) * 16777216 + (raw.charCodeAt(at+1) << 16) + (raw.charCodeAt(at+2) << 8) + raw.charCodeAt(at+3));
  const size = uint(16);
  if (size !== uint(20) || size < 384 || size > 1536 || size % 3 !== 0) throw new Error('Use a square 3 × 3 atlas, from 384 to 1536 pixels wide.');
  let at = 8, ended = false;
  while (at + 12 <= raw.length) {
    const length = uint(at), kind = raw.slice(at+4,at+8);
    if (at + length + 12 > raw.length) throw new Error('PNG data is incomplete.');
    if (kind === 'acTL') throw new Error('Use a still PNG atlas, not an animated PNG.');
    at += length + 12;
    if (kind === 'IEND') { ended = true; break; }
  }
  if (!ended) throw new Error('PNG data is incomplete.');
  return size;
}
export function parseOrbPack(text: string): OrbPack {
  if (new TextEncoder().encode(text).byteLength > MAX_PACK_BYTES) throw new Error('Orb packs must be smaller than 6 MB.');
  let pack: OrbPack;
  try { pack = packSchema.parse(JSON.parse(text)); } catch { throw new Error('This is not a supported version 1 orb pack.'); }
  if (pack.id === 'classic' || pack.id === LUMINOUS_GLASS.id) throw new Error('Give your custom pack a unique ID before importing it.');
  const size = pngDimensions(pack.atlas);
  if (pack.flow && pngDimensions(pack.flow) !== size) throw new Error('The atlas and motion map must have the same dimensions.');
  return pack;
}
