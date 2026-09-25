// Explicit live acceptance: two finite public speech samples through real
// AudioWorklet/Silero/Vosk and the native Gateway, with one Start and no Finish.
// getUserMedia supplies scheduled synthetic PCM. TTS callbacks are simulated:
// this proves turn lifecycle, not audible playback, echo cancellation or Android.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const origin = 'https://srv2003889.hstgr.cloud';
const expectedBuild = process.argv[2];
assert.ok(expectedBuild, 'Pass the expected deployed revision.');
const access = JSON.parse(await readFile(process.env.VC_LIVE_CREDENTIAL_FILE || '.local/owner-access.json', 'utf8'));
assert.equal(access.origin, origin);
const safe = value => String(value).split(String(access.password)).join('[redacted]');
const fixture = await readFile('.local/audio-check/test.wav');
const fixtureSha256 = createHash('sha256').update(fixture).digest('hex');
assert.equal(fixtureSha256, 'dcfea5712c43a43ba7ae8083afb39d36993e5a69c46e88b68aaa72b65cb615bb');
let format, data;
for (let offset = 12; offset + 8 <= fixture.length;) {
  const type = fixture.toString('ascii', offset, offset + 4), size = fixture.readUInt32LE(offset + 4);
  assert.ok(offset + 8 + size <= fixture.length);
  if (type === 'fmt ') format = fixture.subarray(offset + 8, offset + 8 + size);
  if (type === 'data') data = fixture.subarray(offset + 8, offset + 8 + size);
  offset += 8 + size + size % 2;
}
assert.equal(format?.readUInt16LE(0), 1); assert.equal(format.readUInt16LE(2), 1);
assert.equal(format.readUInt32LE(4), 16000); assert.equal(format.readUInt16LE(14), 16);
// First complete phrase, including its natural leading/trailing silence. The
// source also contains later phrases separated by deliberate >1-second pauses;
// those are separate acoustic turns, not a semantic endpointing benchmark.
const sampleEndSeconds = 3.5;
const samples = Array.from({ length: sampleEndSeconds * 16000 }, (_, i) => data.readInt16LE(i * 2) / 32768);
const report = { time: new Date().toISOString(), expectedBuild, fixtureSha256, sampleEndSeconds,
  synthetic: true, realMicrophone: false, realVadAndRecognition: true, playbackCallbacksSimulated: true,
  limit: 'Scheduled public PCM in desktop Chromium. Physical speech, noisy-car, audible output, echo cancellation, Bluetooth and Android remain unqualified.' };
