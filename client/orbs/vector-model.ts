import type { OrbState, VectorFacePack } from '../../contract/orb-packs';
import { VECTOR_CHANNELS, type VectorValues, type VectorGeometry, type VectorNode } from '../../contract/vector-art';
import type { MouthPose } from './speech';

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
const round = (value: number) => Math.round(value * 1000) / 1000;
const ease = (value: number) => .5 - Math.cos(clamp(value) * Math.PI) / 2;
export function hashNoise(index: number, salt = 0): number {
  let h = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  h = Math.imul(h ^ h >>> 13, 0x27d4eb2d); h ^= h >>> 15;
  return ((h >>> 0) % 100000) / 100000;
}
export function lerpPose(a: VectorValues, b: VectorValues, amount: number): VectorValues {
  const k = ease(amount), out: VectorValues = {};
  for (const key of VECTOR_CHANNELS) out[key] = (a[key] ?? 0) + ((b[key] ?? 0) - (a[key] ?? 0)) * k;
  return out;
}

// Finite repeating schedules, rather than walking from time zero every frame.
// 24 is divisible by three, preserving centered fixations across cycle boundaries.
const schedules = Object.fromEntries(['standby', 'connecting', 'listening', 'thinking', 'working'].map(state => {
  const base = state === 'thinking' ? 1150 : state === 'working' ? 620 : 900;
  let at = 0;
  const entries = Array.from({ length: 24 }, (_, index) => {
    const hold = base * (.55 + hashNoise(index, 11) * 1.1);
    const entry = { index, at, hold }; at += hold + 78; return entry;
  });
  return [state, { entries, period: at }];
})) as Record<string, { entries: { index: number; at: number; hold: number }[]; period: number }>;

export function gazeAt(tMs: number, state: OrbState) {
  if (state === 'idle' || state === 'error' || state === 'speaking') return { x: 0, y: 0, moving: false, blink: 0 };
  const schedule = schedules[state]!, t = Math.max(0, tMs) % schedule.period;
  const entry = schedule.entries.findLast(entry => t >= entry.at)!;
  const target = (i: number) => {
    const index = (i + 24) % 24;
    if (index % 3 === 2) return { x: 0, y: 0 };
    return { x: state === 'working' ? index % 5 / 4 * 1.2 - .6 : (hashNoise(index, 3) * 2 - 1),
      y: (hashNoise(index, 7) * 2 - 1) * .55 };
  };
  const from = target(entry.index - 1), to = target(entry.index), local = t - entry.at, moving = local < 78;
  const u = clamp(local / 78) - 1, flight = 1 + 2.9 * u ** 3 + 1.9 * u ** 2;
  const drift = moving ? 0 : Math.sin(t / 2600 * Math.PI * 2 + entry.index) * .045;
  const k = moving ? flight : 1;
  // Only place a blink inside a hold with enough time for full closure/reopen.
  const blinkTime = local - 78 - entry.hold * .3;
  const blink = entry.index % 4 === 3 && entry.hold > 350
    ? blinkTime >= 0 && blinkTime < 62 ? ease(blinkTime / 62)
      : blinkTime >= 62 && blinkTime < 204 ? 1 - ease((blinkTime - 62) / 142) : 0 : 0;
  const amplitude = state === 'listening' ? .4 : state === 'standby' ? .18 : state === 'working' ? .35 : .6;
  return { x: ((from.x + (to.x - from.x) * k) + drift) * amplitude,
    y: ((from.y + (to.y - from.y) * k) + drift * .4) * amplitude, moving, blink: moving ? 0 : blink };
}

export function statePose(pack: VectorFacePack, state: OrbState, tMs: number, reduced = false): VectorValues {
  const pose = pack.poses[state];
  if (reduced || !pose.variants) return { ...pose.channels };
  const variants = pose.variants, duration = variants.reduce((sum, pose) => sum + pose.holdMs, 0);
  const local = Math.max(0, tMs) % duration;
  let at = 0, index = 0;
  while (index < variants.length - 1 && local >= at + variants[index]!.holdMs) { at += variants[index]!.holdMs; index++; }
  const current = variants[index]!, previous = variants[(index + variants.length - 1) % variants.length]!;
  return lerpPose({ ...pose.channels, ...previous.channels }, { ...pose.channels, ...current.channels }, (local - at) / 420);
}

