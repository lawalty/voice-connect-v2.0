import { describe,expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LUMINOUS_GLASS, parseOrbPack, restoreOrbPreferences, MAX_PACK_BYTES } from '../client/orbs/packs';
const atlas='data:image/png;base64,'+readFileSync('client/public/orb-packs/luminous-glass/atlas.png').toString('base64');
const flow='data:image/png;base64,'+readFileSync('client/public/orb-packs/luminous-glass/flow.png').toString('base64');
const custom={...LUMINOUS_GLASS,id:'my-own-orb',name:'My own orb',atlas,flow};
describe('portable face packs',()=>{
  it('accepts a prepared face without any application or voice changes',()=>{expect(parseOrbPack(JSON.stringify(custom))).toEqual(custom);expect(parseOrbPack(JSON.stringify({...custom,flow:undefined}))).not.toHaveProperty('flow');});
  it('rejects URLs, executable content, unsupported renderers, and reserved identities',()=>{
    for(const patch of [{atlas:'https://example.org/face.png'},{atlas:'data:image/svg+xml;base64,PHN2Zy8+'},{script:'alert(1)'},{renderer:'external-js'},{id:'classic'},{id:'luminous-glass'},{id:'__proto__'},{motion:{yaw:999,pitch:7,roll:7}}])expect(()=>parseOrbPack(JSON.stringify({...custom,...patch}))).toThrow();
  });
  it('bounds packed bytes and checks dimensions before decoding',()=>{
    expect(()=>parseOrbPack(' '.repeat(MAX_PACK_BYTES+1))).toThrow(/6 MB/);
    const png=readFileSync('client/public/orb-packs/luminous-glass/atlas.png');png.writeUInt32BE(100000,16);
    expect(()=>parseOrbPack(JSON.stringify({...custom,atlas:'data:image/png;base64,'+png.toString('base64')}))).toThrow(/1536/);
    expect(()=>parseOrbPack(JSON.stringify({...custom,atlas:atlas.slice(0,-28)}))).toThrow();
  });
  it('recovers malformed preferences and bounds motion',()=>{expect(restoreOrbPreferences('null')).toEqual({packId:'classic',motion:1,phaseColors:true});expect(restoreOrbPreferences('{')).toEqual({packId:'classic',motion:1,phaseColors:true});expect(restoreOrbPreferences('{"packId":"my-face","motion":20}')).toEqual({packId:'my-face',motion:1.5,phaseColors:true});});
});
