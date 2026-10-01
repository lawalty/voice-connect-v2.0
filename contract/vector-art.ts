import { z } from 'zod';

/** Closed vocabulary: pack data cannot evaluate expressions or execute SVG. */
export const VECTOR_CHANNELS = ['blinkLeft', 'blinkRight', 'browLeft', 'browRight', 'browInnerLeft', 'browInnerRight',
  'smile', 'mouthOpen', 'mouthRound', 'mouthWide', 'gazeX', 'gazeY', 'focus', 'sleep', 'error', 'sparkle',
  'zzz', 'ears', 'thought', 'work', 'breath', 'accentPulse', 'accentRise', 'vowel'] as const;
export type VectorChannel = typeof VECTOR_CHANNELS[number];
const coordinate = z.number().min(-150).max(250);
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const solidPaint = z.union([z.string().regex(/^#[\da-fA-F]{6}$/), z.enum(['$features', '$pupils', '$state'])]);
export const vectorPaintSchema = z.union([solidPaint, z.literal('none'), z.string().regex(/^@gradient:[a-z][a-z0-9-]{0,47}$/)]);
const stops = z.array(z.object({ offset: z.number().min(0).max(1), color: solidPaint, opacity: z.number().min(0).max(1).optional() }).strict()).min(2).max(8);
export const vectorResourcesSchema = z.object({ gradients: z.array(z.discriminatedUnion('kind', [
  z.object({ id: identifier, kind: z.literal('linear'), x1: coordinate, y1: coordinate, x2: coordinate, y2: coordinate, stops }).strict(),
  z.object({ id: identifier, kind: z.literal('radial'), cx: coordinate, cy: coordinate, r: z.number().positive().max(150), fx: coordinate, fy: coordinate, stops }).strict(),
])).max(16) }).strict();
export const vectorCommandSchema = z.union([
  z.tuple([z.literal('M'), coordinate, coordinate]), z.tuple([z.literal('L'), coordinate, coordinate]),
  z.tuple([z.literal('Q'), coordinate, coordinate, coordinate, coordinate]),
  z.tuple([z.literal('C'), coordinate, coordinate, coordinate, coordinate, coordinate, coordinate]),
  z.tuple([z.literal('Z')]),
]);
export const vectorGeometrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), commands: z.array(vectorCommandSchema).min(2).max(64) }).strict(),
  z.object({ kind: z.literal('ellipse'), cx: coordinate, cy: coordinate, rx: z.number().min(0).max(100), ry: z.number().min(0).max(100) }).strict(),
  z.object({ kind: z.literal('circle'), cx: coordinate, cy: coordinate, r: z.number().min(0).max(100) }).strict(),
]);
export const vectorValuesSchema = z.partialRecord(z.enum(VECTOR_CHANNELS), z.number().min(-1).max(1));
export const vectorNodeSchema = z.object({
  id: identifier, geometry: vectorGeometrySchema, fill: vectorPaintSchema,
  layer: z.enum(['body', 'face', 'accent']).optional(),
  stroke: vectorPaintSchema.optional(), strokeWidth: z.number().min(0).max(8).optional(),
  opacity: z.number().min(0).max(1).optional(), clip: identifier.optional(),
  anchor: z.tuple([coordinate, coordinate]).optional(),
  morphs: z.partialRecord(z.enum(VECTOR_CHANNELS), vectorGeometrySchema).optional(),
  bindings: z.array(z.object({ channel: z.enum(VECTOR_CHANNELS),
    when: z.enum(VECTOR_CHANNELS).optional(),
    property: z.enum(['x', 'y', 'rotate', 'scaleX', 'scaleY', 'opacity']), amount: z.number().min(-150).max(150) }).strict()).max(12).optional(),
}).strict();
const eye = z.object({ outline: identifier, pupils: z.array(identifier).min(1).max(6) }).strict();
export const vectorRigSchema = z.object({
  leftEye: eye, rightEye: eye,
  brows: z.object({ left: identifier, right: identifier }).strict(),
  mouth: z.object({ outline: identifier, tongue: identifier.optional() }).strict(),
}).strict();
export const vectorPoseSchema = z.object({ channels: vectorValuesSchema,
  variants: z.array(z.object({ channels: vectorValuesSchema, holdMs: z.number().int().min(1500).max(2600) }).strict()).min(2).max(8).optional(),
}).strict();
export const vectorArtworkSchema = z.object({ viewBox: z.literal('0 0 100 100'), nodes: z.array(vectorNodeSchema).min(8).max(64) }).strict();
export type VectorGeometry = z.infer<typeof vectorGeometrySchema>;
export type VectorNode = z.infer<typeof vectorNodeSchema>;
export type VectorValues = z.infer<typeof vectorValuesSchema>;
export type VectorRig = z.infer<typeof vectorRigSchema>;
export type VectorPose = z.infer<typeof vectorPoseSchema>;

