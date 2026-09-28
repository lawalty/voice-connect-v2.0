import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../service/config.js';

afterEach(()=>vi.unstubAllEnvs());

describe('Gateway admin opt-in',()=>{
  it.each([undefined,'false','1','TRUE','true'])('only enables admin for the exact explicit true value: %s',value=>{
    vi.stubEnv('VC_GATEWAY_ADMIN',value);
    const stateDir=mkdtempSync(join(tmpdir(),'vc2-gateway-permissions-'));
    try {
      const config=loadConfig({stateDir,masterKey:randomBytes(32),gatewayToken:'',bootstrapToken:'',libraryToken:'',voskToken:''});
      expect(config.gatewayAdmin).toBe(value==='true');
    } finally {rmSync(stateDir,{recursive:true,force:true});}
  });
});
