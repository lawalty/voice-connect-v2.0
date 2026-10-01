import type { VectorFacePack, OrbState } from '../contract/orb-packs';
import { buildVectorScene } from '../client/orbs/vector-model';
import type { VectorValues } from '../contract/vector-art';
import { VectorRenderer } from '../client/orbs/vector-renderer';

const pack = JSON.parse(document.getElementById('pack')!.textContent!) as VectorFacePack;
const svg = document.querySelector('svg')!, renderer = new VectorRenderer(svg, pack, 'review');
const stateControl = document.querySelector<HTMLSelectElement>('#state')!, motionControl = document.querySelector<HTMLInputElement>('#motion')!;
const reducedControl = document.querySelector<HTMLInputElement>('#reduced')!, speechControl = document.querySelector<HTMLInputElement>('#speech')!;
const mouthOpen = document.querySelector<HTMLInputElement>('#mouth-open')!, mouthRound = document.querySelector<HTMLInputElement>('#mouth-round')!, mouthWide = document.querySelector<HTMLInputElement>('#mouth-wide')!;
const clockControl = document.querySelector<HTMLInputElement>('#clock')!, stage = document.querySelector<HTMLElement>('#stage')!;
let state: OrbState = 'idle', at = 0, origin = performance.now(), live = true, previous: VectorValues | undefined;
let transitions: { blend?: { from: VectorValues; atMs: number }; wakeAtMs?: number; sleepAtMs?: number; delightedAtMs?: number } = {};
const draw = (t: number) => {
  const open = speechControl.checked ? Math.max(0, Math.sin(t * .018) * .33 + Math.sin(t * .031) * .2 + .25) : Number(mouthOpen.value);
  const scene = buildVectorScene({ pack, state, tMs: t, stateAtMs: at, movement: Number(motionControl.value),
    speech: { open, round:Number(mouthRound.value),wide:Number(mouthWide.value),source:'estimated' },reducedMotion:reducedControl.checked,...transitions });
  renderer.draw(scene,state); previous=scene.channels;
  const h=scene.orb;
  svg.style.transform=`translate(${h.x}%,${h.y}%) rotate(${h.roll}deg) scale(${h.scale})`;
  stage.dataset.orbState=state;
  stage.style.setProperty('--halo',state==='standby'?'#10b981':pack.colors[state]);
  document.querySelector<HTMLElement>('#halo')!.style.transform=`scale(${scene.haloScale})`;
  document.querySelector('#time')!.textContent=`${Math.round(t)} ms · ${scene.markers['data-orb-moment']}`;
};
function choose(next: OrbState,t: number) {
  if(previous)transitions.blend={from:previous,atMs:t};
  if(state==='idle'&&(next==='connecting'||next==='listening'))transitions.wakeAtMs=t;
  if(next==='idle'&&state!=='idle')transitions.sleepAtMs=t;
  if(state==='speaking'&&next!=='speaking')transitions.delightedAtMs=t;
  if(!['connecting','listening'].includes(next))delete transitions.wakeAtMs;
  state=next;at=t;stateControl.value=next;draw(t);
}
stateControl.addEventListener('change',()=>choose(stateControl.value as OrbState,live?performance.now()-origin:Number(clockControl.value)));
document.querySelector('#seek')!.addEventListener('click',()=>{live=false;draw(Number(clockControl.value));});
document.querySelector('#play')!.addEventListener('click',()=>{origin=performance.now()-Number(clockControl.value);live=true;});
document.querySelector('#wake')!.addEventListener('click',()=>{const t=live?performance.now()-origin:Number(clockControl.value);transitions.wakeAtMs=t;choose('listening',t);});
for(const element of [motionControl,reducedControl,speechControl,mouthOpen,mouthRound,mouthWide])element.addEventListener('input',()=>draw(live?performance.now()-origin:Number(clockControl.value)));
function tick(now:number){if(live&&!document.hidden){const t=now-origin;clockControl.value=String(Math.round(t));draw(t);}requestAnimationFrame(tick);}
document.title=`${pack.name} · Vector rig review`;
document.querySelector('h1')!.textContent=pack.name;
// Review-only controls in the generated artifact, never installed by a pack.
Object.assign(window,{vectorReview:{seek(t:number){live=false;clockControl.value=String(t);draw(t);},
  state(next:OrbState,t=0){choose(next,t);},reset(){transitions={};previous=undefined;at=0;},play(){origin=performance.now();live=true;}}});
draw(0);requestAnimationFrame(tick);
