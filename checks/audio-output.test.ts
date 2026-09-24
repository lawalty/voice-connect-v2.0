import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPEECH } from '../contract/types';
import { BrowserOutput, PremiumOutput } from '../client/audio/output';

afterEach(() => vi.unstubAllGlobals());
describe('playback cancellation', () => {
  it('discards queued browser speech and ignores late native callbacks', () => {
    const utterances: { onstart?(): void; onend?(): void }[] = [];
    const synthesis = { speak: (utterance: object) => utterances.push(utterance), cancel: vi.fn(), getVoices: () => [] };
    vi.stubGlobal('window', { speechSynthesis: synthesis }); vi.stubGlobal('speechSynthesis', synthesis);
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(readonly text: string) {} });
    const events = { started: vi.fn(), ended: vi.fn(), error: vi.fn() };
    const output = new BrowserOutput(DEFAULT_SPEECH, events);
    output.enqueue('First sentence.'); output.enqueue('Queued second sentence.'); output.finish();
    const stale = utterances[0]!;
    output.cancel(); stale.onstart?.(); stale.onend?.();
    expect(synthesis.cancel).toHaveBeenCalledOnce(); expect(utterances).toHaveLength(1);
    expect(events.started).not.toHaveBeenCalled(); expect(events.ended).not.toHaveBeenCalled();
  });

  it('silences PCM locally before network interrupt and never plays late provider bytes', () => {
    const operations: string[] = [], sockets: FakeSocket[] = [], sources: { stop: ReturnType<typeof vi.fn> }[] = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 1; binaryType = ''; onmessage?: (event: { data: string | ArrayBuffer }) => void;
      onerror?: () => void; onclose?: () => void;
      constructor(readonly url: string) { sockets.push(this); }
      send(value: string) { operations.push(JSON.parse(value).type); }
      close() { operations.push('close'); }
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('location', { href: 'https://voice.test/', protocol: 'https:' });
    const context = {
      currentTime: 2, destination: {},
      createBuffer: (_channels: number, length: number, rate: number) => ({ duration: length / rate, getChannelData: () => new Float32Array(length) }),
      createBufferSource: () => {
        const source = { buffer: undefined, connect() {}, disconnect() {}, start() {}, stop: vi.fn(() => operations.push('stop')) };
        sources.push(source); return source;
      },
    } as unknown as AudioContext;
    const events = { started: vi.fn(), ended: vi.fn(), error: vi.fn() };
    const output = new PremiumOutput(context, 'conversation', 'flux-haley-en', events);
    output.enqueue('A reply.'); output.finish();
    const socket = sockets[0]!;
    socket.onmessage!({ data: JSON.stringify({ type: 'ready', sampleRate: 24000 }) });
    expect(operations).toEqual(['speak', 'flush']);
    socket.onmessage!({ data: new ArrayBuffer(4800) });
    expect(sources).toHaveLength(1);
    output.cancel();
    expect(operations.indexOf('stop')).toBeLessThan(operations.indexOf('interrupt'));
    socket.onmessage!({ data: new ArrayBuffer(4800) });
    socket.onmessage!({ data: JSON.stringify({ type: 'speech-done' }) });
    expect(sources).toHaveLength(1); expect(sources[0]!.stop).toHaveBeenCalledOnce();
    expect(events.ended).not.toHaveBeenCalled();
  });
});