export interface VectorInput {
  pack: VectorFacePack; state: OrbState; tMs: number; stateAtMs?: number; movement: number; speech: MouthPose;
  reducedMotion?: boolean;
  blend?: { from: VectorValues; atMs: number };
  wakeAtMs?: number; sleepAtMs?: number; delightedAtMs?: number;
}
export interface VectorScene {
  nodes: { node: VectorNode; geometry: VectorGeometry; opacity: number; transform: string }[];
  channels: VectorValues;
  orb: { x: number; y: number; roll: number; scale: number }; haloScale: number;
  markers: Record<string, string>;
}

function deform(base: VectorGeometry, morphs: VectorNode['morphs'], channels: VectorValues): VectorGeometry {
  const active = Object.entries(morphs ?? {}).filter(([key]) => channels[key as keyof VectorValues]);
  const value = (key: string, original: number, commandIndex?: number, coordinateIndex?: number) => {
    let result = original;
    for (const [channel, target] of active) {
      const targetValue = target.kind === 'path' && commandIndex !== undefined && coordinateIndex !== undefined
        ? target.commands[commandIndex]![coordinateIndex] as number : (target as unknown as Record<string, number>)[key]!;
      result += (targetValue - original) * (channels[channel as keyof VectorValues] ?? 0);
    }
    return round(result);
  };
  if (base.kind === 'path') return { kind: 'path', commands: base.commands.map((command, i) => command.map((v, j) => j === 0 ? v : value('', v as number, i, j))) as typeof base.commands };
  if (base.kind === 'circle') return { kind: 'circle', cx: value('cx', base.cx), cy: value('cy', base.cy), r: Math.max(0, value('r', base.r)) };
  return { kind: 'ellipse', cx: value('cx', base.cx), cy: value('cy', base.cy), rx: Math.max(0, value('rx', base.rx)), ry: Math.max(0, value('ry', base.ry)) };
}

