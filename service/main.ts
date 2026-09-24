import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import serveStatic from '@fastify/static';
import { hash, verify } from '@node-rs/argon2';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type WebSocket from 'ws';
import type { AppStatus, AppSettings, ServerEvent, Attachment } from '../contract/types.js';
import { loadConfig, type ServiceConfig } from './config.js';
import { Store, digest } from './store.js';
import { Gateway, type GatewayPort } from './gateway.js';
import { bridgeAudio, PREMIUM_VOICES } from './audio.js';
import { normalizeImage } from './images.js';

const password=z.string().min(12).max(256);
const id=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const nativeId=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/).refine(v=>v!=='.'&&v!=='..');
export interface AppOptions {config?:Partial<ServiceConfig>;gatewayFactory?:(cfg:ServiceConfig,store:Store,publish:(e:ServerEvent)=>void)=>GatewayPort;}
function equal(a:string,b:string):boolean {const aa=Buffer.from(digest(a)),bb=Buffer.from(digest(b));return timingSafeEqual(aa,bb);}
export async function buildApp(options:AppOptions={}) {
  const cfg=loadConfig(options.config),store=new Store(cfg.stateDir,cfg.masterKey);
  const app=Fastify({logger:false,bodyLimit:128*1024,trustProxy:false,requestTimeout:30000});
  const sockets=new Map<WebSocket,{conversationId:string;token:string;events:boolean;alive:boolean}>();
  const heartbeat=setInterval(()=>{for(const [socket,binding] of sockets){if(!store.session(binding.token)){socket.close(1008,'Sign in again');continue;}if(!binding.alive){socket.terminate();continue;}binding.alive=false;if(socket.readyState===1)socket.ping();}},20000);heartbeat.unref();
  const publish=(event:ServerEvent)=>{
    for(const [socket,binding] of sockets){
      if(!store.session(binding.token)){socket.close(1008,'Sign in again');continue;}
      if(!binding.events)continue;
      if('conversationId'in event&&event.conversationId!==binding.conversationId)continue;
      if(socket.readyState===1){if(socket.bufferedAmount>1024*1024){socket.close(1013,'Reconnect to restore your conversation');continue;}socket.send(JSON.stringify(event));}
    }
  };
  const gateway=options.gatewayFactory?.(cfg,store,publish)??new Gateway(cfg,store,publish);
  app.decorate('vc',{cfg,store,gateway});
  await app.register(cookie);
  await app.register(rateLimit,{max:240,timeWindow:60000,errorResponseBuilder:()=>({error:'Too many requests. Please wait a moment.'})});
  await app.register(multipart,{limits:{fileSize:5*1024*1024,files:1,fields:0,parts:1}});
  await app.register(websocket,{options:{maxPayload:128*1024,perMessageDeflate:false}});
  const session=(req:FastifyRequest)=>store.session(req.cookies.vc_session??'');
  const status=(req:FastifyRequest):AppStatus&{csrfToken?:string}=>({ownerConfigured:store.ownerConfigured(),authenticated:Boolean(session(req)),build:cfg.build,...session(req)?{csrfToken:session(req)!.csrf}:{}});
  const closeToken=(token:string)=>{for(const [socket,v] of sockets)if(v.token===token)socket.close(1008,'Session ended');};
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','same-origin').header('Cross-Origin-Opener-Policy','same-origin').header('Cross-Origin-Embedder-Policy','require-corp');
    reply.header('Permissions-Policy','microphone=(self), camera=(self), geolocation=()');
    reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    if(!req.url.startsWith('/api/'))return;
    reply.header('Cache-Control','no-store');
    const path=req.url.split('?')[0],authEntry=path==='/api/auth/setup'||path==='/api/auth/login';
    const mutating=!['GET','HEAD','OPTIONS'].includes(req.method),ws=path==='/api/events'||path==='/api/audio';
    if((mutating||ws)&&req.headers.origin!==cfg.origin)return reply.code(403).send({error:'This request must come from Voice Connect.'});
    if(path==='/api/status'||authEntry)return;
    const s=session(req);if(!s)return reply.code(401).send({error:'Sign in to continue.'});
    if(mutating&&!equal(String(req.headers['x-csrf-token']??''),s.csrf))return reply.code(403).send({error:'Refresh Voice Connect and try again.'});
  });
  app.setErrorHandler((error,req,reply)=>{
    const validation=error instanceof z.ZodError;
    const code=(error as {statusCode?:number}).statusCode;
    const statusCode=validation?400:typeof code==='number'&&code<500?code:500;
    reply.code(statusCode).send({error:validation?'Please check the information and try again.':statusCode===413?'This file is too large.':statusCode===429?'Too many requests. Please wait a moment.':'This request could not be completed. Your conversation is preserved.'});
  });
  app.get('/health',async()=>({ready:true,build:cfg.build,openclaw:gateway.capabilities().connected}));
  app.get('/api/status',async req=>status(req));
  app.get('/api/diagnostics',async()=>({build:cfg.build,gateway:gateway.capabilities(),deviceId:store.get('gateway-device-id'),timings:gateway.diagnostics?.()??[]}));
  const authRate={rateLimit:{max:12,timeWindow:15*60*1000}};
  app.post('/api/auth/setup',{config:authRate},async(req,reply)=>{
    const body=z.object({password,bootstrapToken:z.string().min(20).max(256)}).strict().parse(req.body);
    if(store.ownerConfigured())return reply.code(409).send({error:'An owner already exists. Sign in instead.'});
    if(!cfg.bootstrapToken||!equal(body.bootstrapToken,cfg.bootstrapToken))return reply.code(403).send({error:'The setup token is invalid.'});
    const encoded=await hash(body.password,{memoryCost:19456,timeCost:2,parallelism:1});
    if(store.ownerConfigured())return reply.code(409).send({error:'An owner already exists.'});
    store.set('password',encoded);cfg.bootstrapToken='';
    const tokenFile=process.env.VC_BOOTSTRAP_TOKEN_FILE;if(tokenFile&&existsSync(tokenFile)){try{unlinkSync(tokenFile);}catch{/* A read-only secret mount is harmless: the persisted owner disables setup. */}}
    const s=store.createSession();reply.setCookie('vc_session',s.token,{httpOnly:true,secure:cfg.secureCookie,sameSite:'strict',path:'/',maxAge:7*86400});
    return {ownerConfigured:true,authenticated:true,build:cfg.build,csrfToken:s.csrf};
  });
  app.post('/api/auth/login',{config:authRate},async(req,reply)=>{
    const body=z.object({password:z.string().min(1).max(256)}).strict().parse(req.body);const encoded=store.get('password');
    if(!encoded||!await verify(encoded,body.password))return reply.code(401).send({error:'The password was not accepted.'});
    if(req.cookies.vc_session)store.logout(req.cookies.vc_session);
    const s=store.createSession();reply.setCookie('vc_session',s.token,{httpOnly:true,secure:cfg.secureCookie,sameSite:'strict',path:'/',maxAge:7*86400});return {ownerConfigured:true,authenticated:true,build:cfg.build,csrfToken:s.csrf};
  });
  app.post('/api/auth/password',{config:authRate},async(req,reply)=>{
    const body=z.object({currentPassword:z.string().max(256),newPassword:password}).strict().parse(req.body);
    if(!await verify(store.get('password')!,body.currentPassword))return reply.code(401).send({error:'The current password was not accepted.'});
    const encoded=await hash(body.newPassword,{memoryCost:19456,timeCost:2,parallelism:1});store.set('password',encoded);
    store.db.prepare('DELETE FROM sessions WHERE hash<>?').run(digest(req.cookies.vc_session!));
    for(const [s,b] of sockets)if(!store.session(b.token))s.close(1008,'Sign in again');return status(req);
  });
  app.post('/api/auth/logout',async(req,reply)=>{const token=req.cookies.vc_session??'';store.logout(token);closeToken(token);reply.clearCookie('vc_session',{path:'/'});return {ok:true};});
  app.get('/api/settings',async():Promise<AppSettings>=>({deepgramConfigured:Boolean(store.get('deepgram')),premiumVoices:PREMIUM_VOICES,harness:gateway.capabilities()}));
  app.put('/api/settings/deepgram',async req=>{const body=z.object({apiKey:z.string().min(16).max(512).regex(/^[A-Za-z0-9._-]+$/)}).strict().parse(req.body);store.set('deepgram',store.encrypt(body.apiKey));return {ok:true};});
  app.delete('/api/settings/deepgram',async()=>{store.remove('deepgram');return {ok:true};});
  app.get('/api/conversations',async()=>store.conversations());
  app.post('/api/conversations',async(req,reply)=>{const body=z.object({title:z.string().trim().min(1).max(100).optional()}).strict().parse(req.body??{});if(!store.get('default-agent'))return reply.code(503).send({error:'OpenClaw is connecting. Please try again shortly.'});return store.createConversation(body.title);});
  app.get('/api/conversations/:id',async(req,reply)=>{const p=z.object({id}).parse(req.params);if(!store.conversation(p.id))return reply.code(404).send({error:'Conversation not found.'});return gateway.history(p.id);});
  app.post('/api/conversations/:id/turns',{config:{rateLimit:{max:30,timeWindow:60000}}},async(req,reply)=>{
    const p=z.object({id}).parse(req.params);if(!store.conversation(p.id))return reply.code(404).send({error:'Conversation not found.'});
    const turn=z.object({id,text:z.string().max(20000),attachments:z.array(id).max(4).optional()}).strict().parse(req.body);
    if(!turn.text.trim()&&!turn.attachments?.length)return reply.code(400).send({error:'Add a message or image first.'});
    const prior=store.turn(turn.id);if(prior&&prior.conversationId!==p.id)return reply.code(409).send({error:'This message belongs to another conversation.'});
    try{return await gateway.send(p.id,turn);}catch{return reply.code(409).send({error:'This message could not be sent. Check image support or start a new message.'});}
  });
  app.post('/api/conversations/:id/turns/:turnId/abort',async(req,reply)=>{const p=z.object({id,turnId:id}).parse(req.params);const t=store.turn(p.turnId);if(!t||t.conversationId!==p.id)return reply.code(404).send({error:'Turn not found.'});try {await gateway.abort(p.id,p.turnId);return {ok:true,agentConfirmed:true};}catch{return reply.code(202).send({ok:true,agentConfirmed:false});}});
  app.post('/api/uploads',{config:{rateLimit:{max:20,timeWindow:60000}}},async(req,reply)=>{
    const file=await req.file();if(!file)return reply.code(400).send({error:'Choose an image.'});
    let decoded:Awaited<ReturnType<typeof normalizeImage>>;
    try {decoded=await normalizeImage(await file.toBuffer());}catch(error){if((error as {statusCode?:number}).statusCode===413)throw error;return reply.code(400).send({error:'Use a valid PNG, JPEG or WebP image under 5 MB and 40 megapixels.'});}
    const {bytes,...d}=decoded;
    const attachmentId=randomUUID();const ext=d.mimeType==='image/png'?'png':d.mimeType==='image/webp'?'webp':'jpg';
    const meta:Attachment={id:attachmentId,...d,name:`image-${attachmentId.slice(0,8)}.${ext}`,previewUrl:`/api/attachments/${attachmentId}`};store.saveAttachment(meta,bytes);return meta;
  });
  app.get('/api/attachments/:id',async(req,reply)=>{const p=z.object({id}).parse(req.params),a=store.attachment(p.id);if(!a)return reply.code(404).send({error:'Image not found.'});return reply.type(a.meta.mimeType).header('Content-Disposition',`inline; filename="${a.meta.name}"`).send(a.bytes);});
  app.post('/api/approvals/:id',async(req,reply)=>{const p=z.object({id:nativeId}).parse(req.params),b=z.object({decision:z.enum(['allow-once','deny'])}).strict().parse(req.body);try{await gateway.approval(p.id,b.decision);return {ok:true};}catch{return reply.code(409).send({error:'This approval cannot be resolved here. It may have expired or requires review in OpenClaw.'});}});
  app.post('/api/questions/:id',async(req,reply)=>{const p=z.object({id}).parse(req.params),b=z.object({answer:z.string().min(1).max(4000)}).strict().parse(req.body);try{await gateway.answer(p.id,b.answer);return {ok:true};}catch{return reply.code(409).send({error:'This question is no longer available.'});}});
  function bindSocket(socket:WebSocket,req:FastifyRequest):string|undefined {
    const q=z.object({conversationId:id}).passthrough().safeParse(req.query);if(!q.success||!store.conversation(q.data.conversationId)||sockets.size>=12){socket.close(1008,'Conversation unavailable');return;}
    sockets.set(socket,{conversationId:q.data.conversationId,token:req.cookies.vc_session!,events:req.url.startsWith('/api/events'),alive:true});socket.on('pong',()=>{const binding=sockets.get(socket);if(binding)binding.alive=true;});socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});return q.data.conversationId;
  }
  app.get('/api/events',{websocket:true},(socket,req)=>{const conversationId=bindSocket(socket,req);if(!conversationId)return;socket.send(JSON.stringify({type:'hello',conversationId,capabilities:gateway.capabilities()}));});
  app.get('/api/audio',{websocket:true},(socket,req)=>{
    const conversationId=bindSocket(socket,req);if(!conversationId)return;
    const q=z.object({kind:z.enum(['stt','tts']),voice:z.enum(['flux-haley-en']).default('flux-haley-en'),conversationId:id}).safeParse(req.query);
    const key=store.deepgramKey();if(!q.success||!key){socket.send(JSON.stringify({type:'error',message:'Set a Deepgram key in Settings to use Premium speech.'}));socket.close(1008,'Speech unavailable');return;}
    bridgeAudio(socket,q.data.kind,key,q.data.voice,()=>Boolean(session(req)));
  });
  if(existsSync(cfg.staticDir)){await app.register(serveStatic,{root:cfg.staticDir,prefix:'/',index:['index.html']});app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({error:'Not found.'}):reply.type('text/html').sendFile('index.html'));}
  app.addHook('onClose',async()=>{clearInterval(heartbeat);for(const socket of sockets.keys())socket.close(1001,'Service restarting');gateway.close();store.close();});
  await app.ready();return app;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const app=await buildApp();const cfg=(app as unknown as {vc:{cfg:ServiceConfig}}).vc.cfg;
  await app.listen({host:cfg.host,port:cfg.port});
  process.stdout.write(`Voice Connect ${cfg.build} ready on port ${cfg.port}.\n`);
  for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void app.close().then(()=>process.exit(0));});
}
