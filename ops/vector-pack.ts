import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { parseOrbPack, vectorFacePackSchema } from '../contract/orb-packs';
import { compileVectorSvg } from '../contract/vector-svg';
import { geometryAttributes } from '../client/orbs/vector-model';
import { build } from 'esbuild';

const [action, first, second, third] = process.argv.slice(2);
const save = async (path: string, value: unknown) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n'); };
try {
  if (action === 'validate' && first) {
    const raw = await readFile(first, 'utf8'), data = JSON.parse(raw);
    // Show field paths as well as the common import/size/reserved-ID checks.
    if (data.renderer === 'vector-face-v1') vectorFacePackSchema.parse(data);
    const pack = parseOrbPack(raw);
    console.log(`Valid ${pack.renderer} pack: ${pack.id}`);
  } else if (action === 'compile' && first && second && third) {
    const pack = compileVectorSvg(await readFile(first, 'utf8'), JSON.parse(await readFile(second, 'utf8')));
    parseOrbPack(JSON.stringify(pack)); await save(third, pack);
    console.log(`Compiled ${pack.id} into ${third}`);
  } else if (action === 'schema' && first) {
    await save(first, z.toJSONSchema(vectorFacePackSchema, { target: 'draft-2020-12' }));
  } else if (action === 'preview' && first && second) {
    const pack = parseOrbPack(await readFile(first,'utf8'));
    if(pack.renderer!=='vector-face-v1')throw new Error('Preview requires a vector face pack.');
    const result = await build({entryPoints:['ops/vector-preview.ts'],bundle:true,write:false,minify:true,platform:'browser',format:'iife'});
    const json=JSON.stringify(pack).replace(/</g,'\\u003c');
    const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vector rig review</title><style>
      *{box-sizing:border-box}body{margin:0;background:#0a111a;color:#fff8e8;font:16px system-ui;padding:24px}main{max-width:760px;margin:auto}h1{font-weight:500}p{color:#9dadb8;line-height:1.5}#stage{position:relative;width:min(500px,100%);aspect-ratio:1;margin:auto}svg{position:absolute;inset:15%;width:70%;height:70%;overflow:visible}#halo{position:absolute;inset:8%;border-radius:50%;background:var(--halo);opacity:.25;filter:blur(30px)}#stage[data-orb-state=idle] #halo,#stage[data-orb-state=error] #halo{display:none}fieldset{display:flex;gap:14px;flex-wrap:wrap;border:1px solid #33414b;border-radius:12px;padding:18px}label{display:flex;gap:6px;align-items:center}select,input,button{font:inherit;max-width:100%}button,select,input[type=number]{background:#15222e;color:#fff8e8;border:1px solid #53616b;border-radius:6px;padding:8px}#clock{width:110px}#time{font-variant-numeric:tabular-nums;color:#9dadb8;font-size:13px;margin:14px 0}input[type=range]{width:130px}
      </style><main><h1>Vector rig review</h1><p>Live SVG artwork and a reusable rig. Silent estimated speech preview; no microphone or provider connection.</p><div id="stage"><div id="halo"></div><svg viewBox="0 0 100 100" aria-label="Animated vector character"></svg></div><fieldset><label>State <select id="state">${['idle','standby','connecting','listening','thinking','working','speaking','error'].map(state=>`<option>${state}</option>`).join('')}</select></label><label>Movement <input id="motion" type="range" min="0" max="1.5" step=".05" value="1"></label><label><input id="reduced" type="checkbox">Reduced motion</label><label><input id="speech" type="checkbox" checked>Animate speech</label><label>Open <input id="mouth-open" type="range" min="0" max="1" step=".05" value="0"></label><label>Round <input id="mouth-round" type="range" min="0" max="1" step=".05" value=".2"></label><label>Wide <input id="mouth-wide" type="range" min="0" max="1" step=".05" value=".3"></label><button id="wake">Wake</button><label>Clock <input id="clock" type="number" min="0" value="0"></label><button id="seek">Seek</button><button id="play">Play</button></fieldset><div id="time"></div></main><script type="application/json" id="pack">${json}</script><script>${result.outputFiles[0]!.text}</script></html>`;
    await mkdir(dirname(second),{recursive:true});await writeFile(second,html);console.log(`Created offline vector preview: ${second}`);
  } else if (action === 'extract' && first && second) {
    const pack = parseOrbPack(await readFile(first, 'utf8'));
    if (pack.renderer !== 'vector-face-v1') throw new Error('Extract requires a vector face pack.');
    const { artwork, resources, ...metadata } = pack;
    const animation = Object.fromEntries(artwork.nodes.map(({ geometry: _geometry, id, ...rest }) => [id, rest]));
    const escape = (value: string) => value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
    const svgPaint = (value: string) => value.startsWith('@gradient:') ? `url(#${value.slice(10)})`
      : value === '$state' ? pack.colors.listening : value === '$features' ? pack.ink.features : value === '$pupils' ? pack.ink.pupils : value;
    const shapes = artwork.nodes.map(node => {
      const attributes = { id: node.id, ...geometryAttributes(node.geometry), fill: svgPaint(node.fill),
        ...(node.stroke ? { stroke: svgPaint(node.stroke) } : {}), ...(node.strokeWidth ? { 'stroke-width': String(node.strokeWidth) } : {}), ...(node.opacity === undefined ? {} : { opacity: String(node.opacity) }) };
      return `<${node.geometry.kind} ${Object.entries(attributes).map(([key,value]) => `${key}="${escape(value)}"`).join(' ')} />`;
    });
    const definitions = (resources?.gradients ?? []).map(({id,kind,stops,...coordinates}) => {
      const tag=kind==='radial'?'radialGradient':'linearGradient';
      return `<${tag} id="${id}" gradientUnits="userSpaceOnUse" ${Object.entries(coordinates).map(([key,value])=>`${key}="${value}"`).join(' ')}>${stops.map(stop=>`<stop offset="${stop.offset}" stop-color="${stop.color}"${stop.opacity===undefined?'':` stop-opacity="${stop.opacity}"`}/>`).join('')}</${tag}>`;
    });
    await mkdir(second, { recursive: true });
    await writeFile(`${second}/artwork.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">\n<defs>${definitions.join('\n')}</defs>\n${shapes.join('\n')}\n</svg>\n`);
    await save(`${second}/rig.json`, { ...metadata, animation });
    console.log(`Extracted editable artwork.svg and rig.json into ${second}`);
  } else throw new Error('Usage: npm run orb:validate -- pack.orb.json | npm run orb:compile -- artwork.svg rig.json out.orb.json | npm run orb:extract -- pack.orb.json authoring-folder | npm run orb:schema -- out.schema.json | npm run orb:preview -- pack.orb.json out.html');
} catch (error) {
  if (error instanceof z.ZodError) for (const issue of error.issues) console.error(`${issue.path.join('.') || 'pack'}: ${issue.message}`);
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
