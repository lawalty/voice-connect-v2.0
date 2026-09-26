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
  private awaitingNextTurn = false;
  private pendingFinish?: Promise<void>;
  private finishResolve?: () => void;
  private finishReject?: (error: Error) => void;
  private startReject?: (error: Error) => void;
  private startTimer?: ReturnType<typeof setTimeout>;
  private finishTimer?: ReturnType<typeof setTimeout>;
  private startResolve?: () => void;
  private active = false;
  private started = false;
  private recovering = false;
  private attempts = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  constructor(private conversationId: string, private events: RecognizerEvents) {}
  get running() { return this.ready; }
  start(): Promise<void> {
    this.stop(); this.active = true;
    return new Promise((resolve, reject) => {
      this.startResolve = resolve; this.startReject = reject;
      this.connect();
    });
  }
  private connect() {
      if (!this.active) return;
      const generation = ++this.generation;
      const socket = this.socket = new WebSocket(audioURL('stt', this.conversationId));
      this.startTimer = setTimeout(() => this.disconnected('Premium recognition did not become ready.', true), 12000);
      socket.onmessage = (message) => {
        if (generation !== this.generation) return;
        let event: AudioEvent; try { event = JSON.parse(String(message.data)); } catch { return; }
        if (event.type === 'ready') {
          if (event.sampleRate !== 16000) { this.fail('Premium recognition requested an unsupported audio rate.'); return; }
          clearTimeout(this.startTimer); clearTimeout(this.recoveryTimer);
          this.ready = true; this.started = true; this.startResolve?.(); this.startResolve = undefined; this.startReject = undefined;
          const recovered = this.recovering, attempts = this.attempts;
          this.recovering = false; this.attempts = 0;
          if (recovered) this.events.connection?.(false, attempts);
        } else if (event.type === 'error') this.disconnected(event.message, event.retryable === true);
        else if (event.type === 'stt') {
          if (event.final && this.awaitingNextTurn && !event.started) return;
          this.awaitingNextTurn = event.final;
          this.turnOpen = !event.final;
          this.events.result(event);
          if (event.turnComplete) {
            clearTimeout(this.finishTimer); this.finishResolve?.(); this.finishResolve = undefined; this.finishReject = undefined;
          }
        }
      };
      socket.onerror = () => { if (generation === this.generation) this.disconnected('Premium speech connection failed.', true, 1006); };
      socket.onclose = event => {
        if (generation === this.generation) this.disconnected('Premium recognition disconnected.', event?.code !== 1008, event?.code ?? 1006);
      };
  }
  private disconnected(message: string, retryable: boolean, closeCode?: number) {
    if (!this.active) return;
    if (!retryable || !this.started || this.pendingFinish) { this.fail(message); return; }
    this.ready = false; this.detachSocket();
    // No microphone audio is replayed across a failed connection. The engine
    // preserves any incomplete text and decides whether it is safe to resume.
    this.samples = []; this.turnOpen = false; this.awaitingNextTurn = false;
    if (!this.recovering) {
      this.recovering = true;
      this.recoveryTimer = setTimeout(() => this.fail('Voice could not reconnect. Your draft is preserved; tap to restart.'), 20000);
    }
    if (++this.attempts > 4) { this.fail('Voice could not reconnect. Your draft is preserved; tap to restart.'); return; }
    this.events.connection?.(true, this.attempts, closeCode);
    // The callback may deliberately stop recovery to protect an interrupted turn.
    if (this.active) this.retryTimer = setTimeout(() => this.connect(), [250, 750, 1500, 3000][this.attempts - 1]);
  }
  private detachSocket() {
    ++this.generation; clearTimeout(this.startTimer); clearTimeout(this.retryTimer);
    const socket = this.socket; this.socket = undefined;
    if (socket) { socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close(); }
  }
  push(samples: Float32Array) {
    if (!this.ready || this.pendingFinish) return;
    this.samples.push(...samples);
    while (this.samples.length >= 1280) {
      if (!this.sendSamples(Float32Array.from(this.samples.splice(0, 1280)))) return;
    }
  }
  private sendSamples(samples: Float32Array): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) { this.disconnected('Premium speech connection is no longer open.', true); return false; }
    if (this.socket.bufferedAmount > 64000) { this.fail('Speech upload is too slow. Your unsent draft is preserved.', 'overload'); return false; }
    try { this.socket.send(pcm16(samples)); return true; }
    catch { this.disconnected('Premium speech connection failed.', true, 1006); return false; }
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
    this.active = false; this.started = false; this.ready = false;
    this.detachSocket(); clearTimeout(this.finishTimer); clearTimeout(this.recoveryTimer);
    const recovering = this.recovering; this.recovering = false; this.attempts = 0;
    if (recovering) this.events.connection?.(false, 0);
    this.startResolve = undefined;
    this.startReject?.(new Error('Premium speech startup stopped.')); this.startReject = undefined;
    this.finishReject?.(new Error('Premium speech stopped before finalization.')); this.finishReject = undefined; this.finishResolve = undefined;
    this.pendingFinish = undefined;
    this.samples = []; this.turnOpen = false; this.awaitingNextTurn = false;
  }
}
