import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { InstallationSpeech } from '../contract/types.js';
import { DEFAULT_FISH_DELIVERY, FISH_DELIVERIES } from '../contract/fish-delivery.js';

export const speechSelection = z.object({
  recognition: z.enum(['vosk', 'deepgram', 'browser']), output: z.enum(['fish', 'browser']),
  fishVoice: z.string().trim().max(128).regex(/^[a-zA-Z0-9_-]*$/),
  fishDelivery: z.enum(FISH_DELIVERIES).optional(),
}).strict();
const stored = speechSelection.extend({ fishDelivery: z.enum(FISH_DELIVERIES).default(DEFAULT_FISH_DELIVERY), version: z.literal(1), revision: z.number().int().nonnegative(), setupComplete: z.boolean() }).strict();

/** Only non-secret installation choices. Browser preferences never seed this file. */
export class SpeechSettings {
  readonly path: string;
  constructor(directory: string) { this.path = join(directory, 'preferences.json'); }
  read(): InstallationSpeech {
    if (!existsSync(this.path)) return { version: 1, revision: 0, setupComplete: false, recognition: 'vosk', output: 'browser', fishVoice: '', fishDelivery: DEFAULT_FISH_DELIVERY };
    // Invalid settings fail visibly; never overwrite a damaged file with defaults.
    return stored.parse(JSON.parse(readFileSync(this.path, 'utf8')));
  }
  save(selection: z.input<typeof speechSelection>, revision: number): InstallationSpeech {
    const before = this.read();
    if (before.revision !== revision) throw Object.assign(new Error('Settings changed elsewhere. Reopen Settings before saving.'), { statusCode: 409 });
    const parsed = speechSelection.parse(selection);
    const next: InstallationSpeech = { ...parsed, fishDelivery: parsed.fishDelivery ?? before.fishDelivery ?? DEFAULT_FISH_DELIVERY, version: 1, revision: before.revision + 1, setupComplete: true };
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    const file = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(file, JSON.stringify(next, null, 2) + '\n'); fsyncSync(file); }
    finally { closeSync(file); }
    try { renameSync(temporary, this.path); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return next;
  }
}
