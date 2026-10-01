import type { VoicePhase } from '../../contract/types';
import type { FacePack } from './packs';
import type { FaceFrame } from './renderer';
import type { MouthPose } from './speech';

const colors={teal:[.38,.92,.86],gold:[1,.76,.44],purple:[.74,.56,1],silver:[.69,.81,.91],red:[.92,.42,.38]} as const;
export class FaceMotion {
  private last=0;
  private phase:VoicePhase='off';
  private delightedUntil=0;
  private values={listen:0,think:0,smile:0,blink:0,hue:0,sleep:1,mouth:0,round:.2,wide:.3};
  sample(now:number,phase:VoicePhase,asleep:boolean,reduced:boolean,strength:number,pack:FacePack,speech:MouthPose):FaceFrame {
    const dt=this.last?Math.max(0,Math.min(.06,(now-this.last)/1000)):.033;this.last=now;
    if(this.phase==='speaking' && (phase==='listening'||phase==='off'))this.delightedUntil=now+1700;
    this.phase=phase;
    const work=phase==='thinking'||phase==='working'||phase==='finalizing'||phase.endsWith('-commentary');
    const talking=phase==='speaking'||phase.endsWith('-commentary');
    const sleeping=asleep||phase==='standby';
    const t=now/1000;
    // These atlas poses look upward. Use them as brief glances, then return
    // to the forward-facing neutral pose instead of holding them while waiting.
    const glanceTime=t%9.6;
    const glance=!reduced&&glanceTime>6.8&&glanceTime<8?Math.sin((glanceTime-6.8)/1.2*Math.PI)**2:0;
    const cycle=t%4.7;
    const blink=Math.max(0,1-Math.abs(cycle-1.8)/.12);
    const hue=sleeping?0:talking?.255:work?-.35:0;
    // Every spoken state, including progress commentary, looks forward.
    // Head turns, nods, blinks and the audio-driven mouth remain independent.
    const target={listen:!sleeping&&!talking&&(phase==='listening'||phase==='hearing')?.55*glance:0,think:!sleeping&&!talking&&work?.65*glance:0,
      smile:!sleeping&&now<this.delightedUntil?.7:0,blink:sleeping?1:blink,hue,sleep:Number(sleeping),
      mouth:!sleeping&&talking&&!reduced?speech.open:0,round:speech.round,wide:speech.wide};
    for(const key of Object.keys(target) as (keyof typeof target)[]){const rate=key==='mouth'?90:key==='blink'?60:talking&&(key==='listen'||key==='think')?28:5;this.values[key]=reduced?target[key]:this.values[key]+(target[key]-this.values[key])*(1-Math.exp(-dt*rate));}
    const motion=reduced?0:strength*(sleeping?.25:1);
    const yaw=(Math.sin(t*.72+.2)*.68+Math.sin(t*1.43-.5)*.24+(talking?Math.sin(t*.94+.8)*.22:0))*pack.motion.yaw;
    const pitch=(Math.sin(t*.93-.3)*.47+Math.sin(t*1.71+.6)*.24+(talking?Math.sin(t*3.2)*speech.open*.3:0))*pack.motion.pitch;
    const roll=(Math.sin(t*.87)*.73+Math.sin(t*1.69+.3)*.28)*pack.motion.roll;
    const color=sleeping?colors.silver:phase==='error'?colors.red:talking?colors.purple:work?colors.gold:colors.teal;
    return {...this.values,time:reduced?0:t,yaw:yaw*motion*Math.PI/180,pitch:pitch*motion*Math.PI/180,roll:roll*motion*Math.PI/180,
      driftX:(Math.sin(t*.64)*.020+Math.sin(t*1.27+.4)*.006)*motion,driftY:Math.sin(t*1.03)*.012*motion,color};
  }
}
