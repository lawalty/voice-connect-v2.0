import type { OrbState, VectorFacePack } from '../../contract/orb-packs';
import { geometryAttributes, type VectorScene } from './vector-model';

const NS = 'http://www.w3.org/2000/svg';
type ElementRef = { shape: SVGElement; clip?: SVGElement };
/** Small retained SVG renderer. Pack strings never enter innerHTML or CSS. */
export class VectorRenderer {
  private attributes = new WeakMap<Element, Map<string, string>>();
  private nodes = new Map<string, ElementRef>();
  private gradients: { element: SVGStopElement; paint: string }[] = [];
  private clips = new Map<string, SVGElement>();
  private group: SVGGElement;
  private defs: SVGDefsElement;
  constructor(private svg: SVGSVGElement, private pack: VectorFacePack, private prefix: string) {
    this.defs = this.create('defs') as SVGDefsElement;
    this.group = this.create('g') as SVGGElement;
    svg.replaceChildren(this.defs, this.group);
    this.set(svg, 'viewBox', pack.artwork.viewBox);
    for (const gradient of pack.resources?.gradients ?? []) {
      const element = this.create(gradient.kind === 'radial' ? 'radialGradient' : 'linearGradient');
      this.set(element, 'id', `${prefix}-gradient-${gradient.id}`);
      this.set(element, 'gradientUnits', 'userSpaceOnUse');
      const { id: _id, kind: _kind, stops, ...coordinates } = gradient;
      for (const [name, value] of Object.entries(coordinates)) this.set(element, name, String(value));
      for (const stop of stops) {
        const child = this.create('stop') as SVGStopElement;
        this.set(child, 'offset', String(stop.offset)); this.set(child, 'stop-opacity', String(stop.opacity ?? 1));
        element.appendChild(child); this.gradients.push({ element: child, paint: stop.color });
      }
      this.defs.appendChild(element);
    }
    for (const id of new Set(pack.artwork.nodes.flatMap(node => node.clip ? [node.clip] : []))) {
      const source = pack.artwork.nodes.find(node => node.id === id)!;
      const clip = this.create('clipPath'), shape = this.create(source.geometry.kind);
      this.set(clip, 'id', `${prefix}-clip-${id}`); this.set(clip, 'clipPathUnits', 'userSpaceOnUse');
      clip.appendChild(shape); this.defs.appendChild(clip); this.clips.set(id, shape);
    }
    for (const node of pack.artwork.nodes) {
      const shape = this.create(node.geometry.kind);
      this.set(shape, 'data-vector-node', node.id);
      this.set(shape, 'stroke-linecap', 'round'); this.set(shape, 'stroke-linejoin', 'round');
      if (node.id === pack.rig.mouth.outline) this.set(shape, 'data-orb-mouth', 'true');
      let clip: SVGElement | undefined;
      if (node.clip) {
        clip = this.create('g'); this.set(clip, 'clip-path', `url(#${prefix}-clip-${node.clip})`);
        clip.appendChild(shape); this.group.appendChild(clip);
      } else this.group.appendChild(shape);
      this.nodes.set(node.id, { shape, clip });
    }
  }
  private create(tag: string) { return document.createElementNS(NS, tag); }
  private set(element: Element, name: string, value: string | null) {
    let known = this.attributes.get(element);
    if (!known) { known = new Map(); this.attributes.set(element, known); }
    if (value === null) { if (known.has(name)) { element.removeAttribute(name); known.delete(name); } }
    else if (known.get(name) !== value) { element.setAttribute(name, value); known.set(name, value); }
  }
  private paint(value: string | undefined, state: OrbState): string {
    if (!value) return 'none';
    if (value === '$features') return this.pack.ink.features;
    if (value === '$pupils') return this.pack.ink.pupils;
    if (value === '$state') return this.pack.colors[state];
    if (value.startsWith('@gradient:')) return `url(#${this.prefix}-gradient-${value.slice(10)})`;
    return value;
  }
  draw(scene: VectorScene, state: OrbState) {
    for (const [name, value] of Object.entries(scene.markers)) this.set(this.svg, name, value);
    for (const stop of this.gradients) this.set(stop.element, 'stop-color', this.paint(stop.paint, state));
    for (const { node, geometry, opacity, transform } of scene.nodes) {
      const shape = this.nodes.get(node.id)!.shape;
      for (const [name, value] of Object.entries(geometryAttributes(geometry))) this.set(shape, name, value);
      this.set(shape, 'fill', this.paint(node.fill, state)); this.set(shape, 'stroke', node.stroke ? this.paint(node.stroke, state) : null);
      this.set(shape, 'stroke-width', node.strokeWidth === undefined ? null : String(node.strokeWidth));
      this.set(shape, 'opacity', String(opacity)); this.set(shape, 'transform', transform);
      const clip = this.clips.get(node.id);
      if (clip) {
        for (const [name, value] of Object.entries(geometryAttributes(geometry))) this.set(clip, name, value);
        this.set(clip, 'transform', transform);
      }
    }
  }
  dispose() { this.svg.replaceChildren(); this.nodes.clear(); this.clips.clear(); }
}
