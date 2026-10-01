import { chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ORB_STATES, parseOrbPack } from '../contract/orb-packs';

const [file, directory] = process.argv.slice(2);
if (!file || !directory) throw new Error('Usage: npm run orb:evidence -- pack.orb.json output-folder');
const pack = parseOrbPack(await readFile(file, 'utf8'));
if (pack.renderer !== 'vector-face-v1') throw new Error('Evidence requires a vector face pack.');
const folder = resolve(directory), html = join(folder, 'review.html');
await mkdir(folder, { recursive: true });
await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs','ops/vector-pack.ts','preview',file,html]);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 760, height: 960 }, recordVideo: { dir: folder, size: { width: 760, height: 960 } } });
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(html).href);
  await page.waitForFunction(() => Boolean((window as any).vectorReview));
  const frame = async (state: string, t: number) => page.evaluate(({state,t}) => {
    const review = (window as any).vectorReview;
    review.state(state,0);review.reset();review.seek(t);
  },{state,t});
  const images: string[] = [];
  for (const state of ORB_STATES) {
    await frame(state,1800);
    const image = await page.locator('#stage').screenshot({path:join(folder,`${state}.png`)});
    images.push(`<figure><img src="data:image/png;base64,${image.toString('base64')}" alt="${state}"><figcaption>${state}</figcaption></figure>`);
  }
  // Render an actual browser contact sheet; don't alter the screenshot pixels.
  const sheet = await context.newPage();
  await sheet.setViewportSize({width:1200,height:760});
  await sheet.setContent(`<!doctype html><style>body{margin:0;background:#0a111a;color:#fff8e8;font:18px system-ui;padding:24px}h1{font-size:24px;font-weight:500;margin:0 0 8px}p{color:#9dadb8;font-size:13px;margin:0 0 12px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}figure{margin:0;background:#0d151f;border-radius:10px;overflow:hidden}img{display:block;width:100%}figcaption{text-align:center;padding:6px}</style><h1></h1><p>Live SVG rig · deterministic 1800 ms frames · silent estimated speech</p><div class="grid">${images.join('')}</div>`);
  await sheet.locator('h1').evaluate((element,name)=>{element.textContent=name;},pack.name);
  await sheet.screenshot({path:join(folder,'states.png'),fullPage:true});
  await sheet.close();
  await frame('idle',0);
  await page.evaluate(()=>(window as any).vectorReview.play());
  await page.waitForTimeout(500);
  await page.locator('#wake').click();
  await page.waitForTimeout(1900);
  await page.locator('#state').selectOption('speaking');
  await page.waitForTimeout(4000);
  await page.locator('#state').selectOption('listening');
  await page.waitForTimeout(1900);
  await page.locator('#state').selectOption('idle');
  await page.waitForTimeout(1200);
  const video = page.video();
  // Identical seeks must produce no SVG attribute churn.
  await frame('listening',1800);
  const changed = await page.evaluate(() => {
    const svg = document.querySelector('svg')!;
    const observer = new MutationObserver(()=>{});observer.observe(svg,{attributes:true,subtree:true});
    (window as any).vectorReview.seek(1800);
    const count = observer.takeRecords().length;observer.disconnect();return count;
  });
  if(changed)throw new Error(`Identical scene wrote ${changed} SVG attributes.`);
  if(errors.length)throw new Error(errors.join('\n'));
  await context.close();
  if(video)await rename(await video.path(),join(folder,'wake-speaking.webm'));
  await writeFile(join(folder,'evidence.json'),JSON.stringify({pack:pack.id,states:ORB_STATES,clockMs:1800,identicalFrameAttributeWrites:changed,
    pageErrors:errors,speech:'silent estimated review signal',physicalAndroidTested:false},null,2)+'\n');
  console.log(`Captured eight states, a contact sheet and wake/speech/yawn recording in ${folder}`);
} finally { await browser.close(); }
