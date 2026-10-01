import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { EXPRESSIVE_FACE, ORB_STATES, parseOrbPack, vectorFacePackSchema, type OrbState } from '../contract/orb-packs';
import { buildVectorScene, gazeAt, statePose } from '../client/orbs/vector-model';
import { SILENT_MOUTH } from '../client/orbs/speech';
import { statusOrbState } from '../client/orbs/status';
import { compileVectorSvg, parseVectorPath } from '../contract/vector-svg';

const custom = () => structuredClone({ ...EXPRESSIVE_FACE, id: 'my-expressive-face', name: 'My Expressive Face' });
const frame = (state: OrbState, tMs = 0, patch = {}) => buildVectorScene({ pack: EXPRESSIVE_FACE, state, tMs, movement: 1, speech: SILENT_MOUTH, ...patch });
const geometry = (scene: ReturnType<typeof frame>, id: string) => scene.nodes.find(({ node }) => node.id === id)!.geometry;

describe('portable reusable vector rigs', () => {
  it('round-trips full artwork, rig and resources and accepts a different silhouette', () => {
    expect(parseOrbPack(JSON.stringify(custom()))).toEqual(custom());
    const copper = JSON.parse(readFileSync('docs/vector-face/examples/copper-companion.orb.json', 'utf8'));
    expect(parseOrbPack(JSON.stringify(copper))).toEqual(copper);
    expect(copper.artwork.nodes[0].geometry).not.toEqual(EXPRESSIVE_FACE.artwork.nodes[0]!.geometry);
  });
  it('rejects missing states, invalid colors, executables, URLs, raster art, unknown fields and reserved IDs', () => {
    for (const field of ORB_STATES) {
      const palette = custom(); delete (palette.colors as any)[field]; expect(() => parseOrbPack(JSON.stringify(palette))).toThrow();
      const poses = custom(); delete (poses.poses as any)[field]; expect(() => parseOrbPack(JSON.stringify(poses))).toThrow();
    }
    for (const patch of [{ colors: { ...custom().colors, idle:'red' } }, { colors: { ...custom().colors, idle:'#fff' } },
      { ink: { features:'url(https://example.org)',pupils:'#000000' } }, { atlas:'data:image/png;base64,anything' },
      { svg:'<svg><script/></svg>' },{ script:'alert(1)' },{ audio:'https://example.org/sound.mp3' },
      { url:'https://example.org/art.svg' },{ id:'expressive-face' },{ id:'classic' },{ id:'voice-connect-v1' },{ id:'luminous-glass' },
      { motion: { yaw:21,pitch:6,roll:7 } },{ motion: { yaw:10,pitch:13,roll:7 } },{ motion: { yaw:10,pitch:6,roll:-1 } }])
      expect(() => parseOrbPack(JSON.stringify({ ...custom(), ...patch }))).toThrow();
    const badNode = custom(); (badNode.artwork.nodes[0] as any).onclick = 'alert(1)';
    expect(vectorFacePackSchema.safeParse(badNode).success).toBe(false);
    const noRig = custom(); delete (noRig as any).artwork;
    expect(vectorFacePackSchema.safeParse(noRig).success).toBe(false);
  });
  it('validates topology, local references, roles, channels and resource budgets', () => {
    for (const mutate of [
      (p: ReturnType<typeof custom>) => { p.artwork.nodes[1]!.id = p.artwork.nodes[0]!.id; },
      (p: ReturnType<typeof custom>) => { p.rig.leftEye.outline = 'missing'; },
      (p: ReturnType<typeof custom>) => { p.artwork.nodes.find(n => n.id === 'pupil-left')!.clip = 'eye-right'; },
      (p: ReturnType<typeof custom>) => { p.artwork.nodes.find(n => n.id === 'mouth')!.morphs!.mouthOpen = { kind:'circle',cx:50,cy:50,r:10 }; },
      (p: ReturnType<typeof custom>) => { p.artwork.nodes[0]!.fill = '@gradient:missing'; },
      (p: ReturnType<typeof custom>) => { (p.poses.thinking.channels as any).customScript = 1; },
      (p: ReturnType<typeof custom>) => { p.artwork.nodes = Array.from({ length:65 }, () => p.artwork.nodes[0]!); },
    ]) { const pack = custom(); mutate(pack); expect(vectorFacePackSchema.safeParse(pack).success).toBe(false); }
  });
  it('compiles SVG artwork plus rig JSON back into the same self-contained pack', () => {
    const svg = readFileSync('docs/vector-face/examples/copper-companion-source/artwork.svg','utf8');
    const rig = JSON.parse(readFileSync('docs/vector-face/examples/copper-companion-source/rig.json','utf8'));
    const expected = JSON.parse(readFileSync('docs/vector-face/examples/copper-companion.orb.json','utf8'));
    expect(compileVectorSvg(svg, rig)).toEqual(expected);
    const defaultPaint=structuredClone(rig);delete defaultPaint.animation.nose.fill;
    const noFill=svg.replace(/(<path id="nose"[^>]*?) fill="[^"]*"/,'$1');
    expect(compileVectorSvg(noFill,defaultPaint).artwork.nodes.find(n=>n.id==='nose')!.fill).toBe('#000000');
    expect(()=>compileVectorSvg(svg.replace('<path ', '<g opacity=".5"><path ').replace('</svg>','</g></svg>'),rig)).toThrow();
    for (const extra of ['<script>alert(1)</script>','<image href="https://example.org/x.png"/>','<foreignObject/>','<use href="https://example.org/x"/>'])
      expect(() => compileVectorSvg(svg.replace('</svg>',`${extra}</svg>`),rig)).toThrow();
    for (const attr of ['onclick="alert(1)"','style="fill:red"','transform="rotate(90)"'])
      expect(() => compileVectorSvg(svg.replace('<path ',`<path ${attr} `),rig)).toThrow();
    expect(() => compileVectorSvg('<!DOCTYPE svg>'+svg,rig)).toThrow();
    expect(() => compileVectorSvg(svg.replace('fill="#fff1d6"','fill="url(https://example.org)"'),rig)).toThrow();
  });
  it('normalizes relative SVG paths without executing or silently accepting unsupported commands', () => {
    expect(parseVectorPath('M10 20 h5 v-4 l2 3 z').commands).toEqual([['M',10,20],['L',15,20],['L',15,16],['L',17,19],['Z']]);
    expect(() => parseVectorPath('M 1 2 A 10 10 0 0 0 5 6')).toThrow(/Unsupported/);
    expect(() => parseVectorPath('M 1')).toThrow();
  });
});