const browser = await chromium.launch();
const errors = [], posts = [], audioRequests = [], receipts = [], terminal = new Map();
let page;
await mkdir('.local/release-evidence', { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => {
    const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const state = window.__voiceAcceptance = { microphoneOpens: 0, starts: 0, finishes: 0, playbackStarts: 0, playbackEnds: 0, spoken: [], feed: null };
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (!constraints.audio || constraints.video) return native(constraints);
      state.microphoneOpens++;
      const audio = new AudioContext({ sampleRate: 16000 }), destination = audio.createMediaStreamDestination();
      // A silent source keeps one live track between the two scheduled turns.
      const zero = audio.createConstantSource(); zero.offset.value = 0; zero.connect(destination); zero.start();
      await audio.resume();
      state.feed = async values => {
        const buffer = audio.createBuffer(1, values.length, 16000); buffer.getChannelData(0).set(values);
        const source = audio.createBufferSource(); source.buffer = buffer; source.connect(destination);
        const finished = new Promise(resolve => { source.onended = () => { source.disconnect(); resolve(); }; });
        source.start(); await finished;
      };
      destination.stream.getAudioTracks()[0].addEventListener('ended', () => { void audio.close(); });
      return destination.stream;
    };
    const playback = new Set();
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], addEventListener() {}, removeEventListener() {},
      speak(utterance) {
        state.spoken.push(utterance.text); state.playbackStarts++;
        utterance.onstart?.(new Event('start'));
        const timer = setTimeout(() => { playback.delete(timer); state.playbackEnds++; utterance.onend?.(new Event('end')); }, 500);
        playback.add(timer);
      },
      cancel() { for (const timer of playback) clearTimeout(timer); playback.clear(); },
    } });
    document.addEventListener('click', event => {
      const button = event.target.closest?.('button');
      if (button?.classList.contains('orb-wake-button')) state.starts++;
      if (button?.textContent?.includes('Finish thought')) state.finishes++;
    });
  });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(safe(error.message)));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/audio') audioRequests.push(path);
    if (request.method() === 'POST' && /^\/api\/conversations\/[^/]+\/turns$/.test(path)) posts.push({ at: Date.now(), conversationId: path.split('/')[3], ...request.postDataJSON() });
  });
  page.on('response', async response => {
    if (response.request().method() === 'POST' && /\/turns$/.test(new URL(response.url()).pathname)) receipts.push(await response.json());
  });
  page.on('websocket', socket => {
    if (socket.url().includes('/api/audio')) audioRequests.push(socket.url());
    if (!socket.url().includes('/api/events')) return;
    socket.on('framereceived', ({ payload }) => {
      try { const event = JSON.parse(String(payload)); if (event.type === 'complete') terminal.set(event.turnId, event); } catch {}
    });
  });
  await page.goto(origin);
  await page.getByLabel('Password', { exact: true }).fill(access.password);
  await page.getByRole('button', { name: 'Enter your space' }).click();
  await expect(page.getByRole('button', { name: 'Wake NorthPointe', exact: true })).toBeEnabled({ timeout: 30000 });
  const created = await page.evaluate(async ({ expectedBuild }) => {
    const status = await (await fetch('/api/status')).json();
    if (!String(status.build).includes(expectedBuild)) throw Error('Unexpected deployed build.');
    const response = await fetch('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': status.csrfToken }, body: JSON.stringify({ title: `Synthetic automatic turns ${new Date().toISOString()}` }) });
    if (!response.ok) throw Error('Synthetic conversation creation failed.');
    const conversation = await response.json(); localStorage.setItem('vc2:conversation', conversation.id);
    return { conversationId: conversation.id, build: status.build };
  }, { expectedBuild });
  Object.assign(report, created);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Wake NorthPointe', exact: true })).toBeEnabled({ timeout: 30000 });
  await page.getByLabel('Message NorthPointe').fill('Synthetic Voice Connect automatic-turn test. The next two messages will contain only numbers from a public speech sample, not real user requests. Do not use tools, take external actions or save memory for this test. Reply READY now. For each of the following two number messages, reply only AUTO-TEST-ACK.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => receipts.length, { timeout: 30000 }).toBe(1);
  await expect.poll(() => terminal.has(receipts[0].turnId), { timeout: 120000 }).toBe(true);
  assert.ok(!terminal.get(receipts[0].turnId).failed && !terminal.get(receipts[0].turnId).cancelled);
  console.log('PASS synthetic prelude in the native conversation');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: /^Vosk/ }).click();
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible({ timeout: 120000 });
  await page.getByRole('checkbox', { name: /Hands-free turns|Automatic turns/ }).check();
  await page.getByRole('button', { name: 'Save preferences' }).click();
  const startedAt = Date.now();
  await page.getByRole('button', { name: 'Wake NorthPointe', exact: true }).click();
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible({ timeout: 120000 });
  await expect(page.getByRole('button', { name: 'Finish thought', exact: true })).toHaveCount(0);
  report.startupMs = Date.now() - startedAt;
  await page.waitForTimeout(2000);
  assert.equal(posts.length, 1, 'silence did not submit');
  report.turns = [];
  for (let turn = 1; turn <= 2; turn++) {
    const inputStartedAt = Date.now();
    await page.evaluate(values => window.__voiceAcceptance.feed(values), samples);
    await expect.poll(() => posts.length, { timeout: 20000 }).toBe(turn + 1);
    await expect.poll(() => receipts.length, { timeout: 10000 }).toBe(turn + 1);
    assert.match(posts[turn].text, /^one zero zero zero one[.!]?$/i, 'whole first phrase survived VAD and recognition drain');
    assert.equal(posts[turn].conversationId, created.conversationId);
    await expect.poll(() => terminal.has(receipts[turn].turnId), { timeout: 120000 }).toBe(true);
    assert.ok(!terminal.get(receipts[turn].turnId).cancelled && !terminal.get(receipts[turn].turnId).failed);
    await expect(page.getByText('Listening to you', { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('button', { name: 'Finish thought', exact: true })).toHaveCount(0);
    await page.waitForTimeout(1500);
    assert.equal(posts.length, turn + 1, 'no repeated submission during reply or following silence');
    report.turns.push({ text: posts[turn].text, submissionAfterSampleStartMs: posts[turn].at - inputStartedAt, returnedToListening: true });
    console.log(`PASS automatic turn ${turn}: real VAD/recognition -> native reply -> listening`);
  }
  const history = await page.evaluate(async id => (await fetch(`/api/conversations/${id}`)).json(), created.conversationId);
  assert.equal(history.messages.filter(message => message.role === 'user').length, 3);
  assert.equal(history.messages.filter(message => message.role === 'assistant' && /AUTO-TEST-ACK/.test(message.text)).length, 2);
  const lifecycle = await page.evaluate(() => { const { feed, ...counters } = window.__voiceAcceptance; return counters; });
  assert.equal(lifecycle.microphoneOpens, 1); assert.equal(lifecycle.starts, 1); assert.equal(lifecycle.finishes, 0);
  assert.ok(lifecycle.playbackStarts >= 2); assert.equal(lifecycle.playbackEnds, lifecycle.playbackStarts);
  assert.equal(audioRequests.length, 0); assert.deepEqual(errors, []);
  await page.getByRole('button', { name: 'End voice session' }).click();
  Object.assign(report, { ...lifecycle, voicePosts: 2, nativeHistoryUserTurns: 3, sameConversation: true, pageErrors: errors });
  await page.screenshot({ path: '.local/release-evidence/live-hands-free.png', fullPage: true });
  await writeFile('.local/release-evidence/live-hands-free.json', JSON.stringify(report, null, 2));
  console.log('PASS continuous automatic conversation', JSON.stringify(report));
} catch (error) {
  Object.assign(report, { failed: true, failure: safe(error.message), submittedTurns: posts.length, pageErrors: errors });
  await writeFile('.local/release-evidence/live-hands-free-failure.json', JSON.stringify(report, null, 2));
  if (page && report.conversationId) await page.screenshot({ path: '.local/release-evidence/live-hands-free-failure.png', fullPage: true }).catch(() => {});
  console.error(report.failure); process.exitCode = 1;
} finally { await browser.close(); }
