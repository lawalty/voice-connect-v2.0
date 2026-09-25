import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { decode, encode } from '@msgpack/msgpack';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeFishAudio } from '../service/fish';
import { PLAYBACK_WINDOW_BYTES, PCM_BYTES_PER_SECOND } from '../contract/audio-flow';

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: { data: string | Uint8Array; binary: boolean }[] = [];
  close = vi.fn(() => { this.readyState = WebSocket.CLOSED; this.emit('close'); });
  pause = vi.fn(); resume = vi.fn();
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
    expect(f.client.events()).toEqual([{ type: 'ready', sampleRate: 24000, playbackWindowBytes: PLAYBACK_WINDOW_BYTES }]);
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

  it('bounds upstream/client backlog and connection/audio waits without a cumulative text cap', async () => {
    for (const side of ['upstream', 'client'] as const) {
      const f = fixture(); f.open();
      if (side === 'upstream') { f.remote.bufferedAmount = 256 * 1024 + 1; f.client.control({ type: 'speak', text: 'Reply.' }); }
      else { f.client.bufferedAmount = 2097153; f.remote.provider({ event: 'audio', audio: Uint8Array.of(0, 1) }); }
      expect(f.client.events().at(-1)?.type).toBe('error');
    }
    const long = fixture(); long.open(); for (let n = 0; n < 8; n++) long.client.control({ type: 'speak', text: 'x'.repeat(4000) });
    expect(long.client.events().at(-1)?.type).toBe('ready'); long.client.close();
    const connecting = fixture(); await vi.advanceTimersByTimeAsync(15000); expect(connecting.client.events().at(-1)?.type).toBe('error');
    const silent = fixture(); silent.open(); silent.client.control({ type: 'speak', text: 'Reply.' }); await vi.advanceTimersByTimeAsync(30000);
    expect(silent.client.events().at(-1)?.type).toBe('error'); expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects invalid voice identifiers without opening a provider connection', () => {
    const f = fixture('https://unexpected.example/voice');
    expect(f.factory).not.toHaveBeenCalled(); expect(f.client.events().at(-1)?.type).toBe('error'); expect(vi.getTimerCount()).toBe(0);
  });

  it('paces a burst by consumed PCM, preserves every byte, and delays done until the queue drains', () => {
    const f = fixture(); f.open(); f.client.control({ type: 'playback', playedBytes: 0 });
    f.client.control({ type: 'speak', text: 'A reply delivered faster than it can be played.' }); f.client.control({ type: 'flush' });
    const pcm = Buffer.alloc(PCM_BYTES_PER_SECOND * 24);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251;
    f.remote.provider({ event: 'audio', audio: pcm });
    expect(f.client.pcm().length).toBe(PLAYBACK_WINDOW_BYTES); expect(f.remote.pause).toHaveBeenCalledOnce();
    f.remote.provider({ event: 'finish', reason: 'stop' });
    expect(f.client.events().some(event => event.type === 'speech-done')).toBe(false);
    for (let consumed = PLAYBACK_WINDOW_BYTES; consumed < pcm.length; consumed += PLAYBACK_WINDOW_BYTES) {
      f.client.control({ type: 'playback', playedBytes: consumed });
      expect(f.client.pcm().length - consumed).toBeLessThanOrEqual(PLAYBACK_WINDOW_BYTES);
    }
    expect(f.client.pcm()).toEqual(pcm); expect(f.client.events().at(-1)?.type).toBe('speech-done');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a ten-minute reply flowing with bounded outstanding audio and no absolute reply deadline', async () => {
    const f = fixture(); f.open(); f.client.control({ type: 'playback', playedBytes: 0 });
    f.client.control({ type: 'speak', text: 'A long response.' }); f.client.control({ type: 'flush' });
    let played = 0;
    for (let n = 0; n < 150; n++) {
      f.remote.provider({ event: 'audio', audio: new Uint8Array(PLAYBACK_WINDOW_BYTES) });
      expect(f.client.pcm().length - played).toBe(PLAYBACK_WINDOW_BYTES);
      await vi.advanceTimersByTimeAsync(4000);
      played += PLAYBACK_WINDOW_BYTES; f.client.control({ type: 'playback', playedBytes: played });
      expect(f.client.events().some(event => event.type === 'error')).toBe(false);
    }
    f.remote.provider({ event: 'finish', reason: 'stop' });
    expect(f.client.events().at(-1)?.type).toBe('speech-done'); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels paused synthesis without draining or reviving queued audio', () => {
    const f = fixture(); f.open(); f.client.control({ type: 'playback', playedBytes: 0 });
    f.client.control({ type: 'speak', text: 'Interrupted long reply.' });
    f.remote.provider({ event: 'audio', audio: new Uint8Array(PLAYBACK_WINDOW_BYTES * 2) });
    const sent = f.client.pcm().length;
    f.client.control({ type: 'interrupt' }); f.client.control({ type: 'playback', playedBytes: sent });
    f.remote.provider({ event: 'audio', audio: new Uint8Array(100) });
    expect(f.client.pcm().length).toBe(sent); expect(f.remote.close).toHaveBeenCalledOnce();
    expect(f.client.events().at(-1)?.type).toBe('interrupted'); expect(vi.getTimerCount()).toBe(0);
  });

  it('waits across tool gaps but detects a consumer that stops advancing', async () => {
    const f = fixture(); f.open(); f.client.control({ type: 'playback', playedBytes: 0 });
    f.client.control({ type: 'speak', text: 'Let me look that up.' });
    f.remote.provider({ event: 'audio', audio: new Uint8Array(200) });
    f.client.control({ type: 'playback', playedBytes: 200 });
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.client.events().some(event => event.type === 'error')).toBe(false);
    f.client.control({ type: 'speak', text: 'Here is what I found.' });
    f.remote.provider({ event: 'audio', audio: new Uint8Array(PLAYBACK_WINDOW_BYTES) });
    await vi.advanceTimersByTimeAsync(30001);
    expect(f.client.events().at(-1)?.message).toContain('stopped advancing'); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([-2, 1, 100, Number.NaN])('rejects impossible playback progress %s', playedBytes => {
    const f = fixture(); f.open(); f.client.control({ type: 'playback', playedBytes });
    expect(f.client.events().at(-1)?.type).toBe('error'); expect(vi.getTimerCount()).toBe(0);
  });
});
