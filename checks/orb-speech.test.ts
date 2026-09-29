import { describe,expect,it } from 'vitest';
import { SpeechFaceTimeline,SILENT_MOUTH } from '../client/orbs/speech';
import { FaceMotion } from '../client/orbs/motion';
import { LUMINOUS_GLASS } from '../client/orbs/packs';
const tone=(seconds=.1)=>Float32Array.from({length:24000*seconds},(_,i)=>Math.sin(i/24000*220*Math.PI*2)*.18);
describe('playback-clock face movement',()=>{
  it('waits for playback, closes in gaps, and ignores network arrival time',()=>{
    const t=new SpeechFaceTimeline();t.schedule({samples:tone(),sampleRate:24000,startTime:5});
    t.schedule({samples:tone(),sampleRate:24000,startTime:5.3});
    expect(t.sample(4.99,90000)).toEqual(SILENT_MOUTH);expect(t.sample(5.03,90010).open).toBeGreaterThan(.4);
    expect(t.sample(5.15,90020)).toEqual(SILENT_MOUTH);expect(t.sample(5.35,90030).open).toBeGreaterThan(.4);expect(t.sample(6,90040)).toEqual(SILENT_MOUTH);
  });
  it('silence and cancellation cannot leave a mouth talking',()=>{
    const t=new SpeechFaceTimeline();t.schedule({samples:tone(),sampleRate:24000,startTime:1});t.clear();expect(t.sample(1.05,0)).toEqual(SILENT_MOUTH);
    t.schedule({samples:new Float32Array(2400),sampleRate:24000,startTime:2});expect(t.sample(2.02,0).open).toBe(0);
    t.nativeStarted(100);expect(t.sample(2,150).source).toBe('estimated');t.clear();expect(t.sample(2,180)).toEqual(SILENT_MOUTH);
  });
  it('clearly labels the device-voice fallback and never keeps PCM in feature frames',()=>{
    const samples=tone(),t=new SpeechFaceTimeline();t.schedule({samples,sampleRate:24000,startTime:0});samples.fill(0);expect(t.sample(.02,0).open).toBeGreaterThan(.4);
    t.nativeStarted(0);expect(t.sample(0,123).source).toBe('estimated');
  });
  it('resumes at current audio after a long period without rendering',()=>{
    const t=new SpeechFaceTimeline();
    for(let second=0;second<90;second++)t.schedule({samples:tone(1),sampleRate:24000,startTime:second},second);
    expect(t.sample(89.04,0).open).toBeGreaterThan(.4);
  });
  it('keeps head movement while talking and honors reduced motion',()=>{
    const motion=new FaceMotion(),speech={open:.8,round:.2,wide:.3,source:'audio' as const};
    const a=motion.sample(1000,'speaking',false,false,1,LUMINOUS_GLASS,speech),b=motion.sample(1600,'speaking',false,false,1,LUMINOUS_GLASS,speech);
    expect(a.yaw).not.toBe(b.yaw);expect(b.mouth).toBeGreaterThan(.7);
    const reduced=motion.sample(2000,'speaking',false,true,1,LUMINOUS_GLASS,speech);expect([reduced.yaw,reduced.pitch,reduced.roll,reduced.driftX,reduced.driftY,reduced.mouth]).toEqual([0,0,0,0,0,0]);
  });
});
