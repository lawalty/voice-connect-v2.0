import type { AudioEvent, SpeechOutput, SpeechPreferences } from '../../contract/types';
import { Generation } from './dsp';

export function audioURL(kind: 'stt' | 'tts', conversationId: string, voice?: string) {
  const url = new URL('/api/audio', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('kind', kind); url.searchParams.set('conversationId', conversationId);
  if (voice) url.searchParams.set('voice', voice);
  return url.href;
}
export interface OutputEvents { started(): void; ended(): void; error(message: string): void; }

export class BrowserOutput implements SpeechOutput {
  private queue: string[] = [];
  private active = false;
  private complete = false;
  private generation = new Generation();
  private utterance?: SpeechSynthesisUtterance;
  constructor(private preferences: SpeechPreferences, private events: OutputEvents) {}
  enqueue(text: string) {
    if (!('speechSynthesis' in window)) { this.events.error('This browser has no speech output. The reply is available as text.'); return; }
    // Short utterances reduce platform-specific long-utterance hangs.
    const pieces = text.match(/.{1,220}(?:\s|$)|\S{1,220}/g) ?? [text];
    this.queue.push(...pieces); this.complete = false; this.pump();
  }
  private pump() {
    if (this.active) return;
    const text = this.queue.shift();
    if (!text) { if (this.complete) this.events.ended(); return; }
    const id = this.generation.current;
    const utterance = this.utterance = new SpeechSynthesisUtterance(text.trim());
    const voices = speechSynthesis.getVoices();
    const preferred = voices.find((voice) => voice.voiceURI === this.preferences.browserVoice || voice.name === this.preferences.browserVoice);
    if (preferred) utterance.voice = preferred;
    utterance.lang = preferred?.lang ?? 'en-US';
    this.active = true;
    utterance.onstart = () => { if (this.generation.is(id)) this.events.started(); };
    utterance.onend = () => { if (!this.generation.is(id)) return; this.active = false; this.utterance = undefined; this.pump(); };
    utterance.onerror = (event) => {
      if (!this.generation.is(id)) return;
      this.active = false; this.queue = [];
      if (event.error !== 'canceled' && event.error !== 'interrupted') this.events.error('Browser speech stopped. The full reply remains available as text.');
      this.events.ended();
    };
    speechSynthesis.speak(utterance);
  }
  finish() { this.complete = true; this.pump(); }
  cancel() {
    this.generation.next(); this.queue = []; this.active = false; this.complete = false;
    this.utterance = undefined; if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
  dispose() { this.cancel(); }
}

export class PremiumOutput implements SpeechOutput {
  private socket?: WebSocket;
  private generation = new Generation();
  private sources = new Set<AudioBufferSourceNode>();
  private commands: Record<string, unknown>[] = [];
  private nextTime = 0;
  private firstTime = 0;
  private sampleRate = 24000;
  private ready = false;
  private done = false;
  private complete = false;
  private started = false;
  private timeout?: ReturnType<typeof setTimeout>;
  constructor(private context: AudioContext, private conversationId: string, private voice: string, private events: OutputEvents) {}
  private connect() {
    if (this.socket) return;
    const id = this.generation.current;
    const socket = this.socket = new WebSocket(audioURL('tts', this.conversationId, this.voice));
    socket.binaryType = 'arraybuffer';
    this.timeout = setTimeout(() => this.fail('Premium voice did not become ready. The reply remains available as text.'), 15000);
    socket.onmessage = (message) => {
      if (!this.generation.is(id)) return;
      if (message.data instanceof ArrayBuffer) { this.play(message.data, id); return; }
      let event: AudioEvent; try { event = JSON.parse(String(message.data)); } catch { return; }
      if (event.type === 'ready') {
        clearTimeout(this.timeout); this.ready = true; this.sampleRate = event.sampleRate;
        for (const command of this.commands) socket.send(JSON.stringify(command)); this.commands = [];
      } else if (event.type === 'speech-done') { this.done = true; this.checkDone(); }
      else if (event.type === 'error') this.fail(event.message);
    };
    socket.onerror = () => { if (this.generation.is(id)) this.fail('Premium voice connection failed. Read the reply or retry.'); };
    socket.onclose = () => { if (this.generation.is(id) && !this.done) this.fail('Premium voice disconnected. The reply remains available as text.'); };
  }
  private send(command: Record<string, unknown>) {
    this.connect();
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(command));
    else this.commands.push(command);
  }
  enqueue(text: string) {
    this.done = false;
    for (let offset = 0; offset < text.length; offset += 3500) this.send({ type: 'speak', text: text.slice(offset, offset + 3500) });
  }
  finish() { this.complete = true; if (this.socket) this.send({ type: 'flush' }); else this.events.ended(); }
  private play(bytes: ArrayBuffer, id: number) {
    if (bytes.byteLength % 2 || !this.generation.is(id)) return;
    const samples = bytes.byteLength / 2;
    if (!samples) return;
    if (this.nextTime - this.context.currentTime > 60) { this.fail('The spoken reply is too long to buffer safely. Read the remaining text.'); return; }
    const buffer = this.context.createBuffer(1, samples, this.sampleRate), channel = buffer.getChannelData(0), view = new DataView(bytes);
    for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    const start = Math.max(this.context.currentTime + 0.025, this.nextTime);
    if (!this.started) { this.started = true; this.firstTime = start; this.events.started(); }
    this.nextTime = start + buffer.duration; this.sources.add(source);
    source.onended = () => { source.disconnect(); this.sources.delete(source); if (this.generation.is(id)) this.checkDone(); };
    source.start(start);
  }
  private checkDone() {
    if (this.complete && this.done && this.sources.size === 0) {
      this.generation.next(); this.socket?.close(); this.socket = undefined; this.ready = false;
      this.events.ended();
    }
  }
  private fail(message: string) { this.cancel(); this.events.error(message); this.events.ended(); }
  cancel() {
    const offsetMs = this.started ? Math.max(0, (Math.min(this.context.currentTime, this.nextTime) - this.firstTime) * 1000) : 0;
    this.generation.next(); clearTimeout(this.timeout);
    // Silence first; provider acknowledgement must never delay a local interruption.
    for (const source of this.sources) { try { source.stop(); } catch { /* already ended */ } source.disconnect(); }
    this.sources.clear();
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'interrupt', offsetMs }));
    this.socket?.close(); this.socket = undefined; this.commands = []; this.ready = false;
    this.nextTime = 0; this.firstTime = 0; this.started = false; this.complete = false; this.done = false;
  }
  dispose() { this.cancel(); }
}
