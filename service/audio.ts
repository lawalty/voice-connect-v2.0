import WebSocket from 'ws';
import type { AudioEvent } from '../contract/types.js';

export const PREMIUM_VOICES=[{id:'flux-haley-en',name:'Haley · English'}];
export function bridgeAudio(client:WebSocket, kind:'stt'|'tts', key:string, voice:string, authorized:()=>boolean):void {
  const url=new URL(kind==='stt'?'wss://api.deepgram.com/v2/listen':'wss://api.deepgram.com/v2/speak');
  url.searchParams.set('model',kind==='stt'?'flux-general-en':voice);
  url.searchParams.set('encoding','linear16');url.searchParams.set('sample_rate',kind==='stt'?'16000':'24000');
  if(kind==='stt'){url.searchParams.set('eot_threshold','0.8');url.searchParams.set('eot_timeout_ms','5000');}
  const remote=new WebSocket(url,{headers:{Authorization:`Token ${key}`},maxPayload:1024*1024,perMessageDeflate:false,handshakeTimeout:10000});
  let ready=false,ended=false,interrupted=false,lastSequence=-1,bytes=0,textChars=0;
  const send=(event:AudioEvent)=>{if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify(event));};
  const fail=(message:string)=>{if(ended)return;ended=true;send({type:'error',message});remote.close();client.close(1011,'Speech connection ended');};
  const timer=setTimeout(()=>fail('Speech provider did not become ready. Try again or choose Browser speech.'),12000);
  const limitTimer=setTimeout(()=>fail('Speech connection reached its time limit. Start a new voice session.'),30*60*1000);
  remote.on('error',()=>fail('Speech provider is unavailable. Check your key or choose Browser speech.'));
  remote.on('close',()=>{clearTimeout(timer);if(!ended)fail('Speech connection closed. Your conversation is preserved.');});
  remote.on('message',(data,binary)=>{
    if(ended||!authorized()){fail('Your sign-in expired. Sign in again.');return;}
    if(binary){if(kind==='tts'&&!interrupted){if(client.bufferedAmount>2*1024*1024){fail('Audio playback could not keep up.');return;}client.send(data,{binary:true});}return;}
    let p:Record<string,any>;try{p=JSON.parse(data.toString());}catch{return;}
    if(p.type==='Connected'){ready=true;clearTimeout(timer);send({type:'ready',sampleRate:kind==='stt'?16000:24000});}
    else if(p.type==='Error')fail('Speech provider could not process this audio. Try again or select Browser speech.');
    else if(kind==='stt'&&p.type==='TurnInfo'){
      if(typeof p.sequence_id==='number'&&p.sequence_id<=lastSequence)return;
      lastSequence=typeof p.sequence_id==='number'?p.sequence_id:lastSequence;
      if(['StartOfTurn','Update','EndOfTurn'].includes(p.event)&&typeof p.transcript==='string')send({type:'stt',text:p.transcript.slice(0,20000),final:p.event==='EndOfTurn',turnComplete:p.event==='EndOfTurn',started:p.event==='StartOfTurn'});
    }else if(kind==='tts'&&p.type==='SpeechMetadata'){textChars=0;send({type:'speech-done'});}
    else if(kind==='tts'&&p.type==='SpeechInterrupted'){interrupted=false;textChars=0;send({type:'interrupted'});}
  });
  client.on('message',(data,binary)=>{
    if(!authorized()){fail('Your sign-in expired. Sign in again.');return;}
    if(ended)return;
    if(!ready){fail('Speech provider is not ready.');return;}
    if(remote.bufferedAmount>256*1024){fail('Speech connection is too slow. Please try again.');return;}
    if(binary){
      const size=Array.isArray(data)?data.reduce((n,b)=>n+b.length,0):data instanceof ArrayBuffer?data.byteLength:data.length;
      if(kind!=='stt'||size>64000||size%2!==0){fail('Unsupported audio frame.');return;}
      bytes+=size;if(bytes>60*60*32000){fail('Audio session limit reached.');return;}
      remote.send(data,{binary:true});return;
    }
    let p:Record<string,any>;try{p=JSON.parse(data.toString());}catch{fail('Invalid speech control.');return;}
    if(kind==='stt'&&p.type==='finish')remote.send(JSON.stringify({type:'ForceEndTurn'}));
    else if(kind==='tts'&&p.type==='speak'&&typeof p.text==='string'&&p.text.length<=4000){
      textChars+=p.text.length;if(textChars>30000){fail('Speech reply is too long. Read the remaining text.');return;}
      remote.send(JSON.stringify({type:'Speak',text:p.text}));
    }else if(kind==='tts'&&p.type==='flush')remote.send(JSON.stringify({type:'Flush'}));
    else if(kind==='tts'&&p.type==='interrupt'){
      interrupted=true;const offset=typeof p.offsetMs==='number'&&Number.isFinite(p.offsetMs)&&p.offsetMs>=0?p.offsetMs:undefined;
      remote.send(JSON.stringify({type:'Interrupt',...offset!==undefined?{playback_offset:{type:'time_ms',value:offset}}:{}}));
    }else fail('Unsupported speech control.');
  });
  client.on('error',()=>{});
  client.on('close',()=>{ended=true;clearTimeout(timer);clearTimeout(limitTimer);remote.close();});
}