export function sameTopology(a: VectorGeometry, b: VectorGeometry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'path' || b.kind !== 'path') return true;
  return a.commands.length === b.commands.length && a.commands.every((command, i) => command[0] === b.commands[i]?.[0]);
}

/** Validate references, the animation contract and bounded renderer work. */
export function validateVectorArtwork(pack: { artwork: z.infer<typeof vectorArtworkSchema>; rig: VectorRig; resources?: z.infer<typeof vectorResourcesSchema> }, ctx: z.RefinementCtx) {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message, path: ['artwork'] });
  const { nodes } = pack.artwork, ids = new Map(nodes.map(node => [node.id, node]));
  if (ids.size !== nodes.length) fail('Vector node IDs must be unique.');
  const gradients = pack.resources?.gradients ?? [], gradientIds = new Set(gradients.map(gradient => gradient.id));
  if (gradientIds.size !== gradients.length) fail('Gradient IDs must be unique.');
  for (const gradient of gradients)
    if (gradient.stops.some((stop, i) => i > 0 && stop.offset < gradient.stops[i - 1]!.offset)) fail('Gradient stops must be in order.');
  let coordinates = 0;
  const checkGeometry = (geometry: VectorGeometry) => {
    if (geometry.kind !== 'path') return;
    coordinates += geometry.commands.reduce((sum, command) => sum + command.length - 1, 0);
    if (geometry.commands[0]?.[0] !== 'M') fail('Paths must start with M.');
  };
  for (const node of nodes) {
    for (const paint of [node.fill, node.stroke])
      if (paint?.startsWith('@gradient:') && !gradientIds.has(paint.slice(10))) fail(`Missing gradient for ${node.id}.`);
    checkGeometry(node.geometry);
    for (const target of Object.values(node.morphs ?? {})) {
      checkGeometry(target);
      if (!sameTopology(node.geometry, target)) fail(`Morph topology differs for ${node.id}.`);
    }
    if (node.clip && (!ids.has(node.clip) || node.clip === node.id)) fail(`Invalid clip reference for ${node.id}.`);
    if (node.clip && ids.get(node.clip)?.clip) fail('Nested clipping is unsupported.');
  }
  if (coordinates > 16384) fail('Vector geometry exceeds the 16384-coordinate budget.');
  for (const [side, channel] of [['leftEye', 'blinkLeft'], ['rightEye', 'blinkRight']] as const) {
    const role = pack.rig[side], outline = ids.get(role.outline);
    if (!outline?.morphs?.[channel]) fail(`${side} needs an outline with a ${channel} morph.`);
    for (const id of role.pupils) {
      const pupil = ids.get(id);
      if (!pupil || pupil.clip !== role.outline) fail(`${side} pupils must reference their eye outline clip.`);
      for (const axis of ['gazeX', 'gazeY'] as const)
        if (!pupil?.bindings?.some(binding => binding.channel === axis)) fail(`${id} needs ${axis} movement.`);
    }
  }
  for (const id of [pack.rig.brows.left, pack.rig.brows.right, pack.rig.mouth.outline, ...(pack.rig.mouth.tongue ? [pack.rig.mouth.tongue] : [])])
    if (!ids.has(id)) fail(`Missing rig node ${id}.`);
  const mouth = ids.get(pack.rig.mouth.outline);
  for (const channel of ['mouthOpen', 'mouthRound', 'mouthWide'] as const)
    if (!mouth?.morphs?.[channel]) fail(`Mouth outline needs a ${channel} morph.`);
  const roles = [pack.rig.leftEye.outline, pack.rig.rightEye.outline, pack.rig.brows.left, pack.rig.brows.right, pack.rig.mouth.outline];
  if (new Set(roles).size !== roles.length) fail('Face rig roles must use distinct nodes.');
}
