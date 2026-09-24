import type { RecognizerCapabilities, RecognizerEvents, SpeechRecognizer } from '../../contract/types';
import { clearExtractedModel, modelArchiveURL } from './model';

type BrokerMessage = { type: 'ready' | 'ack' | 'finished' } | { type: 'result'; text: string; final: boolean } | { type: 'error'; message: string };

/** The legacy binding never executes in the document. Its external broker has a
 * route-specific CSP, inherited by the binding's nested blob worker. */
export class LocalRecognizer implements SpeechRecognizer {
  readonly capabilities: RecognizerCapabilities = {
    provider: 'vosk', available: typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined', input: 'pcm16k', processing: 'local',
    handsFree: true, endpointing: 'local-vad', reason: 'Requires the downloaded model; speed and speaker echo cancellation need device qualification.',
  };
  private worker?: Worker;
  private active = false;
  private pending = 0;
  private drain?: () => void;
  private flushed?: () => void;
  private failed?: (error: Error) => void;
  private startupFailed?: (error: Error) => void;
  private closed = false;
  constructor(private events: RecognizerEvents) {}
  get running() { return this.active && !this.closed; }
  private error(message: string, overload = false) { this.events.error({ code: overload ? 'overload' : 'unavailable', message, fatal: true }); }
  async start() {
    // Blob archive URLs are per-session. Remove stale extraction rather than accumulating copies.
    await clearExtractedModel();
    const url = await modelArchiveURL();
    try {
      await new Promise<void>((resolve, reject) => {
        if (this.closed) { reject(new Error('Local speech startup cancelled.')); return; }
        const worker = this.worker = new Worker('/audio/vosk.worker.js');
        const timeout = setTimeout(() => {
          const error = new Error('Local speech initialization timed out. Close other tabs, refresh Voice Connect, and retry; use browser or premium speech if this device cannot load the model.');
          this.startupFailed?.(error); this.startupFailed = undefined; this.stop(); reject(error);
        }, 90000);
        this.startupFailed = (error) => { clearTimeout(timeout); reject(error); };
        worker.onmessage = (event: MessageEvent<BrokerMessage>) => {
          if (this.closed || this.worker !== worker) return;
          const message = event.data;
          if (message.type === 'ready') { clearTimeout(timeout); this.startupFailed = undefined; this.active = true; resolve(); }
          else if (message.type === 'result') this.events.result({ text: message.text, final: message.final, turnComplete: false });
          else if (message.type === 'ack') this.ack();
          else if (message.type === 'finished') { const done = this.flushed; this.flushed = undefined; done?.(); }
          else if (message.type === 'error') this.fail(message.message);
        };
        worker.onerror = (error) => this.fail(/content.security.policy|unsafe-eval/i.test(error.message)
          ? 'This site’s security policy blocked local speech. Refresh Voice Connect to load the current worker, then retry.'
          : this.active ? 'Local speech stopped unexpectedly. Review the draft, then restart recording.'
            : 'Local speech could not start. Refresh Voice Connect to update cached runtime files, then retry or choose browser/premium speech.');
        worker.postMessage({ type: 'start', url });
      });
    } finally { URL.revokeObjectURL(url); }
  }
  private fail(message: string) {
    if (this.closed) return;
    this.startupFailed?.(new Error(message)); this.startupFailed = undefined;
    this.failed?.(new Error(message)); this.failed = undefined;
    this.error(message); this.stop();
  }
  private ack() {
    this.pending = Math.max(0, this.pending - 1);
    if (this.pending === 0) { const done = this.drain; this.drain = undefined; done?.(); }
  }
  push(samples: Float32Array) {
    if (!this.running || !this.worker) return;
    if (this.pending >= 64) { this.error('Local speech cannot keep up with this device. Turn paused to avoid missing words.', true); this.stop(); return; }
    this.pending++;
    const frame = samples.slice(); this.worker.postMessage({ type: 'audio', samples: frame }, [frame.buffer]);
  }
  async finish() {
    if (!this.running || !this.worker) return;
    await this.wait((resolve) => { if (this.pending === 0) resolve(); else this.drain = resolve; });
    await this.wait((resolve) => { this.flushed = resolve; this.worker!.postMessage({ type: 'finish' }); });
  }
  private wait(begin: (resolve: () => void) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.failed = undefined; reject(new Error('Local speech did not finish in time. Draft preserved; nothing was sent.')); }, 4000);
      this.failed = (error) => { clearTimeout(timeout); reject(error); };
      begin(() => { clearTimeout(timeout); this.failed = undefined; resolve(); });
    });
  }
  stop() {
    this.closed = true; this.active = false;
    this.startupFailed?.(new Error('Local speech startup cancelled.')); this.startupFailed = undefined;
    this.failed?.(new Error('Speech stopped.')); this.failed = undefined; this.drain = undefined; this.flushed = undefined;
    // Terminating the owner worker also terminates its descendant worker and closes IDB.
    this.worker?.terminate(); this.worker = undefined; this.pending = 0;
  }
}
