import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecognizerEvents } from '../contract/types';
import { HostRecognizer } from '../client/audio/vosk';
vi.mock('../client/audio/output', () => ({ audioURL: () => 'wss://voice.test/api/audio?kind=stt&conversationId=existing' }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture() {
  const sockets: Socket[] = [];
  class Socket {
    onmessage?: (event: { data: string }) => void; onerror?: () => void; onclose?: () => void;
    bufferedAmount = 0; send = vi.fn(); close = vi.fn();
    constructor(readonly url: string) { sockets.push(this); }
    event(data: object) { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  vi.stubGlobal('WebSocket', Socket);
  const callbacks: RecognizerEvents = { result: vi.fn(), error: vi.fn(), ended: vi.fn() };
  return { sockets, callbacks, recognizer: new HostRecognizer('existing', callbacks) };
}
describe('host Vosk streaming boundary', () => {
  it('keeps PCM, segments and final acknowledgement ordered without committing interim fragments', async () => {
    const { sockets, callbacks, recognizer } = fixture();
    const started = recognizer.start(), socket = sockets[0]!;
    expect(socket.url).toContain('provider=vosk'); socket.event({ type: 'ready' }); await started;
    recognizer.push(Float32Array.of(.1, .2)); recognizer.push(Float32Array.of(.3, .4));
    let finished = false; const finish = recognizer.finish().then(() => { finished = true; });
    expect(socket.send.mock.calls[0]![0]).toBeInstanceOf(ArrayBuffer);
    expect(JSON.parse(socket.send.mock.calls[2]![0])).toEqual({ type: 'finish', id: 1 });
    socket.event({ type: 'stt', text: 'complete', final: false });
    socket.event({ type: 'stt', text: 'complete thought', final: true, turnComplete: true });
    socket.event({ type: 'finished', id: 999 }); await Promise.resolve(); expect(finished).toBe(false);
    socket.event({ type: 'finished', id: 1 }); await finish;
    expect(callbacks.result).toHaveBeenLastCalledWith({ text: 'complete thought', final: true, turnComplete: false });
    recognizer.stop(); socket.event({ type: 'stt', text: 'late', final: true });
    expect(callbacks.result).toHaveBeenCalledTimes(2);
  });
  it('rejects a finalization lost to disconnect instead of submitting an incomplete draft', async () => {
    const { sockets, recognizer, callbacks } = fixture();
    const start = recognizer.start(); sockets[0]!.event({ type: 'ready' }); await start;
    const finished = expect(recognizer.finish()).rejects.toThrow('disconnected');
    sockets[0]!.onclose?.(); await finished;
    expect(recognizer.running).toBe(false); expect(callbacks.error).toHaveBeenCalledOnce();
  });
  it('bounds unacknowledged audio and respects credits', async () => {
    const { sockets, recognizer, callbacks } = fixture();
    const start = recognizer.start(); sockets[0]!.event({ type: 'ready' }); await start;
    recognizer.push(new Float32Array(32000)); sockets[0]!.event({ type: 'ack', bytes: 64000 });
    recognizer.push(new Float32Array(32000)); recognizer.push(new Float32Array(32000)); expect(callbacks.error).not.toHaveBeenCalled();
    recognizer.push(new Float32Array(512)); expect(callbacks.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'overload' }));
    expect(recognizer.running).toBe(false);
  });
  it('rejects cancelled startup and times out stalled finalization', async () => {
    vi.useFakeTimers();
    const first = fixture(); const cancelled = expect(first.recognizer.start()).rejects.toThrow('stopped'); first.recognizer.stop(); await cancelled;
    const next = fixture(); const start = next.recognizer.start(); next.sockets[0]!.event({ type: 'ready' }); await start;
    const failed = expect(next.recognizer.finish()).rejects.toThrow('did not finish');
    await vi.advanceTimersByTimeAsync(6001); await failed;
  });
});
