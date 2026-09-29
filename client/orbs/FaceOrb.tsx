import { useEffect, useRef, useState } from 'react';
import ClassicOrb, { type OrbProps } from './ClassicOrb';
import type { OrbPack } from './packs';
import { GlassFaceRenderer } from './renderer';
import { FaceMotion } from './motion';
import { SILENT_MOUTH, type MouthPose } from './speech';

export interface FaceOrbProps extends OrbProps { pack:OrbPack; motion:number; getSpeech?:()=>MouthPose; }
export default function FaceOrb(props:FaceOrbProps){
  const {pack,motion:strength,phase,asleep=false,waking=false,onWake,wakeDisabled=false,onStandby,onResume}=props;
  const canvas=useRef<HTMLCanvasElement>(null),latest=useRef(props),repaint=useRef(()=>{});
  const [failed,setFailed]=useState(false),[ready,setReady]=useState(false);
  latest.current=props;
  useEffect(()=>{
    const surface=canvas.current;if(!surface)return;
    setFailed(false);setReady(false);
    const abort=new AbortController(),media=matchMedia('(prefers-reduced-motion: reduce)'),motion=new FaceMotion();
    let renderer:GlassFaceRenderer|undefined,raf=0,last=0,loaded=false,visible=true;
    const fail=()=>{loaded=false;cancelAnimationFrame(raf);raf=0;if(!abort.signal.aborted)setFailed(true);};
    const draw=(time:number)=>{
      raf=0;if(!loaded||document.hidden||!visible)return;
      if(!media.matches&&time-last<33){schedule();return;}last=time;
      const current=latest.current,speech=current.getSpeech?.()||SILENT_MOUTH;
      const pose=motion.sample(time,current.phase,Boolean(current.asleep),media.matches,current.motion,current.pack,speech);
      renderer!.draw(pose);
      surface.dataset.mouthOpen=pose.mouth.toFixed(2);surface.dataset.yaw=pose.yaw.toFixed(3);surface.dataset.speechSource=speech.source;
      if(!media.matches)schedule();
    };
    const schedule=()=>{if(!raf&&loaded&&!document.hidden&&visible)raf=requestAnimationFrame(draw);};
    const invalidate=()=>{last=0;schedule();};
    const visibility=()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else invalidate();};
    const lost=(e:Event)=>{e.preventDefault();cancelAnimationFrame(raf);raf=0;fail();};
    const resize=new ResizeObserver(()=>{renderer?.resize();invalidate();});
    const intersection=new IntersectionObserver(entries=>{visible=entries.some(e=>e.isIntersecting);if(visible)invalidate();else{cancelAnimationFrame(raf);raf=0;}});
    surface.addEventListener('webglcontextlost',lost);
    try{
      renderer=new GlassFaceRenderer(surface);
      resize.observe(surface);intersection.observe(surface);
      void renderer.load(pack,abort.signal).then(()=>{if(abort.signal.aborted)return;loaded=true;renderer!.resize();setReady(true);invalidate();}).catch(fail);
    }catch{fail();}
    media.addEventListener('change',invalidate);document.addEventListener('visibilitychange',visibility);repaint.current=invalidate;
    return()=>{abort.abort();cancelAnimationFrame(raf);resize.disconnect();intersection.disconnect();media.removeEventListener('change',invalidate);document.removeEventListener('visibilitychange',visibility);surface.removeEventListener('webglcontextlost',lost);renderer?.dispose();repaint.current=()=>{};};
  },[pack]);
  useEffect(()=>{repaint.current();},[phase,asleep,waking,strength]);
  if(failed)return <div className="orb-face-fallback"><ClassicOrb {...props}/><p className="orb-face-notice" role="status">This face is unavailable. Showing the classic orb.</p></div>;
  const standby=phase==='standby',action=standby?onResume:onStandby||onWake,disabled=standby||!onStandby?wakeDisabled:false;
  return <div className={`orb-stage orb-character phase-${phase}${asleep?' orb-sleeping':''}`} data-presence={standby?'standby':waking?'waking':asleep?'sleeping':'awake'} data-orb-pack={pack.id} data-face-ready={ready}>
    <canvas ref={canvas} className="orb-canvas" aria-hidden="true"/>
    {!ready&&<span className="orb-face-loading" role="status">Loading your orb…</span>}
    {action&&<button type="button" className="orb-wake-button" disabled={disabled} aria-label={standby?'Resume conversation':onStandby?'Enter standby mode':'Wake NorthPointe'} aria-pressed={onStandby||standby?standby:undefined} onClick={action}>
      {!disabled&&<span className="orb-wake-hint" aria-hidden="true">{standby?'Tap to resume':onStandby?'Tap for standby':asleep?'Tap to wake':''}</span>}
    </button>}
  </div>;
}
