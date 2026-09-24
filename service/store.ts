import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { join } from 'node:path';
import type { Conversation, Delivery, Attachment, TurnRequest, TurnReceipt, Message } from '../contract/types.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export interface TurnRow { id: string; conversationId: string; text: string; attachments: string[]; fingerprint: string; delivery: Delivery; runId?: string; cancelRequested: boolean; createdAt: number; }
export class Store {
  readonly db: DatabaseSync;
  constructor(dir: string, readonly key: Buffer) {
    this.db = new DatabaseSync(dir === ':memory:' ? dir : join(dir, 'voice-connect.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, session_key TEXT NOT NULL, session_id TEXT);
      CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, conversation TEXT NOT NULL REFERENCES conversations(id), text TEXT NOT NULL, attachments TEXT NOT NULL, fingerprint TEXT NOT NULL, delivery TEXT NOT NULL, run_id TEXT, cancelled INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, bytes BLOB NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS turns_conversation ON turns(conversation,created);
      CREATE INDEX IF NOT EXISTS turns_run ON turns(run_id);`);
    this.db.prepare("UPDATE turns SET delivery='uncertain' WHERE delivery IN ('pending','accepted') AND cancelled=0").run();
  }
  get(key: string): string | undefined { return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|undefined)?.value; }
  set(key: string, value: string): void { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  remove(key: string): void { this.db.prepare('DELETE FROM settings WHERE key=?').run(key); }
  ownerConfigured(): boolean { return Boolean(this.get('password')); }
  session(token: string): { csrf: string; expires: number } | undefined {
    return this.db.prepare('SELECT csrf, expires FROM sessions WHERE hash=? AND expires>?').get(digest(token), Date.now()) as {csrf:string;expires:number}|undefined;
  }
  createSession(): {token:string;csrf:string} {
    this.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    const token=randomBytes(32).toString('base64url'), csrf=randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token),csrf,Date.now()+7*86400_000);
    return {token,csrf};
  }
  logout(token:string):void { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token)); }
  encrypt(value: string): string {
    const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',this.key,iv);
    const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    return [iv,cipher.getAuthTag(),encrypted].map(v=>v.toString('base64')).join('.');
  }
  decrypt(value: string): string {
    const [iv,tag,bytes]=value.split('.').map(v=>Buffer.from(v,'base64'));
    const decipher=createDecipheriv('aes-256-gcm',this.key,iv);decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(bytes),decipher.final()]).toString('utf8');
  }
  deepgramKey():string { const v=this.get('deepgram'); return v?this.decrypt(v):''; }
  createConversation(title='New conversation'):Conversation {
    const id=randomUUID(),now=Date.now();
    const agentId=this.get('default-agent');if(!agentId)throw new Error('The OpenClaw agent has not been discovered');
    this.db.prepare('INSERT INTO conversations(id,title,created,updated,session_key) VALUES (?,?,?,?,?)').run(id,title,now,now,`agent:${agentId}:vc2:${id}`);
    return {id,title,createdAt:now,updatedAt:now};
  }
  conversations():Conversation[] { return this.db.prepare('SELECT id,title,created AS createdAt,updated AS updatedAt FROM conversations ORDER BY updated DESC LIMIT 200').all() as unknown as Conversation[]; }
  conversation(id:string):Conversation|undefined { return this.db.prepare('SELECT id,title,created AS createdAt,updated AS updatedAt FROM conversations WHERE id=?').get(id) as unknown as Conversation|undefined; }
  conversationForSession(key:string):string|undefined {return (this.db.prepare('SELECT id FROM conversations WHERE session_key=?').get(key) as {id:string}|undefined)?.id;}
  mapping(id:string):{sessionKey:string;sessionId?:string} {
    const row=this.db.prepare('SELECT session_key AS sessionKey, session_id AS sessionId FROM conversations WHERE id=?').get(id) as {sessionKey:string;sessionId?:string}|undefined;
    if(!row)throw new Error('Conversation not found');return row;
  }
  setSession(id:string, sessionId:string):void { this.db.prepare('UPDATE conversations SET session_id=? WHERE id=?').run(sessionId,id); }
  turn(id:string):TurnRow|undefined {
    const row=this.db.prepare('SELECT id,conversation AS conversationId,text,attachments,fingerprint,delivery,run_id AS runId,cancelled AS cancelRequested,created AS createdAt FROM turns WHERE id=?').get(id) as Record<string,unknown>|undefined;
    return row?{...row,attachments:JSON.parse(row.attachments as string),cancelRequested:Boolean(row.cancelRequested)} as unknown as TurnRow:undefined;
  }
  findRun(runId:string):TurnRow|undefined { const row=this.db.prepare('SELECT id FROM turns WHERE run_id=? OR id=? LIMIT 1').get(runId,runId) as {id:string}|undefined;return row?this.turn(row.id):undefined; }
  addTurn(conversationId:string, turn:TurnRequest):{row:TurnRow;fresh:boolean} {
    const fingerprint=digest(JSON.stringify([conversationId,turn.text,turn.attachments??[]]));
    const prior=this.turn(turn.id);
    if(prior){if(prior.fingerprint!==fingerprint)throw new Error('Send identity already used');return {row:prior,fresh:false};}
    const now=Date.now();
    this.db.prepare('INSERT INTO turns(id,conversation,text,attachments,fingerprint,delivery,created) VALUES (?,?,?,?,?,?,?)').run(turn.id,conversationId,turn.text,JSON.stringify(turn.attachments??[]),fingerprint,'pending',now);
    this.db.prepare('UPDATE conversations SET updated=?,title=CASE WHEN title=? THEN ? ELSE title END WHERE id=?').run(now,'New conversation',turn.text.slice(0,70)||'Image conversation',conversationId);
    return {row:this.turn(turn.id)!,fresh:true};
  }
  updateTurn(id:string, delivery:Delivery, runId?:string):void {
    this.db.prepare("UPDATE turns SET delivery=CASE WHEN cancelled=1 THEN 'cancelled' WHEN delivery IN ('complete','cancelled','failed') AND ? IN ('pending','accepted','uncertain') THEN delivery ELSE ? END,run_id=COALESCE(?,run_id) WHERE id=?").run(delivery,delivery,runId??null,id);
  }
  cancelTurn(id:string):void { this.db.prepare("UPDATE turns SET cancelled=1,delivery='cancelled' WHERE id=?").run(id); }
  outstanding():TurnRow[] { return (this.db.prepare("SELECT id FROM turns WHERE delivery IN ('pending','accepted','uncertain') OR cancelled=1 ORDER BY created DESC LIMIT 200").all() as {id:string}[]).map(v=>this.turn(v.id)!); }
  conversationTurns(id:string):TurnRow[] {return (this.db.prepare('SELECT id FROM turns WHERE conversation=? ORDER BY created DESC LIMIT 200').all(id) as {id:string}[]).map(v=>this.turn(v.id)!);}
  receipt(row:TurnRow):TurnReceipt { return {turnId:row.id,delivery:row.delivery,...row.runId?{runId:row.runId}:{}}; }
  active(conversationId:string):TurnReceipt|undefined { const row=this.db.prepare("SELECT id FROM turns WHERE conversation=? AND delivery IN ('pending','accepted') ORDER BY created DESC LIMIT 1").get(conversationId) as {id:string}|undefined;return row?this.receipt(this.turn(row.id)!):undefined; }
  pendingMessages(conversationId:string):Message[] {
    return (this.db.prepare("SELECT id FROM turns WHERE conversation=? AND delivery IN ('pending','accepted','uncertain','failed') ORDER BY created").all(conversationId) as {id:string}[]).map(({id})=>{const t=this.turn(id)!;return {id:t.id,role:'user',text:t.text,createdAt:t.createdAt,turnId:t.id,delivery:t.delivery,attachments:t.attachments.map(a=>this.attachment(a)?.meta).filter(Boolean) as Attachment[]};});
  }
  saveAttachment(meta:Attachment, bytes:Buffer):void {
    const total=(this.db.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS total FROM attachments').get() as {total:number}).total;
    if(total+bytes.length>250*1024*1024)throw new Error('Image storage limit reached');
    this.db.prepare('INSERT INTO attachments VALUES (?,?,?,?)').run(meta.id,JSON.stringify(meta),bytes,Date.now());
  }
  attachment(id:string):{meta:Attachment;bytes:Buffer}|undefined { const row=this.db.prepare('SELECT metadata,bytes FROM attachments WHERE id=?').get(id) as {metadata:string;bytes:Uint8Array}|undefined;return row?{meta:JSON.parse(row.metadata),bytes:Buffer.from(row.bytes)}:undefined; }
  close():void { this.db.close(); }
}
