import WebSocket from 'ws';
import type { AudioEvent } from '../contract/types.js';

type RecognitionRemoteFactory=(url:URL,options:WebSocket.ClientOptions)=>WebSocket;
export function bridgeRecognition(client:WebSocket,key:string,authorized:()=>boolean,remoteFactory:RecognitionRemoteFactory=(url,options)=>new WebSocket(url,options)):void {
  const url=new URL('wss://api.deepgram.com/v2/listen');
  url.searchParams.set('model','flux-general-en');
  url.searchParams.set('encoding','linear16');url.searchParams.set('sample_rate','16000');
  url.searchParams.set('eot_threshold','0.8');url.searchParams.set('eot_timeout_ms','5000');
  const remote=remoteFactory(url,{headers:{Authorization:`Token ${key}`},maxPayload:1024*1024,perMessageDeflate:false,handshakeTimeout:10000});
  let ready=false,ended=false,lastSequence=-1,bytes=0;
  const send=(event:AudioEvent)=>{if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify(event));};
  const fail=(message:string)=>{if(ended)return;ended=true;send({type:'error',message});remote.close();client.close(1011,'Speech connection ended');};
  const timer=setTimeout(()=>fail('Speech provider did not become ready. Try again or choose Browser speech.'),12000);
  const limitTimer=setTimeout(()=>fail('Speech connection reached its time limit. Start a new voice session.'),30*60*1000);
  remote.on('error',()=>fail('Speech provider is unavailable. Check your key or choose Browser speech.'));
  remote.on('close',()=>{clearTimeout(timer);if(!ended)fail('Speech connection closed. Your conversation is preserved.');});
  remote.on('message',(data,binary)=>{
    if(ended||!authorized()){fail('Your sign-in expired. Sign in again.');return;}
    if(binary)return;
    let p:Record<string,any>;try{p=JSON.parse(data.toString());}catch{return;}
    if(!p||typeof p!=='object')return;
    if(p.type==='Connected'){ready=true;clearTimeout(timer);send({type:'ready',sampleRate:16000});}
    else if(p.type==='Error')fail('Speech provider could not process this audio. Try again or select Browser speech.');
    else if(p.type==='TurnInfo'){
      if(typeof p.sequence_id==='number'&&p.sequence_id<=lastSequence)return;
      lastSequence=typeof p.sequence_id==='number'?p.sequence_id:lastSequence;
      if(['StartOfTurn','Update','EndOfTurn'].includes(p.event)&&typeof p.transcript==='string')send({type:'stt',text:p.transcript.slice(0,20000),final:p.event==='EndOfTurn',turnComplete:p.event==='EndOfTurn',started:p.event==='StartOfTurn'});
    }
  });
  client.on('message',(data,binary)=>{
    if(!authorized()){fail('Your sign-in expired. Sign in again.');return;}
    if(ended)return;
    if(!ready){fail('Speech provider is not ready.');return;}
    if(remote.bufferedAmount>256*1024){fail('Speech connection is too slow. Please try again.');return;}
    if(binary){
      const size=Array.isArray(data)?data.reduce((n,b)=>n+b.length,0):data instanceof ArrayBuffer?data.byteLength:data.length;
      if(size>64000||size%2!==0){fail('Unsupported audio frame.');return;}
      bytes+=size;if(bytes>60*60*32000){fail('Audio session limit reached.');return;}
      remote.send(data,{binary:true});return;
    }
    let p:Record<string,any>;try{p=JSON.parse(data.toString());}catch{fail('Invalid speech control.');return;}
    if(p&&p.type==='finish')remote.send(JSON.stringify({type:'ForceEndTurn'}));
    else fail('Unsupported speech recognition control.');
  });
  client.on('error',()=>{});
  client.on('close',()=>{ended=true;clearTimeout(timer);clearTimeout(limitTimer);remote.close();});
}
