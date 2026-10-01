import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { enterFixtureSession } from './fixture-session';
import { installationFixture } from './installation-fixture';
import { waitForFixtureBudget } from './fixture-budget';
import { VOICE_CONNECT_V1, parseOrbPack, type InstallationOrbs } from '../../contract/orb-packs';

test.beforeEach(waitForFixtureBudget);
async function settings(page: Page) {
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByText('Orb appearance', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Orb style', exact: true })).toBeEnabled();
}
async function shared(page: Page) {
  const before = await (await page.request.get('/api/orbs')).json() as InstallationOrbs;
  const csrf = (await (await page.request.get('/api/status')).json()).csrfToken;
  const headers = { origin: new URL(page.url()).origin, 'x-csrf-token': csrf };
  const read = async () => (await (await page.request.get('/api/orbs')).json()) as InstallationOrbs;
  return { read, headers, async restore(id?: string) {
    let current = await read();
    if (id && current.packs.some(p => p.id === id)) { await page.request.delete(`/api/orbs/packs/${id}`, { headers, data: { revision: current.revision } }); current = await read(); }
    await page.request.patch('/api/orbs/preferences', { headers, data: { revision: current.revision, patch: before.preferences } });
  } };
}

test('legacy pack previews all eight states, exports/imports, persists and switches back to faces', async ({ page, browser, context }, info) => {
  await enterFixtureSession(page); await expect(page.getByRole('button', { name: 'Open settings', exact: true })).toBeEnabled();
  const saved = await shared(page), importedId = `legacy-${randomUUID().slice(0, 8)}`;
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  let fresh: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    await settings(page);
    const selector = page.getByRole('combobox', { name: 'Orb style', exact: true });
    await selector.selectOption(VOICE_CONNECT_V1.id);
    const preview = page.locator('.orb-pack-preview .status-orb');
    await expect(preview).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'State colors', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove imported orb', exact: true })).toHaveCount(0);
    const stages = [['off','idle'],['standby','standby'],['starting','connecting'],['listening','listening'],['thinking','thinking'],['working','working'],['speaking','speaking'],['error','error']] as const;
    for (const [phase, stage] of stages) {
      await page.getByRole('combobox', { name: 'Preview expression', exact: true }).selectOption(phase);
      await expect(preview).toHaveAttribute('data-orb-state', stage);
      await expect(preview.locator('.status-orb-ear span')).toHaveCount(24);
      const hex = VOICE_CONNECT_V1.colors[stage], rgb = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16));
      await expect(preview.locator('.status-orb-body')).toHaveCSS('background-color', `rgb(${rgb.join(', ')})`);
      await expect(preview.locator('.status-orb-glyph')).toHaveCSS('animation-name', stage === 'speaking' ? 'status-spin' : 'none');
      if (stage === 'idle' || stage === 'error') await expect(preview.locator('.status-orb-halo')).toHaveCSS('display', 'none');
      await preview.screenshot({ path: info.outputPath(`legacy-${stage}.png`) });
    }
    await page.getByRole('combobox', { name: 'Preview expression', exact: true }).selectOption('speaking');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(preview.locator('.status-orb-glyph')).toHaveCSS('animation-name', 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(preview.locator('.status-orb-glyph')).toHaveCSS('animation-name', 'status-spin');
    await page.getByRole('button', { name: 'Export orb pack', exact: true }).click();
    const downloaded = page.waitForEvent('download'); await page.getByRole('link', { name: /^Save my-voice-connect-v1/ }).click();
    const download = await downloaded;
    const exported = parseOrbPack(await readFile((await download.path())!, 'utf8'));
    expect(exported).toEqual({ ...VOICE_CONNECT_V1, id: 'my-voice-connect-v1', name: 'My Voice Connect v1' });
    await page.locator('input[type=file][accept*=".orb.json"]').setInputFiles({ name: 'original.orb.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...exported, id: importedId })) });
    await expect(selector).toHaveValue(importedId);
    await page.reload(); await settings(page); await expect(selector).toHaveValue(importedId);
    fresh = await browser.newContext({ baseURL: String(info.project.use.baseURL), storageState: { cookies: await context.cookies(), origins: [] } });
    const pc = await fresh.newPage(); await pc.goto('/'); await settings(pc);
    await expect(pc.getByRole('combobox', { name: 'Orb style', exact: true })).toHaveValue(importedId);
    await selector.selectOption('luminous-glass');
    await expect(page.locator('.orb-pack-preview [data-face-ready="true"]')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'State colors', exact: true })).toBeVisible();
    await selector.selectOption(VOICE_CONNECT_V1.id);
    await expect.poll(async () => (await saved.read()).preferences.packId).toBe(VOICE_CONNECT_V1.id);
    await page.getByRole('button', { name: 'Close Make yourself at home', exact: true }).click();
    await expect(page.locator('.voice-center .status-orb')).toBeVisible();
    await page.screenshot({ path: info.outputPath('legacy-app.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await fresh?.close(); await saved.restore(importedId); }
});

test('legacy meters follow capture and tool events turn the orb orange without background audio', async ({ page, context }, info) => {
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
    new MutationObserver(() => { const state = document.querySelector('.voice-center .status-orb')?.getAttribute('data-orb-state'); if (state && probe.states.at(-1) !== state) probe.states.push(state); }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-orb-state'] });
  });
  await enterFixtureSession(page); await expect(page.getByRole('button', { name: 'Wake NorthPointe', exact: true })).toBeEnabled();
  const saved = await shared(page);
  try {
    await settings(page); await page.getByRole('combobox', { name: 'Orb style', exact: true }).selectOption(VOICE_CONNECT_V1.id);
    await expect.poll(async () => (await saved.read()).preferences.packId).toBe(VOICE_CONNECT_V1.id);
    await page.getByRole('button', { name: 'Close Make yourself at home', exact: true }).click();
    await page.getByRole('button', { name: 'Wake NorthPointe', exact: true }).click();
    const orb = page.locator('.voice-center .status-orb'); await expect(orb).toHaveAttribute('data-orb-state', 'listening');
    for (const side of ['left','right']) await expect(orb.locator(`.status-orb-ear-${side}`)).toHaveAttribute('data-lit-segments', '12');
    await page.evaluate(() => { const p = (window as any).legacyProbe; p.amplitude = 0; });
    await expect(orb.locator('.status-orb-ear-left')).toHaveAttribute('data-lit-segments', '0');
    await page.evaluate(() => (window as any).legacyProbe.emit('Progress commentary fixture'));
    await page.getByRole('button', { name: 'Finish thought', exact: true }).click();
    await expect(orb).toHaveAttribute('data-orb-state', 'working');
    await expect(orb.locator('.status-orb-body')).toHaveCSS('background-color', 'rgb(255, 105, 0)');
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
    await expect(orb.locator('.status-orb-ear-left')).toHaveAttribute('data-lit-segments', '0');
    await page.getByRole('button', { name: 'Resume conversation', exact: true }).click();
    await expect(orb).toHaveAttribute('data-orb-state', 'listening');
    await page.getByRole('button', { name: 'End voice session', exact: true }).click();
    await expect(orb).toHaveAttribute('data-orb-state', 'idle'); expect(media).toEqual([]);
  } finally { await saved.restore(); }
});
