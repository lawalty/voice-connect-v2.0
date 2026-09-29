import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { LUMINOUS_GLASS, MAX_PACK_BYTES, parseOrbPack, restoreOrbPreferences, type OrbPack, type OrbPreferences } from './packs';
import { loadOrbPacks, removeOrbPack, saveOrbPack, verifyPackImages } from './storage';

const KEY='vc2:orb';
interface Appearance {
  packs:OrbPack[];pack?:OrbPack;preferences:OrbPreferences;notice:string;loaded:boolean;
  choose(patch:Partial<OrbPreferences>):void;importPack(file:File):Promise<void>;removePack():Promise<void>;exportPack():Promise<{url:string;name:string}>;
}
const Context=createContext<Appearance|null>(null);
function read(){try{return restoreOrbPreferences(localStorage.getItem(KEY));}catch{return restoreOrbPreferences(null);}}
async function embedded(url:string):Promise<string>{
  if(url.startsWith('data:'))return url;
  const response=await fetch(url);if(!response.ok)throw new Error('The orb artwork could not be exported.');
  const blob=await response.blob();
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('The orb artwork could not be exported.'));reader.readAsDataURL(blob);});
}
export function OrbProvider({children}:{children:ReactNode}){
  const [preferences,setPreferences]=useState(read),[custom,setCustom]=useState<OrbPack[]>([]),[notice,setNotice]=useState(''),[loaded,setLoaded]=useState(false);
  useEffect(()=>{
    let active=true;
    void loadOrbPacks().then(packs=>{if(active)setCustom(packs);}).catch(()=>{if(active)setNotice('Imported faces are unavailable because browser storage could not be opened.');}).finally(()=>{if(active)setLoaded(true);});
    const changed=(event:StorageEvent)=>{if(event.key===KEY){setPreferences(read());void loadOrbPacks().then(packs=>{if(active)setCustom(packs);}).catch(()=>{if(active)setNotice('Imported faces could not be refreshed.');});}};
    window.addEventListener('storage',changed);return()=>{active=false;window.removeEventListener('storage',changed);};
  },[]);
  const packs=[LUMINOUS_GLASS,...custom],pack=packs.find(p=>p.id===preferences.packId);
  function choose(patch:Partial<OrbPreferences>){
    const next=restoreOrbPreferences(JSON.stringify({...preferences,...patch}));
    try{localStorage.setItem(KEY,JSON.stringify(next));setNotice('');}catch{setNotice('This choice works for this session, but the browser could not save it.');}
    setPreferences(next);
  }
  async function importPack(file:File){
    if(file.size>MAX_PACK_BYTES)throw new Error('Orb packs must be smaller than 6 MB.');
    const incoming=parseOrbPack(await file.text());
    if(custom.some(p=>p.id===incoming.id))throw new Error('A pack with that ID is already installed. Give this pack a new ID or remove the old one first.');
    await verifyPackImages(incoming);await saveOrbPack(incoming);
    setCustom(await loadOrbPacks());choose({packId:incoming.id});
  }
  async function removePack(){if(!pack||pack.id===LUMINOUS_GLASS.id)return;await removeOrbPack(pack.id);setCustom(await loadOrbPacks());choose({packId:'classic'});}
  async function exportPack(){
    if(!pack)throw new Error('Choose a face to export.');
    const [atlas,flow]=await Promise.all([embedded(pack.atlas),pack.flow?embedded(pack.flow):Promise.resolve(undefined)]);
    const exported={...pack,id:pack.id===LUMINOUS_GLASS.id?'my-luminous-glass':pack.id,name:pack.id===LUMINOUS_GLASS.id?'My Luminous Glass':pack.name,atlas,...(flow?{flow}:{})};
    return {url:URL.createObjectURL(new Blob([JSON.stringify(exported,null,2)],{type:'application/json'})),name:`${exported.id}.orb.json`};
  }
  return <Context.Provider value={{packs,pack,preferences,notice,loaded,choose,importPack,removePack,exportPack}}>{children}</Context.Provider>;
}
export function useOrbAppearance(){const value=useContext(Context);if(!value)throw new Error('OrbProvider is required.');return value;}
