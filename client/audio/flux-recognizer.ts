import type { AudioEvent, RecognizerCapabilities, RecognizerEvents, SpeechRecognizer } from '../../contract/types';
import { pcm16 } from './dsp';
import { audioURL } from './output';

/** Owns provider framing and lifecycle; application turn policy stays in VoiceEngine. */
export class FluxRecognizer implements SpeechRecognizer {
  readonly capabilities: RecognizerCapabilities = {
    provider: 'deepgram', available: typeof WebSocket !== 'undefined', input: 'pcm16k', processing: 'remote',
    handsFree: true, endpointing: 'provider-turn', reason: 'Requires a configured provider and connectivity; device echo cancellation still needs qualification.',
  };
  private socket?: WebSocket;
  private ready = false;
  private generation = 0;
  private samples: number[] = [];
  private turnOpen = false;
  private pendingFinish?: Promise<void>;
  private finishResolve?: () => void;
  private finishReject?: (error: Error) => void;
  private startReject?: (error: Error) => void;
  private startTimer?: ReturnType<typeof setTimeout>;
  private finishTimer?: ReturnType<typeof setTimeout>;
  constructor(private conversationId: string, private events: RecognizerEvents) {}
  get running() { return this.ready; }
  start(): Promise<void> {
    this.stop(); const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      const socket = this.socket = new WebSocket(audioURL('stt', this.conversationId));
      this.startReject = reject;
      this.startTimer = setTimeout(() => this.fail('Premium recognition did not become ready.'), 15000);
      socket.onmessage = (message) => {
        if (generation !== this.generation) return;
        let event: AudioEvent; try { event = JSON.parse(String(message.data)); } catch { return; }
        if (event.type === 'ready') {
          if (event.sampleRate !== 16000) { this.fail('Premium recognition requested an unsupported audio rate.'); return; }
          clearTimeout(this.startTimer); this.startReject = undefined; this.ready = true; resolve();
        } else if (event.type === 'error') this.fail(event.message);
        else if (event.type === 'stt') {
          this.turnOpen = !event.final;
          this.events.result(event);
          if (event.turnComplete) {
            clearTimeout(this.finishTimer); this.finishResolve?.(); this.finishResolve = undefined; this.finishReject = undefined;
          }
        }
      };
      socket.onerror = () => { if (generation === this.generation) this.fail('Premium speech connection failed.'); };
      socket.onclose = () => { if (generation === this.generation) this.fail('Premium recognition disconnected. Draft preserved; tap to restart.'); };
    });
  }
  push(samples: Float32Array) {
    if (!this.ready || this.pendingFinish) return;
    this.samples.push(...samples);
    while (this.samples.length >= 1280) {
      if (!this.sendSamples(Float32Array.from(this.samples.splice(0, 1280)))) return;
    }
  }
  private sendSamples(samples: Float32Array): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) { this.fail('Premium speech connection is no longer open.'); return false; }
    if (this.socket.bufferedAmount > 64000) { this.fail('Speech upload is too slow. Your unsent draft is preserved.', 'overload'); return false; }
    this.socket.send(pcm16(samples)); return true;
  }
  finish(): Promise<void> {
    if (this.pendingFinish) return this.pendingFinish;
    if (!this.ready || !this.turnOpen) return Promise.resolve();
    if (this.samples.length) { const pending = Float32Array.from(this.samples); this.samples = []; if (!this.sendSamples(pending)) return Promise.reject(new Error('Speech upload stopped before finalization.')); }
    const pending = new Promise<void>((resolve, reject) => {
      this.finishResolve = resolve; this.finishReject = reject;
      this.finishTimer = setTimeout(() => {
        this.finishResolve = undefined; this.finishReject = undefined;
        reject(new Error('Speech provider did not finalize. Review the draft and send as text.'));
      }, 6000);
      this.socket!.send(JSON.stringify({ type: 'finish' }));
    }).finally(() => { if (this.pendingFinish === pending) this.pendingFinish = undefined; });
    this.pendingFinish = pending;
    return pending;
  }
  private fail(message: string, code: 'network' | 'overload' = 'network') {
    this.startReject?.(new Error(message)); this.startReject = undefined;
    this.finishReject?.(new Error(message)); this.finishReject = undefined;
    this.stop(); this.events.error({ code, message, fatal: true }); this.events.ended(false);
  }
  stop() {
    ++this.generation; clearTimeout(this.startTimer); clearTimeout(this.finishTimer); this.ready = false;
    this.startReject?.(new Error('Premium speech startup stopped.')); this.startReject = undefined;
    this.finishReject?.(new Error('Premium speech stopped before finalization.')); this.finishReject = undefined; this.finishResolve = undefined;
    this.pendingFinish = undefined;
    this.socket?.close(); this.socket = undefined; this.samples = []; this.turnOpen = false;
  }
}
