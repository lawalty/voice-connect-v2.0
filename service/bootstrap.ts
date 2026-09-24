import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const args=process.argv.slice(2);
function option(name:string,fallback:string):string {const i=args.indexOf(name);return i>=0&&args[i+1]?resolve(args[i+1]):resolve(fallback);}
const dir=option('--state-dir',process.env.VC_STATE_DIR??'.state');
const master=option('--master-key-file',process.env.VC_MASTER_KEY_FILE??`${dir}/master.key`);
const token=option('--token-file',process.env.VC_BOOTSTRAP_TOKEN_FILE??`${dir}/bootstrap.token`);
mkdirSync(dir,{recursive:true,mode:0o700});
for(const [path,value] of [[master,randomBytes(32).toString('hex')],[token,randomBytes(32).toString('base64url')]]){
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  if(!existsSync(path))writeFileSync(path,value+'\n',{flag:'wx',mode:0o600});
}
process.stdout.write('Private bootstrap files are ready. Existing secrets and owner accounts were preserved.\n');
