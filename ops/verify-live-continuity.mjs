// Authorized synthetic live acceptance: real Deepgram/Fish and native OpenClaw.
// No physical microphone; generated silence and a muted local playback monitor.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const [expected, voice] = process.argv.slice(2);
assert.match(expected || '', /^[a-f0-9]{40}$/);
assert.match(voice || '', /^[a-zA-Z0-9_-]{1,128}$/);
const access = JSON.parse(await readFile(process.env.VC_LIVE_CREDENTIAL_FILE || '.local/owner-access.json', 'utf8'));
assert.equal(access.origin, 'https://srv2003889.hstgr.cloud');
const evidence = `.local/release-evidence/continuity-${expected.slice(0, 7)}`;
await mkdir(evidence, { recursive: true });
const wav = Buffer.alloc(44 + 48000 * 2 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
const silentFile = resolve(evidence, 'synthetic-silence.wav'); await writeFile(silentFile, wav);
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${silentFile}`, '--autoplay-policy=no-user-gesture-required'] });
try {
  const context = await browser.newContext({ baseURL: access.origin, permissions: ['microphone'], viewport: { width: 412, height: 915 } });
  const login = await context.request.post('/api/auth/login', { headers: { Origin: access.origin }, data: { password: access.password } });
  assert.equal(login.status(), 200); const status = await login.json(); assert.equal(status.build, expected);
  const created = await context.request.post('/api/conversations', { headers: { Origin: access.origin, 'X-CSRF-Token': status.csrfToken }, data: { title: 'Synthetic phone continuity QA' } });
  assert.equal(created.status(), 200); const conversation = await created.json();
  await context.addInitScript(({ id, voice }) => {
    localStorage.setItem('vc2:conversation', id);
    localStorage.setItem('vc2:speech', JSON.stringify({ recognition: 'deepgram', output: 'fish', fishVoice: voice, handsFree: true, audioCues: false, keepAwake: false }));
    const probe = window.continuity = { tracks: [], scheduledSeconds: 0, nonzeroSamples: 0, stops: 0 };
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => { const stream = await capture(constraints); probe.tracks.push(...stream.getAudioTracks()); return stream; };
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      createBufferSource() {
        const source = super.createBufferSource(), start = source.start.bind(source), stop = source.stop.bind(source), connect = source.connect.bind(source);
        const monitor = this.createGain(); monitor.gain.value = 0; monitor.connect(this.destination);
        source.connect = (destination, ...rest) => connect(destination === this.destination ? monitor : destination, ...rest);
        source.start = (...args) => {
          if (source.buffer) {
            probe.scheduledSeconds += source.buffer.duration;
            for (const sample of source.buffer.getChannelData(0)) if (Math.abs(sample) > 0.001) probe.nonzeroSamples++;
          }
          return start(...args);
        };
        source.stop = (...args) => { probe.stops++; return stop(...args); };
        source.addEventListener('ended', () => monitor.disconnect(), { once: true });
        return source;
      }
    };
  }, { id: conversation.id, voice });
  const page = await context.newPage(), controls = [], recognitions = [], requests = [], errors = [];
  await page.routeWebSocket(url => url.pathname === '/api/events', route => { controls.push(route); route.connectToServer(); });
  await page.routeWebSocket(url => url.pathname === '/api/audio' && url.searchParams.get('kind') === 'stt', route => { recognitions.push(route); route.connectToServer(); });
  page.on('pageerror', error => errors.push(error.name));
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/turns')) requests.push(request.postDataJSON().id); });
  const probe = () => page.evaluate(() => {
    const p = window.continuity;
    return { captures: p.tracks.length, live: p.tracks.filter(t => t.readyState === 'live' && t.enabled).length, scheduledSeconds: p.scheduledSeconds, nonzeroSamples: p.nonzeroSamples, stops: p.stops };
  });
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
  await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  await page.getByRole('switch', { name: 'Auto mode' }).click();
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible({ timeout: 30000 });
  const initial = await probe(), initialControls = controls.length, initialRecognitions = recognitions.length;
  await page.getByLabel('Message NorthPointe').fill('Synthetic Voice Connect continuity QA. Do not use tools, contact anyone, change files, or save memories. Describe an imaginary garden in six complete sentences, about 90 words. Plain prose only; begin immediately.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await probe()).nonzeroSamples, { timeout: 90000 }).toBeGreaterThan(1000);
  const playing = await probe(), began = Date.now();
  // Break both app-facing channels during real Fish playback. TTS is independent.
  recognitions.at(-1).close(); controls.at(-1).close();
  await expect.poll(() => recognitions.length, { timeout: 10000 }).toBe(initialRecognitions + 1);
  await expect.poll(() => controls.length, { timeout: 10000 }).toBe(initialControls + 1);
  await expect(page.locator('.site-header .connection-pill')).toHaveText('Connected');
  const recovered = await probe(), recoveryMs = Date.now() - began;
  assert.equal(recovered.captures, initial.captures); assert.equal(recovered.live, 1); assert.equal(recovered.stops, playing.stops);
  await expect.poll(async () => (await probe()).scheduledSeconds).toBeGreaterThan(playing.scheduledSeconds);
  await expect(page.getByRole('switch', { name: 'Auto mode' })).toBeChecked();
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible({ timeout: 120000 });
  await page.getByLabel('Message NorthPointe').fill('Second synthetic continuity check. No tools, files, contacts, or saved memories. Reply with exactly: Continuity confirmed.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('article', { name: 'NorthPointe', exact: true }).last()).toContainText('Continuity confirmed', { timeout: 90000 });
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible({ timeout: 60000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('vc2:conversation')), conversation.id);
  assert.equal(requests.length, 2); assert.equal(new Set(requests).size, 2); assert.deepEqual(errors, []);
  const final = await probe(); assert.equal(final.captures, initial.captures); assert.equal(final.live, 1);
  await page.screenshot({ path: `${evidence}/recovered.png`, fullPage: true });
  await page.getByRole('button', { name: 'End voice session' }).click();
  const result = { build: expected, time: new Date().toISOString(), conversationId: conversation.id, recoveryMs, ...final, requests: requests.length, errors,
    realDeepgram: true, realFish: true, nativeOpenClaw: true, physicalPhone: false, monitorMuted: true, microphoneAudioRetained: false };
  await writeFile(`${evidence}/result.json`, JSON.stringify(result, null, 2));
  console.log('PASS live independent channel recovery during Fish playback', JSON.stringify(result));
} finally { await browser.close(); }
