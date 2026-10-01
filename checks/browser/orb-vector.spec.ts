import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { enterFixtureSession } from './fixture-session';
import { installationFixture } from './installation-fixture';
import { waitForFixtureBudget } from './fixture-budget';
import { EXPRESSIVE_FACE, parseOrbPack, type InstallationOrbs } from '../../contract/orb-packs';

test.beforeEach(waitForFixtureBudget);
// This fixture has no Library service. Keep unrelated document polling healthy
// so console-error assertions cover the actual orb/pack flow.
test.beforeEach(async({page})=>{await page.route('**/api/library/generated?*',route=>route.fulfill({json:[]}));});
test.use({ video: 'on' });
async function settings(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name:'Open settings',exact:true }).click();
  await page.getByText('Orb appearance',{exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Orb style',exact:true})).toBeEnabled();
}
async function shared(page: import('@playwright/test').Page) {
  const read=async()=>(await(await page.request.get('/api/orbs')).json()) as InstallationOrbs;
  const before=await read(),csrf=(await(await page.request.get('/api/status')).json()).csrfToken;
  const headers={origin:new URL(page.url()).origin,'x-csrf-token':csrf};
  return {read,headers,async restore(){const current=await read();await page.request.patch('/api/orbs/preferences',{headers,data:{revision:current.revision,patch:before.preferences}});}};
}

test('vector artwork previews eight states, exports/imports, shares across devices and preserves every old style', async ({page,browser,context}, info) => {
  const errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await enterFixtureSession(page);await settings(page);
  const read=async()=>(await(await page.request.get('/api/orbs')).json()) as InstallationOrbs;
  const before=await read(),csrf=(await(await page.request.get('/api/status')).json()).csrfToken;
  const headers={origin:new URL(page.url()).origin,'x-csrf-token':csrf};
  const id=`vector-${randomUUID().slice(0,8)}`, copperId=`copper-${randomUUID().slice(0,8)}`;
  let fresh:Awaited<ReturnType<typeof browser.newContext>>|undefined;
  try {
    const selector=page.getByRole('combobox',{name:'Orb style',exact:true});
    await selector.selectOption('expressive-face');
    const preview=page.locator('.orb-pack-preview .vector-face-orb'),svg=preview.locator('svg');
    await expect(svg).toHaveAttribute('viewBox','0 0 100 100');
    await expect(page.getByRole('slider',{name:'Movement',exact:true})).toBeVisible();
    await expect(page.getByRole('checkbox',{name:'State colors',exact:true})).toHaveCount(0);
    const stages=[['off','idle'],['standby','standby'],['starting','connecting'],['listening','listening'],['thinking','thinking'],['working','working'],['speaking','speaking'],['error','error']] as const;
    for(const [phase,state]of stages){
      await page.getByRole('combobox',{name:'Preview expression',exact:true}).selectOption(phase);
      await expect(preview).toHaveAttribute('data-orb-state',state);
      await expect(preview.locator('[data-vector-node="head"]')).toHaveAttribute('fill',EXPRESSIVE_FACE.colors[state]);
      if(state==='idle'||state==='error')await expect(preview.locator('.vector-face-halo')).toHaveCSS('display','none');
      await expect(svg.locator('image,foreignObject,script')).toHaveCount(0);
      await expect(svg.locator('[data-vector-node]')).toHaveCount(EXPRESSIVE_FACE.artwork.nodes.length);
      // Wait for the intentional color blend, not an arbitrary animation frame.
      const rgb=EXPRESSIVE_FACE.colors[state].slice(1).match(/../g)!.map(s=>parseInt(s,16)).join(', ');
      await expect(preview.locator('[data-vector-node="head"]')).toHaveCSS('fill',`rgb(${rgb})`);
      await preview.screenshot({path:info.outputPath(`vector-${state}.png`)});
    }
    await page.getByRole('combobox',{name:'Preview expression',exact:true}).selectOption('off');
    await expect(svg).toHaveAttribute('data-orb-moment','yawn');
    await page.getByRole('combobox',{name:'Preview expression',exact:true}).selectOption('listening');
    await expect(svg).toHaveAttribute('data-orb-moment','wake');
    await expect(svg).toHaveAttribute('data-orb-moment','none');
    await page.getByRole('combobox',{name:'Preview expression',exact:true}).selectOption('speaking');
    const mouth=preview.locator('[data-orb-mouth]');
    const first=await mouth.getAttribute('d');await expect.poll(()=>mouth.getAttribute('d')).not.toBe(first);
    await expect(svg).toHaveAttribute('data-orb-gaze-x','0.000');
    await page.emulateMedia({reducedMotion:'reduce'});
    await expect(svg).toHaveAttribute('data-orb-micro-motion','reduced');
    const frozen=await svg.innerHTML();
    await page.waitForTimeout(300);expect(await svg.innerHTML()).toBe(frozen);
    await page.emulateMedia({reducedMotion:'no-preference'});
    await expect(svg).toHaveAttribute('data-orb-micro-motion','active');
    // Visibility policies suspend the face clock without losing the current pose.
    await preview.evaluate(element=>{element.style.transform='translateY(10000px)';});
    await page.waitForTimeout(100);
    const offscreen=await svg.getAttribute('data-orb-clock-ms');
    await page.waitForTimeout(120);expect(await svg.getAttribute('data-orb-clock-ms')).toBe(offscreen);
    await preview.evaluate(element=>{element.style.transform='';});
    await expect.poll(()=>svg.getAttribute('data-orb-clock-ms')).not.toBe(offscreen);
    await page.evaluate(()=>{
      Object.assign(window,{vectorHidden:true});
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>(window as any).vectorHidden});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hidden=await svg.getAttribute('data-orb-clock-ms');
    await page.waitForTimeout(120);expect(await svg.getAttribute('data-orb-clock-ms')).toBe(hidden);
    await page.evaluate(()=>{delete (document as any).hidden;document.dispatchEvent(new Event('visibilitychange'));});
    await expect.poll(()=>svg.getAttribute('data-orb-clock-ms')).not.toBe(hidden);
    await page.getByRole('button',{name:'Export orb pack',exact:true}).click();
    const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Save my-expressive-face.orb.json',exact:true}).click();
    const downloaded=await downloadPromise;
    expect(downloaded.suggestedFilename()).toBe('my-expressive-face.orb.json');
    const pack=parseOrbPack(await readFile((await downloaded.path())!,'utf8'));
    expect(pack).toEqual({...EXPRESSIVE_FACE,id:'my-expressive-face',name:'My Expressive Face'});
    const upload=page.locator('input[type=file][accept*=".orb.json"]');
    await upload.setInputFiles({name:'my-vector.orb.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...pack,id}))});
    await expect(selector).toHaveValue(id);
    fresh=await browser.newContext({baseURL:String(info.project.use.baseURL),storageState:{cookies:await context.cookies(),origins:[]}});
    const pc=await fresh.newPage();
    await pc.route('**/api/library/generated?*',route=>route.fulfill({json:[]}));
    pc.on('pageerror',e=>errors.push(e.message));pc.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await pc.goto('/');await settings(pc);
    await expect(pc.getByRole('combobox',{name:'Orb style',exact:true})).toHaveValue(id);
    await expect(pc.locator('.orb-pack-preview .vector-face-orb')).toHaveAttribute('data-orb-pack',id);
    const copper=JSON.parse(await readFile('docs/vector-face/examples/copper-companion.orb.json','utf8'));
    await upload.setInputFiles({name:'copper.orb.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...copper,id:copperId}))});
    await expect(selector).toHaveValue(copperId);
    await expect(preview.locator('[data-vector-node="head"]')).toHaveAttribute('d',/^M 25 8/);
    await expect(svg.locator('radialGradient')).toHaveCount(1);
    await preview.screenshot({path:info.outputPath('copper-companion.png')});
    await selector.selectOption('luminous-glass');await expect(page.locator('.orb-pack-preview [data-face-ready="true"]')).toBeVisible();
    await expect(page.getByRole('checkbox',{name:'State colors',exact:true})).toBeVisible();
    await selector.selectOption('voice-connect-v1');await expect(page.locator('.orb-pack-preview .status-orb')).toBeVisible();
    await selector.selectOption('classic');await expect(page.locator('.orb-pack-preview')).toHaveCount(0);
    await selector.selectOption(id);await expect(preview).toBeVisible();
    await expect.poll(async()=>(await read()).preferences.packId).toBe(id);
    await page.reload();await settings(page);await expect(selector).toHaveValue(id);
    await page.getByRole('button',{name:'Close Make yourself at home',exact:true}).click();
    await expect(page.locator('.voice-center .vector-face-orb')).toBeVisible();
    await expect(page.locator('.voice-center .orb-ear-meter')).toHaveCount(2);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await fresh?.close();
    for(const importedId of [id,copperId]) {const state=await read();if(state.packs.some(pack=>pack.id===importedId))await page.request.delete(`/api/orbs/packs/${importedId}`,{headers,data:{revision:state.revision}});}
    const state=await read();await page.request.patch('/api/orbs/preferences',{headers,data:{revision:state.revision,patch:before.preferences}});
  }
});

test('vector rig follows real voice events, meters, commentary and standby without background audio', async ({ page, context }, info) => {
  await context.grantPermissions(['microphone']); await installationFixture(page, { output: 'browser', recognition: 'browser' });
  const media: string[] = []; page.on('request', r => { if (/\.(wav|mp3)(?:\?|$)/.test(r.url())) media.push(r.url()); });
  await page.addInitScript(() => {
    localStorage.setItem('vc2:speech', JSON.stringify({ audioCues: false, keepAwake: false, audioVuMeters: true, handsFree: false }));
    const probe = { amplitude: .2, spoken: [] as string[], states: [] as string[], generation: 0, emit: (_text: string) => {} };
    Object.assign(window, { legacyProbe: probe });
    class Recognition { onstart?: () => void; onend?: () => void; onresult?: (event: unknown) => void;
      start() { probe.emit = text => this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] }); queueMicrotask(() => this.onstart?.()); }
      stop() { this.onend?.(); } abort() {} }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition });
    // The native utterance voice setter rejects our synthetic voice descriptor.
    class Utterance { onstart?: (event: Event) => void; onend?: (event: Event) => void; onerror?: (event: Event) => void; constructor(public text: string) {} }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: Utterance });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [{ name: 'Fixture', voiceURI: 'fixture', lang: 'en-US', localService: true, default: true }], addEventListener() {}, removeEventListener() {}, cancel() { probe.generation++; },
      speak(utterance: SpeechSynthesisUtterance) { const generation = probe.generation; probe.spoken.push(utterance.text); queueMicrotask(() => utterance.onstart?.(new Event('start') as SpeechSynthesisEvent)); setTimeout(() => { if (generation === probe.generation) utterance.onend?.(new Event('end') as SpeechSynthesisEvent); }, 650); },
    } });
    const NativeWorklet = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeWorklet { constructor(c: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
      super(c, name, options); if (name === 'voice-capture') this.port.addEventListener('message', e => { if (e.data.samples) e.data.samples.fill(probe.amplitude); });
    } };
    new MutationObserver(() => { const state = document.querySelector('.voice-center .vector-face-orb')?.getAttribute('data-orb-state'); if (state && probe.states.at(-1) !== state) probe.states.push(state); }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-orb-state'] });
  });
  await enterFixtureSession(page); await expect(page.getByRole('button', { name: 'Wake NorthPointe', exact: true })).toBeEnabled();
  const saved = await shared(page);
  try {
    await settings(page); await page.getByRole('combobox', { name: 'Orb style', exact: true }).selectOption(EXPRESSIVE_FACE.id);
    await expect.poll(async () => (await saved.read()).preferences.packId).toBe(EXPRESSIVE_FACE.id);
    await page.getByRole('button', { name: 'Close Make yourself at home', exact: true }).click();
    await page.getByRole('button', { name: 'Wake NorthPointe', exact: true }).click();
    const orb = page.locator('.voice-center .vector-face-orb'); await expect(orb).toHaveAttribute('data-orb-state', 'listening');
    for (const side of ['left','right']) await expect(orb.locator(`.orb-ear-${side}`)).toHaveAttribute('data-lit-segments', '16');
    await page.evaluate(() => { const p = (window as any).legacyProbe; p.amplitude = 0; });
    await expect(orb.locator('.orb-ear-left')).toHaveAttribute('data-lit-segments', '0');
    await page.evaluate(() => (window as any).legacyProbe.emit('Progress commentary fixture Vector rig'));
    await page.getByRole('button', { name: 'Finish thought', exact: true }).click();
    await expect(orb).toHaveAttribute('data-orb-state', 'working');
    // Short tool/commentary windows can interrupt the deliberate 720 ms blend.
    await expect(orb.locator('[data-vector-node="head"]')).toHaveAttribute('fill', '#f97316');
    await page.screenshot({ path: info.outputPath('legacy-tool-working.png'), fullPage: true });
    await expect.poll(() => page.evaluate(() => (window as any).legacyProbe.spoken)).toEqual(['I will check the configuration.', 'I found the setting.', 'The configuration is correct.']);
    // Browser fallback finishes capture with the submitted turn; restarting is
    // explicit. The selected orb must not change that existing provider behavior.
    await expect(page.getByRole('button', { name: 'Record again', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Record again', exact: true }).click();
    await expect(orb).toHaveAttribute('data-orb-state', 'listening');
    const states = await page.evaluate(() => (window as any).legacyProbe.states as string[]);
    expect(states).toContain('thinking'); expect(states).toContain('working'); expect(states).toContain('speaking');
    await page.getByRole('button', { name: 'Enter standby mode', exact: true }).click();
    await expect(orb).toHaveAttribute('data-orb-state', 'standby');
    await expect(orb.locator('.orb-ear-left')).toHaveAttribute('data-lit-segments', '0');
    await page.getByRole('button', { name: 'Resume conversation', exact: true }).click();
    await expect(orb).toHaveAttribute('data-orb-state', 'listening');
    await page.getByRole('button', { name: 'End voice session', exact: true }).click();
    await expect(orb).toHaveAttribute('data-orb-state', 'idle'); expect(media).toEqual([]);
  } finally { await saved.restore(); }
});
