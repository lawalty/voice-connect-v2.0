// Authorized synthetic acceptance against a deployed owner account. Never runs in CI.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { request, chromium } from '@playwright/test';
import WebSocket from 'ws';
import sharp from 'sharp';

const credentials=JSON.parse(await readFile(process.env.VC_LIVE_CREDENTIAL_FILE||'.local/owner-access.json','utf8'));
const origin=credentials.origin;
if(origin!=='https://srv2003889.hstgr.cloud')throw Error('Unexpected acceptance target');
const report={time:new Date().toISOString(),origin,checks:[],timings:[]};
function passed(label){report.checks.push(label);console.log(`PASS ${label}`);}
const api=await request.newContext({baseURL:origin,extraHTTPHeaders:{Origin:origin}});
const login=await api.post('/api/auth/login',{data:{password:credentials.password}});
if(!login.ok())throw Error(`Login failed (${login.status()})`);
const status=await login.json();report.build=status.build;
const headers={'X-CSRF-Token':status.csrfToken};
async function get(url){const r=await api.get(url);if(!r.ok())throw Error(`${url} returned ${r.status()}`);return r.json();}
async function post(url,data={}){const r=await api.post(url,{data,headers});if(!r.ok())throw Error(`${url} returned ${r.status()}`);return r.json();}
const settings=await get('/api/settings');
if(!settings.harness.connected)throw Error('Native gateway not connected');
report.harness=settings.harness;passed('Authenticated native Gateway connected');
const conversation=await post('/api/conversations',{title:'VC2 release acceptance'});report.conversationId=conversation.id;
let socket;const events=[];
async function connect(){
  socket?.close();
  const cookies=(await api.storageState()).cookies.map(v=>`${v.name}=${v.value}`).join('; ');
  const url=new URL('/api/events',origin);url.protocol='wss:';url.searchParams.set('conversationId',conversation.id);
  socket=new WebSocket(url,{origin,headers:{Cookie:cookies}});
  socket.on('message',raw=>{events.push({at:performance.now(),...JSON.parse(raw.toString())});});
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
}
await connect();await get(`/api/conversations/${conversation.id}`);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(test,limit=120000){const until=Date.now()+limit;while(Date.now()<until){const value=await test();if(value)return value;await sleep(100);}throw Error('Acceptance timed out');}
async function turn(text,attachments){
  const id=randomUUID(),start=performance.now();
  const body={id,text,...attachments?{attachments}:{}};
  const receipt=await post(`/api/conversations/${conversation.id}/turns`,body);
  if(!['accepted','complete'].includes(receipt.delivery))throw Error(`Turn ${receipt.delivery}`);
  const duplicate=await post(`/api/conversations/${conversation.id}/turns`,body);
  if(duplicate.runId!==receipt.runId)throw Error('Duplicate acquired a different run');
  const completed=await waitFor(()=>events.find(e=>e.type==='complete'&&e.turnId===id));
  if(completed.failed||completed.cancelled)throw Error('Synthetic turn failed');
  const first=events.find(e=>e.type==='assistant'&&e.turnId===id);
  report.timings.push({turnId:id,admittedMs:Math.round((events.find(e=>e.type==='turn'&&e.turnId===id)?.at||performance.now())-start),firstTextMs:first?Math.round(first.at-start):null,completeMs:Math.round(completed.at-start)});
  return {id,text:completed.text||'',receipt};
}
const identity=await turn('Synthetic Voice Connect release check. Do not use tools or change files or saved memories. State your configured agent name, then the code ORBIT 482. Keep the answer to one sentence.');
if(!/NorthPointe/i.test(identity.text)||!identity.text.includes('482'))throw Error('Native persona or test code did not match');
passed('NorthPointe identity and native text round-trip');
const follow=await turn('Without tools or changing saved memory, what code did I give in the previous message? Answer just the code.');
if(!follow.text.includes('482'))throw Error('Conversation continuity failed');
const history=await get(`/api/conversations/${conversation.id}`);
if(history.messages.filter(m=>m.role==='user'&&m.text.includes('ORBIT 482')).length!==1)throw Error('Duplicate message in native history');
passed('Same-session follow-up and idempotent duplicate delivery');
if(!settings.harness.images)throw Error('Previously verified camera capability missing');
const card=await sharp(Buffer.from('<svg width="640" height="400"><rect width="640" height="400" fill="#10202c"/><rect x="30" y="30" width="580" height="340" fill="white"/><circle cx="145" cy="165" r="65" fill="red"/><text x="260" y="190" font-family="sans-serif" font-size="54" fill="black">VC2 739</text></svg>')).png().toBuffer();
const upload=await api.post('/api/uploads',{headers,multipart:{image:{name:'release-card.png',mimeType:'image/png',buffer:card}}});
if(!upload.ok())throw Error(`Image upload ${upload.status()}`);
const attachment=await upload.json();
const visual=await turn('Synthetic camera acceptance. Read the code and name the circle color in the attached image. Do not use tools or change saved memory. Answer in one sentence.',[attachment.id]);
if(!/739/.test(visual.text)||!/red/i.test(visual.text))throw Error('Image understanding did not match the test card');
passed('Actual image upload and visual understanding');
const cancelId=randomUUID();
const pending=await post(`/api/conversations/${conversation.id}/turns`,{id:cancelId,text:'Synthetic interruption check. Without tools, produce a 1200-word fictional story about a quiet garden. Do not save anything.'});
const cancelStart=performance.now();const cancellation=await post(`/api/conversations/${conversation.id}/turns/${cancelId}/abort`);
if(cancellation.agentConfirmed!==true)throw Error('Native cancellation was not confirmed');
const cancelApiMs=Math.round(performance.now()-cancelStart);
const cancelled=await waitFor(()=>events.find(e=>e.type==='turn'&&e.turnId===cancelId&&e.delivery==='cancelled'));
await sleep(1500);
if(events.some(e=>e.turnId===cancelId&&e.at>cancelled.at&&(e.type==='assistant'||(e.type==='complete'&&!e.cancelled))))throw Error('Cancelled text resumed');
report.timings.push({turnId:cancelId,cancelApiMs});
passed('Exact owned run cancellation, late output suppressed');
const reconnectStart=performance.now();await connect();await get(`/api/conversations/${conversation.id}`);
report.timings.push({reconnectHistoryMs:Math.round(performance.now()-reconnectStart)});
passed('Control socket reconnection and authoritative history');
const browser=await chromium.launch();
try{
  const context=await browser.newContext({storageState:await api.storageState(),viewport:{width:1440,height:960}});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.evaluate(id=>localStorage.setItem('vc2:conversation',id),conversation.id);await page.reload();
  await page.getByRole('button',{name:'Start talking',exact:true}).waitFor();
  await page.getByRole('log',{name:'Messages'}).getByText(visual.text,{exact:true}).waitFor({timeout:20000});
  await mkdir('.local/release-evidence',{recursive:true});await page.screenshot({path:'.local/release-evidence/live-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'Open settings'}).click();await page.screenshot({path:'.local/release-evidence/live-settings.png',fullPage:true});
  if(errors.length)throw Error(`Browser page errors: ${errors.join('; ')}`);
  passed('Authenticated deployed browser reload, transcript and settings');
}finally{await browser.close();}
report.diagnostics=await get('/api/diagnostics');
await mkdir('.local/release-evidence',{recursive:true});await writeFile('.local/release-evidence/live.json',JSON.stringify(report,null,2));
socket?.close();await api.dispose();
console.log(JSON.stringify({build:report.build,checks:report.checks,timings:report.timings},null,2));
