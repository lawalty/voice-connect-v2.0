import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { ConversationView, HarnessAdapter, HarnessCapabilities, Message, ServerEvent, TurnRequest, TurnReceipt } from '../contract/types.js';
import type { ServiceConfig } from './config.js';
import { Store } from './store.js';
import { signGatewayChallenge } from './identity.js';
import { Timings, type TimingSample } from './telemetry.js';

type Json = Record<string, any>;
class RejectedRequest extends Error {constructor(readonly code?:string){super('OpenClaw declined the request');}}
const terminal=new Set(['complete','failed','cancelled']);
export interface GatewayPort extends HarnessAdapter {
  approval(id:string,decision:string):Promise<void>; answer(id:string,answer:string):Promise<void>; diagnostics?():TimingSample[];
}
export function displayText(message:unknown):string {
  if(!message || typeof message!=='object')return '';
  const m=message as Json;if(m.isReasoning===true)return '';
  const text=typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.filter((v:Json)=>v.type==='text'&&typeof v.text==='string').map((v:Json)=>v.text).join('\n'):typeof m.text==='string'?m.text:'';
  return text.trim()==='NO_REPLY'?'':text;
}
export class Gateway implements GatewayPort {
  private timings=new Timings();
  private socket?:WebSocket; private ready=false; private stopped=false; private timer?:NodeJS.Timeout;
  private connectingTimer?:NodeJS.Timeout; private backoff=1000; private version=''; private methods=new Set<string>();
  private pairingRequired=false;
  private pending=new Map<string,{resolve:(v:Json)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  private sequence=new Map<string,number>(); private text=new Map<string,string>(); private modelImages=new Set<string>();
  private images=false; private approvals=false; private subscribed=new Set<string>();
  private prompts=new Map<string,{kind:'approval'|'question';conversationId:string;expiresAt:number;allow?:boolean;requestId?:string;questionId?:string;event?:ServerEvent}>();
  private questionGroups=new Map<string,{ids:string[];answers:Record<string,string[]>;expiresAt:number}>();
  constructor(private cfg:ServiceConfig, private store:Store, private publish:(event:ServerEvent)=>void) {
    if(cfg.gatewayEnabled&&cfg.gatewayToken)this.connect();
  }
  capabilities():HarnessCapabilities {return {connected:this.ready,images:this.images,cancellation:this.methods.has('chat.abort'),approvals:this.ready&&this.approvals,version:this.version,...!this.ready?{reason:this.pairingRequired?'Voice Connect requires one-time device approval on the OpenClaw server.':'OpenClaw is reconnecting. Your conversation is preserved.'}:{}};}
  diagnostics():TimingSample[]{return this.timings.snapshot();}
  private connect():void {
    if(this.stopped)return;
    const ws=new WebSocket(this.cfg.gatewayUrl,{maxPayload:25*1024*1024,perMessageDeflate:false,handshakeTimeout:10000});this.socket=ws;
    this.connectingTimer=setTimeout(()=>ws.terminate(),15000);
    ws.on('error',()=>{});
    ws.on('message',(data,isBinary)=>{if(isBinary)return;try{this.frame(JSON.parse(data.toString()),ws);}catch{/* malformed remote frames are not exposed */}});
    ws.on('close',()=>{
      if(ws!==this.socket)return;clearTimeout(this.connectingTimer);this.ready=false;this.approvals=false;this.subscribed.clear();this.prompts.clear();this.questionGroups.clear();this.sequence.clear();this.text.clear();
      for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Gateway connection lost'));}this.pending.clear();
      for(const row of this.store.outstanding())if(row.delivery==='pending'||row.delivery==='accepted')this.store.updateTurn(row.id,'uncertain');
      this.publish({type:'connection',connected:false,reason:this.capabilities().reason});
      if(!this.stopped){this.timer=setTimeout(()=>this.connect(),this.backoff);this.backoff=Math.min(4000,this.backoff*2);}
    });
  }
  private frame(frame:Json,ws:WebSocket):void {
    if(ws!==this.socket)return;
    if(frame.type==='res'){
      const p=this.pending.get(frame.id);if(!p)return;this.pending.delete(frame.id);clearTimeout(p.timer);
      frame.ok?p.resolve(frame.payload??{}):p.reject(new RejectedRequest(frame.error?.code==='NOT_PAIRED'&&frame.error?.details?.code==='PAIRING_REQUIRED'?'PAIRING_REQUIRED':undefined));return;
    }
    if(frame.type!=='event')return;
    if(frame.event==='connect.challenge'){
      if(typeof frame.payload?.nonce!=='string'||!Number.isSafeInteger(frame.payload?.ts)){ws.close(1008,'Invalid challenge');return;}
      const scopes=['operator.read','operator.write','operator.approvals','operator.questions'];
      const device=signGatewayChallenge(this.store,this.cfg.gatewayToken,frame.payload.nonce,frame.payload.ts,scopes);
      void this.request('connect',{minProtocol:4,maxProtocol:4,client:{id:'gateway-client',version:'2.0.0',platform:'linux',mode:'backend'},role:'operator',scopes,caps:['tool-events'],device,auth:{token:this.cfg.gatewayToken},locale:'en-US'},true).then(async hello=>{
        clearTimeout(this.connectingTimer);if(this.socket!==ws)return;
        if(hello.protocol!==4)throw new Error('Unsupported gateway protocol');
        this.version=String(hello.server?.version??'');this.methods=new Set(hello.features?.methods??[]);
        if(!this.methods.has('chat.send')||!this.methods.has('chat.history')||!this.methods.has('chat.abort'))throw new Error('Gateway chat methods unavailable');
        const agents=await this.request('agents.list',{},true);
        if(typeof agents.defaultId!=='string'||!/^[a-z0-9_-]+$/i.test(agents.defaultId))throw new Error('No default OpenClaw agent');
        this.store.set('default-agent',agents.defaultId);
        this.ready=true;this.pairingRequired=false;this.backoff=1000;this.publish({type:'connection',connected:true});
        await this.discoverImages(hello).catch(()=>{});
        for(const row of this.store.outstanding()) {
          if(row.cancelRequested){void this.request('chat.abort',{...this.target(row.conversationId),runId:row.runId??row.id}).catch(()=>{});}
        }
        for(const c of this.store.conversations().slice(0,20)){void this.history(c.id).then(()=>this.publish({type:'reconcile',conversationId:c.id})).catch(()=>{});}
      }).catch(error=>{this.pairingRequired=error instanceof RejectedRequest&&error.code==='PAIRING_REQUIRED';ws.close(1008,'Gateway unavailable');});return;
    }
    if(!this.ready)return;
    if(frame.event==='chat')this.chat(frame.payload??{});
    if(frame.event==='agent')this.activity(frame.payload??{});
    if(frame.event==='exec.approval.requested'||frame.event==='question.requested')this.prompt(frame.event,frame.payload??{});
    if(frame.event==='session.approval'){
      const p=frame.payload??{},id=p.approval?.id;
      if(p.phase==='terminal'&&typeof id==='string')this.prompts.delete(id);
      else if(p.phase==='pending'&&this.approvals)void this.restorePrompts().catch(()=>{});
    }
    if(frame.event==='exec.approval.resolved'&&typeof frame.payload?.id==='string')this.prompts.delete(frame.payload.id);
    if(frame.event==='question.resolved'&&typeof frame.payload?.id==='string'){for(const [id,p] of this.prompts)if(p.requestId===frame.payload.id)this.prompts.delete(id);this.questionGroups.delete(frame.payload.id);}
  }
  private async discoverImages(hello:Json):Promise<void> {
    const catalog=await this.request('models.list',{});
    for(const m of catalog.models??[])if(Array.isArray(m.input)&&m.input.includes('image')){this.modelImages.add(String(m.id));if(m.provider)this.modelImages.add(`${m.provider}/${m.id}`);}
    for(const m of this.cfg.qualifiedImageModels)this.modelImages.add(m);
    const defaultModel=hello.snapshot?.sessionDefaults?.model??hello.snapshot?.defaults?.model??this.cfg.gatewayModel;
    if(typeof defaultModel==='string')this.images=this.modelImages.has(defaultModel);
  }
  private target(id:string):{sessionKey:string;agentId:string;sessionId?:string} {const mapping=this.store.mapping(id);return {...mapping,agentId:mapping.sessionKey.split(':')[1]};}
  private async subscribe(id:string):Promise<void> {
    if(this.subscribed.has(id))return;const t=this.target(id);
    const approvals=this.methods.has('exec.approval.resolve');
    try {await this.request('sessions.messages.subscribe',{key:t.sessionKey,agentId:t.agentId,...approvals?{includeApprovals:true}:{}});this.approvals=approvals;}
    catch(error){if(!(error instanceof RejectedRequest)||!approvals)throw error;this.approvals=false;await this.request('sessions.messages.subscribe',{key:t.sessionKey,agentId:t.agentId});}
    this.subscribed.add(id);
    this.publish({type:'hello',conversationId:id,capabilities:this.capabilities()});
    void this.restorePrompts().catch(()=>{});
  }
  private restoringPrompts?:Promise<void>;
  private restorePrompts():Promise<void> {
    if(this.restoringPrompts)return this.restoringPrompts;
    this.restoringPrompts=(async()=>{
      if(this.approvals&&this.methods.has('exec.approval.list')){const items=await this.request('exec.approval.list',{});if(Array.isArray(items))for(const item of items.slice(0,100))this.prompt('exec.approval.requested',item);}
      if(this.methods.has('question.list')&&this.methods.has('question.resolve')){const items=await this.request('question.list',{});for(const item of (items.questions??[]).slice(0,100))if(item.status==='pending')this.prompt('question.requested',item);}
    })().finally(()=>{this.restoringPrompts=undefined;});return this.restoringPrompts;
  }
  request(method:string,params:Json,connecting=false):Promise<Json> {
    const ws=this.socket;if((!this.ready&&!connecting)||!ws||ws.readyState!==WebSocket.OPEN)return Promise.reject(new Error('Gateway unavailable'));
    const id=randomUUID();return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Gateway request timed out'));},15000);
      this.pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({type:'req',id,method,params}),error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(new Error('Gateway unavailable'));}});
    });
  }
  async history(id:string):Promise<ConversationView> {
    const conversation=this.store.conversation(id);if(!conversation)throw new Error('Conversation not found');
    if(!this.ready)throw Object.assign(new Error('Conversation reconnecting'),{statusCode:503});
    await this.subscribe(id);
    const result=await this.request('chat.history',{...this.target(id),limit:200,maxChars:50000});
    if(typeof result.sessionId==='string')this.store.setSession(id,result.sessionId);
    const info=result.sessionInfo??{};const model=info.model??result.model;const provider=info.modelProvider??info.provider??result.modelProvider;
    if(typeof model==='string')this.images=this.modelImages.has(model)||this.modelImages.has(`${provider}/${model}`);
    const messages:Message[]=[];const seen=new Set<string>();
    const live=result.inFlightRun;
    const activeRunIds=new Set<string>(Array.isArray(info.activeRunIds)?info.activeRunIds.filter((v:unknown)=>typeof v==='string'):[]);
    if(typeof live?.runId==='string')activeRunIds.add(live.runId);
    const lastRun=typeof info.lastRunId==='string'?this.store.findRun(info.lastRunId):undefined;
    if(lastRun?.conversationId===id&&['done','failed','killed'].includes(info.status)){this.store.updateTurn(lastRun.id,info.status==='done'?'complete':info.status==='killed'?'cancelled':'failed',info.lastRunId);if(!terminal.has(lastRun.delivery))this.timings.record(lastRun.id,'reconciled',lastRun.createdAt);}
    for(const raw of result.messages??[]){
      if(!['user','assistant'].includes(raw.role))continue;const text=displayText(raw);
      const sendId=raw.idempotencyKey??raw.sourceId??raw.inputRunId??raw.runId;
      let known=typeof sendId==='string'?this.store.findRun(sendId):undefined;
      const rawTime=typeof raw.timestamp==='number'?raw.timestamp:Date.parse(raw.timestamp??'');
      // Native transcripts may omit the input receipt id. Match each recent local send once,
      // only with both exact content and a bounded timestamp, and never infer completion from text alone.
      if(!known&&raw.role==='user'&&Number.isFinite(rawTime))known=this.store.conversationTurns(id).find(t=>!seen.has(t.id)&&t.text===text&&Math.abs(t.createdAt-rawTime)<5000);
      if(known?.conversationId!==id)known=undefined;
      if(known){seen.add(known.id);if(known.delivery==='pending'||known.delivery==='uncertain')this.store.updateTurn(known.id,'accepted',known.runId??known.id);}
      const createdAt=typeof raw.timestamp==='number'?raw.timestamp:Date.parse(raw.timestamp??'')||Date.now();
      if(text)messages.push({id:String(raw.id??raw.messageId??`${raw.role}-${messages.length}-${createdAt}`),role:raw.role,text,createdAt,...known?{turnId:known.id,delivery:known.delivery}:{},...raw.runId?{runId:raw.runId}:{}});
    }
    if(live?.runId){const row=this.store.findRun(live.runId);if(row&&!row.cancelRequested){this.store.updateTurn(row.id,'accepted',live.runId);if(typeof live.text==='string')this.text.set(live.runId,live.text);}}
    // A missing run is unknown, never silently resent. It is not an active speaking run.
    for(const row of this.store.conversationTurns(id))if(['pending','accepted','uncertain'].includes(row.delivery)&&row.id!==lastRun?.id){
      if(activeRunIds.has(row.runId??row.id)||activeRunIds.has(row.id))this.store.updateTurn(row.id,'accepted',row.runId??row.id);
      else if(info.hasActiveRun!==true||activeRunIds.size>0)this.store.updateTurn(row.id,'uncertain');
    }
    for(const pending of this.store.pendingMessages(id))if(!seen.has(pending.id))messages.push(pending);
    this.boundState();
    for(const prompt of this.prompts.values())if(prompt.conversationId===id&&prompt.event)this.publish(prompt.event);
    return {conversation,messages,activeTurn:this.store.active(id)};
  }
  async send(id:string,turn:TurnRequest):Promise<TurnReceipt> {
    this.store.mapping(id);
    for(const a of turn.attachments??[])if(!this.store.attachment(a))throw new Error('Attachment not found');
    if((turn.attachments?.length??0)>0&&!this.images)throw new Error('Image support is not verified for this OpenClaw model');
    const {row,fresh}=this.store.addTurn(id,turn);if(!fresh)return this.store.receipt(row);
    this.timings.record(row.id,'submitted',row.createdAt);
    if(!this.ready){this.store.updateTurn(row.id,'failed');return this.store.receipt(this.store.turn(row.id)!);}
    try{
      await this.subscribe(id);if(this.store.turn(row.id)?.cancelRequested)return this.store.receipt(this.store.turn(row.id)!);
      const attachments=(turn.attachments??[]).map(a=>{const value=this.store.attachment(a)!;return {type:'image',mimeType:value.meta.mimeType,fileName:value.meta.name,content:value.bytes.toString('base64')};});
      const response=await this.request('chat.send',{...this.target(id),message:turn.text,idempotencyKey:turn.id,...attachments.length?{attachments}:{}});
      const runId=typeof response.runId==='string'?response.runId:row.id;
      this.store.updateTurn(row.id,'accepted',runId);
      this.timings.record(row.id,'admitted',row.createdAt);
      if(this.store.turn(row.id)?.cancelRequested)await this.request('chat.abort',{...this.target(id),runId});
    }catch(error){this.store.updateTurn(row.id,error instanceof RejectedRequest?'failed':'uncertain');}
    const receipt=this.store.receipt(this.store.turn(row.id)!);this.publish({type:'turn',conversationId:id,...receipt});return receipt;
  }
  async abort(id:string,turnId:string):Promise<void> {
    const row=this.store.turn(turnId);if(!row||row.conversationId!==id)throw new Error('Turn not found');
    this.store.cancelTurn(turnId);this.clearPrompts(id);this.text.delete(row.runId??row.id);this.sequence.delete(row.runId??row.id);this.publish({type:'turn',conversationId:id,turnId,delivery:'cancelled',runId:row.runId});
    const startedAt=Date.now();this.timings.record(turnId,'cancel-requested',startedAt);
    if(this.ready)await this.request('chat.abort',{...this.target(id),runId:row.runId??row.id}).then(()=>this.timings.record(turnId,'cancel-confirmed',startedAt)).catch(()=>{});
  }
  private chat(p:Json):void {
    const row=this.store.findRun(p.runId);if(!row)return;
    if(p.sessionKey!==this.store.mapping(row.conversationId).sessionKey)return;
    if(!Number.isSafeInteger(p.seq)||p.seq<0||p.seq<=(this.sequence.get(p.runId)??-1))return;
    if(row.cancelRequested||terminal.has(row.delivery))return;
    const priorSeq=this.sequence.get(p.runId);this.sequence.set(p.runId,p.seq);
    if(priorSeq!==undefined&&p.seq>priorSeq+1)this.publish({type:'reconcile',conversationId:row.conversationId});
    this.store.updateTurn(row.id,'accepted',p.runId);
    if(p.state==='delta'){
      const delta=typeof p.deltaText==='string'?p.deltaText:displayText(p.message);
      const replace=p.replace===true||typeof p.deltaText!=='string';
      const accumulated=replace?delta:(this.text.get(p.runId)??'')+delta;
      if(accumulated.length>200000){this.publish({type:'reconcile',conversationId:row.conversationId});this.text.delete(p.runId);return;}
      if(!this.text.has(p.runId))this.timings.record(row.id,'first-text',row.createdAt);
      this.text.set(p.runId,accumulated);this.boundState();
      this.publish({type:'assistant',conversationId:row.conversationId,turnId:row.id,runId:p.runId,seq:p.seq,text:delta,replace});
    }else if(['final','aborted','error'].includes(p.state)){
      const cancelled=p.state==='aborted';const delivery=cancelled?'cancelled':p.state==='error'?'failed':'complete';
      this.store.updateTurn(row.id,delivery,p.runId);
      this.timings.record(row.id,p.state==='error'?'failed':'completed',row.createdAt);
      this.publish({type:'turn',conversationId:row.conversationId,turnId:row.id,runId:p.runId,delivery,...p.state==='error'?{error:'OpenClaw could not finish this turn. Your message is retained.'}:{}});
      this.publish({type:'complete',conversationId:row.conversationId,turnId:row.id,runId:p.runId,...p.state==='error'?{failed:true}:{text:displayText(p.message)||this.text.get(p.runId)||''},cancelled});
      this.text.delete(p.runId);this.sequence.delete(p.runId);this.clearPrompts(row.conversationId);
    }else if(p.state==='status')this.publish({type:'activity',conversationId:row.conversationId,turnId:row.id,label:'Preparing your response'});
  }
  private activity(p:Json):void {
    const row=this.store.findRun(p.runId);if(!row||row.cancelRequested||['complete','failed'].includes(row.delivery))return;
    if(p.stream==='tool')this.publish({type:'activity',conversationId:row.conversationId,turnId:row.id,label:'Using a tool'});
    else if(p.stream==='lifecycle'&&p.data?.phase==='start')this.publish({type:'activity',conversationId:row.conversationId,turnId:row.id,label:'Working on your request'});
  }
  private prompt(event:string,p:Json):void {
    this.boundState();
    const runId=p.runId??p.request?.runId;
    const sessionKey=p.sessionKey??p.request?.sessionKey;
    const conversationId=typeof sessionKey==='string'?this.store.conversationForSession(sessionKey):undefined;
    const row=typeof runId==='string'?this.store.findRun(runId):undefined;
    const owner=row??(conversationId?this.store.conversationTurns(conversationId).find(t=>!t.cancelRequested&&!terminal.has(t.delivery)):undefined);
    if(!owner||owner.cancelRequested||terminal.has(owner.delivery)||typeof p.id!=='string'||p.id.length>128||this.prompts.size>=100||this.prompts.has(p.id)||this.questionGroups.has(p.id))return;
    if(typeof sessionKey==='string'&&sessionKey!==this.store.mapping(owner.conversationId).sessionKey)return;
    const expiresAt=Math.min(typeof p.expiresAtMs==='number'?p.expiresAtMs:Date.now()+120000,Date.now()+600000);if(expiresAt<=Date.now())return;
    if(event==='exec.approval.requested'){
      if(!this.approvals)return;
      const request=p.request??p;const command=request.command??request.systemRunPlan?.commandText;
      const cwd=request.cwd??request.systemRunPlan?.cwd??'(default workspace)';
      const secret=/\b(?:api[_-]?key|token|password|secret|authorization)\s*[:=]|\bsk-[a-z0-9]{12}|-----BEGIN .*PRIVATE KEY|--(?:password|token|api-key)\b/i;
      const detail=typeof command==='string'?`Command:\n${command}\n\nDirectory:\n${cwd}`:'';
      const allow=Boolean(detail&&detail.length<=8000&&!secret.test(detail)&&!Object.keys(request.env??{}).length);
      const outgoing:ServerEvent={type:'approval',conversationId:owner.conversationId,id:p.id,label:allow?'OpenClaw requests permission to run this command.':'This command requires review in OpenClaw; it cannot be safely displayed here.',...(allow?{detail}:{}),expiresAt};
      this.prompts.set(p.id,{kind:'approval',conversationId:owner.conversationId,expiresAt,allow,event:outgoing});this.publish(outgoing);
    }else if(this.methods.has('question.resolve')&&Array.isArray(p.questions)&&p.questions.length>0&&p.questions.length<=10){
      const valid=p.questions.filter((q:Json)=>typeof q.id==='string'&&typeof q.question==='string'&&q.question.length<=4000&&!q.isSecret);
      if(valid.length!==p.questions.length)return;
      this.questionGroups.set(p.id,{ids:valid.map((q:Json)=>q.id),answers:{},expiresAt});
      for(const q of valid){const localId=randomUUID();const outgoing:ServerEvent={type:'question',conversationId:owner.conversationId,id:localId,text:q.question,options:Array.isArray(q.options)?q.options.slice(0,20).map((v:Json)=>v.label).filter((v:unknown)=>typeof v==='string'&&v.length<=500):undefined};this.prompts.set(localId,{kind:'question',conversationId:owner.conversationId,expiresAt,requestId:p.id,questionId:q.id,event:outgoing});this.publish(outgoing);}
    }
  }
  private clearPrompts(conversationId:string):void {for(const [id,p] of this.prompts)if(p.conversationId===conversationId){this.prompts.delete(id);if(p.requestId)this.questionGroups.delete(p.requestId);}}
  private boundState():void {
    for(const [id,p] of this.prompts)if(p.expiresAt<Date.now())this.prompts.delete(id);
    for(const [id,p] of this.questionGroups)if(p.expiresAt<Date.now())this.questionGroups.delete(id);
    for(const map of [this.sequence,this.text])while(map.size>100)map.delete(map.keys().next().value!);
  }
  async approval(id:string,decision:string):Promise<void> {
    const p=this.prompts.get(id);if(!p||p.kind!=='approval'||p.expiresAt<Date.now())throw new Error('Approval is no longer available');
    if(decision!=='deny'&&!p.allow)throw new Error('Review and allow this command in OpenClaw');
    await this.request('exec.approval.resolve',{id,decision});this.prompts.delete(id);
  }
  async answer(id:string,answer:string):Promise<void> {const p=this.prompts.get(id);if(!p||p.kind!=='question'||p.expiresAt<Date.now()||!p.requestId||!p.questionId)throw new Error('Question is no longer available');const group=this.questionGroups.get(p.requestId);if(!group)throw new Error('Question is no longer available');group.answers[p.questionId]=[answer];if(group.ids.every(q=>group.answers[q])){await this.request('question.resolve',{id:p.requestId,answers:{answers:group.answers}});this.questionGroups.delete(p.requestId);}this.prompts.delete(id);}
  close():void {this.stopped=true;clearTimeout(this.timer);clearTimeout(this.connectingTimer);this.socket?.removeAllListeners();this.socket?.close();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Service stopped'));}this.pending.clear();}
}
