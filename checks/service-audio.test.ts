import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeRecognition } from '../service/audio';

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: { data: string | Buffer; binary: boolean }[] = [];
  send(data: string | Buffer, options?: { binary?: boolean }) { this.sent.push({data,binary:options?.binary??false}); }
  close = vi.fn(() => { this.readyState = WebSocket.CLOSED; this.emit('close'); });
  event(value: unknown) { this.emit('message',Buffer.from(JSON.stringify(value)),false); }
  frames() { return this.sent.filter(item=>!item.binary).map(item=>JSON.parse(item.data.toString())); }
}
function fixture() {
  const client=new Socket(),remote=new Socket();let allowed=true;
  const factory=vi.fn((_url:URL,_options:WebSocket.ClientOptions)=>remote as unknown as WebSocket);
  bridgeRecognition(client as unknown as WebSocket,'synthetic-recognition-secret',()=>allowed,factory);
  return {client,remote,factory,revoke:()=>{allowed=false;}};
}
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});

describe('recognition-only Deepgram Flux transport',()=>{
  it('preserves the Flux v2 configuration, PCM forwarding, turn boundaries, and ForceEndTurn',()=>{
    const f=fixture(),[url,options]=f.factory.mock.calls[0]!;
    expect(url.origin+url.pathname).toBe('wss://api.deepgram.com/v2/listen');
    expect(Object.fromEntries(url.searchParams)).toEqual({model:'flux-general-en',encoding:'linear16',sample_rate:'16000',eot_threshold:'0.8',eot_timeout_ms:'5000'});
    expect(options.headers).toEqual({Authorization:'Token synthetic-recognition-secret'});
    expect(f.client.frames()).toEqual([]);f.remote.event({type:'Connected'});
    expect(f.client.frames()).toEqual([{type:'ready',sampleRate:16000}]);
    const pcm=Buffer.from([0x34,0x12,0xfe,0xff]);f.client.emit('message',pcm,true);
    expect(f.remote.sent).toEqual([{data:pcm,binary:true}]);
    for(const [sequence_id,event,transcript] of [[1,'StartOfTurn',''],[2,'Update','A complete'],[3,'EndOfTurn','A complete thought.']] as const)f.remote.event({type:'TurnInfo',sequence_id,event,transcript});
    expect(f.client.frames().slice(1)).toEqual([
      {type:'stt',text:'',final:false,turnComplete:false,started:true},
      {type:'stt',text:'A complete',final:false,turnComplete:false,started:false},
      {type:'stt',text:'A complete thought.',final:true,turnComplete:true,started:false},
    ]);
    f.client.event({type:'finish'});expect(f.remote.frames()).toEqual([{type:'ForceEndTurn'}]);
    f.client.close();expect(f.remote.close).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores stale sequences and never forwards synthesis events or provider audio',()=>{
    const f=fixture();f.remote.event({type:'Connected'});
    f.remote.event({type:'TurnInfo',sequence_id:7,event:'EndOfTurn',transcript:'One thought.'});
    f.remote.event({type:'TurnInfo',sequence_id:7,event:'EndOfTurn',transcript:'Duplicate.'});
    f.remote.event({type:'TurnInfo',sequence_id:6,event:'Update',transcript:'Stale.'});
    f.remote.event({type:'SpeechMetadata'});f.remote.event({type:'SpeechInterrupted'});f.remote.emit('message',Buffer.from([0,1]),true);
    expect(f.client.frames()).toHaveLength(2);expect(f.client.sent.every(frame=>!frame.binary)).toBe(true);f.client.close();
  });

  it.each(['speak','flush','interrupt'])('rejects output control %s without forwarding it',type=>{
    const f=fixture();f.remote.event({type:'Connected'});f.client.event({type,text:'Never synthesize this.'});
    expect(f.remote.sent).toEqual([]);expect(f.client.frames().at(-1)).toEqual({type:'error',message:'Unsupported speech recognition control.'});
    expect(f.remote.readyState).toBe(WebSocket.CLOSED);expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves auth failure and bounded input validation without provider error disclosure',()=>{
    const expired=fixture();expired.remote.event({type:'Connected'});expired.revoke();expired.client.emit('message',Buffer.alloc(2560),true);
    expect(expired.remote.sent).toEqual([]);expect(expired.client.frames().at(-1).message).toContain('sign-in expired');
    for(const size of [1,64002]){const f=fixture();f.remote.event({type:'Connected'});f.client.emit('message',Buffer.alloc(size),true);expect(f.remote.sent).toEqual([]);expect(f.client.frames().at(-1).message).toBe('Unsupported audio frame.');}
    const failed=fixture();failed.remote.event({type:'Error',message:'synthetic-recognition-secret'});
    expect(JSON.stringify(failed.client.frames())).not.toContain('synthetic-recognition-secret');expect(vi.getTimerCount()).toBe(0);
  });
});
