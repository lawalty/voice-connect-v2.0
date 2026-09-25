// Explicit live acceptance: one labeled native agent turn and paid Fish synthesis.
// Usage: node ops/verify-live-streaming.mjs <deployed-sha> <fish-voice-id>
// Uses no microphone and saves no generated PCM or transcript.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const [expected, voice] = process.argv.slice(2);
assert.match(expected || '', /^[a-f0-9]{40}$/);
assert.match(voice || '', /^[a-zA-Z0-9_-]{1,128}$/);
const access = JSON.parse(await readFile(process.env.VC_LIVE_CREDENTIAL_FILE || '.local/owner-access.json', 'utf8'));
assert.equal(access.origin, 'https://srv2003889.hstgr.cloud');
const bundle = await build({ stdin: { contents: "export { PremiumOutput } from './client/audio/output'; export { SentenceStream } from './client/audio/dsp';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', globalName: 'VCStreamingProbe', platform: 'browser' });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let context, conversation, csrf, turnId;
try {
  context = await browser.newContext({ baseURL: access.origin, extraHTTPHeaders: { Origin: access.origin } });
  const login = await context.request.post('/api/auth/login', { data: { password: access.password } });
  assert.equal(login.status(), 200); const status = await login.json(); csrf = status.csrfToken;
  assert.equal(status.build, expected);
  const settings = await (await context.request.get('/api/settings')).json();
  assert.equal(settings.fishConfigured, true); assert.equal(settings.harness.connected, true);
  const created = await context.request.post('/api/conversations', { headers: { 'X-CSRF-Token': csrf }, data: { title: 'QA: paced streaming speech' } });
  assert.equal(created.ok(), true); conversation = await created.json();
  const page = await context.newPage(); await page.goto('/');
  await page.evaluate(bundle.outputFiles[0].text + ';window.VCStreamingProbe=VCStreamingProbe;');
  turnId = crypto.randomUUID();
  const result = await page.evaluate(async ({ conversationId, voice, csrf, turnId }) => {
    const { PremiumOutput, SentenceStream } = window.VCStreamingProbe;
    const audio = new AudioContext(); await audio.resume();
    // The QA player advances on the real audio clock, with its local monitor muted.
    const monitor = audio.createGain(); monitor.gain.value = 0; monitor.connect(audio.destination);
    const began = performance.now();
    const report = { firstTextMs: null, firstChunkMs: null, firstPlaybackMs: null, responseDoneMs: null,
      playbackDoneMs: null, maxAheadSeconds: 0, audioSeconds: 0, nonzeroSamples: 0, chunks: 0, characters: 0 };
    const traced = {
      get currentTime() { return audio.currentTime; }, get state() { return audio.state; }, destination: monitor,
      createBuffer: audio.createBuffer.bind(audio), createBufferSource() {
        const source = audio.createBufferSource(), start = source.start.bind(source);
        source.start = time => {
          report.maxAheadSeconds = Math.max(report.maxAheadSeconds, time + source.buffer.duration - audio.currentTime);
          report.audioSeconds += source.buffer.duration;
          for (const value of source.buffer.getChannelData(0)) if (Math.abs(value) > 0.001) report.nonzeroSamples++;
          start(time);
        };
        return source;
      },
    };
    let finished, failed;
    const completion = new Promise((resolve, reject) => { finished = resolve; failed = reject; });
    const output = new PremiumOutput(traced, conversationId, voice, {
      started() { report.firstPlaybackMs ??= performance.now() - began; },
      ended() { report.playbackDoneMs = performance.now() - began; finished(); }, error: message => failed(new Error(message)),
    });
    const sentences = new SentenceStream(); let full = '', sequence = -1, done = false;
    const enqueue = pieces => { for (const piece of pieces) { report.firstChunkMs ??= performance.now() - began; report.chunks++; output.enqueue(piece); } };
    const url = new URL('/api/events', location.href); url.protocol = 'wss:'; url.searchParams.set('conversationId', conversationId);
    const socket = new WebSocket(url);
    const ready = new Promise((resolve, reject) => {
      socket.onerror = () => reject(new Error('Native event connection failed'));
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'hello') resolve();
        if (message.turnId !== turnId) return;
        if (message.type === 'assistant' && message.seq > sequence && !done) {
          sequence = message.seq; report.firstTextMs ??= performance.now() - began;
          const next = message.replace ? message.text : full + message.text;
          if (next.startsWith(full)) enqueue(sentences.append(next.slice(full.length)));
          full = next;
        } else if (message.type === 'complete' && !done) {
          if (message.failed || message.cancelled) { failed(new Error('Native test turn failed')); return; }
          done = true; report.responseDoneMs = performance.now() - began;
          if (message.text?.startsWith(full)) enqueue(sentences.append(message.text.slice(full.length)));
          report.characters = (message.text || full).length; enqueue(sentences.finish()); output.finish();
        }
      };
    });
    const timeout = setTimeout(() => failed(new Error('Streaming acceptance timed out')), 240000);
    try {
      await ready;
      const receipt = await fetch(`/api/conversations/${conversationId}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ id: turnId,
        text: 'Synthetic Voice Connect streaming QA. Do not use tools, contact anyone, change files, or save memories. Write a calm fictional description of an imaginary garden in exactly twenty complete sentences, about 350 words total. Begin the answer immediately with the first sentence. Plain prose only; no headings, lists, or discussion of this test.' }) });
      if (!receipt.ok) throw new Error('Native test submission failed');
      await completion; return report;
    } finally { clearTimeout(timeout); output.dispose(); socket.close(); await audio.close(); }
  }, { conversationId: conversation.id, voice, csrf, turnId });
  assert.ok(result.nonzeroSamples > 24000); assert.ok(result.audioSeconds > 60);
  assert.ok(result.firstPlaybackMs < result.responseDoneMs, 'Speech begins before native response completion');
  assert.ok(result.maxAheadSeconds <= 4.1, 'Actual browser playback remains bounded');
  const evidence = { time: new Date().toISOString(), build: expected, conversationId: conversation.id, turnId, ...result,
    physicalAndroidAudibility: false, monitorMuted: true, microphoneUsed: false, audioRetained: false };
  await mkdir('.local/release-evidence', { recursive: true });
  await writeFile(`.local/release-evidence/streaming-${expected}.json`, JSON.stringify(evidence, null, 2));
  console.log('PASS native OpenClaw -> coherent chunks -> live Fish -> paced browser playback', JSON.stringify(evidence));
} finally {
  if (context && conversation && turnId) await context.request.post(`/api/conversations/${conversation.id}/turns/${turnId}/abort`, { headers: { 'X-CSRF-Token': csrf } }).catch(() => {});
  await browser.close();
}
