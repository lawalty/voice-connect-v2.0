import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import type { ServiceConfig } from './config.js';
import type { GatewayPort } from './gateway.js';
import type { Store } from './store.js';

type Lease = { owner:string; path:string; expires:number; used:boolean; socket?:WebSocket; upstream?:WebSocket };

// Only the fixed Gateway host source is exposed. Native observer credentials stay
// on the service; the browser receives the temporary VNC password for its handshake.
export function registerDesktopRoutes(app:FastifyInstance,cfg:ServiceConfig,store:Store,gateway:GatewayPort) {
  const leases=new Map<string,Lease>();
  const release=(id:string,lease:Lease)=>{
    if(leases.get(id)!==lease)return;
    leases.delete(id);lease.socket?.close(1000,'Desktop disconnected');lease.upstream?.close();
    void gateway.request?.('desktop.release',{wsPath:lease.path}).catch(()=>{});
  };
  const timer=setInterval(()=>{
    for(const [id,lease] of leases) {
      if(!store.session(lease.owner)||(!lease.used&&lease.expires<Date.now()))release(id,lease);
      else if(lease.socket?.readyState===WebSocket.OPEN)lease.socket.ping();
    }
  },10000);timer.unref();
  app.post('/api/desktop/connect',async(req,reply)=>{
    const {control}=z.object({control:z.boolean().default(false)}).strict().parse(req.body);
    const owner=req.cookies.vc_session??'';
    if(!gateway.request||!gateway.capabilities().connected)return reply.code(503).send({error:'The cloud desktop connection is unavailable. Retry after OpenClaw reconnects.'});
    if([...leases.values()].filter(lease=>lease.owner===owner).length>=3)return reply.code(429).send({error:'Close another desktop viewer before opening this one.'});
    let observed:Record<string,any>;
    try { observed=await gateway.request('desktop.observe',{source:{kind:'host'},control}); }
    catch {return reply.code(503).send({error:'The VPS desktop could not start. Check Host Desktop and the Linux desktop setup, then retry.'});}
    // Never accept a caller-provided destination or a native URL outside this path.
    if(observed.transport!=='rfb'||typeof observed.wsPath!=='string'||!/^\/desktop\/observe\?token=[a-zA-Z0-9_-]+$/.test(observed.wsPath)) {
      if(typeof observed.wsPath==='string')void gateway.request('desktop.release',{wsPath:observed.wsPath}).catch(()=>{});
      return reply.code(503).send({error:'The cloud desktop protocol is unavailable.'});
    }
    if(!store.session(owner)){void gateway.request('desktop.release',{wsPath:observed.wsPath}).catch(()=>{});return reply.code(401).send({error:'Sign in again.'});}
    const ticket=randomUUID();
    leases.set(ticket,{owner,path:observed.wsPath,expires:Date.now()+30000,used:false});
    return {ticket,control:observed.control===true,...typeof observed.vncPassword==='string'?{password:observed.vncPassword}:{}};
  });
  app.post('/api/desktop/release',async(req)=>{
    const {ticket}=z.object({ticket:z.string().uuid()}).strict().parse(req.body);
    const lease=leases.get(ticket);if(lease&&lease.owner===req.cookies.vc_session)release(ticket,lease);
    return {released:true};
  });
  app.get('/api/desktop/stream',{websocket:true},(socket,req)=>{
    const parsed=z.object({ticket:z.string().uuid()}).strict().safeParse(req.query);
    const id=parsed.success?parsed.data.ticket:'';
    const lease=leases.get(id);
    if(!lease||lease.used||lease.expires<Date.now()||lease.owner!==req.cookies.vc_session){socket.close(1008,'Desktop connection expired');return;}
    lease.used=true;lease.socket=socket;
    const target=new URL(cfg.gatewayUrl);target.pathname='/desktop/observe';target.search=new URL(lease.path,'http://localhost').search;
    const upstream=new WebSocket(target,{maxPayload:25*1024*1024,perMessageDeflate:false,handshakeTimeout:10000});lease.upstream=upstream;
    let alive=true;
    socket.on('pong',()=>{alive=true;});
    const heartbeat=setInterval(()=>{if(!alive){release(id,lease);return;}alive=false;},20000);heartbeat.unref();
    const forward=(destination:WebSocket,data:WebSocket.RawData,binary:boolean)=>{
      if(destination.readyState!==WebSocket.OPEN||destination.bufferedAmount>4*1024*1024){release(id,lease);return;}
      destination.send(data,{binary});
    };
    socket.on('message',(data,binary)=>forward(upstream,data,binary));
    upstream.on('message',(data,binary)=>forward(socket,data,binary));
    upstream.on('error',()=>{socket.close(1011,'Cloud desktop unavailable');release(id,lease);});
    upstream.on('close',(code)=>{socket.close(code===4000?4000:1000,code===4000?'Another viewer took control':'Cloud desktop disconnected');release(id,lease);});
    socket.on('error',()=>release(id,lease));socket.on('close',()=>{clearInterval(heartbeat);release(id,lease);});
  });
  app.addHook('onClose',async()=>{clearInterval(timer);for(const [id,lease] of leases)release(id,lease);});
}