/** Geometry is a pure function of explicit inputs, including transition anchors. */
export function buildVectorScene(input: VectorInput): VectorScene {
  const { pack, state, movement, speech, reducedMotion: reduced = false } = input;
  const t = reduced ? 0 : Math.max(0, input.tMs), local = reduced ? 0 : Math.max(0, t - (input.stateAtMs ?? 0));
  let channels = statePose(pack, state, local, reduced);
  if (!reduced && input.blend && t - input.blend.atMs < 420)
    channels = lerpPose(input.blend.from, channels, (t - input.blend.atMs) / 420);
  const gaze = reduced ? { x: 0, y: 0, moving: false, blink: 0 } : gazeAt(local, state);
  channels.gazeX = clamp((channels.gazeX ?? 0) + gaze.x, -1, 1);
  channels.gazeY = clamp((channels.gazeY ?? 0) + gaze.y, -1, 1);
  if (state === 'speaking') {
    channels.gazeX = channels.gazeY = 0;
    if (!reduced) {
      channels.mouthOpen = clamp(speech.open);
      channels.mouthRound = clamp(speech.round) * channels.mouthOpen;
      channels.mouthWide = clamp(speech.wide) * channels.mouthOpen;
      channels.vowel = channels.mouthOpen;
      // Forward gaze permits natural blinks, without creating a saccade.
      const blinkTime = local % 4700 - 1800;
      gaze.blink = blinkTime >= 0 && blinkTime < 62 ? ease(blinkTime / 62)
        : blinkTime >= 62 && blinkTime < 204 ? 1 - ease((blinkTime - 62) / 142) : 0;
    }
  }
  for (const key of ['blinkLeft', 'blinkRight'] as const) channels[key] = clamp((channels[key] ?? 0) + gaze.blink * (1 - (channels[key] ?? 0)));
  let moment = 'none';
  const wake = input.wakeAtMs === undefined ? Infinity : t - input.wakeAtMs;
  const yawn = input.sleepAtMs === undefined ? Infinity : t - input.sleepAtMs;
  const delight = input.delightedAtMs === undefined ? Infinity : t - input.delightedAtMs;
  if (!reduced && wake >= 0 && wake < 1500 && (state === 'connecting' || state === 'listening')) {
    moment = 'wake';
    const opening = ease(wake / 500), settle = 1 - ease((wake - 1000) / 500);
    channels.sleep = (1 - opening) * settle;
    channels.blinkLeft = channels.blinkRight = 0;
    channels.browLeft = channels.browRight = .65 * opening * settle;
    channels.smile = .7 * opening * settle;
    channels.gazeX = wake > 500 && wake < 1000 ? Math.sin((wake - 500) / 500 * Math.PI * 2) * .6 : 0;
    channels.gazeY = 0;
  } else if (!reduced && state === 'idle' && yawn >= 0 && yawn < 900) {
    moment = 'yawn'; channels.mouthOpen = Math.sin(yawn / 900 * Math.PI) ** 2 * .6;
    channels.mouthRound = channels.mouthOpen * .65;
  } else if (!reduced && delight >= 0 && delight < 1700 && !['idle', 'standby', 'error'].includes(state)) {
    moment = 'delighted'; channels.smile = Math.max(channels.smile ?? 0, .7 * (1 - ease(delight / 1700)));
  }
  channels.breath = reduced ? 0 : Math.sin(t / (state === 'idle' ? 6500 : 4200) * Math.PI * 2);
  if (!reduced && state === 'idle' && moment !== 'yawn') channels.mouthOpen = .018 + .012 * (.5 + (channels.breath ?? 0) * .5);
  channels.accentRise = reduced ? 0 : state === 'idle' ? (t % 4200) / 4200 : .5 + Math.sin(t / 480) * .5;
  channels.accentPulse = reduced ? .7 : .5 + Math.sin(t / 480) * .5;
  const strength = reduced ? 0 : clamp(movement, 0, 1.5), sleeping = state === 'idle' ? .3 : 1;
  const yaw = (Math.sin(t / 1000 * .72 + .2) * .68 + Math.sin(t / 1000 * 1.43 - .5) * .24) * pack.motion.yaw * strength * sleeping;
  const pitch = Math.sin(t / 1000 * .93 - .3) * pack.motion.pitch * .6 * strength * sleeping;
  const average = (pack.motion.yaw / 20 + pack.motion.pitch / 12 + pack.motion.roll / 12) / 3;
  const orb = { x: round(Math.sin(t / 1000 * .64) * 2 * strength * average),
    y: round(Math.sin(t / 1000 * 1.03) * 1.2 * strength * average),
    roll: round((Math.sin(t / 1000 * .87) * .73 + (channels.sleep ?? 0) * .3) * pack.motion.roll * strength),
    scale: round(1 + (channels.breath ?? 0) * .006 * strength * average) };
  const nodes = pack.artwork.nodes.map(node => {
    let x = node.layer === 'body' ? 0 : yaw * .22, y = node.layer === 'body' ? 0 : pitch * .22;
    let rotate = 0, scaleX = 1, scaleY = 1, opacity = node.opacity ?? 1;
    for (const binding of node.bindings ?? []) {
      const amount = (channels[binding.channel] ?? 0) * binding.amount * (binding.when ? channels[binding.when] ?? 0 : 1);
      switch (binding.property) {
        case 'x': x += amount; break; case 'y': y += amount; break; case 'rotate': rotate += amount; break;
        case 'scaleX': scaleX += amount; break; case 'scaleY': scaleY += amount; break; case 'opacity': opacity += amount;
      }
    }
    // A rig-designated tongue appears in the lower mouth only when wide open.
    if (node.id === pack.rig.mouth.tongue) opacity *= clamp(((channels.mouthOpen ?? 0) - .34) / .2);
    const [cx, cy] = node.anchor ?? [50, 50];
    return { node, geometry: deform(node.geometry, node.morphs, channels), opacity: round(clamp(opacity)),
      transform: `translate(${round(x)} ${round(y)}) translate(${cx} ${cy}) rotate(${round(rotate)}) scale(${round(clamp(scaleX, .01, 4))} ${round(clamp(scaleY, .01, 4))}) translate(${-cx} ${-cy})` };
  });
  const bloom = state === 'speaking' ? .2 : ['thinking', 'working', 'connecting'].includes(state) ? .1 : .05;
  return { nodes, channels, orb, haloScale: reduced ? 1 : round(1 + (.5 + Math.sin(t / 1600 * Math.PI * 2) * .5) * bloom),
    markers: { 'data-orb-clock-ms': String(Math.round(t)), 'data-orb-gaze-x': (channels.gazeX ?? 0).toFixed(3),
      'data-orb-gaze-y': (channels.gazeY ?? 0).toFixed(3), 'data-orb-gaze-state': gaze.moving ? 'saccade' : 'fixation',
      'data-orb-blink': gaze.blink.toFixed(3), 'data-orb-mouth-level': (channels.mouthOpen ?? 0).toFixed(3),
      'data-orb-micro-motion': reduced ? 'reduced' : 'active', 'data-orb-moment': moment } };
}

export function geometryAttributes(geometry: VectorGeometry): Record<string, string> {
  if (geometry.kind === 'path') return { d: geometry.commands.map(command => command.join(' ')).join(' ') };
  return Object.fromEntries(Object.entries(geometry).filter(([key]) => key !== 'kind').map(([key, value]) => [key, String(value)]));
}
