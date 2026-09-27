import type { RecognizerCapabilities, RecognizerEvents, SpeechRecognizer } from '../../contract/types';
import { audioURL } from './output';
import { pcm16 } from './dsp';

/** VAD stays in VC; the host returns recognition segments, never conversational turns. */
export class HostRecognizer implements SpeechRecognizer {
  readonly capabilities: RecognizerCapabilities = { provider: 'vosk', available: typeof WebSocket !== 'undefined', input: 'pcm16k', processing: 'remote', handsFree: true, endpointing: 'local-vad' };
  private socket?: WebSocket;
  private active = false;
  private closed = false;
  private outstanding = 0;
  private sequence = 0;
  private starting?: (error?: Error) => void;
  private finishing?: { id: number; settle(error?: Error): void; promise: Promise<void> };
  constructor(private conversationId: string, private events: RecognizerEvents) {}
  get running() { return this.active && !this.closed; }
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('Host speech startup cancelled.')); return; }
      const url = new URL(audioURL('stt', this.conversationId)); url.searchParams.set('provider', 'vosk');
      const socket = this.socket = new WebSocket(url.href);
      const timeout = setTimeout(() => this.fail('Host Vosk did not become ready. Check its installation in Settings.'), 15000);
      this.starting = error => { clearTimeout(timeout); this.starting = undefined; error ? reject(error) : resolve(); };
      socket.onmessage = event => {
        if (this.closed || this.socket !== socket) return;
        let message; try { message = JSON.parse(String(event.data)); } catch { this.fail('Invalid host recognition response.'); return; }
        if (message.type === 'ready') { this.active = true; this.starting?.(); }
        else if (message.type === 'stt' && typeof message.text === 'string') this.events.result({ text: message.text, final: message.final === true, turnComplete: false });
        else if (message.type === 'ack' && Number.isSafeInteger(message.bytes) && message.bytes > 0) this.outstanding = Math.max(0, this.outstanding - message.bytes);
        else if (message.type === 'finished' && this.finishing && this.finishing.id === message.id) this.finishing.settle();
        else if (message.type === 'error') this.fail(typeof message.message === 'string' ? message.message : 'Host recognition stopped.');
      };
      socket.onerror = () => this.fail('Cannot reach host Vosk. Your draft is preserved.');
      socket.onclose = () => { if (!this.closed) this.fail('Host Vosk disconnected. Your draft is preserved; restart voice when connected.'); };
    });
  }
  private fail(message: string, overload = false) {
    if (this.closed) return;
    const error = new Error(message); this.starting?.(error); this.finishing?.settle(error);
    this.stop(); this.events.error({ code: overload ? 'overload' : 'network', message, fatal: true });
  }
  push(samples: Float32Array) {
    if (!this.running || !this.socket) return;
    const audio = pcm16(samples);
    if (this.outstanding + audio.byteLength > 128000 || this.socket.bufferedAmount > 128000) { this.fail('Host recognition cannot keep up. Draft preserved; nothing incomplete was submitted.', true); return; }
    this.outstanding += audio.byteLength; this.socket.send(audio);
  }
  finish(): Promise<void> {
    if (this.finishing) return this.finishing.promise;
    if (!this.running || !this.socket) return Promise.reject(new Error('Host recognition is not connected. Draft preserved.'));
    const id = ++this.sequence;
    let settle!: (error?: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => this.fail('Host recognition did not finish in time. Draft preserved; nothing was sent.'), 6000);
      settle = error => { clearTimeout(timeout); this.finishing = undefined; error ? reject(error) : resolve(); };
    });
    this.finishing = { id, settle, promise };
    // Ordered behind PCM. Only the acknowledgement AFTER FinalResult releases
    // the turn barrier; silence and segment finals never submit prematurely.
    this.socket.send(JSON.stringify({ type: 'finish', id }));
    return promise;
  }
  stop() {
    this.closed = true; this.active = false;
    const error = new Error('Host speech stopped.'); this.starting?.(error); this.finishing?.settle(error);
    this.socket?.close(); this.socket = undefined; this.outstanding = 0;
  }
}
