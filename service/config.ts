import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ServiceConfig {
  origin: string; stateDir: string; gatewayUrl: string; gatewayToken: string;
  masterKey: Buffer; bootstrapToken: string; build: string; host: string; port: number;
  secureCookie: boolean; staticDir: string; gatewayEnabled: boolean; qualifiedImageModels: string[]; gatewayModel: string;
}
function secretFile(name: string, optional=false): string {
  const path = process.env[name];
  try {return path ? readFileSync(path, 'utf8').trim() : '';}
  catch(error){if(optional&&(error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error;}
}
export function loadConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  const stateDir = overrides.stateDir ?? process.env.VC_STATE_DIR ?? resolve('.state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const origin = overrides.origin ?? process.env.VC_ORIGIN ?? 'http://127.0.0.1:5173';
  const key = overrides.masterKey ?? Buffer.from(secretFile('VC_MASTER_KEY_FILE'), 'hex');
  if (key.length !== 32) throw new Error('VC master key must be a 32-byte hex key in VC_MASTER_KEY_FILE. Run bootstrap first.');
  return {
    origin: new URL(origin).origin, stateDir,
    gatewayUrl: process.env.VC_GATEWAY_URL ?? 'ws://127.0.0.1:18789',
    gatewayToken: overrides.gatewayToken??secretFile('VC_GATEWAY_TOKEN_FILE'), masterKey: key,
    bootstrapToken: overrides.bootstrapToken??secretFile('VC_BOOTSTRAP_TOKEN_FILE',true), build: process.env.VC_BUILD ?? 'development',
    host: process.env.VC_HOST ?? '127.0.0.1', port: Number(process.env.VC_PORT ?? 18880),
    secureCookie: origin.startsWith('https:'), staticDir: resolve('dist/client'), gatewayEnabled: true,
    qualifiedImageModels:(process.env.VC_IMAGE_MODEL_ALLOWLIST??'').split(',').map(v=>v.trim()).filter(Boolean),gatewayModel:process.env.VC_GATEWAY_MODEL??'',
    ...overrides,
  };
}
