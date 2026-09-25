import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { decode, encode } from '@msgpack/msgpack';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeFishAudio } from '../service/fish';

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: { data: string | Uint8Array; binary: boolean }[] = [];
  close = vi.fn(() => { this.readyState = WebSocket.CLOSED; this.emit('close'); });
  send(data: string | Uint8Array, options?: { binary?: boolean }, callback?: (error?: Error) => void) {
    this.sent.push({ data, binary: options?.binary ?? false }); callback?.();
  }
  control(value: object) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  provider(value: object) { this.emit('message', Buffer.from(encode(value)), true); }
  frames() { return this.sent.filter(item => item.binary).map(item => decode(item.data as Uint8Array) as Record<string, unknown>); }
  events() { return this.sent.filter(item => !item.binary).map(item => JSON.parse(item.data as string) as Record<string, unknown>); }
  pcm() { return Buffer.concat(this.sent.filter(item => item.binary).map(item => Buffer.from(item.data))); }
}
function fixture(voice = 'test_voice-123') {
  const client = new Socket(), remote = new Socket(); remote.readyState = WebSocket.CONNECTING;
  let allowed = true;
  const factory = vi.fn((_url: string, _options: WebSocket.ClientOptions) => remote as unknown as WebSocket);
  bridgeFishAudio(client as unknown as WebSocket, 'test-private-api-key', voice, () => allowed, factory);
  return { client, remote, factory, revoke: () => { allowed = false; }, open: () => { remote.readyState = WebSocket.OPEN; remote.emit('open'); } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('Fish Audio authenticated streaming bridge', () => {
  it('uses binary configuration, streams before completion, and drains only after the final flush', () => {
    const f = fixture(); expect(f.client.events()).toEqual([]); f.open();
    expect(f.factory).toHaveBeenCalledWith('wss://api.fish.audio/v1/tts/live', expect.objectContaining({ headers: { Authorization: 'Bearer test-private-api-key', model: 's2.1-pro' }, maxPayload: 2097152 }));
    expect(f.remote.frames()[0]).toEqual({ event: 'start', request: { text: '', reference_id: 'test_voice-123', format: 'pcm', sample_rate: 24000, latency: 'balanced', chunk_length: 200 } });
    expect(f.client.events()).toEqual([{ type: 'ready', sampleRate: 24000 }]);
    f.client.control({ type: 'speak', text: 'First coherent sentence.' });
    expect(f.remote.frames().slice(1)).toEqual([{ event: 'text', text: 'First coherent sentence.' }, { event: 'flush' }]);
    f.remote.provider({ event: 'audio', audio: Uint8Array.of(0x34) });
    f.remote.provider({ event: 'audio', audio: Uint8Array.of(0x12, 0xfe, 0xff) });
    expect(f.client.pcm()).toEqual(Buffer.from([0x34, 0x12, 0xfe, 0xff]));
    expect(f.client.events()).not.toContainEqual({ type: 'speech-done' });
    f.client.control({ type: 'speak', text: 'Second sentence.' }); f.client.control({ type: 'flush' }); f.client.control({ type: 'flush' });
    expect(f.remote.frames().filter(frame => frame.event === 'stop')).toHaveLength(1);
    f.remote.provider({ event: 'finish', reason: 'stop' });
    expect(f.client.events().at(-1)).toEqual({ type: 'speech-done' });
    expect(f.client.close).toHaveBeenCalledWith(1000, 'Speech complete'); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels by closing upstream without draining, and ignores late audio and success', () => {
    const f = fixture(); f.open(); f.client.control({ type: 'speak', text: 'Interrupted reply.' });
    f.client.control({ type: 'interrupt', offsetMs: 30 });
    expect(f.remote.close).toHaveBeenCalledOnce(); expect(f.remote.frames().some(frame => frame.event === 'stop')).toBe(false);
    f.remote.provider({ event: 'audio', audio: Uint8Array.of(0, 1) }); f.remote.provider({ event: 'finish', reason: 'stop' });
    expect(f.client.pcm()).toHaveLength(0); expect(f.client.events().at(-1)).toEqual({ type: 'interrupted' }); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['provider-error', 'early-close', 'truncated-pcm', 'no-audio', 'bad-msgpack', 'bad-audio'])('fails safely for %s rather than reporting success', mode => {
    const f = fixture(); f.open(); f.client.control({ type: 'speak', text: 'A reply.' }); f.client.control({ type: 'flush' });
    if (mode === 'provider-error') f.remote.provider({ event: 'finish', reason: 'error', message: 'test-private-api-key provider private detail' });
    if (mode === 'early-close') f.remote.close();
    if (mode === 'truncated-pcm') { f.remote.provider({ event: 'audio', audio: Uint8Array.of(4) }); f.remote.provider({ event: 'finish', reason: 'stop' }); }
    if (mode === 'no-audio') f.remote.provider({ event: 'finish', reason: 'stop' });
    if (mode === 'bad-msgpack') f.remote.emit('message', Buffer.from([0xc1]), true);
    if (mode === 'bad-audio') f.remote.provider({ event: 'audio', audio: 'not binary' });
    expect(f.client.events().at(-1)?.type).toBe('error'); expect(f.client.events().some(event => event.type === 'speech-done')).toBe(false);
    expect(JSON.stringify(f.client.events())).not.toMatch(/test-private-api-key|provider private detail/); expect(vi.getTimerCount()).toBe(0);
  });

  it('expires authentication on an idle open socket and closes upstream on browser disconnect', async () => {
    const expired = fixture(); expired.open(); expired.revoke(); await vi.advanceTimersByTimeAsync(20000);
    expect(expired.client.events().at(-1)).toEqual({ type: 'error', message: 'Your sign-in expired. Sign in again.' }); expect(expired.remote.close).toHaveBeenCalledOnce();
    const closed = fixture(); closed.open(); closed.client.close();
    expect(closed.remote.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds upstream/client backlog, total text, and connection/audio waits', async () => {
    for (const side of ['upstream', 'client'] as const) {
      const f = fixture(); f.open();
      if (side === 'upstream') { f.remote.bufferedAmount = 256 * 1024 + 1; f.client.control({ type: 'speak', text: 'Reply.' }); }
      else { f.client.bufferedAmount = 2097153; f.remote.provider({ event: 'audio', audio: Uint8Array.of(0, 1) }); }
      expect(f.client.events().at(-1)?.type).toBe('error');
    }
    const long = fixture(); long.open(); for (let n = 0; n < 8; n++) long.client.control({ type: 'speak', text: 'x'.repeat(4000) });
    expect(long.client.events().at(-1)?.type).toBe('error');
    const connecting = fixture(); await vi.advanceTimersByTimeAsync(15000); expect(connecting.client.events().at(-1)?.type).toBe('error');
    const silent = fixture(); silent.open(); silent.client.control({ type: 'speak', text: 'Reply.' }); await vi.advanceTimersByTimeAsync(30000);
    expect(silent.client.events().at(-1)?.type).toBe('error'); expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects invalid voice identifiers without opening a provider connection', () => {
    const f = fixture('https://unexpected.example/voice');
    expect(f.factory).not.toHaveBeenCalled(); expect(f.client.events().at(-1)?.type).toBe('error'); expect(vi.getTimerCount()).toBe(0);
  });
});
