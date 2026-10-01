import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Download, Upload, Trash2, Palette } from 'lucide-react';
import { useOrbAppearance } from './OrbProvider';
import { isBuiltinPack } from './packs';
import type { VoicePhase } from '../../contract/types';
import type { MouthPose } from './speech';
import './orbs.css';

const FaceOrb=lazy(()=>import('./FaceOrb'));
const StatusOrb=lazy(()=>import('./StatusOrb'));
const previewSpeech=():MouthPose=>({open:Math.max(0,Math.sin(performance.now()*.012)*.48+.45),round:.2,wide:.3,source:'estimated'});
export default function OrbAppearance(){
  const appearance=useOrbAppearance(),file=useRef<HTMLInputElement>(null);
  const [open,setOpen]=useState(false),[phase,setPhase]=useState<VoicePhase>('listening'),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [download,setDownload]=useState<{url:string;name:string}>();
  useEffect(()=>()=>{if(download)URL.revokeObjectURL(download.url);},[download]);
  useEffect(()=>{setDownload(undefined);},[appearance.pack?.id]);
  useEffect(()=>{if(open)appearance.refresh();},[open,appearance.refresh]);
  async function run(action:()=>Promise<void>){setBusy(true);setError('');try{await action();}catch(e){setError(e instanceof Error?e.message:'The orb could not be updated.');}finally{setBusy(false);}}
  return <details className="settings-section orb-appearance" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary><Palette size={18}/><span>Orb appearance</span></summary>
    <p className="setting-detail">Orb packs and appearance are shared across devices signed in to this VC installation. Changes save automatically.</p>
    <label>Orb style<select value={appearance.pack?.id||'classic'} disabled={busy||!appearance.loaded} onChange={event=>appearance.choose({packId:event.target.value})}>
      <option value="classic">Classic floating orb</option>{appearance.packs.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}
    </select></label>
    {appearance.pack&&<>
      <div className="orb-pack-preview" aria-label="Silent orb preview">{open&&<Suspense fallback={<p className="setting-detail">Loading preview…</p>}>{appearance.pack.renderer==='status-orb-v1'
        ? <StatusOrb pack={appearance.pack} phase={phase} asleep={phase==='off'} signal={null}/>
        : <FaceOrb pack={appearance.pack} motion={appearance.preferences.motion} phaseColors={appearance.preferences.phaseColors} phase={phase} asleep={phase==='off'} signal={null} getSpeech={previewSpeech}/>}</Suspense>}</div>
      <div className="orb-preview-controls"><label>Preview expression<select value={phase} onChange={e=>setPhase(e.target.value as VoicePhase)}><option value="off">Idle / resting</option><option value="standby">Standby</option><option value="starting">Connecting</option><option value="listening">Listening</option><option value="thinking">Thinking</option><option value="working">Working</option><option value="speaking">Speaking</option><option value="error">Error</option></select></label><span className="setting-detail">Silent preview</span></div>
      {appearance.pack.renderer==='glass-face-v1'?<>
      <label className="toggle-row orb-color-toggle"><span><strong>State colors</strong><small>Change the face’s hue and glow with listening, thinking and speaking.</small></span><input type="checkbox" checked={appearance.preferences.phaseColors} disabled={busy||!appearance.loaded} aria-label="State colors" aria-describedby="orb-color-help" onChange={e=>appearance.choose({phaseColors:e.target.checked})}/></label>
      <p id="orb-color-help" className="setting-detail">Turn off to keep your artwork’s original colors. Expressions, movement and lip-sync continue.</p>
      <label className="orb-motion-label" htmlFor="orb-motion">Movement <output>{appearance.preferences.motion===0?'Head still':appearance.preferences.motion<.7?'Subtle':appearance.preferences.motion>1.15?'Lively':'Expressive'}</output></label>
      <input id="orb-motion" type="range" min="0" max="1.5" step=".05" disabled={busy||!appearance.loaded} value={appearance.preferences.motion} onChange={e=>appearance.choose({motion:Number(e.target.value)})}/>
      <p className="setting-detail">Movement continues while listening and speaking. Your device’s reduced-motion preference takes priority.</p>
      </>:<p className="setting-detail">Eight original state colors, a rotating microphone during speech, and 12-segment ears. Tool activity shows orange; this pack adds no background audio. Your Orb ears setting controls the live meters.</p>}
    </>}
    <div className="orb-pack-actions">
      <button type="button" className="button secondary small" disabled={busy||appearance.saving||!appearance.loaded} onClick={()=>file.current?.click()}><Upload size={14}/>Import orb pack</button>
      {appearance.pack&&<button type="button" className="button secondary small" disabled={busy||appearance.saving} onClick={()=>void run(async()=>setDownload(await appearance.exportPack()))}><Download size={14}/>Export orb pack</button>}
      {appearance.pack&&!isBuiltinPack(appearance.pack.id)&&<button type="button" className="icon-button" aria-label="Remove imported orb" disabled={busy||appearance.saving} onClick={()=>{if(window.confirm('Remove this orb pack from all devices? Export a copy first if you want to keep it.'))void run(appearance.removePack);}}><Trash2 size={16}/></button>}
    </div>
    {download&&<p className="setting-detail" role="status">Your pack is ready. <a href={download.url} download={download.name}>Save {download.name}</a></p>}
    <input ref={file} type="file" accept=".json,.orb.json,application/json" hidden onChange={e=>{const selected=e.target.files?.[0];e.target.value='';if(selected)void run(()=>appearance.importPack(selected));}}/>
    <p className="setting-detail">Orb packs can contain prepared facial expressions or a microphone orb’s state palette. Export a pack as a starting point for your own version.</p>
    {appearance.saving&&<p className="setting-detail" role="status">Saving shared appearance…</p>}
    {appearance.notice&&<p className="inline-notice" role="status">{appearance.notice} <button type="button" className="text-button" disabled={busy||appearance.saving} onClick={appearance.retry}>Retry orb sync</button></p>}{error&&<p className="error-text" role="alert">{error}</p>}
  </details>;
}