describe('deterministic vector acting', () => {
  it('uses the established state mapping including commentary and precedence', () => {
    for (const [phase,state] of [['off','idle'],['paused','standby'],['starting','connecting'],['reconnecting','connecting'],['hearing','listening'],['finalizing','thinking'],['working','working'],['speaking','speaking'],['thinking-commentary','speaking'],['working-commentary','speaking'],['error','error']] as const)
      expect(statusOrbState(phase)).toBe(state);
    expect(statusOrbState('listening',true)).toBe('idle');
    expect(statusOrbState('listening',true,true)).toBe('connecting');
    expect(statusOrbState('error',true,true)).toBe('error');
  });
  it('is pure, does not mutate inputs, and supports seeking backwards and hours ahead', () => {
    const pack = custom(), before = JSON.stringify(pack);
    const input = { pack, state:'thinking' as const,tMs:3870,movement:1,speech:SILENT_MOUTH };
    const a = buildVectorScene(input); frame('working',12*3600*1000); frame('thinking',20);
    expect(buildVectorScene(input)).toEqual(a); expect(JSON.stringify(pack)).toBe(before);
    expect(frame('working',12*3600*1000).nodes.every(n => Number.isFinite(n.opacity))).toBe(true);
  });
  it('sleep has relaxed closed lids and differs from awake; waking opens them', () => {
    const sleep = frame('idle'), awake = frame('listening');
    expect(geometry(sleep,'eye-left')).not.toEqual(geometry(awake,'eye-left'));
    expect(sleep.channels.sleep).toBe(1);
    expect(sleep.nodes.find(n=>n.node.id==='pupil-left')!.opacity).toBe(0);
    const early = frame('listening',0,{wakeAtMs:0}), late = frame('listening',600,{wakeAtMs:0});
    expect(early.channels.sleep).toBeGreaterThan(late.channels.sleep!);
    expect(geometry(early,'eye-left')).not.toEqual(geometry(late,'eye-left'));
    expect(late.markers['data-orb-moment']).toBe('wake');
    expect(frame('idle',450,{sleepAtMs:0}).channels.mouthOpen).toBeGreaterThan(.5);
  });
  it('thinking changes brows, lids and mouth while thinking and working gaze continue for 10 seconds', () => {
    const a=frame('thinking',900),b=frame('thinking',2900);
    for(const node of ['brow-left','eye-left','mouth']) expect(geometry(a,node)).not.toEqual(geometry(b,node));
    for(const state of ['thinking','working','connecting'] as const) {
      const frames=Array.from({length:100},(_,i)=>frame(state,i*100));
      expect(new Set(frames.map(s=>s.markers['data-orb-gaze-x'])).size).toBeGreaterThan(20);
    }
    expect(statePose(EXPRESSIVE_FACE,'thinking',900)).not.toEqual(statePose(EXPRESSIVE_FACE,'thinking',2900));
  });
  it('mouth open, round and wide affect actual vector geometry, with forward speaking gaze', () => {
    const a=frame('speaking',900,{speech:{open:.2,round:0,wide:0,source:'audio'}});
    const b=frame('speaking',900,{speech:{open:.8,round:0,wide:0,source:'audio'}});
    const rounded=frame('speaking',900,{speech:{open:.8,round:.7,wide:0,source:'audio'}});
    const wide=frame('speaking',900,{speech:{open:.8,round:0,wide:.7,source:'audio'}});
    expect(geometry(a,'mouth')).not.toEqual(geometry(b,'mouth'));
    expect(geometry(b,'mouth')).not.toEqual(geometry(rounded,'mouth'));
    expect(geometry(b,'mouth')).not.toEqual(geometry(wide,'mouth'));
    expect(b.nodes.find(n=>n.node.id==='tongue')!.opacity).toBeGreaterThan(0);
    expect(b.nodes.find(n=>n.node.id==='tongue')!.node.clip).toBe(EXPRESSIVE_FACE.rig.mouth.outline);
    for(let t=0;t<10000;t+=83) expect(frame('speaking',t).channels.gazeX).toBe(0);
    expect(frame('listening',900,{delightedAtMs:0}).channels.smile).toBeGreaterThan(.12);
  });
  it('blinks never coincide with saccades and every third fixation returns near center', () => {
    let blinks=0,flights=0;
    for(let t=0;t<60000;t+=10) {
      const gaze=gazeAt(t,'listening');
      if(gaze.moving) { flights++; expect(gaze.blink).toBe(0); }
      if(gaze.blink>.95) blinks++;
    }
    expect(blinks).toBeGreaterThan(0);expect(flights).toBeGreaterThan(0);
  });
  it('Movement zero stops all head motion, while expressions continue', () => {
    const a=frame('thinking',900,{movement:0}),b=frame('thinking',2900,{movement:0});
    expect(a.orb).toEqual({x:0,y:0,roll:0,scale:1});expect(b.orb).toEqual(a.orb);
    expect(geometry(a,'mouth')).not.toEqual(geometry(b,'mouth'));
  });
  it('reduced motion is exactly static for every state despite time, speech and transition changes', () => {
    for(const state of ORB_STATES) {
      const a=frame(state,0,{reducedMotion:true,wakeAtMs:0,sleepAtMs:0});
      const b=frame(state,9000,{reducedMotion:true,speech:{open:1,round:1,wide:1,source:'audio'},delightedAtMs:8000});
      expect(b).toEqual(a);
    }
  });
});
