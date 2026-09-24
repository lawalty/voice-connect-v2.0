import type { Model, KaldiRecognizer } from 'vosk-browser';
import { clearExtractedModel, modelArchiveURL } from './model';
type VoskGlobal = { Model: typeof Model };
let runtime: Promise<VoskGlobal> | undefined;

function loadRuntime(): Promise<VoskGlobal> {
  if (runtime) return runtime;
  runtime = new Promise<VoskGlobal>((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/runtime/vosk.js';
    script.onload = () => {
      const value = (window as unknown as { Vosk?: VoskGlobal }).Vosk;
      if (value) resolve(value); else reject(new Error('Local speech runtime could not initialize.'));
    };
    script.onerror = () => { script.remove(); reject(new Error('Local speech runtime could not load.')); };
    document.head.append(script);
  }).catch((error: unknown) => { runtime = undefined; throw error; });
  return runtime;
}

export class LocalRecognizer {
  private model?: Model;
  private recognizer?: KaldiRecognizer;
  private pending = 0;
  private drain?: () => void;
  private flushed?: () => void;
  private failed?: (error: Error) => void;
  private closed = false;
  constructor(private result: (text: string, final: boolean) => void, private error: (message: string) => void) {}
  async start() {
    const api = await loadRuntime();
    // Blob archive URLs are per-session. Remove stale extraction rather than accumulating copies.
    await clearExtractedModel();
    const url = await modelArchiveURL();
    try {
      await new Promise<void>((resolve, reject) => {
        if (this.closed) { reject(new Error('Local speech startup cancelled.')); return; }
        const model = this.model = new api.Model(url, -1);
        const timeout = setTimeout(() => { model.terminate(); reject(new Error('Local model took too long to initialize.')); }, 90_000);
        model.on('load', (message) => { clearTimeout(timeout); if (message.event === 'load' && message.result) resolve(); else reject(new Error('Local speech model failed to load.')); });
        model.on('error', (message) => { clearTimeout(timeout); if (message.event === 'error') { reject(new Error(message.error)); this.error(message.error); } });
      });
      if (this.closed) { this.model?.terminate(); return; }
      this.createRecognizer();
    } finally { URL.revokeObjectURL(url); }
  }
  private createRecognizer() {
    if (!this.model || this.closed) return;
    const recognizer = this.recognizer = new this.model.KaldiRecognizer(16000);
    recognizer.on('partialresult', (message) => {
      if (this.recognizer !== recognizer || this.closed || message.event !== 'partialresult') return;
      this.result(message.result.partial, false); this.ack();
    });
    recognizer.on('result', (message) => {
      if (this.recognizer !== recognizer || this.closed || message.event !== 'result') return;
      this.result(message.result.text, true);
      if (this.flushed) { const done = this.flushed; this.flushed = undefined; done(); }
      else this.ack();
    });
    recognizer.on('error', (message) => {
      if (message.event === 'error') { this.failed?.(new Error(message.error)); this.error(message.error); }
    });
  }
  private ack() {
    this.pending = Math.max(0, this.pending - 1);
    if (this.pending === 0) { const done = this.drain; this.drain = undefined; done?.(); }
  }
  push(samples: Float32Array) {
    if (!this.recognizer || this.closed) return;
    if (this.pending >= 64) { this.error('Local speech cannot keep up with this device. Turn paused to avoid missing words.'); this.stop(); return; }
    this.pending++;
    this.recognizer.acceptWaveformFloat(samples.slice(), 16000);
  }
  async finish() {
    if (!this.recognizer || this.closed) return;
    await this.wait((resolve) => { if (this.pending === 0) resolve(); else this.drain = resolve; });
    await this.wait((resolve) => { this.flushed = resolve; this.recognizer!.retrieveFinalResult(); });
    this.recognizer?.remove(); this.recognizer = undefined; this.pending = 0;
    this.createRecognizer();
  }
  private wait(begin: (resolve: () => void) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.failed = undefined; reject(new Error('Local speech did not finish in time. Draft preserved; nothing was sent.')); }, 4000);
      this.failed = (error) => { clearTimeout(timeout); reject(error); };
      begin(() => { clearTimeout(timeout); this.failed = undefined; resolve(); });
    });
  }
  stop() { this.closed = true; this.failed?.(new Error('Speech stopped.')); this.recognizer?.remove(); this.recognizer = undefined; this.model?.terminate(); this.model = undefined; }
}
