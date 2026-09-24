// Bounded production acceptance: verified prerecorded WAV -> Vosk -> one native
// NorthPointe turn. Credentials stay in process memory; no real microphone or paid speech API.
// Usage: node ops/verify-live-voice.mjs <expected-deployed-revision>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const ORIGIN = 'https://srv2003889.hstgr.cloud';
const EXPECTED_BUILD = process.env.VC_EXPECTED_BUILD || process.argv[2];
assert.ok(EXPECTED_BUILD, 'Pass the expected deployed revision as an argument or VC_EXPECTED_BUILD.');
const fixture = await readFile('.local/audio-check/test.wav');
const fixtureSha256 = createHash('sha256').update(fixture).digest('hex');
assert.equal(fixtureSha256, 'dcfea5712c43a43ba7ae8083afb39d36993e5a69c46e88b68aaa72b65cb615bb', 'official Vosk fixture integrity');
assert.equal(fixture.toString('ascii', 0, 4), 'RIFF');
assert.equal(fixture.toString('ascii', 8, 12), 'WAVE');
let format, data;
for (let offset = 12; offset + 8 <= fixture.length;) {
  const type = fixture.toString('ascii', offset, offset + 4), bytes = fixture.readUInt32LE(offset + 4);
  assert.ok(offset + 8 + bytes <= fixture.length, 'valid WAV chunk bounds');
  if (type === 'fmt ') format = fixture.subarray(offset + 8, offset + 8 + bytes);
  if (type === 'data') data = fixture.subarray(offset + 8, offset + 8 + bytes);
  offset += 8 + bytes + bytes % 2;
}
assert.ok(format && data); assert.equal(format.readUInt16LE(0), 1); assert.equal(format.readUInt16LE(2), 1);
assert.equal(format.readUInt32LE(4), 16000); assert.equal(format.readUInt16LE(14), 16);
// Fake capture begins as soon as permission opens. Startup silence ensures the
// checked utterance starts after the real Worklet/VAD/model readiness boundary.
const leadingSilenceMs = 20000, trailingSilenceMs = 5000;
const pcm = Buffer.concat([Buffer.alloc(16000 * 2 * leadingSilenceMs / 1000), data, Buffer.alloc(16000 * 2 * trailingSilenceMs / 1000)]);
const wav = Buffer.alloc(44 + pcm.length);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
await mkdir('.local/audio-check', { recursive: true }); await mkdir('.local/release-evidence', { recursive: true });
const capturePath = resolve('.local/audio-check/live-number-capture.wav'); await writeFile(capturePath, wav);
const access = JSON.parse(await readFile(process.env.VC_LIVE_CREDENTIAL_FILE || '.local/owner-access.json', 'utf8'));
assert.equal(access.origin, ORIGIN, 'authorized destination');
const safeError = (value) => String(value).split(String(access.password)).join('[redacted]');
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${capturePath}`] });
const report = { time: new Date().toISOString(), expectedBuild: EXPECTED_BUILD, fixtureSha256, leadingSilenceMs, trailingSilenceMs,
  synthetic: true, realMicrophone: false, premiumSpeech: false,
  limit: 'Desktop Chromium with a prerecorded fake microphone; physical Android/car/Bluetooth, audible playback, and live premium speech are not qualified.' };
let page, syntheticConversationId, voiceReceipt, preludeReceipt;
const pageErrors = [], turnRequests = [], terminal = new Map(), requests = [];
try {
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 960 } });
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(safeError(error.message)));
  page.on('request', (request) => {
    if (request.url().includes('/api/audio')) requests.push(new URL(request.url()).searchParams.get('kind'));
    if (request.method() !== 'POST' || !/\/api\/conversations\/[^/]+\/turns$/.test(new URL(request.url()).pathname)) return;
    const value = request.postDataJSON();
    turnRequests.push({ conversationId: new URL(request.url()).pathname.split('/')[3], id: value.id, text: value.text });
  });
  page.on('websocket', (socket) => {
    if (socket.url().includes('/api/audio')) requests.push(new URL(socket.url()).searchParams.get('kind'));
    if (!socket.url().includes('/api/events')) return;
    socket.on('framereceived', ({ payload }) => {
      try { const event = JSON.parse(String(payload)); if (event.type === 'complete') terminal.set(event.turnId, { conversationId: event.conversationId, cancelled: Boolean(event.cancelled), failed: Boolean(event.failed) }); } catch {}
    });
  });
  const response = await page.goto(ORIGIN);
  expect(response.headers()['content-security-policy']).not.toContain("'unsafe-eval'");
  await page.getByLabel('Password', { exact: true }).fill(access.password);
  await page.getByRole('button', { name: 'Enter your space' }).click();
  await expect(page.getByRole('button', { name: 'Start talking' })).toBeEnabled({ timeout: 30000 });
  const created = await page.evaluate(async ({ expected, title }) => {
    const status = await (await fetch('/api/status')).json();
    if (!String(status.build).includes(expected)) throw new Error('Deployment changed before synthetic acceptance.');
    const response = await fetch('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': status.csrfToken }, body: JSON.stringify({ title }) });
    if (!response.ok) throw new Error('Could not create the synthetic acceptance conversation.');
    const conversation = await response.json(); localStorage.setItem('vc2:conversation', conversation.id);
    return { id: conversation.id, build: status.build, title: conversation.title };
  }, { expected: EXPECTED_BUILD, title: `Synthetic voice acceptance ${new Date().toISOString()}` });
  syntheticConversationId = created.id; Object.assign(report, { conversationId: created.id, build: created.build, title: created.title });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Start talking' })).toBeEnabled({ timeout: 30000 });
  const prelude = 'Synthetic Voice Connect acceptance test only. The next message will be a prerecorded public speech-recognition number test, not a real user request. Do not use tools, take external actions, or save any memory for either test message. Reply READY now. After the following number recording, reply VOICE-TEST-ACK and briefly repeat the recognized numbers; do nothing else.';
  await page.getByLabel('Message NorthPointe').fill(prelude);
  const preludeResponse = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/conversations/${created.id}/turns`));
  await page.getByRole('button', { name: 'Send message' }).click();
  preludeReceipt = await (await preludeResponse).json();
  await expect.poll(() => terminal.has(preludeReceipt.turnId), { timeout: 120000 }).toBe(true);
  assert.deepEqual(terminal.get(preludeReceipt.turnId), { conversationId: created.id, cancelled: false, failed: false });
  assert.equal(turnRequests.length, 1, 'only the synthetic prelude was sent');
  console.log('PASS synthetic text prelude completed in the new native conversation');

  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: /On this device/ }).click();
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible({ timeout: 120000 });
  await page.getByRole('combobox').filter({ has: page.locator('option[value="browser"]') }).selectOption('browser');
  await page.getByRole('checkbox', { name: /Hands-free turns/ }).uncheck();
  await page.getByRole('button', { name: 'Save preferences' }).click();
  const startedAt = Date.now();
  await page.getByRole('button', { name: 'Start talking' }).click();
  await expect(page.getByText('Listening to you', { exact: true })).toBeVisible({ timeout: 120000 });
  report.captureStartupMs = Date.now() - startedAt;
  assert.ok(report.captureStartupMs < leadingSilenceMs - 2000, 'readiness occurred before the prerecorded utterance began');
  const heard = page.locator('.heard-draft p');
  await expect(heard).toContainText('zero one eight zero three', { timeout: 65000 });
  const draft = (await heard.innerText()).trim();
  assert.match(draft, /^one zero zero zero one\b/, 'leading words survived controlled capture');
  assert.match(draft, /zero one eight zero three$/, 'complete prerecorded ending is present');
  assert.equal(turnRequests.length, 1, 'partial transcripts were never submitted');
  const voiceResponse = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/conversations/${created.id}/turns`));
  await page.getByRole('button', { name: 'Finish thought' }).click();
  const responseAt = Date.now(); voiceReceipt = await (await voiceResponse).json();
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await expect.poll(() => terminal.has(voiceReceipt.turnId), { timeout: 120000 }).toBe(true);
  assert.deepEqual(terminal.get(voiceReceipt.turnId), { conversationId: created.id, cancelled: false, failed: false });
  report.voiceCompletionMs = Date.now() - responseAt;
  const voiceRequests = turnRequests.filter((request) => request.id === voiceReceipt.turnId);
  assert.equal(turnRequests.length, 2, 'one text prelude and exactly one voice submission');
  assert.equal(voiceRequests.length, 1, 'voice turn was submitted once');
  assert.equal(voiceRequests[0].conversationId, created.id, 'voice shares the typed conversation');
  assert.match(voiceRequests[0].text, /^one zero zero zero one\b/); assert.match(voiceRequests[0].text, /zero one eight zero three$/);
  assert.equal(requests.length, 0, 'no premium speech connection was requested');
  const history = await page.evaluate(async (id) => (await fetch(`/api/conversations/${id}`)).json(), created.id);
  const userTurns = history.messages.filter((message) => message.role === 'user');
  assert.equal(userTurns.length, 2, 'native history contains both synthetic user turns exactly once');
  assert.equal(userTurns.filter((message) => message.text === voiceRequests[0].text).length, 1);
  assert.ok(history.messages.some((message) => message.role === 'assistant' && /VOICE-TEST-ACK/i.test(message.text)), 'NorthPointe acknowledged the prerecorded utterance');
  report.voiceText = voiceRequests[0].text;
  Object.assign(report, { textPreludePosts: 1, voicePosts: 1, sharedConversation: true, nativeHistoryUserTurns: userTurns.length, voiceCompleted: true, nativeAcknowledgement: true, pageErrors });
  await page.getByRole('button', { name: 'End voice session' }).click();
  await page.screenshot({ path: '.local/release-evidence/live-voice.png', fullPage: true });
  assert.deepEqual(pageErrors, []);
  await writeFile('.local/release-evidence/live-voice.json', JSON.stringify(report, null, 2));
  console.log('PASS prerecorded voice -> complete turn -> native NorthPointe -> same conversation', JSON.stringify(report));
} catch (error) {
  Object.assign(report, { failed: true, failure: safeError(error instanceof Error ? error.message : 'Synthetic voice test failed'), conversationId: syntheticConversationId, submittedTurns: turnRequests.length, voiceReceipt: voiceReceipt?.turnId, pageErrors });
  await writeFile('.local/release-evidence/live-voice-failure.json', JSON.stringify(report, null, 2));
  if (page && syntheticConversationId) await page.screenshot({ path: '.local/release-evidence/live-voice-failure.png', fullPage: true }).catch(() => {});
  console.error('Synthetic voice acceptance failed:', report.failure);
  process.exitCode = 1;
} finally { await browser.close(); }
