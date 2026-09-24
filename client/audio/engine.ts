import type { AcousticSignal, AudioEvent, SpeechOutput, SpeechPreferences, VoicePhase } from '../../contract/types';
import { acousticSignal, pcm16, Resampler, SentenceStream, Transcript } from './dsp';
import { audioURL, BrowserOutput, PremiumOutput } from './output';
import { LocalRecognizer } from './vosk';

interface RecognitionEvent { resultIndex: number; results: { length: number; [index: number]: { isFinal: boolean; 0: { transcript: string } } }; }
interface NativeRecognition {
  lang: string; interimResults: boolean; continuous: boolean;
  onstart: (() => void) | null; onend: (() => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void; stop(): void; abort(): void;
}
type RecognitionConstructor = new () => NativeRecognition;
export interface VoiceCallbacks {
  onPhase(phase: VoicePhase): void; onDraft(text: string): void; onTurn(text: string): void;
  onSignal(signal: AcousticSignal): void; onError(message: string): void;
  onInterrupt(): void; onNotice(message: string): void;
}

export class VoiceEngine {
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private vad?: Worker;
  private vadPending = 0;
  private vadSequence = 0;
  private vadIgnoreBefore = 0;
  private resampler?: Resampler;
  private analysisBuffer: number[] = [];
  private providerBuffer: number[] = [];
  private prebuffer: Float32Array[] = [];
  private prebufferSamples = 0;
  private local?: LocalRecognizer;
  private recognition?: NativeRecognition;
  private recognitionActive = false;
  private recognitionEnded?: () => void;
  private stt?: WebSocket;
  private sttReady = false;
  private providerTurnOpen = false;
  private sttEnded?: () => void;
  private sttFailure?: (error: Error) => void;
  private output?: SpeechOutput;
  private sentences = new SentenceStream();
  private transcript = new Transcript();
  private preferences?: SpeechPreferences;
  private conversationId = '';
  private phase: VoicePhase = 'off';
  private generation = 0;
  private active = false;
  private ready = false;
  private muted = false;
  private turnAudio = false;
  private finishing = false;
  private outputActive = false;
  private responseOpen = false;
  private wakeLock?: { release(): Promise<void> };
  private gap = false;
  private disposed = false;
  private browserMeterSupported = true;
  private lastCaptureAt = 0;
  private maxTurnTimer?: ReturnType<typeof setTimeout>;
  constructor(private callbacks: VoiceCallbacks) {
    document.addEventListener('visibilitychange', this.visibility);
    window.addEventListener('offline', this.offline);
  }
  private setPhase(phase: VoicePhase) { if (this.phase !== phase) { this.phase = phase; this.callbacks.onPhase(phase); } }
  private warmContext(): AudioContext {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.context.onstatechange = () => {
        if (this.active && this.ready && this.context?.state !== 'running') this.captureFailure('Browser audio was suspended. Review the draft before restarting.');
      };
    }
    void this.context.resume().catch(() => this.callbacks.onNotice('Tap the microphone or speaker to allow audio playback.'));
    return this.context;
  }
  async start(preferences: SpeechPreferences, conversationId: string): Promise<void> {
    if (this.disposed) return;
    if (this.outputActive || this.responseOpen) this.interrupt();
    this.stop();
    const generation = ++this.generation;
    this.preferences = { ...preferences }; this.conversationId = conversationId;
    this.active = true; this.muted = false; this.gap = false; this.transcript.clear();
    this.callbacks.onDraft(''); this.setPhase('starting');
    const context = this.warmContext();
    try {
      if (!window.isSecureContext) throw new Error('Voice requires HTTPS or localhost.');
      if (preferences.recognition === 'browser') {
        if (preferences.handsFree) this.callbacks.onNotice('Browser speech uses tap-to-talk here. Choose local Vosk or premium recognition for hands-free turns.');
        this.callbacks.onNotice('Browser recognition may send microphone audio to your browser vendor. Availability and recording duration depend on your browser.');
        // Built-in recognition owns its capture. A separate meter is best effort only.
        try { if (this.browserMeterSupported) await this.openCapture(context, generation, false); }
        catch { this.closeCapture(); this.callbacks.onNotice('Live microphone visualization is unavailable with browser speech on this device.'); }
        if (generation !== this.generation) return;
        await this.startBrowser(generation);
      } else {
        await this.openCapture(context, generation, true);
        if (generation !== this.generation) return;
        if (preferences.recognition === 'vosk') {
          this.callbacks.onNotice('Loading the downloaded local Vosk model. Audio stays on this device.');
          this.local = new LocalRecognizer((text, final) => {
            if (generation !== this.generation || !this.active) return;
            this.callbacks.onDraft(this.transcript.update(text, final));
          }, (message) => { if (generation === this.generation) this.captureFailure(message); });
          await this.local.start();
        } else await this.startPremium(generation);
        if (generation !== this.generation) return;
        this.ready = true; this.setPhase('listening');
        if (preferences.handsFree && preferences.output === 'browser') this.callbacks.onNotice('Hands-free interruption with a browser voice depends on this device’s echo cancellation. Headphones can improve it.');
      }
      if (generation !== this.generation) return;
      if (preferences.keepAwake) await this.requestWakeLock(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      const message = error instanceof Error ? error.message : String(error);
      this.stop(); this.setPhase('error'); this.callbacks.onError(message);
    }
  }
  private async openCapture(context: AudioContext, generation: number, requireVad: boolean) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable in this browser.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (generation !== this.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.stream = stream;
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => { if (generation === this.generation) this.captureFailure('Microphone disconnected. Your unsent draft is preserved.'); };
      track.onmute = () => { if (generation === this.generation && this.ready) this.captureFailure('Microphone capture was interrupted. Review your draft before sending.'); };
    });
    await context.audioWorklet.addModule('/audio/capture.js');
    if (generation !== this.generation) return;
    this.resampler = new Resampler(context.sampleRate);
    this.source = context.createMediaStreamSource(stream);
    const worklet = this.worklet = new AudioWorkletNode(context, 'voice-capture');
    worklet.port.onmessage = (event) => {
      worklet.port.postMessage('ack');
      if (generation !== this.generation || !this.active) return;
      if (event.data.dropped > 0 && this.ready) { this.captureFailure('Microphone processing fell behind. Review your draft; incomplete audio was not sent.'); return; }
      if (this.muted || !this.ready) return;
      const now = performance.now();
      if (this.lastCaptureAt && now - this.lastCaptureAt > 500) { this.captureFailure('Microphone audio had an unexpected gap. Review your draft before sending.'); return; }
      this.lastCaptureAt = now;
      this.process(this.resampler!.push(event.data.samples as Float32Array));
    };
    this.source.connect(this.worklet); this.worklet.connect(context.destination);
    try { await this.startVad(generation); }
    catch (error) {
      this.vad?.terminate(); this.vad = undefined;
      if (requireVad) throw new Error(`Speech detection could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private startVad(generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = this.vad = new Worker(new URL('./vad.worker.ts', import.meta.url), { type: 'module' });
      const timeout = setTimeout(() => reject(new Error('Local speech detector timed out.')), 20000);
      let ready = false;
      worker.onmessage = (event) => {
        if (generation !== this.generation) return;
        if (event.data.type === 'ready') { clearTimeout(timeout); ready = true; resolve(); }
        else if (event.data.type === 'error') {
          clearTimeout(timeout);
          if (!ready) reject(new Error(event.data.message));
          else this.captureFailure('Speech detection stopped. Review your draft before restarting.');
        } else if (event.data.type === 'signal') {
          this.vadPending = Math.max(0, this.vadPending - 1);
          if (this.muted || !this.ready || event.data.sequence < this.vadIgnoreBefore) return;
          this.callbacks.onSignal(event.data.signal as AcousticSignal);
          if (event.data.transition === 'start') this.speechStarted();
          else if (event.data.transition === 'end' && this.preferences?.recognition === 'vosk' && this.preferences.handsFree && this.turnAudio) void this.finish();
        }
      };
      worker.onerror = () => { clearTimeout(timeout); if (!ready) reject(new Error('Speech detector could not load.')); else this.captureFailure('Speech detector stopped.'); };
      worker.postMessage({ type: 'init' });
    });
  }
  private acceptsInput() { return this.active && !this.muted && !this.finishing && (this.phase === 'listening' || this.phase === 'hearing' || Boolean(this.preferences?.handsFree && this.preferences.recognition !== 'browser')); }
  private process(samples: Float32Array) {
    if (!samples.length) return;
    if (!this.vad) this.callbacks.onSignal(acousticSignal(samples, 0, 0.008));
    else {
      this.analysisBuffer.push(...samples);
      while (this.analysisBuffer.length >= 512) {
        const frame = Float32Array.from(this.analysisBuffer.splice(0, 512));
        if (this.vadPending >= 12) { this.captureFailure('This device could not keep up with speech detection. Nothing incomplete was sent.'); return; }
        this.vadPending++; this.vad!.postMessage({ type: 'frame', samples: frame, sequence: this.vadSequence++ }, [frame.buffer]);
      }
    }
    if (!this.acceptsInput()) return;
    this.prebuffer.push(samples.slice()); this.prebufferSamples += samples.length;
    while (this.prebufferSamples > 8000 && this.prebuffer.length > 1) this.prebufferSamples -= this.prebuffer.shift()!.length;
    if (this.preferences?.recognition === 'vosk') {
      if (this.turnAudio) this.local?.push(samples);
    } else if (this.preferences?.recognition === 'deepgram' && this.sttReady) {
      this.providerBuffer.push(...samples);
      while (this.providerBuffer.length >= 1280) {
        if (!this.stt || this.stt.bufferedAmount > 64000) { this.captureFailure('Speech upload is too slow. Your unsent draft is preserved.'); return; }
        this.stt.send(pcm16(Float32Array.from(this.providerBuffer.splice(0, 1280))));
      }
    }
  }
  private speechStarted() {
    if (!this.acceptsInput() || this.preferences?.recognition === 'browser') return;
    if (this.outputActive || this.responseOpen) this.interrupt();
    if (!this.turnAudio) {
      this.turnAudio = true;
      if (this.preferences?.recognition === 'vosk') for (const frame of this.prebuffer) this.local?.push(frame);
      this.prebuffer = []; this.prebufferSamples = 0;
      clearTimeout(this.maxTurnTimer);
      this.maxTurnTimer = setTimeout(() => { this.callbacks.onNotice('This turn reached two minutes. Review and send your draft.'); this.captureFailure('Long recording paused to keep the turn complete.'); }, 120000);
    }
    this.setPhase('hearing');
  }
  private async startBrowser(generation: number) {
    const browser = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
    const Constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    if (!Constructor) throw new Error('Browser recognition is unavailable. Choose downloaded local Vosk or premium speech.');
    const recognition = this.recognition = new Constructor();
    recognition.lang = 'en-US'; recognition.interimResults = true; recognition.continuous = false;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Browser recognition did not start. Check microphone permission.')), 15000);
      recognition.onstart = () => {
        clearTimeout(timeout); if (generation !== this.generation) { recognition.abort(); return; }
        this.recognitionActive = true; this.ready = true; this.setPhase('listening'); resolve();
      };
      recognition.onresult = (event) => {
        if (generation !== this.generation || this.muted) return;
        for (let i = event.resultIndex; i < event.results.length; i++) this.transcript.update(event.results[i]![0].transcript, event.results[i]!.isFinal);
        this.callbacks.onDraft(this.transcript.text); if (!this.finishing) this.setPhase('hearing');
      };
      recognition.onend = () => {
        clearTimeout(timeout);
        if (generation !== this.generation) return;
        this.recognitionActive = false;
        this.ready = false;
        this.recognitionEnded?.(); this.recognitionEnded = undefined;
        this.closeCapture();
        if (!this.finishing && this.active) {
          this.ready = false; this.setPhase('paused');
          this.callbacks.onNotice('Browser recording ended. Review your words, then send the turn. Tap the microphone to record again.');
        }
      };
      recognition.onerror = (event) => {
        clearTimeout(timeout); if (generation !== this.generation || event.error === 'aborted') return;
        if (event.error === 'audio-capture') { this.browserMeterSupported = false; this.closeCapture(); }
        const message = event.error === 'not-allowed' ? 'Microphone permission was denied. Allow it in browser settings, then tap to retry.' : event.error === 'audio-capture' ? 'This browser could not share the microphone. Tap to retry with the microphone visualizer disabled, or choose local Vosk or premium recognition.' : event.error === 'no-speech' ? 'No speech was detected. Tap the microphone to try again.' : 'Browser speech disconnected. Review the draft before sending.';
        if (!this.ready) reject(new Error(message)); else { this.gap = event.error !== 'no-speech'; this.callbacks.onNotice(message); }
      };
      try { recognition.start(); } catch (error) { clearTimeout(timeout); reject(error); }
    });
  }
  private startPremium(generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.stt = new WebSocket(audioURL('stt', this.conversationId));
      const timeout = setTimeout(() => reject(new Error('Premium recognition did not become ready.')), 15000);
      socket.onmessage = (message) => {
        if (generation !== this.generation) return;
        let event: AudioEvent; try { event = JSON.parse(String(message.data)); } catch { return; }
        if (event.type === 'ready') { clearTimeout(timeout); this.sttReady = true; resolve(); }
        else if (event.type === 'error') { clearTimeout(timeout); reject(new Error(event.message)); this.sttFailure?.(new Error(event.message)); if (this.ready) this.captureFailure(event.message); }
        else if (event.type === 'stt' && !this.gap && !this.muted) {
          this.providerTurnOpen = !event.final;
          if (event.started && this.preferences?.handsFree && (this.outputActive || this.responseOpen)) this.interrupt();
          this.callbacks.onDraft(this.transcript.update(event.text, event.final));
          if (event.text && !this.finishing) this.setPhase('hearing');
          if (event.turnComplete) {
            if (this.finishing) { this.sttEnded?.(); this.sttEnded = undefined; }
            else if (this.preferences?.handsFree) this.commit();
          }
        }
      };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('Premium speech connection failed.')); };
      socket.onclose = () => {
        clearTimeout(timeout); if (generation !== this.generation) return;
        const error = new Error('Premium recognition disconnected. Draft preserved; tap to restart.');
        reject(error); this.sttFailure?.(error); if (this.ready) this.captureFailure(error.message);
      };
    });
  }
  async finish(): Promise<void> {
    if (this.finishing || !this.preferences || this.gap) { if (this.gap) this.callbacks.onNotice('Recording was interrupted. Review or edit the draft and send it as text.'); return; }
    const generation = this.generation; this.finishing = true; this.setPhase('finalizing');
    try {
      if (this.preferences.recognition === 'browser' && this.recognitionActive) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => { this.recognitionEnded = undefined; this.recognition?.abort(); reject(new Error('Browser recognition did not finish. Review the draft and send as text.')); }, 2500);
          this.recognitionEnded = () => { clearTimeout(timeout); resolve(); }; this.recognition!.stop();
        });
      } else if (this.preferences.recognition === 'vosk') await this.local?.finish();
      else if (this.preferences.recognition === 'deepgram' && this.sttReady && (this.providerTurnOpen || !this.transcript.stable && this.transcript.text)) {
        if (this.providerBuffer.length) { this.stt!.send(pcm16(Float32Array.from(this.providerBuffer))); this.providerBuffer = []; }
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => { this.sttEnded = undefined; this.sttFailure = undefined; reject(new Error('Speech provider did not finalize. Review the draft and send as text.')); }, 6000);
          this.sttEnded = () => { clearTimeout(timeout); this.sttFailure = undefined; resolve(); };
          this.sttFailure = (error) => { clearTimeout(timeout); reject(error); };
          this.stt!.send(JSON.stringify({ type: 'finish' }));
        });
      }
      if (generation === this.generation) this.commit();
    } catch (error) {
      if (generation === this.generation) { this.gap = true; this.setPhase('paused'); this.callbacks.onNotice(error instanceof Error ? error.message : String(error)); }
    } finally { if (generation === this.generation) this.finishing = false; }
  }
  private commit() {
    clearTimeout(this.maxTurnTimer); this.turnAudio = false; this.prebuffer = []; this.prebufferSamples = 0;
    const draft = this.transcript.text, text = this.transcript.take();
    if (!text) {
      this.callbacks.onDraft(draft); this.setPhase(this.ready ? 'listening' : 'paused');
      if (draft) this.callbacks.onNotice('Only an unconfirmed draft was returned. Review it and send as text.');
      return;
    }
    this.callbacks.onDraft(''); this.sentences.reset(); this.responseOpen = true;
    this.setPhase('thinking'); this.callbacks.onTurn(text);
  }
  mute(muted: boolean) {
    this.muted = muted;
    this.vadIgnoreBefore = this.vadSequence;
    this.lastCaptureAt = 0;
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    if (muted) {
      if (this.recognitionActive) this.recognition?.abort();
      this.prebuffer = []; this.prebufferSamples = 0; this.providerBuffer = [];
      this.callbacks.onSignal({ energy: 0, speechProbability: 0, noiseFloor: 0, pitch: null, confidence: 0 });
      if (this.turnAudio || this.transcript.text) { this.gap = true; this.callbacks.onNotice('Recording paused. Review the unsent draft before continuing.'); }
      this.setPhase('paused');
    } else if (this.preferences?.recognition === 'browser' || this.gap) this.callbacks.onNotice('Tap the microphone to start a new recording. Your draft is preserved.');
    else if (this.active && this.ready) { this.vad?.postMessage({ type: 'reset' }); this.setPhase('listening'); }
  }
  private captureFailure(message: string) {
    if (!this.active || this.gap) return;
    this.gap = true; this.callbacks.onNotice(message); this.stop(); this.setPhase('paused');
  }
  stop() {
    ++this.generation; this.active = false; this.ready = false; this.finishing = false;
    clearTimeout(this.maxTurnTimer); this.recognition?.abort(); this.recognition = undefined; this.recognitionActive = false;
    this.local?.stop(); this.local = undefined; this.stt?.close(); this.stt = undefined; this.sttReady = false; this.providerTurnOpen = false;
    this.closeCapture();
    this.prebuffer = []; this.prebufferSamples = 0; this.analysisBuffer = []; this.providerBuffer = []; this.turnAudio = false;
    this.recognitionEnded = undefined; this.sttEnded = undefined; this.sttFailure = undefined;
    void this.wakeLock?.release().catch(() => {}); this.wakeLock = undefined;
    this.callbacks.onSignal({ energy: 0, speechProbability: 0, noiseFloor: 0, pitch: null, confidence: 0 });
    if (!this.outputActive && !this.responseOpen) this.setPhase('off');
  }
  private closeCapture() {
    this.lastCaptureAt = 0;
    this.vad?.terminate(); this.vad = undefined; this.vadPending = 0;
    this.worklet?.disconnect(); this.worklet = undefined; this.source?.disconnect(); this.source = undefined;
    this.stream?.getTracks().forEach((track) => { track.onended = null; track.onmute = null; track.stop(); }); this.stream = undefined;
  }
  speak(text: string, replace = false) {
    if (!this.preferences || !text || this.disposed) return;
    if (!this.responseOpen) { this.sentences.reset(); this.responseOpen = true; }
    const pieces = this.sentences.append(text, replace);
    for (const piece of pieces) this.enqueue(piece);
  }
  private enqueue(text: string) {
    if (!this.output) {
      const events = {
        started: () => { this.outputActive = true; this.setPhase('speaking'); },
        ended: () => { this.outputActive = false; if (!this.responseOpen) { this.output?.dispose(); this.output = undefined; this.setPhase(this.active && this.ready && this.preferences?.recognition !== 'browser' ? 'listening' : this.active ? 'paused' : 'off'); } },
        error: (message: string) => this.callbacks.onNotice(message),
      };
      this.output = this.preferences!.output === 'deepgram'
        ? new PremiumOutput(this.warmContext(), this.conversationId, this.preferences!.premiumVoice, events)
        : new BrowserOutput(this.preferences!, events);
    }
    this.output.enqueue(text);
  }
  responseDone() {
    for (const piece of this.sentences.finish()) this.enqueue(piece);
    this.responseOpen = false;
    if (this.output) this.output.finish();
    else this.setPhase(this.active && this.ready ? 'listening' : this.active ? 'paused' : 'off');
  }
  interrupt() {
    const pending = this.outputActive || this.responseOpen || Boolean(this.output);
    this.output?.cancel(); this.output?.dispose(); this.output = undefined;
    this.outputActive = false; this.responseOpen = false; this.sentences.reset();
    if (pending) this.callbacks.onInterrupt();
    if (this.active) this.setPhase(this.ready && (this.preferences?.recognition !== 'browser' || this.recognitionActive) ? 'listening' : 'paused');
  }
  private async requestWakeLock(generation: number) {
    try {
      if ('wakeLock' in navigator) {
        const lock = await navigator.wakeLock.request('screen');
        if (generation !== this.generation || !this.active) await lock.release();
        else this.wakeLock = lock;
      }
    } catch { this.callbacks.onNotice('Keep this page visible while speaking; the browser could not keep the screen awake.'); }
  }
  private visibility = () => {
    if (document.visibilityState === 'hidden' && this.active) this.captureFailure('Voice paused because the page was hidden. Reopen it and tap the microphone to resume.');
  };
  private offline = () => {
    if (this.active && this.preferences?.recognition !== 'vosk') this.captureFailure('Network disconnected. Your unsent draft is preserved. Tap to reconnect when online.');
  };
  dispose() {
    this.disposed = true; this.stop(); this.output?.dispose(); this.output = undefined;
    void this.context?.close().catch(() => {}); this.context = undefined;
    document.removeEventListener('visibilitychange', this.visibility); window.removeEventListener('offline', this.offline);
  }
}
