export type TimingStage='submitted'|'admitted'|'first-text'|'completed'|'failed'|'cancel-requested'|'cancel-confirmed'|'reconciled';
export interface TimingSample {turnId:string;stage:TimingStage;at:number;elapsedMs:number;}
/** Bounded diagnostics contain identifiers and timings only: never messages, audio, keys, or tool arguments. */
export class Timings {
  private samples:TimingSample[]=[];
  record(turnId:string,stage:TimingStage,startedAt:number):void {
    const at=Date.now();this.samples.push({turnId,stage,at,elapsedMs:Math.max(0,at-startedAt)});
    if(this.samples.length>200)this.samples.splice(0,this.samples.length-200);
  }
  snapshot():TimingSample[]{return this.samples.slice();}
}
