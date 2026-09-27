import WebSocket from 'ws';
import type { HostModelStatus } from '../contract/types.js';

export class VoskHost {
  constructor(private url: string, private token: string) {}
  async request(path: '/status' | '/install' | '/model', method = 'GET'): Promise<HostModelStatus> {
    if (!this.token) throw new Error('Host Vosk service is not configured.');
    const response = await fetch(new URL(path, this.url), { method, headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw Object.assign(new Error(response.status === 409 ? 'Stop voice on all devices before removing the host model.' : 'The host Vosk service is unavailable.'), { statusCode: response.status === 409 ? 409 : 503 });
    const data = await response.json() as HostModelStatus;
    return { id: data.id, installed: data.installed === true, state: data.state, bytes: data.bytes, received: data.received, error: data.error };
  }
  async status(): Promise<HostModelStatus> {
    try { return await this.request('/status'); }
    catch { return { id: 'vosk-model-en-us-0.22-lgraph', installed: false, state: 'unavailable', bytes: 130557655, received: 0, error: 'The host speech service is unavailable.' }; }
  }
  bridge(client: WebSocket, authorized: () => boolean) {
    const url = new URL('/recognize', this.url); url.protocol = 'ws:';
    const remote = new WebSocket(url, { headers: { Authorization: `Bearer ${this.token}` }, perMessageDeflate: false, maxPayload: 128 * 1024, handshakeTimeout: 10000 });
    let ready = false, ended = false, outstanding = 0;
    const send = (event: object) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event)); };
    const fail = (message: string) => {
      if (ended) return; ended = true; clearTimeout(timer);
      send({ type: 'error', message }); client.close(1011, 'Host speech ended'); remote.terminate();
    };
    const timer = setTimeout(() => fail('Host Vosk did not become ready. Check its installation in Settings.'), 15000);
    remote.on('error', () => fail('Host Vosk disconnected. Your draft is preserved; restart voice when connected.'));
    remote.on('unexpected-response', (_request, response) => { response.resume(); response.destroy(); fail(response.statusCode === 429 ? 'Two devices are already using Vosk. End one voice session and retry.' : 'Install Vosk lgraph on the host in Settings before starting voice.'); });
    remote.on('close', () => { if (!ended) fail('Host Vosk disconnected. Your draft is preserved.'); });
    remote.on('message', (raw, binary) => {
      if (ended || !authorized()) { fail('Your sign-in expired. Sign in again.'); return; }
      if (binary) return;
      let event: any; try { event = JSON.parse(raw.toString()); } catch { fail('Invalid host speech response.'); return; }
      if (event.type === 'ready') { ready = true; clearTimeout(timer); send({ type: 'ready', sampleRate: 16000 }); }
      else if (event.type === 'stt' && typeof event.text === 'string') send({ type: 'stt', text: event.text.slice(0, 20000), final: event.final === true, turnComplete: false });
      else if (event.type === 'finished' && Number.isSafeInteger(event.id)) send({ type: 'finished', id: event.id });
      else if (event.type === 'ack' && Number.isSafeInteger(event.bytes) && event.bytes > 0) { outstanding = Math.max(0, outstanding - event.bytes); send({ type: 'ack', bytes: event.bytes }); }
      else if (event.type === 'error') fail('Host recognition stopped. Your draft is preserved.');
    });
    client.on('message', (data, binary) => {
      if (!authorized()) { fail('Your sign-in expired. Sign in again.'); return; }
      if (ended) return;
      if (!ready || remote.readyState !== WebSocket.OPEN) { fail('Host speech is not ready.'); return; }
      if (binary) {
        const size = Array.isArray(data) ? data.reduce((n, part) => n + part.length, 0) : data instanceof ArrayBuffer ? data.byteLength : data.length;
        outstanding += size;
        if (size % 2 || size <= 0 || size > 64000 || outstanding > 128000 || remote.bufferedAmount > 128000) { fail('Host recognition cannot keep up. Your draft is preserved.'); return; }
        remote.send(data, { binary: true });
      } else {
        let event: any; try { event = JSON.parse(data.toString()); } catch { fail('Invalid speech control.'); return; }
        if (event.type !== 'finish' || !Number.isSafeInteger(event.id)) { fail('Unsupported speech control.'); return; }
        remote.send(JSON.stringify({ type: 'finish', id: event.id }));
      }
    });
    client.on('error', () => {});
    client.on('close', () => { ended = true; clearTimeout(timer); remote.terminate(); });
  }
}
