// Isolated test-only gateway. Never loaded by the application or deployed service.
import { WebSocketServer } from 'ws';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const [appPort=5180,readinessPort=5181,gatewayPort=18791]=process.argv.slice(2).map(Number);
if([appPort,readinessPort,gatewayPort].some(port=>!Number.isInteger(port)||port<1024||port>65535)||new Set([appPort,readinessPort,gatewayPort]).size!==3)throw new Error('Fixture ports must be three distinct unprivileged ports');
const origin=`http://127.0.0.1:${appPort}`;
const dir=await mkdtemp(join(tmpdir(),'vc2-browser-'));
const token=randomBytes(24).toString('hex');
await mkdir(join(dir,'state'));
await writeFile(join(dir,'master'),randomBytes(32).toString('hex'));
await writeFile(join(dir,'bootstrap'),token);
await writeFile(join(dir,'gateway'),'fixture-token');
const gateway=new WebSocketServer({host:'127.0.0.1',port:gatewayPort});
const sessions=new Map(), timers=new Map(), receipts=new Map();
gateway.on('connection',ws=>{
  ws.send(JSON.stringify({type:'event',event:'connect.challenge',payload:{nonce:'fixture',ts:Date.now()}}));
  ws.on('message',raw=>{
    const f=JSON.parse(raw.toString()), p=f.params;
    const res=payload=>ws.readyState===1&&ws.send(JSON.stringify({type:'res',id:f.id,ok:true,payload}));
    const event=(name,payload)=>ws.readyState===1&&ws.send(JSON.stringify({type:'event',event:name,payload}));
    if(f.method==='connect')return res({type:'hello-ok',protocol:4,server:{version:'2026.9.6-fixture'},features:{methods:['agents.list','models.list','chat.history','chat.send','chat.abort','sessions.messages.subscribe','exec.approval.resolve','question.resolve']},snapshot:{sessionDefaults:{defaultAgentId:'northpointe',model:'openai/gpt-6-astra'}}});
    if(f.method==='agents.list')return res({defaultId:'northpointe',agents:[{id:'northpointe',name:'NorthPointe'}]});
    if(f.method==='models.list')return res({models:[{id:'gpt-6-astra',provider:'openai',input:['text','image']}]});
    if(f.method==='sessions.messages.subscribe')return res({ok:true});
    if(f.method==='chat.history')return res({sessionId:p.sessionKey,messages:sessions.get(p.sessionKey)||[],sessionInfo:{modelProvider:'openai',model:'gpt-6-astra'}});
    if(f.method==='chat.send'){
      if(receipts.has(p.idempotencyKey))return res(receipts.get(p.idempotencyKey));
      const runId=p.idempotencyKey, receipt={runId,status:'started'};
      receipts.set(runId,receipt);
      const history=sessions.get(p.sessionKey)||[];
      history.push({id:randomUUID(),role:'user',content:[{type:'text',text:p.message}],timestamp:Date.now(),runId});sessions.set(p.sessionKey,history);
      res(receipt);
      const answer=p.message.includes('Markdown speech fixture')?'**Your first sentence.** A *second* thought.':p.message.includes('second')?'Your second message is in the same conversation.':'Your conversation stays together. I’m here with you.';
      const slow=p.message.includes('slow');
      event('chat',{sessionKey:p.sessionKey,runId,seq:0,state:'status'});
      const first=setTimeout(()=>event('chat',{sessionKey:p.sessionKey,runId,seq:1,state:'delta',deltaText:answer.slice(0,33)}),100);
      const second=setTimeout(()=>event('chat',{sessionKey:p.sessionKey,runId,seq:2,state:'delta',deltaText:answer,replace:true}),slow?8000:200);
      const last=setTimeout(()=>{
        const message={id:randomUUID(),role:'assistant',content:[{type:'text',text:answer}],timestamp:Date.now(),runId};history.push(message);
        event('chat',{sessionKey:p.sessionKey,runId,seq:3,state:'final',message});timers.delete(runId);
      },slow?12000:350);
      timers.set(runId,[first,second,last]);return;
    }
    if(f.method==='chat.abort'){
      for(const t of timers.get(p.runId)||[])clearTimeout(t);timers.delete(p.runId);
      event('chat',{sessionKey:p.sessionKey,runId:p.runId,seq:4,state:'aborted'});return res({ok:true,aborted:true,runIds:[p.runId]});
    }
    res({ok:true});
  });
});
const app=spawn(process.execPath,['dist/service/main.js'],{stdio:['ignore','inherit','inherit'],env:{...process.env,NODE_ENV:'test',VC_HOST:'127.0.0.1',VC_PORT:String(appPort),VC_ORIGIN:origin,VC_STATE_DIR:join(dir,'state'),VC_GATEWAY_URL:`ws://127.0.0.1:${gatewayPort}`,VC_GATEWAY_TOKEN_FILE:join(dir,'gateway'),VC_MASTER_KEY_FILE:join(dir,'master'),VC_BOOTSTRAP_TOKEN_FILE:join(dir,'bootstrap'),VC_BUILD:'browser-fixture'}});
let ready=false;
for(let n=0;n<100;n++){
  try { const response=await fetch(`${origin}/api/status`); if(response.ok){ready=true;break;} }catch{}
  await new Promise(r=>setTimeout(r,150));
}
if(!ready)throw new Error('Browser fixture application did not start');
const setup=await fetch(`${origin}/api/auth/setup`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({bootstrapToken:token,password:'browser-fixture-password-2026'})});
if(!setup.ok)throw new Error(`Fixture setup failed ${setup.status}`);
console.log(`Isolated browser fixture ready at ${origin}.`);
const readiness=createServer((req,res)=>{res.writeHead(200);res.end('ready');}).listen(readinessPort,'127.0.0.1');
let closing=false;
async function close(){if(closing)return;closing=true;app.kill();readiness.close();for(const ws of gateway.clients)ws.terminate();gateway.close();for(const group of timers.values())for(const t of group)clearTimeout(t);await new Promise(r=>setTimeout(r,500));if(dir.startsWith(join(tmpdir(),'vc2-browser-')))await rm(dir,{recursive:true,force:true}).catch(()=>{});process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);app.on('exit',()=>{if(!closing)void close();});
