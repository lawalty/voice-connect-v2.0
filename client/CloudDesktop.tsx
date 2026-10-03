import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Monitor, RefreshCw, Globe, Terminal, Folder, Clipboard } from 'lucide-react';
import NoVNC from '@novnc/novnc/lib/rfb.js';
import { api, setCsrf } from './api';
import type { AppStatus } from '../contract/types';
import './desktop.css';

type Connection={ticket:string;control:boolean;password?:string};
// The published noVNC CommonJS package has a nested default under Vite's interop.
const RFB=typeof NoVNC==='function'?NoVNC:(NoVNC as unknown as {default:typeof NoVNC}).default;
type RFB=NoVNC;
export default function CloudDesktop() {
  const [authenticated,setAuthenticated]=useState(false),[password,setPassword]=useState(''),[loading,setLoading]=useState(true);
  const [error,setError]=useState(''),[state,setState]=useState('Disconnected'),[control,setControl]=useState(false),[attempt,setAttempt]=useState(0);
  const [connected,setConnected]=useState(false),[manual,setManual]=useState(false),[clipboard,setClipboard]=useState('');
  const screen=useRef<HTMLDivElement>(null),viewer=useRef<RFB|null>(null);
  useEffect(()=>{let current=true;void api<AppStatus>('/api/status').then(status=>{if(current){setCsrf(status.csrfToken);setAuthenticated(status.authenticated);}}).catch(()=>{if(current)setError('Voice Connect could not connect. Reload to retry.');}).finally(()=>{if(current)setLoading(false);});return()=>{current=false;};},[]);
  async function login(event:FormEvent) {
    event.preventDefault();setError('');setLoading(true);
    try {const status=await api<AppStatus>('/api/auth/login',{method:'POST',body:JSON.stringify({password})});setCsrf(status.csrfToken);setPassword('');setAuthenticated(status.authenticated);}
    catch(reason){setError(reason instanceof Error?reason.message:'Sign-in failed.');}finally{setLoading(false);}
  }
  useEffect(()=>{
    if(!authenticated||!screen.current)return;
    let current=true,rfb:RFB|undefined,ticket:string|undefined;
    setState('Connecting…');setConnected(false);setManual(false);setError('');
    const release=(value:string)=>{void api('/api/desktop/release',{method:'POST',body:JSON.stringify({ticket:value})}).catch(()=>{});};
    void api<Connection>('/api/desktop/connect',{method:'POST',body:JSON.stringify({control})}).then(connection=>{
      ticket=connection.ticket;
      if(!current){release(ticket);return;}
      const url=new URL('/api/desktop/stream',window.location.origin);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('ticket',ticket);
      rfb=new RFB(screen.current!,url.href,{credentials:{password:connection.password}});viewer.current=rfb;
      rfb.viewOnly=!connection.control;rfb.scaleViewport=true;rfb.resizeSession=false;rfb.background='#07111b';
      rfb.addEventListener('connect',()=>{if(current){setConnected(true);setManual(connection.control);setState(connection.control?'You have control':'View only');}});
      rfb.addEventListener('disconnect',()=>{if(current){setConnected(false);setManual(false);setState('Disconnected');setError('The desktop disconnected or another viewer took control. Reconnect to continue.');}});
      rfb.addEventListener('securityfailure',()=>{if(current)setError('Desktop authentication failed. Reconnect to retry.');});
    }).catch(reason=>{if(current){setState('Unavailable');setError(reason instanceof Error?reason.message:'The cloud desktop is unavailable.');}});
    return()=>{current=false;viewer.current=null;rfb?.disconnect();if(ticket)release(ticket);};
  },[authenticated,control,attempt]);
  function paste(event:FormEvent) {event.preventDefault();if(connected&&manual&&clipboard){viewer.current?.clipboardPasteFrom(clipboard);setClipboard('');viewer.current?.focus();}}
  function openApp(app:'browser'|'terminal'|'files') {
    const rfb=viewer.current;if(!connected||!manual||!rfb||rfb.viewOnly)return;
    const key={browser:[0x62,'KeyB'],terminal:[0x74,'KeyT'],files:[0x65,'KeyE']}[app] as [number,string];
    // These fixed desktop shortcuts use the same native-controlled RFB input
    // channel as typing on the screen. View-only observers cannot launch apps.
    rfb.sendKey(0xffeb,'MetaLeft',true);
    try {rfb.sendKey(key[0],key[1]);} finally {rfb.sendKey(0xffeb,'MetaLeft',false);}
    rfb.focus();
  }
  function returnToVoiceConnect() {
    viewer.current?.disconnect();
    try {
      const original=window.opener as Window|null;
      if(original&&!original.closed&&original.location.origin===window.location.origin) {
        original.focus();window.close();return;
      }
    } catch { /* The original may have navigated to another origin. */ }
    // A directly opened desktop or a closed original returns in this same tab.
    window.location.replace('/');
  }
  if(!authenticated)return <main className="desktop-login"><Monitor size={32}/><h1>Cloud desktop</h1><p>Sign in with your Voice Connect password.</p><form onSubmit={event=>void login(event)}><label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event=>setPassword(event.target.value)}/></label><button className="button primary" disabled={loading}>{loading?'Connecting…':'Sign in'}</button></form>{error&&<p role="alert">{error}</p>}</main>;
  return <main className="cloud-desktop">
    <header className="desktop-toolbar"><div><h1><Monitor size={20}/>Cloud desktop</h1><span className="desktop-subtitle">Your VPS workspace</span></div><div className="desktop-actions"><button className="button secondary" onClick={()=>setAttempt(value=>value+1)}><RefreshCw size={16}/>Reconnect</button><button className="button secondary" onClick={returnToVoiceConnect} title="Return to the original Voice Connect window and close this desktop">Voice Connect</button></div></header>
    <p className="desktop-hint">{manual?'Use the screen or dock to switch apps. Release control when you want the agent to continue.':'Watch the agent here. Select Take control to use the screen and dock.'}</p>
    {error&&<p className="desktop-error" role="alert">{error}</p>}
    <section className="desktop-frame" aria-label="Cloud workspace">
      <div ref={screen} className="desktop-screen" aria-label="VPS desktop screen"/>
      <nav className="desktop-dock" aria-label="Desktop applications">
        <button className="desktop-app" onClick={()=>openApp('browser')} disabled={!connected||!manual} title={manual?'Open or focus Google Chrome':'Take control to open Browser'}><span className="desktop-app-icon browser-icon"><Globe size={25}/></span><span>Browser</span></button>
        <button className="desktop-app" onClick={()=>openApp('terminal')} disabled={!connected||!manual} title={manual?'Open or focus Terminal':'Take control to open Terminal'}><span className="desktop-app-icon terminal-icon"><Terminal size={25}/></span><span>Terminal</span></button>
        <button className="desktop-app" onClick={()=>openApp('files')} disabled={!connected||!manual} title={manual?'Open or focus Shared files':'Take control to open Files'}><span className="desktop-app-icon files-icon"><Folder size={25}/></span><span>Files</span></button>
      </nav>
    </section>
    <footer className="desktop-control"><span role="status">Ubuntu VPS · {state}</span><button className="button primary" onClick={()=>{setControl(!manual);setAttempt(value=>value+1);}} disabled={!connected}>{manual?'Release control':'Take control'}</button></footer>
    {manual&&<details className="desktop-clipboard"><summary><Clipboard size={15}/>Clipboard</summary><form className="desktop-keyboard" onSubmit={paste}><label>Clipboard text<input value={clipboard} onChange={event=>setClipboard(event.target.value)} placeholder="Text to copy into the remote clipboard"/></label><button className="button secondary" disabled={!connected||!clipboard}>Copy to desktop</button><button type="button" className="button secondary" disabled={!connected} onClick={()=>{viewer.current?.sendKey(0xffe3,'ControlLeft',true);viewer.current?.sendKey(0x76,'KeyV');viewer.current?.sendKey(0xffe3,'ControlLeft',false);}}>Paste</button></form></details>}
  </main>;
}
