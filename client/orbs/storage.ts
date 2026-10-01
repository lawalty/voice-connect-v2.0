import { MAX_CUSTOM_PACKS, parseOrbPack, type OrbPack } from './packs';

const DB = 'vc2-orb-packs';
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve,reject) => {
    const req = indexedDB.open(DB,1);let blocked=false;
    req.onupgradeneeded = () => req.result.createObjectStore('packs',{ keyPath:'id' });
    req.onsuccess = () => {if(blocked){req.result.close();return;}req.result.onversionchange=()=>req.result.close();resolve(req.result);};
    req.onerror = () => reject(new Error('This browser could not open orb storage.'));
    req.onblocked = () => {blocked=true;reject(new Error('Close other Voice Connect tabs and try again.'));};
  });
}
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve,reject) => {
    const tx = db.transaction('packs',mode), request = action(tx.objectStore('packs'));
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onabort = tx.onerror = () => { db.close(); reject(new Error('The orb pack could not be saved. Browser storage may be full.')); };
  });
}
export async function loadOrbPacks(): Promise<OrbPack[]> {
  const saved = await transaction<unknown[]>('readonly',s => s.getAll(null,MAX_CUSTOM_PACKS));
  return saved.flatMap(value => { try { return [parseOrbPack(JSON.stringify(value))]; } catch { return []; } });
}
export async function saveOrbPack(pack: OrbPack) {
  const validated = parseOrbPack(JSON.stringify(pack));
  const db=await database();
  await new Promise<void>((resolve,reject)=>{
    // Count and insert in one transaction so two tabs cannot exceed the limit.
    const tx=db.transaction('packs','readwrite'),store=tx.objectStore('packs'),count=store.count();
    let message='The pack could not be saved. Storage may be full or its ID is already installed.';
    count.onsuccess=()=>{
      if(count.result>=MAX_CUSTOM_PACKS){message='Remove an imported orb before adding another. You can keep up to eight.';tx.abort();}
      else store.add(validated);
    };
    tx.oncomplete=()=>{db.close();resolve();};
    tx.onabort=tx.onerror=()=>{db.close();reject(new Error(message));};
  });
}
export async function removeOrbPack(id: string) { await transaction('readwrite',s => s.delete(id)); }

export async function verifyPackImages(pack: OrbPack) {
  if (pack.renderer !== 'glass-face-v1') return;
  await Promise.all([pack.atlas,pack.flow].filter((x): x is string => Boolean(x)).map(async uri => {
    const image = new Image();
    image.src = uri;
    try { await image.decode(); } catch { throw new Error('The orb artwork could not be opened.'); }
    if (image.width !== image.height || image.width > 1536 || image.width < 384) throw new Error('The orb artwork has invalid dimensions.');
  }));
}
