import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash, createPublicKey, verify } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { buildApp } from '../service/main.js';
import { Gateway } from '../service/gateway.js';
import type { ServerEvent } from '../contract/types.js';
import { Store } from '../service/store.js';
import { signGatewayChallenge } from '../service/identity.js';
import sharp from 'sharp';
import { loadConfig } from '../service/config.js';
import * as recognition from '../service/audio.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.reverse())await fn();cleanup.length=0;});
const origin='http://127.0.0.1:5173',bootstrap='test-bootstrap-token-that-is-long-enough';
describe('isolated local recognition worker policy',()=>{
  it('allows generated JS only on the exact worker asset, including cache validation, never HTML fallback',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'vc2-worker-policy-')),staticDir=join(dir,'public');
    mkdirSync(join(staticDir,'audio'),{recursive:true});mkdirSync(join(staticDir,'runtime'));
    writeFileSync(join(staticDir,'index.html'),'<!doctype html><title>Strict document</title>');
    writeFileSync(join(staticDir,'audio','vosk.worker.js'),'self.onmessage = () => {};');
    writeFileSync(join(staticDir,'audio','other.js'),'void 0;');writeFileSync(join(staticDir,'runtime','vosk.js'),'void 0;');
    const app=await buildApp({config:{stateDir:dir,masterKey:randomBytes(32),gatewayToken:'',gatewayEnabled:false,staticDir,origin}});
    cleanup.push(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
    const header=(r:{headers:Record<string,unknown>})=>String(r.headers['content-security-policy']);
    const worker=await app.inject({url:'/audio/vosk.worker.js'});expect(worker.statusCode).toBe(200);expect(header(worker)).toContain("'unsafe-eval'");expect(header(worker)).toContain("worker-src 'self' blob:");expect(header(worker)).toContain("connect-src 'self' blob:");
    expect(header(await app.inject({method:'HEAD',url:'/audio/vosk.worker.js?v=test'}))).toContain("'unsafe-eval'");
    const cached=await app.inject({url:'/audio/vosk.worker.js',headers:{'if-none-match':String(worker.headers.etag)}});expect(cached.statusCode).toBe(304);expect(header(cached)).toContain("'unsafe-eval'");
    for(const url of ['/','/index.html','/audio/other.js','/runtime/vosk.js','/audio/vosk.worker.js.map','/audio/vosk.worker.js/anything','/audio/%76osk.worker.js'])expect(header(await app.inject({url}))).not.toContain("'unsafe-eval'");
    for(const url of ['/%61pi/settings','/%61pi/no-such-endpoint','/a%70i/conversations?next=/api/status']){const protectedResponse=await app.inject({url});expect(protectedResponse.statusCode).toBe(401);expect(String(protectedResponse.headers['content-type'])).toContain('application/json');expect(header(protectedResponse)).not.toContain("'unsafe-eval'");}
    unlinkSync(join(staticDir,'audio','vosk.worker.js'));
    const missing=await app.inject({url:'/audio/vosk.worker.js'});expect(String(missing.headers['content-type'])).toContain('text/html');expect(header(missing)).not.toContain("'unsafe-eval'");
  });
});
async function fixture(unremovableBootstrap=false) {
  const dir=mkdtempSync(join(tmpdir(),'vc2-service-'));
  const server=new WebSocketServer({port:0});await new Promise<void>(resolve=>server.once('listening',()=>resolve()));
  const calls:{method:string;params:any}[]=[],clients=new Set<WebSocket>(),events:ServerEvent[]=[];
  let holdSend=false,rejectAbort=false,history:any,pendingApprovals:any[]=[];const held:(()=>void)[]=[];
  server.on('connection',socket=>{
    clients.add(socket);socket.on('close',()=>clients.delete(socket));
    socket.send(JSON.stringify({type:'event',event:'connect.challenge',payload:{nonce:'fixture',ts:Date.now()}}));
    socket.on('message',raw=>{
      const request=JSON.parse(raw.toString());calls.push({method:request.method,params:request.params});
      if('sessionId'in request.params&&typeof request.params.sessionId!=='string'){socket.send(JSON.stringify({type:'res',id:request.id,ok:false,error:{code:'INVALID_REQUEST'}}));return;}
      if((request.method==='chat.abort'&&('sessionId'in request.params||rejectAbort))||(request.method==='chat.history'&&'sessionId'in request.params&&!request.params.messageId)){socket.send(JSON.stringify({type:'res',id:request.id,ok:false,error:{code:'INVALID_REQUEST'}}));return;}
      let payload:any={};
      if(request.method==='connect')payload={type:'hello-ok',protocol:4,server:{version:'2026.9.6-fixture'},features:{methods:['chat.send','chat.history','chat.abort','agents.list','models.list','sessions.messages.subscribe','exec.approval.resolve','exec.approval.list','question.resolve']},snapshot:{sessionDefaults:{model:'openai/verified-image-model'}}};
      if(request.method==='agents.list')payload={defaultId:'northpointe',agents:[{id:'northpointe',name:'NorthPointe'}]};
      if(request.method==='models.list')payload={models:[{id:'verified-image-model',provider:'openai',input:['text','image']}]};
      if(request.method==='chat.history')payload=history??{sessionId:'session-fixture',messages:[],sessionInfo:{model:'verified-image-model',modelProvider:'openai'}};
      if(request.method==='chat.send')payload={runId:request.params.idempotencyKey,status:'started'};
      if(request.method==='chat.abort')payload={ok:true,aborted:true,runIds:[request.params.runId]};
      if(request.method==='exec.approval.list')payload=pendingApprovals;
      const reply=()=>{if(socket.readyState===1)socket.send(JSON.stringify({type:'res',id:request.id,ok:true,payload}));};
      if(request.method==='chat.send'&&holdSend)held.push(reply);else reply();
    });
  });
  const address=server.address();if(typeof address==='string'||!address)throw new Error('No fixture port');
  const app=await buildApp({config:{stateDir:dir,masterKey:randomBytes(32),bootstrapToken:bootstrap,origin,secureCookie:false,gatewayUrl:`ws://127.0.0.1:${address.port}`,gatewayToken:'fixture-only',staticDir:join(dir,'absent')},verifyDeepgramKey:async()=>({ok:true}),gatewayFactory:(cfg,store,publish)=>new Gateway(cfg,store,e=>{events.push(e);publish(e);})});
  cleanup.push(async()=>{await app.close();for(const s of clients)s.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});});
  await expect.poll(async()=>{const r=await app.inject({method:'GET',url:'/health'});return r.json().openclaw;}).toBe(true);
  const previousBootstrapPath=process.env.VC_BOOTSTRAP_TOKEN_FILE;
  if(unremovableBootstrap){const simulatedMount=join(dir,'unremovable-token-mount');mkdirSync(simulatedMount);process.env.VC_BOOTSTRAP_TOKEN_FILE=simulatedMount;}
  let setup:Awaited<ReturnType<typeof app.inject>>;
  try {setup=await app.inject({method:'POST',url:'/api/auth/setup',headers:{origin},payload:{password:'a secure test password',bootstrapToken:bootstrap}});}
  finally {if(previousBootstrapPath===undefined)delete process.env.VC_BOOTSTRAP_TOKEN_FILE;else process.env.VC_BOOTSTRAP_TOKEN_FILE=previousBootstrapPath;}
  expect(setup.statusCode).toBe(200);
  const cookie=setup.cookies[0].name+'='+setup.cookies[0].value,csrf=setup.json().csrfToken;
  const headers={origin,cookie,'x-csrf-token':csrf};
  const created=await app.inject({method:'POST',url:'/api/conversations',headers,payload:{}});expect(created.statusCode).toBe(200);
  const conversation=created.json();
  const emit=(event:string,payload:any)=>{for(const socket of clients)socket.send(JSON.stringify({type:'event',event,payload}));};
  return {app,headers,cookie,csrf,conversation,calls,events,clients,emit,setHistory:(value:any)=>{history=value;},setApprovals:(value:any[])=>{pendingApprovals=value;},rejectCancellation:()=>{rejectAbort=true;},hold:()=>{holdSend=true;},release:()=>{holdSend=false;for(const fn of held.splice(0))fn();}};
}
describe('owner boundary',()=>{
  it('probes authenticated event delivery with independent revisions on both device connections',async()=>{
    const f=await fixture(),address=await f.app.listen({host:'127.0.0.1',port:0});
    const open=()=>{
      const received:ServerEvent[]=[];
      const socket=new WebSocket(`${address.replace('http:','ws:')}/api/events?conversationId=${f.conversation.id}`,{headers:{origin,cookie:f.cookie}});
      socket.on('message',raw=>received.push(JSON.parse(raw.toString())));
      return {socket,received};
    };
    const first=open(),second=open();
    try {
      for(const client of [first,second])await expect.poll(()=>client.received[0]).toMatchObject({type:'hello',revision:0});
      first.socket.send(JSON.stringify({type:'ping',nonce:'before-send'}));
      await expect.poll(()=>first.received.at(-1)).toEqual({type:'pong',nonce:'before-send',revision:0});
      expect((await f.app.inject({method:'POST',url:`/api/conversations/${f.conversation.id}/turns`,headers:f.headers,payload:{id:'two-device-turn',text:'Synthetic device delivery check'}})).statusCode).toBe(200);
      for(const client of [first,second]){
        await expect.poll(()=>client.received.some(e=>e.type==='turn'&&e.turnId==='two-device-turn'&&e.delivery==='accepted')).toBe(true);
        const events=client.received.filter(e=>e.type!=='pong'&&(e.revision??0)>0);
        expect(events.map(e=>e.revision)).toEqual(events.map((_,index)=>index+1));
        client.socket.send(JSON.stringify({type:'ping',nonce:'after-send'}));
        await expect.poll(()=>client.received.at(-1)).toEqual({type:'pong',nonce:'after-send',revision:events.length});
      }
      // Invalid control payloads cannot become stored conversation text.
      first.socket.send(JSON.stringify({type:'ping',nonce:'not-accepted',text:'must not be stored'}));
      first.socket.send(JSON.stringify({type:'ping',nonce:'valid-barrier'}));
      await expect.poll(()=>first.received.at(-1)).toMatchObject({type:'pong',nonce:'valid-barrier'});
      expect(first.received.some(e=>e.type==='pong'&&e.nonce==='not-accepted')).toBe(false);
      expect(f.calls.filter(call=>call.method==='chat.send')).toHaveLength(1);
    } finally {first.socket.terminate();second.socket.terminate();}
  });
  it('preserves HTTP 429 for the twelve-attempt authentication limit',async()=>{
    const f=await fixture();
    for(let attempt=0;attempt<12;attempt++)expect((await f.app.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{password:'an incorrect test password'}})).statusCode).toBe(401);
    const limited=await f.app.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{password:'an incorrect test password'}});
    expect(limited.statusCode).toBe(429);expect(limited.json()).toEqual({error:'Too many requests. Please wait a moment.'});expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
  it('preserves HTTP 429 at the unchanged global 240-request limit',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'vc2-rate-limit-'));
    const app=await buildApp({config:{stateDir:dir,masterKey:randomBytes(32),gatewayEnabled:false,gatewayToken:'',staticDir:join(dir,'absent'),origin}});
    cleanup.push(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
    for(let request=0;request<240;request++)expect((await app.inject({method:'GET',url:'/api/status'})).statusCode).toBe(200);
    const limited=await app.inject({method:'GET',url:'/api/status'});expect(limited.statusCode).toBe(429);expect(limited.json()).toEqual({error:'Too many requests. Please wait a moment.'});expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
  it('finishes one-time setup when a token mount cannot be deleted, and never guesses an agent',async()=>{
    const f=await fixture(true);expect((await f.app.inject({method:'GET',url:'/api/status',headers:f.headers})).json().authenticated).toBe(true);
    const store=(f.app as any).vc.store;store.remove('default-agent');
    expect((await f.app.inject({method:'POST',url:'/api/conversations',headers:f.headers,payload:{}})).statusCode).toBe(503);
    const prior=process.env.VC_BOOTSTRAP_TOKEN_FILE;process.env.VC_BOOTSTRAP_TOKEN_FILE=join((f.app as any).vc.cfg.stateDir,'missing-token');
    try {expect(loadConfig({stateDir:(f.app as any).vc.cfg.stateDir,masterKey:randomBytes(32),gatewayToken:'fixture-only'}).bootstrapToken).toBe('');}
    finally {if(prior===undefined)delete process.env.VC_BOOTSTRAP_TOKEN_FILE;else process.env.VC_BOOTSTRAP_TOKEN_FILE=prior;}
  });
  it('requires a session, exact origin, CSRF, and one-time owner setup',async()=>{
    const f=await fixture();
    expect((await f.app.inject({method:'GET',url:'/api/settings'})).statusCode).toBe(401);
    expect((await f.app.inject({method:'POST',url:'/api/conversations',headers:{...f.headers,origin:'https://other.example'},payload:{}})).statusCode).toBe(403);
    expect((await f.app.inject({method:'POST',url:'/api/conversations',headers:{origin,cookie:f.cookie},payload:{}})).statusCode).toBe(403);
    expect((await f.app.inject({method:'POST',url:'/api/auth/setup',headers:{origin},payload:{password:'another safe password',bootstrapToken:bootstrap}})).statusCode).toBe(409);
    const response=await f.app.inject({method:'GET',url:'/api/status',headers:{cookie:f.cookie}});expect(response.json().csrfToken).toBe(f.csrf);
  });
  it('protects router-decoded API aliases, query tricks, and noncanonical paths',async()=>{
    const f=await fixture();
    for(const url of ['/%61pi/settings','/a%70i/settings','/ap%69/settings','/api/%73ettings','/%61pi/conversations?next=/api/status','/%61pi/settings?path=/api/auth/login'])expect((await f.app.inject({method:'GET',url})).statusCode).toBe(401);
    for(const url of ['//api/settings','/api//settings','/%2e/api/settings','/api%2fsettings'])expect([400,401,403,404]).toContain((await f.app.inject({method:'GET',url})).statusCode);
    for(const url of ['/%61pi/conversations','/a%70i/conversations?path=/api/auth/login']){
      expect((await f.app.inject({method:'POST',url,headers:{origin},payload:{}})).statusCode).toBe(401);
      expect((await f.app.inject({method:'POST',url,headers:{...f.headers,origin:'https://other.example'},payload:{}})).statusCode).toBe(403);
      expect((await f.app.inject({method:'POST',url,headers:{origin,cookie:f.cookie},payload:{}})).statusCode).toBe(403);
    }
    expect((await f.app.inject({method:'POST',url:'/%61pi/auth/login',headers:{origin:'https://other.example'},payload:{password:'a secure test password'}})).statusCode).toBe(403);
    expect((await f.app.inject({method:'GET',url:'/%61pi/settings',headers:f.headers})).statusCode).toBe(200);
  });
  it('encrypts provider keys and revokes other sessions on password change',async()=>{
    const f=await fixture();const key='synthetic-deepgram-key-not-a-real-secret';
    expect((await f.app.inject({method:'PUT',url:'/api/settings/deepgram',headers:f.headers,payload:{apiKey:key}})).statusCode).toBe(200);
    const settings=await f.app.inject({method:'GET',url:'/api/settings',headers:f.headers});expect(settings.json().deepgramConfigured).toBe(true);expect(settings.body).not.toContain(key);
    const store=(f.app as any).vc.store;expect(store.get('deepgram')).not.toContain(key);expect(store.deepgramKey()).toBe(key);
    const fishKey='synthetic-fish-key-not-a-real-secret';
    expect((await f.app.inject({method:'PUT',url:'/api/settings/fish',headers:{origin,cookie:f.cookie},payload:{apiKey:fishKey}})).statusCode).toBe(403);
    expect((await f.app.inject({method:'PUT',url:'/api/settings/fish',headers:f.headers,payload:{apiKey:fishKey}})).statusCode).toBe(200);
    const fishSettings=await f.app.inject({url:'/api/settings',headers:f.headers});
    expect(fishSettings.json().fishConfigured).toBe(true);expect(fishSettings.body).not.toContain(fishKey);
    expect(store.get('fish')).not.toContain(fishKey);expect(store.fishKey()).toBe(fishKey);
    expect((await f.app.inject({method:'DELETE',url:'/api/settings/fish',headers:f.headers})).statusCode).toBe(200);
    expect(store.fishKey()).toBe('');expect(store.deepgramKey()).toBe(key);
    const login=await f.app.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{password:'a secure test password'}});
    const otherCookie=login.cookies[0].name+'='+login.cookies[0].value;
    expect((await f.app.inject({method:'POST',url:'/api/auth/password',headers:f.headers,payload:{currentPassword:'a secure test password',newPassword:'an updated secure password'}})).statusCode).toBe(200);
    expect((await f.app.inject({method:'GET',url:'/api/settings',headers:{cookie:otherCookie}})).statusCode).toBe(401);
    expect((await f.app.inject({method:'GET',url:'/api/settings',headers:f.headers})).statusCode).toBe(200);
  });
  it('rejects cross-origin or unauthenticated WebSockets and closes a logged-out socket',async()=>{
    const f=await fixture();const path=`/api/events?conversationId=${f.conversation.id}`;
    const address=await f.app.listen({host:'127.0.0.1',port:0});
    const connect=(headers:Record<string,string>,requestPath=path)=>new Promise<WebSocket>((resolve,reject)=>{const s=new WebSocket(address.replace('http:','ws:')+requestPath,{headers});s.once('open',()=>resolve(s));s.once('error',reject);});
    await expect(connect({origin})).rejects.toThrow('401');
    await expect(connect({cookie:f.cookie})).rejects.toThrow('403');
    await expect(connect({cookie:f.cookie,origin:'https://other.example'})).rejects.toThrow('403');
    for(const requestPath of [`/%61pi/events?conversationId=${f.conversation.id}`,`/a%70i/audio?kind=stt&conversationId=${f.conversation.id}`]){
      await expect(connect({origin},requestPath)).rejects.toThrow('401');
      await expect(connect({cookie:f.cookie},requestPath)).rejects.toThrow('403');
      await expect(connect({cookie:f.cookie,origin:'https://other.example'},requestPath)).rejects.toThrow('403');
    }
    const socket=await connect({cookie:f.cookie,origin},`/%61pi/events?conversationId=${f.conversation.id}`);
    const closed=new Promise<number>(resolve=>socket.once('close',code=>resolve(code)));
    expect((await f.app.inject({method:'POST',url:'/api/auth/logout',headers:f.headers})).statusCode).toBe(200);
    expect(await closed).toBe(1008);
  });
  it('rejects missing Fish credentials and rejects Fish recognition without opening a provider connection',async()=>{
    const f=await fixture(),address=await f.app.listen({host:'127.0.0.1',port:0});
    const attempt=(query:string)=>new Promise<string>((resolve,reject)=>{
      const socket=new WebSocket(`${address.replace('http:','ws:')}/api/audio?conversationId=${f.conversation.id}&${query}`,{headers:{origin,cookie:f.cookie}});
      socket.once('error',reject);socket.once('message',message=>{resolve(JSON.parse(message.toString()).message);socket.close();});
    });
    expect(await attempt('kind=tts&provider=fish&voice=my-voice')).toContain('Fish Audio API key');
    expect(await attempt('kind=stt&provider=fish&voice=my-voice')).toContain('speech output only');
    expect(await attempt('kind=tts&provider=fish')).toContain('voice ID');
    expect(await attempt('kind=tts&provider=fish&voice=https%3A%2F%2Fother.example')).toContain('supported speech provider');
  });
  it('rejects legacy Deepgram output before the upstream bridge while keeping recognition available',async()=>{
    const f=await fixture(),address=await f.app.listen({host:'127.0.0.1',port:0});
    await f.app.inject({method:'PUT',url:'/api/settings/deepgram',headers:f.headers,payload:{apiKey:'synthetic-recognition-key-not-a-secret'}});
    const bridge=vi.spyOn(recognition,'bridgeRecognition').mockImplementation(socket=>{socket.send(JSON.stringify({type:'ready',sampleRate:16000}));socket.close();});
    const attempt=(query:string)=>new Promise<{type:string;message?:string;sampleRate?:number}>((resolve,reject)=>{
      const socket=new WebSocket(`${address.replace('http:','ws:')}/api/audio?conversationId=${f.conversation.id}&${query}`,{headers:{origin,cookie:f.cookie}});
      socket.once('error',reject);socket.once('message',message=>{resolve(JSON.parse(message.toString()));socket.close();});
    });
    try {
      for(const query of ['kind=tts&provider=deepgram&voice=flux-haley-en','kind=tts&provider=deepgram','kind=tts&voice=flux-haley-en','kind=tts']){
        expect(await attempt(query)).toEqual({type:'error',message:'Deepgram is used for recognition only. Choose Fish Audio or Device voices for speech output.'});
      }
      expect(bridge).not.toHaveBeenCalled();
      expect(await attempt('kind=stt')).toEqual({type:'ready',sampleRate:16000});expect(bridge).toHaveBeenCalledOnce();
      expect((await f.app.inject({url:'/api/settings',headers:f.headers})).json()).not.toHaveProperty('premiumVoices');
    } finally {bridge.mockRestore();}
  });
  it('validates decoded image bytes, removes metadata, limits uploads, and protects previews',async()=>{
    const f=await fixture();
    const image=await sharp({create:{width:8,height:8,channels:3,background:'#cc2244'}}).jpeg().withMetadata().toBuffer();
    const upload=async(bytes:Buffer)=>f.app.inject({method:'POST',url:'/api/uploads',headers:{...f.headers,'content-type':'multipart/form-data; boundary=vc2test'},payload:Buffer.concat([Buffer.from('--vc2test\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'),bytes,Buffer.from('\r\n--vc2test--\r\n')])});
    const result=await upload(image);expect(result.statusCode).toBe(200);expect(result.json()).toMatchObject({mimeType:'image/jpeg',width:8,height:8});
    expect((await f.app.inject({method:'GET',url:result.json().previewUrl})).statusCode).toBe(401);
    const preview=await f.app.inject({method:'GET',url:result.json().previewUrl,headers:f.headers});expect(preview.statusCode).toBe(200);expect((await sharp(preview.rawPayload).metadata()).exif).toBeUndefined();
    expect((await upload(image.subarray(0,200))).statusCode).toBe(400);
    expect((await upload(Buffer.alloc(5*1024*1024+1))).statusCode).toBe(413);
    expect((await f.app.inject({method:'POST',url:`/api/conversations/${f.conversation.id}/turns`,headers:f.headers,payload:{id:'missing-image',text:'Look at this',attachments:['other-owner-image']}})).statusCode).toBe(409);
  });
});
describe('native OpenClaw lifecycle',()=>{
  it('restores only local owner image metadata to user history, including an image-only turn',async()=>{
    const f=await fixture(),url=`/api/conversations/${f.conversation.id}`,store=(f.app as any).vc.store;
    const meta={id:'local-photo',name:'image-local.png',mimeType:'image/png',width:2,height:2,previewUrl:'/api/attachments/local-photo'};
    store.saveAttachment(meta,await sharp({create:{width:2,height:2,channels:3,background:'#884422'}}).png().toBuffer());
    expect((await f.app.inject({method:'POST',url:`${url}/turns`,headers:f.headers,payload:{id:'photo-turn',text:'',attachments:['local-photo']}})).json().delivery).toBe('accepted');
    f.setHistory({sessionInfo:{lastRunId:'photo-turn',status:'done'},messages:[
      {id:'native-photo-user',role:'user',runId:'photo-turn',content:[{type:'image',data:'raw-native-image-not-for-ui'}]},
      {id:'native-photo-assistant',role:'assistant',runId:'photo-turn',content:[{type:'text',text:'I can see the picture.'},{type:'image',data:'raw-tool-image-not-for-ui'}]},
    ]});
    const view=await f.app.inject({method:'GET',url,headers:f.headers});expect(view.statusCode).toBe(200);
    expect(view.json().messages[0]).toMatchObject({role:'user',text:'',attachments:[meta]});
    expect(view.json().messages[1]).not.toHaveProperty('attachments');expect(view.body).not.toContain('raw-native-image');expect(view.body).not.toContain('raw-tool-image');
    const refreshed=await f.app.inject({method:'GET',url,headers:f.headers});expect(refreshed.json().messages[0].attachments).toEqual([meta]);
  });
  it('omits an unassigned native sessionId, then preserves the assigned identifier',async()=>{
    const f=await fixture(),url=`/api/conversations/${f.conversation.id}`;
    expect((f.app as any).vc.store.mapping(f.conversation.id)).not.toHaveProperty('sessionId');
    expect((await f.app.inject({method:'GET',url,headers:f.headers})).statusCode).toBe(200);
    expect(f.calls.find(c=>c.method==='chat.history')?.params).not.toHaveProperty('sessionId');
    await f.app.inject({method:'POST',url:`${url}/turns`,headers:f.headers,payload:{id:'assigned-session',text:'Continue the same native session'}});
    expect(f.calls.find(c=>c.method==='chat.send')?.params.sessionId).toBe('session-fixture');
    expect((await f.app.inject({method:'GET',url,headers:f.headers})).statusCode).toBe(200);
    const abort=await f.app.inject({method:'POST',url:`${url}/turns/assigned-session/abort`,headers:f.headers});expect(abort.statusCode).toBe(200);expect(abort.json().agentConfirmed).toBe(true);
    expect(f.calls.filter(c=>c.method==='chat.history'||c.method==='chat.abort').every(c=>!('sessionId'in c.params))).toBe(true);
  });
  it('keeps playback cancelled while reporting unconfirmed native cancellation honestly',async()=>{
    const f=await fixture(),url=`/api/conversations/${f.conversation.id}/turns`;
    await f.app.inject({method:'POST',url,headers:f.headers,payload:{id:'unconfirmed-cancel',text:'Cancel this safely'}});f.rejectCancellation();
    const result=await f.app.inject({method:'POST',url:`${url}/unconfirmed-cancel/abort`,headers:f.headers});expect(result.statusCode).toBe(202);expect(result.json()).toEqual({ok:true,agentConfirmed:false});
    expect((f.app as any).vc.store.turn('unconfirmed-cancel')).toMatchObject({delivery:'cancelled',cancelRequested:true});
    expect(f.events.find(e=>e.type==='turn'&&e.delivery==='cancelled'&&e.error)).toMatchObject({error:expect.stringContaining('not confirmed')});
    f.emit('chat',{runId:'unconfirmed-cancel',sessionKey:`agent:northpointe:vc2:${f.conversation.id}`,seq:1,state:'delta',deltaText:'Stale speech'});
    await new Promise(resolve=>setTimeout(resolve,20));expect(f.events.some(e=>e.type==='assistant')).toBe(false);
  });
  it('signs the exact challenge with a stable encrypted application identity and no admin permission',async()=>{
    const f=await fixture();const p=f.calls.find(c=>c.method==='connect')!.params,d=p.device;
    expect(p.scopes).not.toContain('operator.admin');
    const bytes=Buffer.from(d.publicKey,'base64url');expect(d.id).toBe(createHash('sha256').update(bytes).digest('hex'));
    const payload=['v3',d.id,'gateway-client','backend','operator',p.scopes.join(','),String(d.signedAt),'fixture-only',d.nonce,'linux',''].join('|');
    const key=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:d.publicKey},format:'jwk'});
    expect(verify(null,Buffer.from(payload),key,Buffer.from(d.signature,'base64url'))).toBe(true);
    const store=(f.app as any).vc.store;expect(store.get('gateway-device')).not.toContain('PRIVATE KEY');
    expect(signGatewayChallenge(store,'fixture-only','another',Date.now(),p.scopes).id).toBe(d.id);
  });
  it('uses discovered agent, preserves send identity, and implements delta replacement without duplication',async()=>{
    const f=await fixture();const url=`/api/conversations/${f.conversation.id}/turns`;
    const turn={id:'turn-one',text:'A complete coherent utterance'};
    const first=await f.app.inject({method:'POST',url,headers:f.headers,payload:turn});expect(first.json().delivery).toBe('accepted');
    const duplicate=await f.app.inject({method:'POST',url,headers:f.headers,payload:turn});expect(duplicate.json().runId).toBe('turn-one');
    expect(f.calls.filter(v=>v.method==='chat.send')).toHaveLength(1);
    expect(f.calls.find(v=>v.method==='chat.send')!.params.sessionKey).toBe(`agent:northpointe:vc2:${f.conversation.id}`);
    expect((await f.app.inject({method:'POST',url,headers:f.headers,payload:{...turn,text:'Different'}})).statusCode).toBe(409);
    const base={runId:'turn-one',sessionKey:`agent:northpointe:vc2:${f.conversation.id}`};
    f.emit('chat',{...base,seq:1,state:'delta',deltaText:'First '});
    f.emit('chat',{...base,seq:2,state:'delta',deltaText:'Second',replace:true});
    f.emit('chat',{...base,seq:2,state:'delta',deltaText:'duplicate'});
    f.emit('chat',{...base,seq:3,state:'final'});
    await expect.poll(()=>f.events.filter(e=>e.type==='complete').length).toBe(1);
    expect(f.events.filter(e=>e.type==='assistant')).toHaveLength(2);
    expect(f.events.find(e=>e.type==='complete')).toMatchObject({text:'Second'});
  });
  it('persists cancellation before a delayed acknowledgment and discards stale output',async()=>{
    const f=await fixture();f.hold();const url=`/api/conversations/${f.conversation.id}/turns`;
    const sending=f.app.inject({method:'POST',url,headers:f.headers,payload:{id:'cancel-me',text:'This turn will be interrupted'}});
    await expect.poll(()=>f.calls.filter(c=>c.method==='chat.send').length).toBe(1);
    expect((await f.app.inject({method:'POST',url:`${url}/cancel-me/abort`,headers:f.headers})).statusCode).toBe(200);
    f.release();expect((await sending).json().delivery).toBe('cancelled');
    f.emit('chat',{runId:'cancel-me',sessionKey:`agent:northpointe:vc2:${f.conversation.id}`,seq:1,state:'delta',deltaText:'This must never be spoken'});
    await new Promise(resolve=>setTimeout(resolve,30));expect(f.events.some(e=>e.type==='assistant')).toBe(false);
    expect(f.calls.filter(c=>c.method==='chat.abort').every(c=>c.params.runId==='cancel-me')).toBe(true);
  });
  it('does not downgrade a completed run when its admission reply arrives late',async()=>{
    const f=await fixture();f.hold();const url=`/api/conversations/${f.conversation.id}/turns`;
    const sending=f.app.inject({method:'POST',url,headers:f.headers,payload:{id:'fast-final',text:'Very quick response'}});
    await expect.poll(()=>f.calls.filter(c=>c.method==='chat.send').length).toBe(1);
    f.emit('chat',{runId:'fast-final',sessionKey:`agent:northpointe:vc2:${f.conversation.id}`,seq:1,state:'final',message:{role:'assistant',content:[{type:'text',text:'Done.'}]}});
    await expect.poll(()=>f.events.some(e=>e.type==='complete')).toBe(true);
    f.release();expect((await sending).json().delivery).toBe('complete');
  });
  it('reconnects and reconciles history without resending an accepted turn',async()=>{
    const f=await fixture();const url=`/api/conversations/${f.conversation.id}/turns`;
    await f.app.inject({method:'POST',url,headers:f.headers,payload:{id:'network-turn',text:'Keep this send exactly once'}});
    f.setHistory({sessionInfo:{lastRunId:'network-turn',status:'done'},messages:[{id:'upstream-user',role:'user',content:'Keep this send exactly once',runId:'network-turn'},{id:'upstream-assistant',role:'assistant',content:'The authoritative answer.',runId:'network-turn'}]});
    for(const socket of f.clients)socket.terminate();
    await expect.poll(()=>f.events.some(e=>e.type==='connection'&&!e.connected)).toBe(true);
    await expect.poll(()=>f.calls.filter(c=>c.method==='connect').length,{timeout:4000}).toBe(2);
    await expect.poll(()=>f.events.some(e=>e.type==='reconcile')).toBe(true);
    expect(f.calls.filter(c=>c.method==='chat.send')).toHaveLength(1);
    const view=await f.app.inject({method:'GET',url:`/api/conversations/${f.conversation.id}`,headers:f.headers});
    expect(view.json().activeTurn).toBeUndefined();expect(view.json().messages).toHaveLength(2);
    expect((f.app as any).vc.store.turn('network-turn').delivery).toBe('complete');
  });
  it('does not present an unknown reconnect send as an active run or speak failed partial text',async()=>{
    const f=await fixture();await f.app.inject({method:'POST',url:`/api/conversations/${f.conversation.id}/turns`,headers:f.headers,payload:{id:'error-turn',text:'synthetic private text never present in metrics'}});
    const base={runId:'error-turn',sessionKey:`agent:northpointe:vc2:${f.conversation.id}`};
    f.emit('chat',{...base,seq:1,state:'delta',deltaText:'An unfinished answer'});f.emit('chat',{...base,seq:2,state:'error',error:'raw secret error'});
    await expect.poll(()=>f.events.some(e=>e.type==='complete')).toBe(true);
    expect(f.events.find(e=>e.type==='complete')).toMatchObject({failed:true});expect(f.events.find(e=>e.type==='complete')).not.toHaveProperty('text');
    expect(JSON.stringify(f.events)).not.toContain('raw secret error');
    const metrics=await f.app.inject({method:'GET',url:'/api/diagnostics',headers:f.headers});expect(metrics.body).not.toContain('synthetic private');expect(metrics.json().timings.some((v:any)=>v.stage==='first-text'&&v.elapsedMs>=0)).toBe(true);
    await f.app.inject({method:'POST',url:`/api/conversations/${f.conversation.id}/turns`,headers:f.headers,payload:{id:'unknown-turn',text:'Unconfirmed admission'}});
    const view=await f.app.inject({method:'GET',url:`/api/conversations/${f.conversation.id}`,headers:f.headers});expect(view.json().activeTurn).toBeUndefined();expect(view.json().messages.find((m:any)=>m.id==='unknown-turn').delivery).toBe('uncertain');
  });
  it('requires a full reviewable command and explicit allow-once for approval',async()=>{
    const f=await fixture();await f.app.inject({method:'POST',url:`/api/conversations/${f.conversation.id}/turns`,headers:f.headers,payload:{id:'approval-turn',text:'A task requiring permission'}});
    f.emit('exec.approval.requested',{id:'approval-one',request:{runId:'approval-turn',command:'date',cwd:'/tmp'},expiresAtMs:Date.now()+10000});
    await expect.poll(()=>f.events.some(e=>e.type==='approval')).toBe(true);
    expect(f.events.find(e=>e.type==='approval')).toMatchObject({detail:'Command:\ndate\n\nDirectory:\n/tmp'});
    expect((await f.app.inject({method:'POST',url:'/api/approvals/approval-one',headers:f.headers,payload:{decision:'allow-once'}})).statusCode).toBe(200);
    expect(f.calls.find(c=>c.method==='exec.approval.resolve')?.params).toEqual({id:'approval-one',decision:'allow-once'});
  });
  it('replays only pending approvals belonging to known VC runs, without exposing other sessions',async()=>{
    const f=await fixture(),url=`/api/conversations/${f.conversation.id}/turns`;
    await f.app.inject({method:'POST',url,headers:f.headers,payload:{id:'replay-turn',text:'Work with a reviewable action'}});
    await expect.poll(()=>f.calls.some(c=>c.method==='exec.approval.list')).toBe(true);
    f.setApprovals([
      {id:'vc:approval.1',request:{runId:'replay-turn',sessionKey:`agent:northpointe:vc2:${f.conversation.id}`,command:'date',cwd:'/tmp'},expiresAtMs:Date.now()+10000},
      {id:'foreign-approval',request:{runId:'not-ours',sessionKey:'agent:northpointe:someone-else',command:'foreign private command'},expiresAtMs:Date.now()+10000},
    ]);
    f.emit('session.approval',{phase:'pending',approval:{id:'vc:approval.1'}});
    await expect.poll(()=>f.events.some(e=>e.type==='approval'&&e.id==='vc:approval.1')).toBe(true);
    expect(JSON.stringify(f.events)).not.toContain('foreign private');
    expect((await f.app.inject({method:'POST',url:'/api/approvals/vc%3Aapproval.1',headers:f.headers,payload:{decision:'allow-once'}})).statusCode).toBe(200);
  });
  it('filters sensitive and mismatched questions and resolves a complete answer group safely',async()=>{
    const f=await fixture(),conversationPath=`/api/conversations/${f.conversation.id}`;
    await f.app.inject({method:'GET',url:conversationPath,headers:f.headers});
    await f.app.inject({method:'POST',url:`${conversationPath}/turns`,headers:f.headers,payload:{id:'question-turn',text:'Ask me two useful questions'}});
    const base={runId:'question-turn',sessionKey:`agent:northpointe:vc2:${f.conversation.id}`,sessionId:'session-fixture',expiresAtMs:Date.now()+10000};
    f.emit('question.requested',{...base,id:'secret-direct',questions:[{id:'s',question:'Private direct field',isSecret:true}]});
    f.emit('question.requested',{...base,id:'secret-store',questions:[{id:'s',question:'Private secret store field',secretStore:{name:'credential'}}]});
    f.emit('question.requested',{...base,id:'other-session',sessionKey:'agent:northpointe:unrelated',questions:[{id:'s',question:'Wrong conversation'}]});
    f.emit('question.requested',{...base,id:'other-session-id',sessionId:'unrelated-native-session',questions:[{id:'s',question:'Wrong native session'}]});
    f.emit('question.requested',{...base,id:'other-run',runId:'unknown-old-run',questions:[{id:'s',question:'Unknown run'}]});
    f.emit('question.requested',{...base,id:'duplicate-ids',questions:[{id:'s',question:'Duplicate one'},{id:'s',question:'Duplicate two'}]});
    f.emit('question.requested',{...base,id:'valid-questions',questions:[{id:'__proto__',question:'What is the first choice?'},{id:'choice',question:'What is the second choice?'}]});
    await expect.poll(()=>f.events.filter(e=>e.type==='question').length).toBe(2);
    const prompts=f.events.filter(e=>e.type==='question');expect(prompts.map(e=>e.text)).toEqual(['What is the first choice?','What is the second choice?']);
    expect((await f.app.inject({method:'POST',url:`/api/questions/${prompts[0].id}`,headers:f.headers,payload:{answer:'First'}})).statusCode).toBe(200);
    expect(f.calls.filter(c=>c.method==='question.resolve')).toHaveLength(0);
    expect((await f.app.inject({method:'POST',url:`/api/questions/${prompts[1].id}`,headers:f.headers,payload:{answer:'Second'}})).statusCode).toBe(200);
    const sent=f.calls.find(c=>c.method==='question.resolve')!.params;expect(sent.id).toBe('valid-questions');expect(Object.keys(sent.answers.answers)).toEqual(['__proto__','choice']);expect(sent.answers.answers.__proto__).toEqual(['First']);expect(sent.answers.answers.choice).toEqual(['Second']);
  });
});
describe('gateway compatibility failures',()=>{
  it.each([
    {name:'unapproved device',error:{code:'NOT_PAIRED',details:{code:'PAIRING_REQUIRED'}},reason:'one-time device approval'},
    {name:'incompatible hello',payload:{protocol:3},reason:'protocol 4'},
    {name:'native protocol rejection',error:{code:'INVALID_REQUEST',message:'protocol mismatch: raw-value-must-not-leak'},reason:'protocol 4'},
    {name:'missing required methods',payload:{protocol:4,features:{methods:['chat.send','chat.history']}},reason:'missing a required'},
  ])('explains $name without exposing raw native errors',async item=>{
    const dir=mkdtempSync(join(tmpdir(),'vc2-compat-')),store=new Store(dir,randomBytes(32));
    const server=new WebSocketServer({port:0});await new Promise<void>(resolve=>server.once('listening',resolve));
    server.on('connection',socket=>{socket.send(JSON.stringify({type:'event',event:'connect.challenge',payload:{nonce:'compatibility-fixture',ts:Date.now()}}));socket.on('message',raw=>{const req=JSON.parse(raw.toString());socket.send(JSON.stringify({type:'res',id:req.id,ok:!item.error,...item.error?{error:item.error}:{payload:item.payload}}));});});
    const address=server.address();if(!address||typeof address==='string')throw new Error('Fixture address unavailable');
    const gateway=new Gateway(loadConfig({stateDir:dir,masterKey:randomBytes(32),gatewayToken:'fixture-only',gatewayUrl:`ws://127.0.0.1:${address.port}`}),store,()=>{});
    cleanup.push(async()=>{gateway.close();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(dir,{recursive:true,force:true});});
    await expect.poll(()=>gateway.capabilities().reason).toContain(item.reason);expect(gateway.capabilities().connected).toBe(false);expect(gateway.capabilities().approvals).toBe(false);expect(JSON.stringify(gateway.capabilities())).not.toContain('raw-value-must-not-leak');
  });
});
it('preserves a cancellation tombstone when service storage reopens',()=>{
  const dir=mkdtempSync(join(tmpdir(),'vc2-cancel-')),key=randomBytes(32);let store=new Store(dir,key);
  try {expect(()=>store.createConversation()).toThrow('not been discovered');store.set('default-agent','northpointe');const c=store.createConversation();store.addTurn(c.id,{id:'restart-cancel',text:'Cancel across restart'});store.cancelTurn('restart-cancel');store.close();store=new Store(dir,key);store.updateTurn('restart-cancel','accepted','late-ack');expect(store.turn('restart-cancel')).toMatchObject({delivery:'cancelled',cancelRequested:true,runId:'late-ack'});expect(store.active(c.id)).toBeUndefined();expect(store.outstanding().some(t=>t.id==='restart-cancel')).toBe(true);}
  finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
