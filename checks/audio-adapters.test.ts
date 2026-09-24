import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecognizerEvents, SpeechRecognizer } from '../contract/types';
import { BrowserRecognizer } from '../client/audio/browser-recognizer';
import { FluxRecognizer } from '../client/audio/flux-recognizer';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function events(): RecognizerEvents { return { result: vi.fn(), ended: vi.fn(), error: vi.fn() }; }
function nativeFixture() {
  const instances: Native[] = [];
  class Native {
    lang = ''; interimResults = false; continuous = true;
    onstart?: () => void; onend?: () => void; onerror?: (event: { error: string }) => void;
    onresult?: (event: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void;
    start = vi.fn(); stop = vi.fn(() => this.onend?.()); abort = vi.fn();
    constructor() { instances.push(this); }
  }
  vi.stubGlobal('SpeechRecognition', Native);
  return instances;
}
function socketFixture() {
  const instances: Socket[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1; bufferedAmount = 0;
    onmessage?: (event: { data: string }) => void; onerror?: () => void; onclose?: () => void;
    send = vi.fn(); close = vi.fn();
    constructor(readonly url: string) { instances.push(this); }
    event(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('location', { href: 'https://voice.test/', protocol: 'https:' });
  return instances;
}

describe('independent browser recognition adapter', () => {
  it('reports native ownership and resolves readiness only after the native start event', async () => {
    const native = nativeFixture(), callbacks = events();
    const recognizer: SpeechRecognizer = new BrowserRecognizer(callbacks);
    const started = recognizer.start();
    expect(recognizer.running).toBe(false);
    expect(recognizer.capabilities).toMatchObject({ input: 'browser-managed', processing: 'browser-vendor', handsFree: false });
    recognizer.push(Float32Array.of(0.25));
    native[0]!.onstart?.(); await started;
    expect(recognizer.running).toBe(true); expect(native[0]!.continuous).toBe(false);
    await recognizer.finish();
    expect(recognizer.running).toBe(false); expect(callbacks.ended).toHaveBeenCalledWith(true);
    recognizer.stop();
  });
  it('guards stopped sessions against late recognition results and native end callbacks', async () => {
    const native = nativeFixture(), callbacks = events(), recognizer = new BrowserRecognizer(callbacks);
    const started = recognizer.start(); native[0]!.onstart?.(); await started;
    recognizer.stop();
    native[0]!.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'late private words' } }] });
    native[0]!.onend?.();
    expect(callbacks.result).not.toHaveBeenCalled(); expect(callbacks.ended).not.toHaveBeenCalled();
  });
  it('rejects finalization rather than allowing an unacknowledged stop to commit', async () => {
    vi.useFakeTimers();
    const native = nativeFixture(), recognizer = new BrowserRecognizer(events());
    const started = recognizer.start(); native[0]!.onstart?.(); await started;
    native[0]!.stop.mockImplementation(() => {});
    const assertion = expect(recognizer.finish()).rejects.toThrow('did not finish');
    await vi.advanceTimersByTimeAsync(2500); await assertion;
    expect(recognizer.running).toBe(false);
  });
});

describe('independent Flux recognition adapter', () => {
  it('owns 80 ms PCM framing and waits for provider final acknowledgement', async () => {
    const sockets = socketFixture(), callbacks = events();
    const recognizer: SpeechRecognizer = new FluxRecognizer('conversation', callbacks);
    const started = recognizer.start(), socket = sockets[0]!;
    recognizer.push(new Float32Array(1280)); expect(socket.send).not.toHaveBeenCalled();
    socket.event({ type: 'ready', sampleRate: 16000 }); await started;
    expect(recognizer.capabilities).toMatchObject({ input: 'pcm16k', handsFree: true, endpointing: 'provider-turn' });
    recognizer.push(new Float32Array(640).fill(0.5)); expect(socket.send).not.toHaveBeenCalled();
    recognizer.push(new Float32Array(800).fill(-0.5));
    const pcm = socket.send.mock.calls[0]![0] as ArrayBuffer;
    expect(pcm.byteLength).toBe(2560); expect(new DataView(pcm).getInt16(0, true)).toBe(16384);
    socket.event({ type: 'stt', text: 'complete thought', final: false, turnComplete: false, started: true });
    let complete = false;
    const finish = recognizer.finish().then(() => { complete = true; });
    await Promise.resolve(); expect(complete).toBe(false);
    expect((socket.send.mock.calls[1]![0] as ArrayBuffer).byteLength).toBe(320);
    expect(JSON.parse(socket.send.mock.calls[2]![0] as string)).toEqual({ type: 'finish' });
    socket.event({ type: 'stt', text: 'complete thought', final: true, turnComplete: true }); await finish;
    expect(callbacks.result).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'complete thought', final: true, turnComplete: true }));
    await recognizer.finish(); expect(socket.send).toHaveBeenCalledTimes(3);
    recognizer.stop();
  });
  it('reports backlog as a terminal failure and ignores late socket data after stop', async () => {
    const sockets = socketFixture(), callbacks = events(), recognizer = new FluxRecognizer('conversation', callbacks);
    const started = recognizer.start(), socket = sockets[0]!;
    socket.event({ type: 'ready', sampleRate: 16000 }); await started;
    socket.bufferedAmount = 64001; recognizer.push(new Float32Array(1280));
    expect(callbacks.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'overload', fatal: true }));
    expect(recognizer.running).toBe(false);
    socket.event({ type: 'stt', text: 'late words', final: true, turnComplete: true });
    expect(callbacks.result).not.toHaveBeenCalled();
  });
  it('ignores duplicate final endpoints and accepts the next provider-started turn without reconnecting', async () => {
    const sockets = socketFixture(), callbacks = events(), recognizer = new FluxRecognizer('conversation', callbacks);
    const started = recognizer.start(), socket = sockets[0]!;
    socket.event({ type: 'ready', sampleRate: 16000 }); await started;
    for (const text of ['First complete thought.', 'Second complete thought.']) {
      socket.event({ type: 'stt', text: '', final: false, turnComplete: false, started: true });
      socket.event({ type: 'stt', text, final: false, turnComplete: false });
      socket.event({ type: 'stt', text, final: true, turnComplete: true });
      socket.event({ type: 'stt', text, final: true, turnComplete: true });
    }
    expect(vi.mocked(callbacks.result).mock.calls.filter(([result]) => result.turnComplete).map(([result]) => result.text))
      .toEqual(['First complete thought.', 'Second complete thought.']);
    expect(recognizer.running).toBe(true); expect(sockets).toHaveLength(1);
    recognizer.stop();
  });
  it('preserves startup failure reasons and rejects an unsupported negotiated sample rate', async () => {
    const sockets = socketFixture(), recognizer = new FluxRecognizer('conversation', events());
    const assertion = expect(recognizer.start()).rejects.toThrow('unsupported audio rate');
    sockets[0]!.event({ type: 'ready', sampleRate: 48000 }); await assertion;
    expect(recognizer.running).toBe(false);
  });
});
