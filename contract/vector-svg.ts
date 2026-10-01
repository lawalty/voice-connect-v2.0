import { vectorFacePackSchema, type VectorFacePack } from './orb-packs.js';
import type { VectorGeometry, VectorNode } from './vector-art.js';

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
const numberList = (value: string) => {
  const numbers = value.match(NUMBER)?.map(Number) ?? [];
  if (value.replace(NUMBER, '').replace(/[\s,]/g, '') || numbers.some(n => !Number.isFinite(n))) throw new Error('Invalid SVG numeric list.');
  return numbers;
};
type Command = Extract<VectorGeometry, { kind: 'path' }>['commands'][number];
/** Normalize the supported SVG path grammar into explicit absolute commands. */
export function parseVectorPath(source: string): Extract<VectorGeometry, { kind: 'path' }> {
  const tokens = source.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  if (source.replace(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g, '').replace(/[\s,]/g, '')) throw new Error('Invalid SVG path.');
  const commands: Command[] = [];
  let i = 0, op = '', x = 0, y = 0, startX = 0, startY = 0;
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i]!)) op = tokens[i++]!;
    const upper = op.toUpperCase(), relative = op !== upper;
    if (!['M','L','H','V','C','Q','Z'].includes(upper)) throw new Error(`Unsupported SVG path command ${op || '(missing)'}. Convert arcs/smooth curves to C or Q.`);
    if (upper === 'Z') { commands.push(['Z']); x = startX; y = startY; op = ''; continue; }
    const count = upper === 'C' ? 6 : upper === 'Q' ? 4 : upper === 'H' || upper === 'V' ? 1 : 2;
    const part = tokens.slice(i, i + count);
    if (part.length !== count || part.some(value => /^[a-zA-Z]$/.test(value))) throw new Error('Incomplete SVG path command.');
    let values = part.map(Number); i += count;
    if (values.some(value => !Number.isFinite(value))) throw new Error('Invalid SVG coordinate.');
    if (upper === 'H') values = [values[0]! + (relative ? x : 0), y];
    else if (upper === 'V') values = [x, values[0]! + (relative ? y : 0)];
    else if (relative) values = values.map((value, index) => value + (index % 2 ? y : x));
    const normalized = upper === 'H' || upper === 'V' ? 'L' : upper;
    commands.push([normalized, ...values] as Command);
    x = values[values.length - 2]!; y = values[values.length - 1]!;
    if (upper === 'M') { startX = x; startY = y; op = relative ? 'l' : 'L'; }
    if (commands.length > 64) throw new Error('SVG path exceeds 64 commands.');
  }
  return { kind: 'path', commands };
}

