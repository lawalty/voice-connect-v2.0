import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { decode, encode } from '@msgpack/msgpack';
import WebSocket, { WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import { bridgeFishAudio } from '../service/fish';
import { PremiumOutput } from '../client/audio/output';
import { PCM_BYTES_PER_SECOND, PCM_RATE } from '../contract/audio-flow';

it('streams three minutes through real sockets, plays before input ends, and drains every sample in order', async () => {
  const provider = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const app = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await Promise.all([once(provider, 'listening'), once(app, 'listening')]);
  const address = (server: WebSocketServer) => `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  const expected = createHash('sha256'), actual = createHash('sha256');
  let cursor = 0, receivedSamples = 0, maximumAhead = 0, beganBeforeDone = false, inputDone = false;
  provider.on('connection', socket => socket.on('message', bytes => {
    const event = decode(new Uint8Array(bytes as Buffer)) as { event: string };
    if (event.event === 'text') {
      // Each of two coherent passages yields 90 seconds almost instantly.
      for (let block = 0; block < 90; block++) {
        const pcm = Buffer.alloc(PCM_BYTES_PER_SECOND);
        for (let i = 0; i < PCM_RATE; i++) pcm.writeInt16LE((cursor++ % 30000) - 15000, i * 2);
        expected.update(pcm); socket.send(encode({ event: 'audio', audio: pcm }));
      }
    } else if (event.event === 'stop') socket.send(encode({ event: 'finish', reason: 'stop' }));
  }));
  app.on('connection', client => bridgeFishAudio(client, 'fixture-key', 'fixture-voice', () => true,
    (_url, options) => new WebSocket(address(provider), options)));
  vi.stubGlobal('location', { href: address(app).replace('ws:', 'http:'), protocol: 'http:' });
  vi.stubGlobal('WebSocket', WebSocket);
  const began = performance.now(), timers = new Set<ReturnType<typeof setTimeout>>();
  const context = {
    get currentTime() { return (performance.now() - began) / 1000 * 60; }, state: 'running', destination: {},
    createBuffer(_channels: number, length: number, rate: number) {
      const channel = new Float32Array(length); return { duration: length / rate, getChannelData: () => channel };
    },
    createBufferSource() {
      let timer: ReturnType<typeof setTimeout>;
      return {
        buffer: undefined as { duration: number; getChannelData(): Float32Array } | undefined,
        onended: undefined as (() => void) | undefined, connect() {}, disconnect() {},
        start(time: number) {
          maximumAhead = Math.max(maximumAhead, time + this.buffer!.duration - context.currentTime);
          const pcm = Buffer.alloc(this.buffer!.getChannelData().length * 2);
          this.buffer!.getChannelData().forEach((sample, i) => pcm.writeInt16LE(Math.round(sample * 32768), i * 2));
          actual.update(pcm); receivedSamples += pcm.length / 2;
          timer = setTimeout(() => { timers.delete(timer); this.onended?.(); }, Math.max(0, (time + this.buffer!.duration - context.currentTime) * 1000 / 60));
          timers.add(timer);
        },
        stop() { clearTimeout(timer); timers.delete(timer); },
      };
    },
  };
  let resolve!: () => void, reject!: (error: Error) => void;
  const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const output = new PremiumOutput(context as unknown as AudioContext, 'fixture', 'fixture-voice', {
    started() {
      beganBeforeDone = !inputDone;
      // The second passage and final boundary do not exist at first playback.
      setTimeout(() => { output.enqueue('Here is the second passage.'); inputDone = true; output.finish(); }, 25);
    },
    ended: resolve, error: message => reject(new Error(message)),
  });
  try {
    output.enqueue('Here is the first passage.');
    await finished;
    expect(beganBeforeDone).toBe(true); expect(maximumAhead).toBeLessThanOrEqual(4.1);
    expect(receivedSamples).toBe(PCM_RATE * 180); expect(actual.digest('hex')).toBe(expected.digest('hex'));
  } finally {
    output.dispose(); for (const timer of timers) clearTimeout(timer);
    for (const server of [provider, app]) { for (const socket of server.clients) socket.terminate(); server.close(); }
    vi.unstubAllGlobals();
  }
}, 15000);
