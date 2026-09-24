import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecognizerEvents } from '../contract/types';
import { LocalRecognizer } from '../client/audio/vosk';

vi.mock('../client/audio/model', () => ({ clearExtractedModel: vi.fn(async () => {}), modelArchiveURL: vi.fn(async () => 'blob:https://voice.test/verified-model') }));
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const workers: Broker[] = [];
  class Broker {
    onmessage?: (event: { data: object }) => void; onerror?: (error: { message: string }) => void;
    postMessage = vi.fn(); terminate = vi.fn();
    constructor(readonly url: string) { workers.push(this); }
    event(data: object) { this.onmessage?.({ data }); }
  }
  vi.stubGlobal('Worker', Broker);
  const callbacks: RecognizerEvents = { result: vi.fn(), error: vi.fn(), ended: vi.fn() };
  return { workers, callbacks, recognizer: new LocalRecognizer(callbacks) };
}
describe('Vosk broker boundary', () => {
  it('uses an external worker, drains all audio acknowledgements, then waits for explicit final acknowledgement', async () => {
    const { workers, callbacks, recognizer } = fixture();
    const started = recognizer.start();
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const worker = workers[0]!;
    expect(worker.url).toBe('/audio/vosk.worker.js'); expect(recognizer.running).toBe(false);
    worker.event({ type: 'ready' }); await started;
    recognizer.push(Float32Array.of(0.1, 0.2)); recognizer.push(Float32Array.of(0.3, 0.4));
    const finish = recognizer.finish();
    worker.event({ type: 'result', text: 'complete', final: false });
    worker.event({ type: 'ack' }); await Promise.resolve();
    expect(worker.postMessage.mock.calls.map(([value]) => value.type)).toEqual(['start', 'audio', 'audio']);
    worker.event({ type: 'ack' }); await Promise.resolve();
    expect(worker.postMessage.mock.calls.map(([value]) => value.type)).toEqual(['start', 'audio', 'audio', 'finish']);
    worker.event({ type: 'result', text: 'complete thought', final: true });
    worker.event({ type: 'finished' }); await finish;
    expect(callbacks.result).toHaveBeenLastCalledWith({ text: 'complete thought', final: true, turnComplete: false });
    expect(recognizer.running).toBe(true); recognizer.stop();
    expect(worker.terminate).toHaveBeenCalledOnce();
    worker.event({ type: 'result', text: 'late', final: true });
    expect(callbacks.result).toHaveBeenCalledTimes(2);
  });
  it('rejects stopped startup and provides an actionable policy error without loading a document script', async () => {
    const first = fixture(); const starting = first.recognizer.start();
    await vi.waitFor(() => expect(first.workers).toHaveLength(1));
    const cancelled = expect(starting).rejects.toThrow('startup cancelled');
    first.recognizer.stop(); await cancelled;
    const second = fixture(); const failure = second.recognizer.start();
    await vi.waitFor(() => expect(second.workers).toHaveLength(1));
    const blocked = expect(failure).rejects.toThrow('security policy blocked local speech');
    second.workers[0]!.onerror?.({ message: 'unsafe-eval blocked by Content Security Policy' }); await blocked;
    expect(second.callbacks.error).toHaveBeenCalledWith(expect.objectContaining({ fatal: true, code: 'unavailable' }));
    expect(second.workers[0]!.terminate).toHaveBeenCalledOnce();
  });
});
