import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Download, Upload, Trash2, Palette } from 'lucide-react';
import { useOrbAppearance } from './OrbProvider';
import { LUMINOUS_GLASS } from './packs';
import type { VoicePhase } from '../../contract/types';
import type { MouthPose } from './speech';
import './orbs.css';

const FaceOrb=lazy(()=>import('./FaceOrb'));
const previewSpeech=():MouthPose=>({open:Math.max(0,Math.sin(performance.now()*.012)*.48+.45),round:.2,wide:.3,source:'estimated'});
export default function OrbAppearance(){
  const appearance=useOrbAppearance(),file=useRef<HTMLInputElement>(null);
  const [open,setOpen]=useState(false),[phase,setPhase]=useState<VoicePhase>('listening'),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [download,setDownload]=useState<{url:string;name:string}>();
  useEffect(()=>()=>{if(download)URL.revokeObjectURL(download.url);},[download]);
  useEffect(()=>{setDownload(undefined);},[appearance.pack?.id]);
  async function run(action:()=>Promise<void>){setBusy(true);setError('');try{await action();}catch(e){setError(e instanceof Error?e.message:'The orb could not be updated.');}finally{setBusy(false);}}
  return <details className="settings-section orb-appearance" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary><Palette size={18}/><span>Orb appearance</span></summary>
    <p className="setting-detail">Choose a face and make it your own. Appearance is saved on this device and changes immediately.</p>
    <label>Orb style<select value={appearance.pack?.id||'classic'} disabled={busy||!appearance.loaded} onChange={event=>appearance.choose({packId:event.target.value})}>
      <option value="classic">Classic floating orb</option>{appearance.packs.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}
    </select></label>
    {appearance.pack&&<>
      <div className="orb-pack-preview" aria-label="Silent orb preview">{open&&<Suspense fallback={<p className="setting-detail">Loading preview…</p>}><FaceOrb pack={appearance.pack} motion={appearance.preferences.motion} phase={phase} asleep={phase==='off'} signal={null} getSpeech={previewSpeech}/></Suspense>}</div>
      <div className="orb-preview-controls"><label>Preview expression<select value={phase} onChange={e=>setPhase(e.target.value as VoicePhase)}><option value="off">Resting</option><option value="listening">Listening</option><option value="thinking">Thinking</option><option value="speaking">Speaking</option></select></label><span className="setting-detail">Silent preview</span></div>
      <label className="orb-motion-label" htmlFor="orb-motion">Movement <output>{appearance.preferences.motion===0?'Head still':appearance.preferences.motion<.7?'Subtle':appearance.preferences.motion>1.15?'Lively':'Expressive'}</output></label>
      <input id="orb-motion" type="range" min="0" max="1.5" step=".05" value={appearance.preferences.motion} onChange={e=>appearance.choose({motion:Number(e.target.value)})}/>
      <p className="setting-detail">Movement continues while listening and speaking. Your device’s reduced-motion preference takes priority.</p>
    </>}
    <div className="orb-pack-actions">
      <button type="button" className="button secondary small" disabled={busy||!appearance.loaded} onClick={()=>file.current?.click()}><Upload size={14}/>Import orb pack</button>
      {appearance.pack&&<button type="button" className="button secondary small" disabled={busy} onClick={()=>void run(async()=>setDownload(await appearance.exportPack()))}><Download size={14}/>Export orb pack</button>}
      {appearance.pack&&appearance.pack.id!==LUMINOUS_GLASS.id&&<button type="button" className="icon-button" aria-label="Remove imported orb" disabled={busy} onClick={()=>void run(appearance.removePack)}><Trash2 size={16}/></button>}
    </div>
    {download&&<p className="setting-detail" role="status">Your pack is ready. <a href={download.url} download={download.name}>Save {download.name}</a></p>}
    <input ref={file} type="file" accept=".json,.orb.json,application/json" hidden onChange={e=>{const selected=e.target.files?.[0];e.target.value='';if(selected)void run(()=>appearance.importPack(selected));}}/>
    <p className="setting-detail">Orb packs include a prepared set of facial expressions. Export a pack as a starting point for a different character.</p>
    {appearance.notice&&<p className="inline-notice" role="status">{appearance.notice}</p>}{error&&<p className="error-text" role="alert">{error}</p>}
  </details>;
}
