import WebSocket from 'ws';
import { decode, encode } from '@msgpack/msgpack';
import type { AudioEvent } from '../contract/types.js';
import { PCM_RATE, PLAYBACK_FRAME_BYTES, PLAYBACK_WINDOW_BYTES } from '../contract/audio-flow.js';

type RemoteFactory = (url: string, options: WebSocket.ClientOptions) => WebSocket;
const MAX_FRAME = 2 * 1024 * 1024;
const MAX_PENDING_AUDIO = MAX_FRAME * 2;

/** One Fish synthesis session per reply; credentials never cross the browser boundary. */
export function bridgeFishAudio(
  client: WebSocket, key: string, voice: string, authorized: () => boolean,
  remoteFactory: RemoteFactory = (url, options) => new WebSocket(url, options),
): void {
  let remote: WebSocket | undefined;
  let ended = false, ready = false, inputEnded = false, textChars = 0, audioBytes = 0;
  let paced = false, paused = false, providerDone = false, sentBytes = 0, playedBytes = 0;
  let pendingBytes = 0;
  const pending: Buffer[] = [];
  let headOffset = 0;
  let trailing: Buffer | undefined;
  let audioTimer: ReturnType<typeof setTimeout> | undefined;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let playbackTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const canUse = () => { try { return authorized(); } catch { return false; } };
  const send = (event: AudioEvent) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event)); };
  const clean = () => {
    clearTimeout(connectTimer); clearTimeout(audioTimer); clearTimeout(finishTimer); clearTimeout(playbackTimer); clearTimeout(idleTimer); clearInterval(authTimer);
    trailing = undefined; pending.length = 0; pendingBytes = 0;
  };
  const closeRemote = () => {
    // A paused receiver cannot consume the peer's close frame.
    if (paused) { remote?.resume(); paused = false; }
    if (remote && (remote.readyState === WebSocket.OPEN || remote.readyState === WebSocket.CONNECTING)) remote.close();
  };
  const fail = (message: string) => {
    if (ended) return;
    ended = true; clean(); send({ type: 'error', message }); closeRemote();
    client.close(1011, 'Speech connection ended');
  };
  const checkAuth = () => {
    if (ended) return false;
    if (!canUse()) { fail('Your sign-in expired. Sign in again.'); return false; }
    return true;
  };
  const connectTimer = setTimeout(() => fail('Fish Audio did not connect. Check your key or choose Browser speech.'), 15000);
  const authTimer = setInterval(checkAuth, 20000);
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail('The voice stream became inactive. Please reconnect voice.'), 10 * 60 * 1000);
  };
  const armAudioTimer = () => {
    clearTimeout(audioTimer);
    if (!paused && !providerDone) audioTimer = setTimeout(() => fail('Fish Audio stopped sending speech. The full reply remains available as text.'), 30000);
  };
  const armFinishTimer = () => {
    clearTimeout(finishTimer);
    if (inputEnded && !paused && !providerDone) finishTimer = setTimeout(() => fail('Fish Audio did not finish the reply. The full text is preserved.'), 45000);
  };
  const drain = () => {
    if (ended) return;
    while (pending.length && client.readyState === WebSocket.OPEN) {
      const credit = paced ? PLAYBACK_WINDOW_BYTES - (sentBytes - playedBytes) : PLAYBACK_FRAME_BYTES;
      if (credit <= 0) break;
      if (client.bufferedAmount > MAX_FRAME) { fail('The voice connection stopped draining audio. Please reconnect voice.'); return; }
      const head = pending[0]!;
      const count = Math.min(credit, PLAYBACK_FRAME_BYTES, head.length - headOffset);
      client.send(head.subarray(headOffset, headOffset + count), { binary: true });
      headOffset += count; pendingBytes -= count; sentBytes += count;
      if (headOffset === head.length) { pending.shift(); headOffset = 0; }
    }
    if (providerDone && !pending.length) {
      ended = true; clean(); send({ type: 'speech-done' }); closeRemote(); client.close(1000, 'Speech complete'); return;
    }
    const blocked = paced && sentBytes - playedBytes >= PLAYBACK_WINDOW_BYTES;
    if (blocked && !paused) {
      paused = true; remote?.pause(); clearTimeout(audioTimer); clearTimeout(finishTimer);
    } else if (!blocked && paused) {
      paused = false; remote?.resume(); if (inputEnded) { armAudioTimer(); armFinishTimer(); }
    }
    if (blocked && !playbackTimer) playbackTimer = setTimeout(() => fail('Your device stopped advancing audio playback. Please reconnect voice.'), 30000);
    if (!blocked) { clearTimeout(playbackTimer); playbackTimer = undefined; }
  };
  const upstream = (event: Record<string, unknown>, done?: () => void): boolean => {
    if (ended || !remote || remote.readyState !== WebSocket.OPEN) { fail('Fish Audio is no longer connected. The reply remains available as text.'); return false; }
    if (remote.bufferedAmount > 256 * 1024) { fail('Speech upload could not keep up. Read the remaining text.'); return false; }
    try {
      remote.send(encode(event), { binary: true }, error => {
        if (ended) return;
        if (error) fail('Fish Audio could not receive this reply. Read the remaining text.');
        else done?.();
      });
      return !ended;
    } catch { fail('Fish Audio could not receive this reply. Read the remaining text.'); return false; }
  };
  const rawBytes = (data: WebSocket.RawData) => Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);

  client.on('message', (data, binary) => {
    if (!checkAuth()) return;
    if (!ready) { fail('Fish Audio is not ready. Try the voice again.'); return; }
    const bytes = rawBytes(data);
    if (binary || bytes.length > 24000) { fail('Unsupported speech control.'); return; }
    let control: Record<string, unknown>;
    try { control = JSON.parse(bytes.toString()); } catch { fail('Invalid speech control.'); return; }
    if (!control || typeof control !== 'object' || Array.isArray(control)) { fail('Invalid speech control.'); return; }
    if (control.type === 'interrupt') {
      // Fish's stop event drains synthesis. Cancellation instead closes its socket.
      ended = true; clean(); closeRemote(); send({ type: 'interrupted' }); client.close(1000, 'Speech interrupted');
    } else if (control.type === 'playback') {
      if (!Number.isSafeInteger(control.playedBytes) || (control.playedBytes as number) % 2 || (control.playedBytes as number) < playedBytes || (control.playedBytes as number) > sentBytes || (!paced && sentBytes !== 0)) {
        fail('Invalid playback progress. Please reconnect voice.'); return;
      }
      const progressed = (control.playedBytes as number) > playedBytes;
      paced = true; playedBytes = control.playedBytes as number;
      if (progressed) { clearTimeout(playbackTimer); playbackTimer = undefined; touch(); }
      drain();
    } else if (control.type === 'speak' && typeof control.text === 'string' && control.text.trim() && control.text.length <= 4000 && !inputEnded) {
      textChars += control.text.length;
      touch();
      // The client supplies coherent chunks. Flush allows the first sentence to
      // play before the complete assistant answer exists.
      if (upstream({ event: 'text', text: control.text }) && upstream({ event: 'flush' })) armAudioTimer();
    } else if (control.type === 'flush') {
      if (inputEnded) return;
      inputEnded = true;
      touch(); if (upstream({ event: 'stop' })) armFinishTimer();
    } else fail('Unsupported speech control.');
  });
  client.on('error', () => { if (!ended) { ended = true; clean(); closeRemote(); } });
  client.on('close', () => { if (!ended) { ended = true; clean(); closeRemote(); } });
  if (!checkAuth()) return;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(voice)) { fail('The Fish Audio voice ID is invalid. Update it in settings.'); return; }
  try {
    remote = remoteFactory('wss://api.fish.audio/v1/tts/live', {
      headers: { Authorization: `Bearer ${key}`, model: 's2.1-pro' },
      maxPayload: MAX_FRAME, perMessageDeflate: false, handshakeTimeout: 10000,
    });
  } catch { fail('Fish Audio is unavailable. Check your key or choose Browser speech.'); return; }
  remote.on('open', () => {
    if (!checkAuth()) return;
    upstream({ event: 'start', request: { text: '', reference_id: voice, format: 'pcm', sample_rate: 24000, latency: 'balanced', chunk_length: 200 } }, () => {
      if (!checkAuth()) return;
      // This protocol has no ready acknowledgement; report transport readiness
      // only after the required start frame has been handed to the socket.
      ready = true; clearTimeout(connectTimer); touch(); send({ type: 'ready', sampleRate: PCM_RATE, playbackWindowBytes: PLAYBACK_WINDOW_BYTES });
    });
  });
  remote.on('message', (data, binary) => {
    if (!checkAuth()) return;
    const bytes = rawBytes(data);
    if (!binary || bytes.length > MAX_FRAME) { fail('Fish Audio returned unsupported speech data.'); return; }
    let event: Record<string, unknown>;
    try {
      const value = decode(bytes, { maxStrLength: 16000, maxBinLength: MAX_FRAME, maxArrayLength: 32, maxMapLength: 32, maxExtLength: 0 });
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid event');
      event = value as Record<string, unknown>;
    } catch { fail('Fish Audio returned unreadable speech data.'); return; }
    if (event.event === 'audio') {
      if (!(event.audio instanceof Uint8Array)) { fail('Fish Audio returned unsupported audio.'); return; }
      audioBytes += event.audio.byteLength;
      if (!event.audio.byteLength) return;
      touch(); clearTimeout(audioTimer); audioTimer = undefined; armFinishTimer();
      const pcm = trailing ? Buffer.concat([trailing, event.audio]) : Buffer.from(event.audio);
      const evenLength = pcm.length - pcm.length % 2;
      trailing = evenLength === pcm.length ? undefined : Buffer.from(pcm.subarray(evenLength));
      if (evenLength) { pending.push(pcm.subarray(0, evenLength)); pendingBytes += evenLength; }
      // ws.pause applies transport backpressure. Allow an already decoded frame
      // to arrive after pausing, but never accumulate a whole reply in memory.
      if (pendingBytes > MAX_PENDING_AUDIO) { fail('The voice provider exceeded its audio transport budget. Please reconnect voice.'); return; }
      drain();
    } else if (event.event === 'finish') {
      if (event.reason !== 'stop' || !inputEnded || trailing || (textChars > 0 && audioBytes === 0)) { fail('Fish Audio could not complete this reply. The full text is preserved.'); return; }
      providerDone = true; clearTimeout(audioTimer); clearTimeout(finishTimer); drain();
    } else if (event.event === 'error') fail('Fish Audio could not generate this reply. Check your voice and key in settings.');
  });
  remote.on('error', () => fail('Fish Audio is unavailable. Check your key or choose Browser speech.'));
  remote.on('close', () => { if (!ended && !providerDone) fail('Fish Audio disconnected before the reply finished. The full text is preserved.'); });
}
