import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket, { WebSocketServer } from 'ws';
import { buildApp } from '../service/main.js';
import type { GatewayPort } from '../service/gateway.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.reverse())await fn();cleanup.length=0;});
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'vc-desktop-'));
  const upstream=new WebSocketServer({port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const port=(upstream.address() as {port:number}).port;
  upstream.on('connection',socket=>{socket.send(Buffer.from('RFB 003.008\n'));socket.on('message',data=>socket.send(data));});
  const request=vi.fn(async(method:string)=>method==='desktop.observe'?{transport:'rfb',wsPath:'/desktop/observe?token=native_private_ticket',control:false,vncPassword:'temporary'}:{released:true});
  const origin='http://127.0.0.1:5173';
  const app=await buildApp({config:{origin,stateDir:dir,masterKey:randomBytes(32),gatewayToken:'',gatewayUrl:`ws://127.0.0.1:${port}`,gatewayEnabled:false,staticDir:join(dir,'absent'),bootstrapToken:'fixture-bootstrap-long-enough'},gatewayFactory:()=>({capabilities:()=>({connected:true}),close:()=>{},request} as unknown as GatewayPort)});
  cleanup.push(async()=>{await app.close();for(const socket of upstream.clients)socket.terminate();await new Promise<void>(resolve=>upstream.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});});
  const auth=await app.inject({method:'POST',url:'/api/auth/setup',headers:{origin},payload:{password:'fixture-password-long-enough',bootstrapToken:'fixture-bootstrap-long-enough'}});
  expect(auth.statusCode).toBe(200);
  const cookie=String(auth.headers['set-cookie']).split(';')[0];const csrf=auth.json().csrfToken;
  const headers={origin,cookie,'x-csrf-token':csrf};
  return {app,request,headers,origin,cookie};
}
it('requires owner, exact origin and CSRF before acquiring a native desktop',async()=>{
  const f=await fixture();
  for(const headers of [{origin:f.origin},{origin:f.origin,cookie:f.cookie},{...f.headers,origin:'https://untrusted.example'}]) {
    const response=await f.app.inject({method:'POST',url:'/api/desktop/connect',headers,payload:{control:true}});
    expect([401,403]).toContain(response.statusCode);
  }
  expect(f.request).not.toHaveBeenCalled();
  const invalid=await f.app.inject({method:'POST',url:'/api/desktop/connect',headers:f.headers,payload:{control:true,source:{kind:'node'}}});
  expect(invalid.statusCode).toBe(400);expect(f.request).not.toHaveBeenCalled();
});
it('binds a one-use ticket to its owner and hides the native observer URL',async()=>{
  const f=await fixture();
  const response=await f.app.inject({method:'POST',url:'/api/desktop/connect',headers:f.headers,payload:{control:false}});
  expect(response.statusCode).toBe(200);expect(response.body).not.toContain('native_private_ticket');
  expect(f.request).toHaveBeenCalledWith('desktop.observe',{source:{kind:'host'},control:false});
  const {ticket}=response.json();
  await f.app.listen({host:'127.0.0.1',port:0});
  const port=(f.app.server.address() as {port:number}).port;
  const url=`ws://127.0.0.1:${port}/api/desktop/stream?ticket=${ticket}`;
  const reject=new WebSocket(url,{origin:'https://untrusted.example',headers:{Cookie:f.cookie}});
  expect(await new Promise<number>(resolve=>{reject.on('unexpected-response',(_req,res)=>{res.resume();reject.terminate();resolve(res.statusCode!);});reject.on('error',()=>{});})).toBe(403);
  const socket=new WebSocket(url,{origin:f.origin,headers:{Cookie:f.cookie}});
  const frame=await new Promise<string>((resolve,reject)=>{socket.once('message',data=>resolve(data.toString()));socket.once('error',reject);});
  expect(frame).toBe('RFB 003.008\n');
  const duplicate=new WebSocket(url,{origin:f.origin,headers:{Cookie:f.cookie}});
  expect(await new Promise<number>(resolve=>duplicate.once('close',code=>resolve(code)))).toBe(1008);
  await f.app.inject({method:'POST',url:'/api/desktop/release',headers:f.headers,payload:{ticket}});
  await new Promise<void>(resolve=>{if(socket.readyState===WebSocket.CLOSED)resolve();else socket.once('close',()=>resolve());});
  expect(f.request).toHaveBeenCalledWith('desktop.release',{wsPath:'/desktop/observe?token=native_private_ticket'});
});
it('rejects native URLs outside the fixed observation route',async()=>{
  const f=await fixture();f.request.mockResolvedValueOnce({transport:'rfb',wsPath:'ws://other-machine:5900',control:false,vncPassword:'never-expose'});
  const response=await f.app.inject({method:'POST',url:'/api/desktop/connect',headers:f.headers,payload:{control:false}});
  expect(response.statusCode).toBe(503);expect(response.body).not.toContain('never-expose');
});
