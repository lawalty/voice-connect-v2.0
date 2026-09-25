import WebSocket from 'ws';
import { decode, encode } from '@msgpack/msgpack';
import type { AudioEvent } from '../contract/types.js';

type RemoteFactory = (url: string, options: WebSocket.ClientOptions) => WebSocket;
const MAX_FRAME = 2 * 1024 * 1024;
const MAX_AUDIO = 32 * 1024 * 1024;

/** One Fish synthesis session per reply; credentials never cross the browser boundary. */
export function bridgeFishAudio(
  client: WebSocket, key: string, voice: string, authorized: () => boolean,
  remoteFactory: RemoteFactory = (url, options) => new WebSocket(url, options),
): void {
  let remote: WebSocket | undefined;
  let ended = false, ready = false, inputEnded = false, textChars = 0, audioBytes = 0;
  let trailing: Buffer | undefined;
  let audioTimer: ReturnType<typeof setTimeout> | undefined;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  const canUse = () => { try { return authorized(); } catch { return false; } };
  const send = (event: AudioEvent) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event)); };
  const clean = () => {
    clearTimeout(connectTimer); clearTimeout(sessionTimer); clearTimeout(audioTimer); clearTimeout(finishTimer); clearInterval(authTimer);
    trailing = undefined;
  };
  const closeRemote = () => {
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
  const sessionTimer = setTimeout(() => fail('This spoken reply reached its time limit. Read the remaining text.'), 5 * 60 * 1000);
  const authTimer = setInterval(checkAuth, 20000);
  const armAudioTimer = () => {
    clearTimeout(audioTimer);
    audioTimer = setTimeout(() => fail('Fish Audio stopped sending speech. The full reply remains available as text.'), 30000);
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
    } else if (control.type === 'speak' && typeof control.text === 'string' && control.text.trim() && control.text.length <= 4000 && !inputEnded) {
      textChars += control.text.length;
      if (textChars > 30000) { fail('Speech reply is too long. Read the remaining text.'); return; }
      // The client supplies coherent chunks. Flush allows the first sentence to
      // play before the complete assistant answer exists.
      if (upstream({ event: 'text', text: control.text }) && upstream({ event: 'flush' }) && !audioTimer) armAudioTimer();
    } else if (control.type === 'flush') {
      if (inputEnded) return;
      inputEnded = true;
      if (upstream({ event: 'stop' })) finishTimer = setTimeout(() => fail('Fish Audio did not finish the reply. The full text is preserved.'), 45000);
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
      ready = true; clearTimeout(connectTimer); send({ type: 'ready', sampleRate: 24000 });
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
      if (audioBytes > MAX_AUDIO || client.bufferedAmount > MAX_FRAME) { fail('Audio playback could not keep up. Read the remaining text.'); return; }
      if (!event.audio.byteLength) return;
      armAudioTimer();
      const pcm = trailing ? Buffer.concat([trailing, event.audio]) : Buffer.from(event.audio);
      const evenLength = pcm.length - pcm.length % 2;
      trailing = evenLength === pcm.length ? undefined : Buffer.from(pcm.subarray(evenLength));
      if (evenLength && client.readyState === WebSocket.OPEN) client.send(pcm.subarray(0, evenLength), { binary: true });
    } else if (event.event === 'finish') {
      if (event.reason !== 'stop' || !inputEnded || trailing || (textChars > 0 && audioBytes === 0)) { fail('Fish Audio could not complete this reply. The full text is preserved.'); return; }
      ended = true; clean(); send({ type: 'speech-done' }); closeRemote(); client.close(1000, 'Speech complete');
    } else if (event.event === 'error') fail('Fish Audio could not generate this reply. Check your voice and key in settings.');
  });
  remote.on('error', () => fail('Fish Audio is unavailable. Check your key or choose Browser speech.'));
  remote.on('close', () => { if (!ended) fail('Fish Audio disconnected before the reply finished. The full text is preserved.'); });
}