interface XmlNode { tag: string; attributes: Record<string, string>; children: XmlNode[]; }
/** Deliberately small XML subset. It never resolves entities, URLs, or scripts. */
function readSvg(source: string): XmlNode {
  if (new TextEncoder().encode(source).length > 1024 * 1024) throw new Error('Source SVG exceeds 1 MiB.');
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[|&/i.test(source)) throw new Error('SVG entities and declarations are unsupported.');
  source = source.replace(/<\?xml\s[^?]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const root: XmlNode = { tag: 'root', attributes: {}, children: [] }, stack = [root];
  const tokens = source.match(/<[^>]*>|[^<]+/g) ?? [];
  if (tokens.join('') !== source) throw new Error('Malformed SVG document.');
  let count = 0;
  for (const token of tokens) {
    if (!token.startsWith('<')) { if (token.trim()) throw new Error('SVG text is unsupported; convert lettering to paths.'); continue; }
    if (token.startsWith('</')) {
      const tag = token.slice(2,-1).trim();
      if (stack.length === 1 || stack.pop()!.tag !== tag) throw new Error('Unbalanced SVG elements.');
      continue;
    }
    const match = /^<([a-zA-Z][\w-]*)([\s\S]*?)\/?\s*>$/.exec(token);
    if (!match) throw new Error('Invalid SVG element.');
    const [,tag,raw] = match, attributes: Record<string, string> = Object.create(null);
    const attr = /([\w:-]+)\s*=\s*(['"])(.*?)\2/g;
    let parsed: RegExpExecArray | null;
    while ((parsed = attr.exec(raw!))) {
      if (Object.hasOwn(attributes, parsed[1]!)) throw new Error('Duplicate SVG attribute.');
      attributes[parsed[1]!] = parsed[3]!;
    }
    if (raw!.replace(attr, '').trim()) throw new Error('Invalid SVG attribute syntax.');
    const node: XmlNode = { tag: tag!, attributes, children: [] };
    stack.at(-1)!.children.push(node);
    if (!/\/\s*>$/.test(token)) stack.push(node);
    if (++count > 512 || stack.length > 16) throw new Error('Source SVG is too complex.');
  }
  if (stack.length !== 1 || root.children.length !== 1 || root.children[0]?.tag !== 'svg') throw new Error('Use one complete SVG document.');
  return root.children[0];
}
const allowed: Record<string, string[]> = {
  svg: ['xmlns','viewBox','width','height'], g: ['id','fill','stroke','stroke-width'], defs: [],
  path: ['id','d','fill','stroke','stroke-width','opacity','stroke-linecap','stroke-linejoin','clip-path'],
  circle: ['id','cx','cy','r','fill','stroke','stroke-width','opacity','clip-path'],
  ellipse: ['id','cx','cy','rx','ry','fill','stroke','stroke-width','opacity','clip-path'],
  rect: ['id','x','y','width','height','rx','ry','fill','stroke','stroke-width','opacity','clip-path'],
  polygon: ['id','points','fill','stroke','stroke-width','opacity','clip-path'],
  polyline: ['id','points','fill','stroke','stroke-width','opacity','clip-path'],
  linearGradient: ['id','gradientUnits','x1','y1','x2','y2'],
  radialGradient: ['id','gradientUnits','cx','cy','r','fx','fy'], stop: ['offset','stop-color','stop-opacity'],
};

function svgGeometry(tag: string, a: Record<string, string>): VectorGeometry {
  const n = (key: string, fallback = 0) => a[key] === undefined ? fallback : Number(a[key]);
  if (tag === 'path') return parseVectorPath(a.d ?? '');
  if (tag === 'circle') return { kind: 'circle', cx: n('cx'), cy: n('cy'), r: n('r') };
  if (tag === 'ellipse') return { kind: 'ellipse', cx: n('cx'), cy: n('cy'), rx: n('rx'), ry: n('ry') };
  if (tag === 'polygon' || tag === 'polyline') {
    const points = numberList(a.points ?? '');
    if (points.length < 4 || points.length % 2) throw new Error('Invalid polygon points.');
    const commands = points.reduce<Command[]>((out, _, i) => { if (i % 2 === 0) out.push([i === 0 ? 'M' : 'L', points[i]!, points[i+1]!]); return out; }, []);
    if (tag === 'polygon') commands.push(['Z']);
    return { kind: 'path', commands };
  }
  const x = n('x'), y = n('y'), w = n('width'), h = n('height'), rx = Math.max(0, Math.min(w/2,n('rx',n('ry')))), ry = Math.max(0, Math.min(h/2,n('ry',rx)));
  if (w <= 0 || h <= 0) throw new Error('Rectangles need positive width and height.');
  if (!rx || !ry) return { kind: 'path', commands: [['M',x,y],['L',x+w,y],['L',x+w,y+h],['L',x,y+h],['Z']] };
  return { kind:'path',commands:[['M',x+rx,y],['L',x+w-rx,y],['Q',x+w,y,x+w,y+ry],['L',x+w,y+h-ry],['Q',x+w,y+h,x+w-rx,y+h],['L',x+rx,y+h],['Q',x,y+h,x,y+h-ry],['L',x,y+ry],['Q',x,y,x+rx,y],['Z']] };
}

export function compileVectorSvg(source: string, rigDocument: unknown): VectorFacePack {
  if (!rigDocument || typeof rigDocument !== 'object' || Array.isArray(rigDocument)) throw new Error('Rig JSON must be an object.');
  const { animation = {}, morphSources = {}, ...metadata } = rigDocument as Record<string, any>;
  if (typeof animation !== 'object' || !animation || Array.isArray(animation) || typeof morphSources !== 'object' || !morphSources || Array.isArray(morphSources)) throw new Error('animation and morphSources must be objects keyed by node ID.');
  const document = readSvg(source), nodes: VectorNode[] = [], shapes = new Map<string, VectorGeometry>(), gradients: any[] = [];
  if (document.attributes.viewBox !== '0 0 100 100') throw new Error('Source SVG must use viewBox="0 0 100 100".');
  const paint = (value: string | undefined) => {
    if (value?.startsWith('url(')) {
      const match = /^url\(#([a-z][a-z0-9-]{0,47})\)$/.exec(value);
      if (!match) throw new Error('Use local named gradients only.');
      return `@gradient:${match[1]}`;
    }
    return value ?? 'none';
  };
  const visit = (node: XmlNode, inherited: Record<string, string> = {}, inDefs = false) => {
    const whitelist = allowed[node.tag];
    if (!whitelist) throw new Error(`Unsupported SVG element <${node.tag}>.`);
    for (const name of Object.keys(node.attributes)) if (!whitelist.includes(name)) throw new Error(`Unsupported SVG attribute ${name} on <${node.tag}>. Flatten transforms and styles before compiling.`);
    const attributes = { ...inherited, ...node.attributes };
    for (const name of ['stroke-linecap','stroke-linejoin'])
      if (attributes[name] && attributes[name] !== 'round') throw new Error('Use round stroke caps and joins or convert the stroke to a filled path.');
    if (node.tag === 'svg' && node.attributes.xmlns && node.attributes.xmlns !== 'http://www.w3.org/2000/svg') throw new Error('Invalid SVG namespace.');
    if (node.tag.endsWith('Gradient')) {
      const a = node.attributes;
      if (a.gradientUnits !== 'userSpaceOnUse') throw new Error('Use gradientUnits="userSpaceOnUse" with numeric coordinates.');
      const gradient: any = { id: a.id, kind: node.tag === 'linearGradient' ? 'linear' : 'radial', stops: [] };
      const keys = gradient.kind === 'linear' ? ['x1','y1','x2','y2'] : ['cx','cy','r','fx','fy'];
      for (const key of keys) gradient[key] = Number(a[key] ?? (key === 'fx' ? a.cx : key === 'fy' ? a.cy : 0));
      for (const stop of node.children) {
        if (stop.tag !== 'stop' || stop.children.length) throw new Error('Gradients contain stop elements only.');
        for (const key of Object.keys(stop.attributes)) if (!allowed.stop!.includes(key)) throw new Error('Unsupported gradient stop attribute.');
        gradient.stops.push({ offset: Number(stop.attributes.offset), color: paint(stop.attributes['stop-color']), ...(stop.attributes['stop-opacity'] === undefined ? {} : { opacity: Number(stop.attributes['stop-opacity']) }) });
      }
      gradients.push(gradient); return;
    }
    if (['svg','g','defs'].includes(node.tag)) {
      const shared = Object.fromEntries(['fill','stroke','stroke-width','opacity'].flatMap(key => attributes[key] === undefined ? [] : [[key,attributes[key]]]));
      for (const child of node.children) visit(child, shared, inDefs || node.tag === 'defs');
      return;
    }
    if (node.tag === 'stop' || node.children.length) throw new Error('Shapes cannot contain child elements.');
    const id = node.attributes.id;
    if (!id || shapes.has(id)) throw new Error('Every SVG shape needs a unique ID.');
    const geometry = svgGeometry(node.tag, attributes); shapes.set(id, geometry);
    if (!inDefs) {
      const overrides = animation[id] ?? {};
      const clip = attributes['clip-path'];
      const clipId = clip ? /^url\(#([a-z][a-z0-9-]{0,47})\)$/.exec(clip)?.[1] : undefined;
      if (clip && !clipId) throw new Error('Invalid local clip reference.');
      nodes.push({ id, geometry, fill: paint(attributes.fill),
        ...(attributes.stroke ? { stroke: paint(attributes.stroke) } : {}),
        ...(attributes['stroke-width'] ? { strokeWidth: Number(attributes['stroke-width']) } : {}),
        ...(attributes.opacity === undefined ? {} : { opacity: Number(attributes.opacity) }), ...(clipId ? { clip: clipId } : {}), ...overrides });
    }
  };
  visit(document,{fill:'#000000'});
  for (const id of Object.keys(animation)) if (!nodes.some(node => node.id === id)) throw new Error(`animation references missing visible node ${id}.`);
  for (const [id, channels] of Object.entries(morphSources)) {
    const node = nodes.find(node => node.id === id);
    if (!node || !channels || typeof channels !== 'object' || Array.isArray(channels)) throw new Error(`Invalid morphSources for ${id}.`);
    for (const [channel, targetId] of Object.entries(channels)) {
      const target = typeof targetId === 'string' ? shapes.get(targetId) : undefined;
      if (!target) throw new Error(`Missing SVG morph target ${String(targetId)}.`);
      node.morphs = { ...node.morphs, [channel]: target };
    }
  }
  const existing = metadata.resources?.gradients ?? [];
  return vectorFacePackSchema.parse({ ...metadata, artwork: { viewBox: '0 0 100 100', nodes },
    ...(gradients.length || existing.length ? { resources: { gradients: [...existing, ...gradients] } } : {}) });
}
