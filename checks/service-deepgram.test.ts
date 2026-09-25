import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { buildApp } from '../service/main';
import { Store } from '../service/store';
import * as recognition from '../service/audio';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.reverse())await fn();cleanup.length=0;vi.restoreAllMocks();});
const origin='http://127.0.0.1:5173',oldKey='synthetic-old-deepgram-key',newKey='synthetic-new-deepgram-key';
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'vc2-deepgram-'));
  const verifier=vi.fn<(key:string)=>Promise<recognition.DeepgramVerification>>().mockResolvedValue({ok:true});
  const app=await buildApp({config:{stateDir:dir,masterKey:randomBytes(32),gatewayEnabled:false,gatewayToken:'',staticDir:join(dir,'absent'),origin,secureCookie:false},verifyDeepgramKey:verifier});
  cleanup.push(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const store=(app as unknown as {vc:{store:Store}}).vc.store,session=store.createSession();
  const headers={origin,cookie:`vc_session=${session.token}`,'x-csrf-token':session.csrf};
  const save=(apiKey:string)=>app.inject({method:'PUT',url:'/api/settings/deepgram',headers,payload:{apiKey}});
  const check=()=>app.inject({method:'POST',url:'/api/settings/deepgram/check',headers});
  const remove=()=>app.inject({method:'DELETE',url:'/api/settings/deepgram',headers});
  return {app,store,session,headers,verifier,save,check,remove};
}
describe('verified Deepgram credential lifecycle',()=>{
  it('trims and verifies before encrypting, then checks the saved credential without modifying it',async()=>{
    const f=await fixture();let release!:(value:recognition.DeepgramVerification)=>void;
    f.verifier.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const pending=f.save(` \t${newKey}\r\n `).then(response=>response);
    await expect.poll(()=>f.verifier.mock.calls.length).toBe(1);
    expect(f.verifier).toHaveBeenCalledWith(newKey);expect(f.store.deepgramKey()).toBe('');
    release({ok:true});const saved=await pending;expect(saved.statusCode).toBe(200);expect(saved.json()).toEqual({ok:true,verified:true});
    expect(f.store.deepgramKey()).toBe(newKey);const encrypted=f.store.get('deepgram');expect(encrypted).not.toContain(newKey);
    const checked=await f.check();expect(checked.statusCode).toBe(200);expect(checked.json()).toEqual({ok:true,verified:true});
    expect(f.verifier).toHaveBeenLastCalledWith(newKey);expect(f.store.get('deepgram')).toBe(encrypted);
    expect((await f.app.inject({url:'/api/settings',headers:f.headers})).body).not.toContain(newKey);
  });
  it('preserves the previous ciphertext on authentication rejection and safely contains thrown failures',async()=>{
    const f=await fixture();await f.save(oldKey);const encrypted=f.store.get('deepgram');
    f.verifier.mockResolvedValueOnce({ok:false,reason:'http',status:401});
    const denied=await f.save(newKey);expect(denied.statusCode).toBe(422);expect(denied.json().error).toContain('HTTP 401');expect(f.store.get('deepgram')).toBe(encrypted);
    f.verifier.mockRejectedValueOnce(new Error(`Authorization: ${newKey} private response`));
    const failed=await f.save(newKey);expect(failed.statusCode).toBe(422);expect(failed.json().error).toContain('could not connect');
    expect(failed.body).not.toMatch(/synthetic|Authorization|private response/);expect(f.store.get('deepgram')).toBe(encrypted);
    f.verifier.mockResolvedValueOnce({ok:false,reason:'http',status:403});
    const checked=await f.check();expect(checked.statusCode).toBe(422);expect(checked.json().error).toContain('HTTP 403');expect(f.store.get('deepgram')).toBe(encrypted);
  });
  it('requires a saved key for checks and rejects invalid candidates before calling the verifier',async()=>{
    const f=await fixture();expect((await f.check()).statusCode).toBe(400);
    for(const key of ['too-short','synthetic key with spaces','synthetic-key\nwith-control'])expect((await f.save(key)).statusCode).toBe(400);
    expect(f.verifier).not.toHaveBeenCalled();expect(f.store.deepgramKey()).toBe('');
  });
  it.each(['PUT','POST'] as const)('protects %s verification with session, exact origin, and CSRF',async method=>{
    const f=await fixture(),url=method==='PUT'?'/api/settings/deepgram':'/api/settings/deepgram/check',payload=method==='PUT'?{apiKey:newKey}:undefined;
    expect((await f.app.inject({method,url,headers:{origin},payload})).statusCode).toBe(401);
    expect((await f.app.inject({method,url,headers:{...f.headers,origin:'https://other.example'},payload})).statusCode).toBe(403);
    expect((await f.app.inject({method,url,headers:{origin,cookie:f.headers.cookie},payload})).statusCode).toBe(403);
    expect(f.verifier).not.toHaveBeenCalled();
  });
  it('shares a six-attempt minute limit across saves and checks',async()=>{
    const f=await fixture();await f.save(oldKey);
    for(let attempt=0;attempt<5;attempt++)expect((await(attempt%2===0?f.check():f.save(newKey))).statusCode).toBe(200);
    for(const request of [f.check,f.save.bind(null,newKey)]){const limited=await request();expect(limited.statusCode).toBe(429);expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);}
    expect(f.verifier).toHaveBeenCalledTimes(6);
  });
  it.each(['removed','replaced','signed-out'] as const)('does not apply an in-flight save after the credential is %s',async change=>{
    const f=await fixture();await f.save(oldKey);let release!:(value:recognition.DeepgramVerification)=>void;
    f.verifier.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const pending=f.save(newKey).then(response=>response);await expect.poll(()=>f.verifier.mock.calls.length).toBe(2);
    if(change==='removed')await f.remove();
    else if(change==='replaced')await f.save('synthetic-concurrent-key');
    else await f.app.inject({method:'POST',url:'/api/auth/logout',headers:f.headers});
    const current=f.store.get('deepgram');release({ok:true});const response=await pending;
    expect(response.statusCode).toBe(change==='signed-out'?401:409);expect(f.store.get('deepgram')).toBe(current);expect(f.store.deepgramKey()).not.toBe(newKey);
  });
  it('does not resurrect a pending first key after removal while no key was yet stored',async()=>{
    const f=await fixture();let release!:(value:recognition.DeepgramVerification)=>void;
    f.verifier.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const pending=f.save(newKey).then(response=>response);await expect.poll(()=>f.verifier.mock.calls.length).toBe(1);
    await f.remove();release({ok:true});expect((await pending).statusCode).toBe(409);expect(f.store.deepgramKey()).toBe('');
  });
  it('closes active Deepgram sockets only on successful credential replacement or removal',async()=>{
    const f=await fixture();await f.save(oldKey);f.store.set('default-agent','northpointe');const conversation=f.store.createConversation();
    vi.spyOn(recognition,'bridgeRecognition').mockImplementation(socket=>socket.send(JSON.stringify({type:'ready',sampleRate:16000})));
    const address=await f.app.listen({host:'127.0.0.1',port:0}),clients:WebSocket[]=[];
    const connect=(path:string)=>new Promise<WebSocket>((resolve,reject)=>{
      const socket=new WebSocket(`${address.replace('http:','ws:')}${path}?conversationId=${conversation.id}${path==='/api/audio'?'&kind=stt':''}`,{headers:f.headers});clients.push(socket);
      socket.once('error',reject);socket.once('message',()=>resolve(socket));
    });
    try {
      const events=await connect('/api/events'),first=await connect('/api/audio');
      f.verifier.mockResolvedValueOnce({ok:false,reason:'http',status:401});expect((await f.save(newKey)).statusCode).toBe(422);expect(first.readyState).toBe(WebSocket.OPEN);
      await f.check();expect(first.readyState).toBe(WebSocket.OPEN);
      const closed=new Promise<void>(resolve=>first.once('close',()=>resolve()));await f.save(newKey);await closed;expect(events.readyState).toBe(WebSocket.OPEN);
      const second=await connect('/api/audio'),removed=new Promise<void>(resolve=>second.once('close',()=>resolve()));await f.remove();await removed;expect(events.readyState).toBe(WebSocket.OPEN);
    } finally {for(const socket of clients)socket.terminate();}
  });
});
