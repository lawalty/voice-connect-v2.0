import type { AudioEvent, SpeechOutput, SpeechPreferences } from '../../contract/types';
import { Generation } from './dsp';
import { PLAYBACK_WINDOW_BYTES } from '../../contract/audio-flow';

export function audioURL(kind: 'stt' | 'tts', conversationId: string, voice?: string) {
  const url = new URL('/api/audio', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('kind', kind); url.searchParams.set('conversationId', conversationId);
  if (voice) url.searchParams.set('voice', voice);
  if (kind === 'tts') url.searchParams.set('provider', 'fish');
  return url.href;
}
export interface PlaybackSamples { samples: Float32Array; sampleRate: number; startTime: number; }
export interface OutputEvents {
  started(): void; ended(): void; error(message: string): void;
  /** Scheduled PCM on the shared AudioContext clock, never provider arrival time. */
  reference?(audio: PlaybackSamples): void;
  cancelled?(atTime: number): void;
}

export class BrowserOutput implements SpeechOutput {
  private queue: string[] = [];
  private active = false;
  private complete = false;
  private failed = false;
  private ended = false;
  private generation = new Generation();
  private utterance?: SpeechSynthesisUtterance;
  private watchdog?: ReturnType<typeof setTimeout>;
  private stopVoiceWait?: () => void;
  private waitedForVoices = false;
  constructor(private preferences: Pick<SpeechPreferences, 'browserVoice'>, private events: OutputEvents) {}
  enqueue(text: string) {
    if (this.failed || !text.trim()) return;
    // Short utterances reduce platform-specific long-utterance hangs.
    const pieces = text.match(/.{1,220}(?:\s|$)|\S{1,220}/g) ?? [text];
    this.queue.push(...pieces); this.complete = false; this.ended = false; this.pump();
  }
  private pump() {
    if (this.active || this.failed || this.stopVoiceWait) return;
    if (!this.queue.length) { if (this.complete) this.reportEnded(); return; }
    if (typeof window === 'undefined' || !window.speechSynthesis || typeof SpeechSynthesisUtterance !== 'function') {
      this.fail('This browser has no speech output. The reply remains available as text.'); return;
    }
    const synthesis = window.speechSynthesis;
    let voices: SpeechSynthesisVoice[];
    try { voices = synthesis.getVoices(); }
    catch { this.fail('The device voice service could not be read. Check device text-to-speech settings and try Test speaker.'); return; }
    // Android initializes the platform voice service lazily. Give its asynchronous
    // inventory a bounded chance, but never defer a direct user-gesture test.
    if (!voices.length && !this.waitedForVoices && !globalThis.navigator?.userActivation?.isActive && typeof synthesis.addEventListener === 'function') {
      this.waitedForVoices = true;
      const id = this.generation.current;
      const retry = () => {
        if (!this.generation.is(id)) return;
        this.stopVoiceWait?.(); this.pump();
      };
      const changed = () => {
        try { if (synthesis.getVoices().length) retry(); }
        catch { retry(); }
      };
      const timeout = setTimeout(retry, 1200);
      this.stopVoiceWait = () => { clearTimeout(timeout); synthesis.removeEventListener('voiceschanged', changed); this.stopVoiceWait = undefined; };
      synthesis.addEventListener('voiceschanged', changed);
      changed(); return;
    }
    // An empty list alone does not prove speech is unavailable: some browsers
    // can still use their OS default voice. Start/error watchdogs verify the attempt.
    const text = this.queue.shift()!;
    const id = this.generation.current;
    try {
      const utterance = this.utterance = new SpeechSynthesisUtterance(text.trim());
      const saved = voices.find((voice) => voice.voiceURI === this.preferences.browserVoice || voice.name === this.preferences.browserVoice);
      const localEnglish = (voice: SpeechSynthesisVoice) => voice.localService && /^en(?:[-_]|$)/i.test(voice.lang);
      const preferred = saved ?? voices.find(voice => localEnglish(voice) && voice.default) ?? voices.find(localEnglish);
      if (preferred) utterance.voice = preferred;
      utterance.lang = preferred?.lang ?? 'en-US'; utterance.volume = 1;
      this.active = true; let started = false;
      const current = () => this.generation.is(id) && this.utterance === utterance;
      this.watchdog = setTimeout(() => {
        if (current()) this.fail('Browser speech did not report a start. Try Test speaker, then check device text-to-speech and sound settings. The reply remains as text.');
      }, 8000);
      utterance.onstart = () => {
        if (!current() || started) return;
        started = true; clearTimeout(this.watchdog);
        this.watchdog = setTimeout(() => {
          if (current()) this.fail('Browser speech stopped responding before it finished. Try Test speaker or choose another voice. The full reply remains as text.');
        }, Math.min(60000, Math.max(15000, text.length * 180 + 5000)));
        this.events.started();
      };
      utterance.onend = () => {
        if (!current()) return;
        if (!started) { this.fail('Browser speech ended without reporting a start. Try Test speaker to check this device. The reply remains as text.'); return; }
        clearTimeout(this.watchdog); this.active = false; this.utterance = undefined; this.pump();
      };
      utterance.onerror = (event) => { if (current()) this.fail(this.failureMessage(event.error)); };
      synthesis.speak(utterance);
    } catch (error) {
      this.fail(this.failureMessage(error instanceof Error && error.name === 'NotAllowedError' ? 'not-allowed' : 'synthesis-failed'));
    }
  }
  private failureMessage(code: string) {
    const messages: Record<string, string> = {
      'not-allowed': 'The browser blocked speech playback (not-allowed). Tap Test speaker to make an explicit playback request and check site sound permissions.',
      'audio-busy': 'The browser could not access audio output (audio-busy). Check other audio apps and the selected speaker or Bluetooth route.',
      'audio-hardware': 'The browser could not find an audio output device (audio-hardware). Check the speaker or Bluetooth route.',
      'synthesis-unavailable': 'No device speech engine is available (synthesis-unavailable). Check Android text-to-speech settings and installed voice data.',
      'language-unavailable': 'The selected speech language is unavailable (language-unavailable). Choose an installed English voice in Settings.',
      'voice-unavailable': 'The selected device voice is unavailable (voice-unavailable). Choose another browser voice in Settings.',
      network: 'The device voice could not connect (network). Check connectivity or select an installed local voice.',
      canceled: 'The browser canceled speech before it started (canceled). Try Test speaker to check this device.',
      interrupted: 'The browser interrupted speech before it finished (interrupted). Check other audio apps or try Test speaker.',
    };
    return `${messages[code] ?? 'The device speech engine failed (synthesis-failed). Try Test speaker or choose another voice.'} The full reply remains as text.`;
  }
  private reportEnded() { if (!this.ended) { this.ended = true; this.events.ended(); } }
  private fail(message: string) {
    if (this.failed) return;
    this.failed = true; this.cancel(); this.events.error(message); this.reportEnded();
  }
  finish() { this.complete = true; if (this.failed) this.reportEnded(); else this.pump(); }
  cancel() {
    this.generation.next(); this.queue = []; this.active = false; this.complete = false;
    clearTimeout(this.watchdog); this.stopVoiceWait?.();
    this.utterance = undefined;
    try { if (typeof window !== 'undefined') window.speechSynthesis?.cancel(); } catch { /* failure is reported by the initiating operation */ }
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
  private failed = false;
  private ended = false;
  private timeout?: ReturnType<typeof setTimeout>;
  private playbackTimeout?: ReturnType<typeof setTimeout>;
  private playbackWindow = 0;
  private pendingBytes = 0;
  private playedBytes = 0;
  constructor(private context: AudioContext, private conversationId: string, private voice: string, private events: OutputEvents) {}
  private connect() {
    if (this.socket || this.failed) return;
    const id = this.generation.current;
    let socket: WebSocket;
    try { socket = this.socket = new WebSocket(audioURL('tts', this.conversationId, this.voice)); }
    catch { this.fail('Premium voice connection could not start. The reply remains available as text.'); return; }
    socket.binaryType = 'arraybuffer';
    this.timeout = setTimeout(() => this.fail('Premium voice did not become ready. The reply remains available as text.'), 15000);
    socket.onmessage = (message) => {
      if (!this.generation.is(id)) return;
      if (message.data instanceof ArrayBuffer) { this.play(message.data, id); return; }
      let event: AudioEvent; try { event = JSON.parse(String(message.data)); } catch { return; }
      if (event.type === 'ready') {
        if (this.ready) return;
        if (event.sampleRate !== 24000) { this.fail('Premium voice requested an unsupported audio rate. The reply remains available as text.'); return; }
        clearTimeout(this.timeout); this.ready = true; this.sampleRate = event.sampleRate;
        if (event.playbackWindowBytes !== undefined) {
          if (event.playbackWindowBytes !== PLAYBACK_WINDOW_BYTES) { this.fail('Voice playback protocol changed. Refresh Voice Connect and try again.'); return; }
          this.playbackWindow = event.playbackWindowBytes;
          socket.send(JSON.stringify({ type: 'playback', playedBytes: 0 }));
        }
        for (const command of this.commands) socket.send(JSON.stringify(command)); this.commands = [];
        this.watchPlayback('Premium voice connected but returned no playable audio. Try Test speaker or check the selected voice.', 15000);
      } else if (event.type === 'speech-done') {
        if (!this.started) { this.fail('Premium voice returned no playable audio. Check the selected voice and try Test speaker.'); return; }
        this.done = true; this.checkDone();
      }
      else if (event.type === 'error') this.fail(event.message);
    };
    socket.onerror = () => { if (this.generation.is(id)) this.fail('Premium voice connection failed. Read the reply or retry.'); };
    socket.onclose = () => { if (this.generation.is(id) && !this.done) this.fail('Premium voice disconnected. The reply remains available as text.'); };
  }
  private send(command: Record<string, unknown>) {
    if (this.failed) return;
    this.connect();
    if (this.failed) return;
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(command));
    else this.commands.push(command);
  }
  enqueue(text: string) {
    if (this.failed || !text.trim()) return;
    this.done = false;
    for (let offset = 0; offset < text.length; offset += 3500) this.send({ type: 'speak', text: text.slice(offset, offset + 3500) });
    if (this.ready) this.watchPlayback('Premium voice returned no audio for the next part of the reply. Please reconnect voice.', Math.max(15000, (this.nextTime - this.context.currentTime) * 1000 + 15000));
  }
  finish() {
    this.complete = true;
    if (this.failed) this.reportEnded();
    else if (this.socket) {
      this.send({ type: 'flush' });
      this.watchPlayback('Premium voice did not finish the reply. Please reconnect voice.', Math.max(15000, (this.nextTime - this.context.currentTime) * 1000 + 15000));
    } else this.reportEnded();
  }
  private play(bytes: ArrayBuffer, id: number) {
    if (bytes.byteLength % 2 || !this.generation.is(id) || !this.ready || this.done || this.failed) return;
    const samples = bytes.byteLength / 2;
    if (!samples) return;
    if (this.context.state && this.context.state !== 'running') { this.fail('Browser audio output is suspended. Tap Test speaker to request playback. The reply remains as text.'); return; }
    // Credit returns only when audio has actually finished, not when it arrives.
    // Long replies therefore use the same small amount of scheduled PCM as short ones.
    if (this.playbackWindow && this.pendingBytes + bytes.byteLength > this.playbackWindow) { this.fail('Voice playback pacing was lost. Please reconnect voice.'); return; }
    if (!this.playbackWindow && this.pendingBytes + bytes.byteLength > this.sampleRate * 2 * 60) { this.fail('Refresh Voice Connect to enable paced voice streaming.'); return; }
    try {
      const buffer = this.context.createBuffer(1, samples, this.sampleRate), channel = buffer.getChannelData(0), view = new DataView(bytes);
      for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
      const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
      const start = Math.max(this.context.currentTime + 0.025, this.nextTime);
      this.nextTime = start + buffer.duration; this.sources.add(source);
      this.pendingBytes += bytes.byteLength;
      source.onended = () => {
        source.disconnect();
        if (!this.sources.delete(source) || !this.generation.is(id)) return;
        this.pendingBytes -= bytes.byteLength; this.playedBytes += bytes.byteLength;
        if (this.playbackWindow && !this.done && this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: 'playback', playedBytes: this.playedBytes }));
        }
        // A tool may take time between spoken passages. An empty playback queue
        // is not a failed synthesis request while the agent is still working.
        if (!this.sources.size && !this.complete) clearTimeout(this.playbackTimeout);
        this.checkDone();
      };
      source.start(start);
      this.events.reference?.({ samples: channel, sampleRate: this.sampleRate, startTime: start });
      if (!this.started) { this.started = true; this.firstTime = start; this.events.started(); }
      this.watchPlayback('Premium speech stopped responding before playback completed. The full reply remains as text.', Math.max(15000, (this.nextTime - this.context.currentTime) * 1000 + 5000));
    } catch { this.fail('Browser audio playback failed. Tap Test speaker to check output. The full reply remains as text.'); }
  }
  private watchPlayback(message: string, delayMs: number) {
    clearTimeout(this.playbackTimeout);
    const id = this.generation.current;
    this.playbackTimeout = setTimeout(() => { if (this.generation.is(id)) this.fail(message); }, delayMs);
  }
  private reportEnded() { if (!this.ended) { this.ended = true; this.events.ended(); } }
  private checkDone() {
    if (this.complete && this.done && this.sources.size === 0) {
      clearTimeout(this.playbackTimeout);
      this.generation.next(); this.socket?.close(); this.socket = undefined; this.ready = false;
      this.reportEnded();
    }
  }
  private fail(message: string) { if (this.failed) return; this.failed = true; this.cancel(); this.events.error(message); this.reportEnded(); }
  cancel() {
    const offsetMs = this.started ? Math.max(0, (Math.min(this.context.currentTime, this.nextTime) - this.firstTime) * 1000) : 0;
    this.generation.next(); clearTimeout(this.timeout); clearTimeout(this.playbackTimeout);
    // Silence first; provider acknowledgement must never delay a local interruption.
    for (const source of this.sources) { try { source.stop(); } catch { /* already ended */ } source.disconnect(); }
    this.sources.clear();
    this.events.cancelled?.(this.context.currentTime);
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'interrupt', offsetMs }));
    this.socket?.close(); this.socket = undefined; this.commands = []; this.ready = false;
    this.nextTime = 0; this.firstTime = 0; this.started = false; this.complete = false; this.done = false;
    this.pendingBytes = 0; this.playedBytes = 0; this.playbackWindow = 0;
  }
  dispose() { this.cancel(); }
}
