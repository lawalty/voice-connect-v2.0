import WebSocket from 'ws';
import type { AudioEvent } from '../contract/types.js';

type RecognitionRemoteFactory=(url:URL,options:WebSocket.ClientOptions)=>WebSocket;
function handshakeFailure(status:number|undefined):string {
  const messages:Record<number,string>={
    400:'Deepgram rejected the recognition request configuration (HTTP 400). Refresh Voice Connect and try again.',
    401:'Deepgram rejected authentication (HTTP 401). Re-enter the intended API key in Settings and choose Save key. If the key is correct, check its project permissions. If the key is already correct, check its project permissions.',
    402:'Deepgram requires account credits (HTTP 402). Check the project billing balance before retrying recognition.',
    403:'Deepgram denied access to Flux recognition (HTTP 403). Check the saved key\'s project permissions and model access.',
    429:'Deepgram recognition is rate limited (HTTP 429). Wait a moment and retry, or choose on-device recognition.',
  };
  if(status!==undefined&&messages[status])return messages[status];
  if(status!==undefined&&status>=500&&status<=599)return 'Deepgram recognition is temporarily unavailable (HTTP 5xx). Retry later or choose on-device recognition.';
  return 'Deepgram rejected the recognition connection. Retry or choose on-device recognition.';
}
export function bridgeRecognition(client:WebSocket,key:string,authorized:()=>boolean,remoteFactory:RecognitionRemoteFactory=(url,options)=>new WebSocket(url,options)):void {
  const url=new URL('wss://api.deepgram.com/v2/listen');
  url.searchParams.set('model','flux-general-en');
  url.searchParams.set('encoding','linear16');url.searchParams.set('sample_rate','16000');
  url.searchParams.set('eot_threshold','0.8');url.searchParams.set('eot_timeout_ms','5000');
  const remote=remoteFactory(url,{headers:{Authorization:`Token ${key}`},maxPayload:1024*1024,perMessageDeflate:false,handshakeTimeout:10000});
  let ready=false,ended=false,lastSequence=-1,bytes=0;
  const send=(event:AudioEvent)=>{if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify(event));};
  const cleanup=()=>{clearTimeout(timer);clearTimeout(limitTimer);};
  const fail=(message:string)=>{if(ended)return;ended=true;cleanup();send({type:'error',message});remote.close();client.close(1011,'Speech connection ended');};
  const timer=setTimeout(()=>fail('Deepgram recognition did not become ready. Try again or choose on-device recognition.'),12000);
  const limitTimer=setTimeout(()=>fail('Deepgram recognition reached its time limit. Start a new voice session.'),30*60*1000);
  remote.on('unexpected-response',(_request,response)=>{
    // Classify only the HTTP status. Neither rejected response contents nor
    // request headers (which contain authorization) cross the browser boundary.
    try {fail(handshakeFailure(response.statusCode));}
    finally {response.resume();response.destroy();}
  });
  remote.on('error',()=>fail('The server could not connect to Deepgram recognition. Retry or choose on-device recognition.'));
  remote.on('close',()=>{cleanup();if(!ended)fail('Deepgram recognition disconnected. Your conversation is preserved.');});
  remote.on('message',(data,binary)=>{
    if(ended||!authorized()){fail('Your sign-in expired. Sign in again.');return;}
    if(binary)return;
    let p:Record<string,any>;try{p=JSON.parse(data.toString());}catch{return;}
    if(!p||typeof p!=='object')return;
    if(p.type==='Connected'){ready=true;clearTimeout(timer);send({type:'ready',sampleRate:16000});}
    else if(p.type==='Error')fail('Deepgram could not process this audio. Try again or choose on-device recognition.');
    else if(p.type==='TurnInfo'){
      if(typeof p.sequence_id==='number'&&p.sequence_id<=lastSequence)return;
      lastSequence=typeof p.sequence_id==='number'?p.sequence_id:lastSequence;
      if(['StartOfTurn','Update','EndOfTurn'].includes(p.event)&&typeof p.transcript==='string')send({type:'stt',text:p.transcript.slice(0,20000),final:p.event==='EndOfTurn',turnComplete:p.event==='EndOfTurn',started:p.event==='StartOfTurn'});
    }
  });
  client.on('message',(data,binary)=>{
    if(!authorized()){fail('Your sign-in expired. Sign in again.');return;}
    if(ended)return;
    if(!ready){fail('Deepgram recognition is not ready.');return;}
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
  client.on('close',()=>{ended=true;cleanup();remote.close();});
}
