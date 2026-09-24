import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import type { Store } from './store.js';

/** Application identity for the Gateway protocol; unrelated to machine SSH credentials. */
export function signGatewayChallenge(store:Store, token:string, nonce:string, signedAt:number, scopes:string[]) {
  let encoded=store.get('gateway-device');
  if(!encoded){
    const generated=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}).toString();
    encoded=store.encrypt(generated);store.set('gateway-device',encoded);
  }
  const privateKey=createPrivateKey(store.decrypt(encoded));
  const publicKey=createPublicKey(privateKey).export({format:'jwk'}).x!;
  const id=createHash('sha256').update(Buffer.from(publicKey,'base64url')).digest('hex');
  const payload=['v3',id,'gateway-client','backend','operator',scopes.join(','),String(signedAt),token,nonce,'linux',''].join('|');
  return {id,publicKey,signature:sign(null,Buffer.from(payload),privateKey).toString('base64url'),signedAt,nonce};
}
