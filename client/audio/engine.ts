import type { AcousticSignal, RecognizerCapabilities, RecognizerEvents, SpeechOutput, SpeechPreferences, SpeechRecognizer, VoicePhase } from '../../contract/types';
import { acousticSignal, SentenceStream, Transcript } from './dsp';
import { BrowserOutput, PremiumOutput, type PlaybackSamples } from './output';
import { CueTransitions, ListeningCues } from './cues';
import { LocalRecognizer } from './vosk';
import { BrowserRecognizer } from './browser-recognizer';
import { FluxRecognizer } from './flux-recognizer';
import { AudioDiagnostics, type AudioDiagnosticEntry } from './diagnostics';
import captureWorkletURL from './capture.worklet.ts?worker&url';
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
  private vadProcessed = -1;
  private vadFence?: { sequence: number; resolve(): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> };
  private analysisBuffer: number[] = [];
  private prebuffer: Float32Array[] = [];
  private prebufferSamples = 0;
  private recognizer?: SpeechRecognizer;
  private lastCapabilities?: RecognizerCapabilities;
  private trace = new AudioDiagnostics();
  private outputRequestedAt = 0;
  private outputStartedAt = 0;
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
  private deferredAudio: Float32Array[] = [];
  private deferredSamples = 0;
  private deferredOnset = false;
  private deferredEndpoint = false;
  private playbackGeneration = 0;
  private outputActive = false;
  private outputFailed = false;
  private speakerMuted = false;
  private responseSilenced = false;
  private responseOpen = false;
  private wakeLock?: { release(): Promise<void> };
  private gap = false;
  private disposed = false;
  private browserMeterSupported = true;
  private lastCaptureAt = 0;
  private maxTurnTimer?: ReturnType<typeof setTimeout>;
  private protectingReply = false;
  private protectionEpoch = 0;
  private cues?: ListeningCues;
  private cueTransitions = new CueTransitions();
  private cuesSuppressed = false;
  private lastBlockedReason = '';
  constructor(private callbacks: VoiceCallbacks) {
    document.addEventListener('visibilitychange', this.visibility);
    window.addEventListener('offline', this.offline);
  }
  diagnostics(): AudioDiagnosticEntry[] { return this.trace.snapshot(); }
  capabilities(): RecognizerCapabilities | undefined { return this.lastCapabilities ? { ...this.lastCapabilities } : undefined; }
  /** A typed send unlocks the selected output without requesting a microphone. */
  prepareSpeech(preferences: SpeechPreferences, conversationId: string) {
    if (this.disposed) return;
    // Voice submission also uses this method just after scheduling its sent
    // cue. Only an inactive session can still have a sleep tail to cancel.
    if (!this.active) this.cues?.cancel();
    this.preferences = { ...preferences }; this.conversationId = conversationId;
    this.warmContext();
  }
  /** Presentation changes never restart capture or replay a missed cue. */
  setCuesSuppressed(suppressed: boolean) {
    this.cuesSuppressed = suppressed;
    if (suppressed) this.cues?.cancel();
  }
  /** The input is committed; wait for its reply without inviting another turn. */
  awaitReply() {
    this.sentences.reset(); this.outputFailed = false; this.responseOpen = true;
    this.responseSilenced = this.speakerMuted;
    // A typed send may happen mid-utterance. Keep collecting that spoken turn;
    // it still owns its transcript and can supersede the typed reply when done.
    const hearing = this.turnAudio || Boolean(this.transcript.text);
    this.protectReply(!hearing);
    this.setPhase(hearing ? 'hearing' : 'thinking', !hearing);
  }
  setSpeakerMuted(muted: boolean) {
    this.speakerMuted = muted;
    if (!muted) return;
    // Silence this reply permanently; unmute never replays its cancelled queue.
    this.responseSilenced = this.responseOpen || this.outputActive;
    ++this.playbackGeneration;
    this.output?.dispose(); this.output = undefined; this.outputActive = false;
    this.protectReply(false);
    this.setPhase(this.responseOpen ? 'thinking' : this.active && this.ready ? 'listening' : 'off');
  }
  private setPhase(phase: VoicePhase, turnSubmitted = false) {
    if (this.phase !== phase) { this.phase = phase; this.trace.record('phase', { phase }); this.callbacks.onPhase(phase); }
    // Listening/hearing are one continuous user turn. Barge-in availability during
    // a reply does not pretend the agent has finished and invited the next turn.
    // Local finalization is tentative: resumed speech still belongs to this turn.
    // Keep the cue window open until the complete input is committed.
    const listening = this.active && this.ready && !this.muted && !this.gap && (phase === 'listening' || phase === 'hearing' || phase === 'finalizing');
    const cue = this.cueTransitions.update(listening, !this.cuesSuppressed && this.preferences?.audioCues !== false, turnSubmitted);
    if (cue) this.cues?.play(cue);
  }
  private protectReply(protecting: boolean) {
    if (this.protectingReply === protecting) return;
    this.protectingReply = protecting; ++this.protectionEpoch;
    this.lastBlockedReason = '';
    this.prebuffer = []; this.prebufferSamples = 0;
  }
  private playbackReference = (audio: PlaybackSamples) => {
    if (!this.vad) return;
    const samples = audio.samples.slice();
    this.vad.postMessage({ type: 'reference', ...audio, samples }, [samples.buffer]);
  };
  private warmContext(): AudioContext {
    if (!this.context || this.context.state === 'closed') {
      const context = this.context = new AudioContext({ latencyHint: 'interactive' });
      context.onstatechange = () => {
        if (this.context === context && this.active && this.ready && context.state !== 'running') { this.trace.record('capture-gap', { reason: 'suspended' }); this.captureFailure('Browser audio was suspended. Review the draft before restarting.'); }
      };
    }
    void this.context.resume().catch(() => this.callbacks.onNotice('Tap the microphone or speaker to allow audio playback.'));
    return this.context;
  }
  private releaseContext() {
    this.cues?.dispose(); this.cues = undefined;
    const context = this.context; this.context = undefined;
    if (context) { context.onstatechange = null; void context.close().catch(() => {}); }
  }
  async start(preferences: SpeechPreferences, conversationId: string): Promise<void> {
    if (this.disposed) return;
    if (this.outputActive || this.responseOpen) this.interrupt();
    this.stop();
    this.trace.clear();
    const generation = ++this.generation;
    this.preferences = { ...preferences }; this.conversationId = conversationId;
    this.active = true; this.muted = false; this.gap = false; this.transcript.clear();
    this.callbacks.onDraft(''); this.setPhase('starting');
    // Android assigns low-latency output to the mode active when it opens.
    // Opening it before processed capture leaves a media player in call mode:
    // the hardware buttons then adjust a different volume stream. Acquire the
    // mic first and use a fresh context on every Android voice start. Other
    // browsers retain activation in the original tap (including Safari).
    if (/Android/i.test(navigator.userAgent)) this.releaseContext();
    else this.warmContext();
    try {
      if (!window.isSecureContext) throw new Error('Voice requires HTTPS or localhost.');
      const recognizer = this.recognizer = this.createRecognizer(generation);
      this.lastCapabilities = { ...recognizer.capabilities };
      if (!recognizer.capabilities.available) throw new Error(`The ${preferences.recognition} recognition engine is unavailable in this browser.`);
      if (recognizer.capabilities.input === 'browser-managed') {
        if (preferences.handsFree) this.callbacks.onNotice('Browser speech uses tap-to-talk here. Choose local Vosk or premium recognition for hands-free turns.');
        this.callbacks.onNotice('Browser recognition may send microphone audio to your browser vendor. Availability and recording duration depend on your browser.');
        // Built-in recognition owns its capture. A separate meter is best effort only.
        try { if (this.browserMeterSupported) await this.openCapture(generation, false); }
        catch {
          if (generation !== this.generation) return;
          this.closeCapture(); this.callbacks.onNotice('Live microphone visualization is unavailable with browser speech on this device.');
        }
        if (generation !== this.generation) return;
      } else {
        await this.openCapture(generation, true);
        if (generation !== this.generation) return;
        if (recognizer.capabilities.processing === 'local') this.callbacks.onNotice('Loading the downloaded local Vosk model. Audio stays on this device.');
        if (preferences.handsFree && preferences.output === 'browser') this.callbacks.onNotice('Hands-free interruption with a browser voice depends on this device’s echo cancellation. Headphones can improve it.');
      }
      if (generation !== this.generation) return;
      const startedAt = performance.now(); this.trace.record('provider-starting', { provider: preferences.recognition });
      this.cues?.dispose(); this.cues = new ListeningCues(this.warmContext(), this.playbackReference);
      await Promise.all([recognizer.start(), preferences.audioCues !== false ? this.cues.prepare() : Promise.resolve()]);
      if (generation !== this.generation) return;
      this.trace.record('provider-ready', { provider: preferences.recognition, durationMs: performance.now() - startedAt });
      this.ready = recognizer.running; this.setPhase(this.ready ? 'listening' : 'paused');
      if (preferences.keepAwake) await this.requestWakeLock(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      const message = error instanceof Error ? error.message : String(error);
      this.stop(); this.setPhase('error'); this.callbacks.onError(message);
    }
  }
  private async openCapture(generation: number, requireVad: boolean) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable in this browser.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (generation !== this.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.stream = stream;
    const context = this.warmContext();
    const settings = stream.getAudioTracks()[0]?.getSettings();
    this.trace.record('capture-settings', { sampleRate: settings?.sampleRate ?? context.sampleRate, channelCount: settings?.channelCount,
      echoCancellation: typeof settings?.echoCancellation === 'boolean' ? settings.echoCancellation : undefined,
      noiseSuppression: settings?.noiseSuppression, autoGainControl: settings?.autoGainControl });
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => { if (generation === this.generation) { this.trace.record('capture-gap', { reason: 'mic-ended' }); this.captureFailure('Microphone disconnected. Your unsent draft is preserved.'); } };
      track.onmute = () => { if (generation === this.generation && this.ready) { this.trace.record('capture-gap', { reason: 'mic-muted' }); this.captureFailure('Microphone capture was interrupted. Review your draft before sending.'); } };
    });
    await context.audioWorklet.addModule(captureWorkletURL);
    if (generation !== this.generation) return;
    this.source = context.createMediaStreamSource(stream);
    const worklet = this.worklet = new AudioWorkletNode(context, 'voice-capture');
    worklet.port.onmessage = (event) => {
      worklet.port.postMessage('ack');
      if (generation !== this.generation || !this.active) return;
      if (event.data.dropped > 0 && this.ready) { this.trace.record('backpressure', { reason: 'capture-backlog', pendingFrames: Math.ceil(event.data.dropped / 512) }); this.captureFailure('Microphone processing fell behind. Review your draft; incomplete audio was not sent.'); return; }
      if (this.muted || !this.ready) return;
      const now = performance.now();
      if (this.lastCaptureAt && now - this.lastCaptureAt > 500) { this.trace.record('capture-gap', { reason: 'capture-gap', durationMs: now - this.lastCaptureAt }); this.captureFailure('Microphone audio had an unexpected gap. Review your draft before sending.'); return; }
      this.lastCaptureAt = now;
      this.process(event.data.samples as Float32Array, event.data.endTime ?? context.currentTime);
    };
    this.source.connect(this.worklet); this.worklet.connect(context.destination);
    try { await this.startVad(generation); }
    catch (error) {
      if (generation !== this.generation) return;
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
          this.vadProcessed = Math.max(this.vadProcessed, event.data.sequence);
          if (this.vadFence && this.vadProcessed >= this.vadFence.sequence) {
            clearTimeout(this.vadFence.timeout); this.vadFence.resolve(); this.vadFence = undefined;
          }
          if (this.muted || !this.ready || event.data.sequence < this.vadIgnoreBefore) return;
          // Accepted interruption changes policy immediately, but already captured
          // frames still contain the rest of the user's words. Drain that exact
          // previous epoch; never let older input cross into a new protected reply.
          if (event.data.epoch !== this.protectionEpoch && !(!this.protectingReply && event.data.epoch === this.protectionEpoch - 1)) return;
          this.callbacks.onSignal(event.data.signal as AcousticSignal);
          const reason = event.data.echoRejected ? 'playback-echo' : event.data.gate?.reason;
          if (this.protectingReply && reason !== this.lastBlockedReason) {
            this.lastBlockedReason = reason;
            if (reason === 'playback-echo' || reason === 'background' || reason === 'low-confidence') this.trace.record('barge-in-blocked', { reason });
          }
          if (event.data.interruption && this.protectingReply && this.acceptsInput()) this.trace.record('barge-in', { provider: this.preferences?.recognition, reason: 'speech-onset', durationMs: event.data.gate?.accumulatedMs });
          this.consumeFrame(event.data.samples as Float32Array, event.data.transition, event.data.interruption === true);
        }
      };
      worker.onerror = () => { clearTimeout(timeout); if (!ready) reject(new Error('Speech detector could not load.')); else this.captureFailure('Speech detector stopped.'); };
      worker.postMessage({ type: 'init', sensitivity: this.preferences?.interruptionSensitivity ?? 50 });
    });
  }
  private waitForVad(): Promise<void> {
    const sequence = this.vadSequence - 1;
    if (!this.vad || this.vadProcessed >= sequence) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.vadFence = undefined;
        reject(new Error('Speech detection did not confirm the turn boundary in time. Review the draft before restarting.'));
      }, 600);
      this.vadFence = { sequence, resolve, reject, timeout };
    });
  }
  private acceptsInput() { return this.active && !this.gap && !this.muted && !this.finishing && (this.phase === 'listening' || this.phase === 'hearing' || Boolean(this.preferences?.handsFree && this.recognizer?.capabilities.handsFree)); }
  private process(samples: Float32Array, endTime: number) {
    if (!samples.length) return;
    if (!this.vad) this.callbacks.onSignal(acousticSignal(samples, 0, 0.008));
    else {
      this.analysisBuffer.push(...samples);
      while (this.analysisBuffer.length >= 512) {
        const frame = Float32Array.from(this.analysisBuffer.splice(0, 512));
        if (this.vadPending >= 12) { this.trace.record('backpressure', { reason: 'vad-backlog', pendingFrames: this.vadPending }); this.captureFailure('This device could not keep up with speech detection. Nothing incomplete was sent.'); return; }
        const frameEnd = endTime - this.analysisBuffer.length / 16000;
        this.vadPending++; this.vad!.postMessage({ type: 'frame', samples: frame, sequence: this.vadSequence++, endTime: frameEnd,
          protecting: this.protectingReply, epoch: this.protectionEpoch, turnActive: this.turnAudio }, [frame.buffer]);
      }
    }
  }
  private consumeFrame(samples: Float32Array, transition: 'start' | 'end' | null, interruption: boolean) {
    if (!samples?.length) return;
    if (this.finishing && !this.gap && this.preferences?.handsFree && this.recognizer?.capabilities.input === 'pcm16k') {
      if (this.deferredSamples + samples.length > 64000) { this.captureFailure('Speech finalization fell behind. Your complete draft is preserved; review it before restarting.'); return; }
      this.deferredAudio.push(samples.slice()); this.deferredSamples += samples.length;
      if (transition === 'start') { this.deferredOnset = true; this.deferredEndpoint = false; }
      else if (transition === 'end' && this.deferredOnset) this.deferredEndpoint = true;
      return;
    }
    if (!this.acceptsInput()) return;
    this.prebuffer.push(samples.slice()); this.prebufferSamples += samples.length;
    while (this.prebufferSamples > 8000 && this.prebuffer.length > 1) this.prebufferSamples -= this.prebuffer.shift()!.length;
    const hadTurn = this.turnAudio;
    if (this.protectingReply) {
      if (!interruption) {
        // Keep the premium stream alive without feeding assistant echo or fan
        // candidates into its next turn. The bounded prefix remains local.
        if (this.recognizer?.capabilities.endpointing === 'provider-turn') this.recognizer.push(new Float32Array(samples.length));
        return;
      }
      const buffered = this.prebuffer;
      this.speechStarted(true);
      if (this.recognizer?.capabilities.endpointing === 'provider-turn') for (const frame of buffered) this.recognizer.push(frame);
      return;
    }
    if (transition === 'start') this.speechStarted();
    if (this.recognizer?.capabilities.input === 'pcm16k' && (this.recognizer.capabilities.endpointing !== 'local-vad' || hadTurn)) this.recognizer.push(samples);
    if (transition === 'end' && this.recognizer?.capabilities.endpointing === 'local-vad' && this.preferences?.handsFree && this.turnAudio) void this.finish('automatic');
  }
  private speechStarted(approvedInterruption = false) {
    if (!this.acceptsInput() || this.recognizer?.capabilities.input === 'browser-managed') return;
    if (this.protectingReply && !approvedInterruption) return;
    const buffered = this.prebuffer;
    if (this.outputActive || this.responseOpen) this.interrupt('speech-onset');
    if (!this.turnAudio) {
      this.turnAudio = true;
      if (this.recognizer?.capabilities.endpointing === 'local-vad') for (const frame of buffered) this.recognizer.push(frame);
      this.prebuffer = []; this.prebufferSamples = 0;
      clearTimeout(this.maxTurnTimer);
      this.maxTurnTimer = setTimeout(() => { this.callbacks.onNotice('This turn reached two minutes. Review and send your draft.'); this.captureFailure('Long recording paused to keep the turn complete.'); }, 120000);
    }
    this.setPhase('hearing');
  }
  private createRecognizer(generation: number): SpeechRecognizer {
    const events: RecognizerEvents = {
      result: (result) => {
        if (generation !== this.generation || !this.active || this.gap || this.muted) return;
        // A remote onset/result cannot bypass the local playback-aware decision.
        if (this.protectingReply) return;
        if (result.started && this.preferences?.handsFree) this.speechStarted();
        this.callbacks.onDraft(this.transcript.update(result.text, result.final));
        if (result.text && !this.finishing) this.setPhase('hearing');
        if (result.turnComplete && !this.finishing && this.preferences?.handsFree) {
          this.trace.record('endpoint-ready', { provider: this.preferences.recognition }); this.commit();
        }
      },
      ended: (expected) => {
        if (generation !== this.generation || !this.active) return;
        this.ready = false;
        if (this.recognizer?.capabilities.input === 'browser-managed') this.closeCapture();
        if (!expected && !this.finishing) {
          this.setPhase('paused');
          this.callbacks.onNotice('Recording ended. Review your words before sending. Tap the microphone to record again.');
        }
      },
      error: (error) => {
        if (generation !== this.generation) return;
        if (error.code === 'capture' && this.recognizer?.capabilities.input === 'browser-managed') { this.browserMeterSupported = false; this.closeCapture(); }
        this.trace.record(error.code === 'overload' ? 'backpressure' : 'capture-gap', { provider: this.preferences?.recognition, reason: 'provider-error' });
        if (this.ready && error.fatal) this.captureFailure(error.message);
        else if (!error.fatal) this.callbacks.onNotice(error.message);
      },
    };
    if (this.preferences!.recognition === 'browser') return new BrowserRecognizer(events);
    if (this.preferences!.recognition === 'vosk') return new LocalRecognizer(events);
    return new FluxRecognizer(this.conversationId, events);
  }
  async finish(source: 'manual' | 'automatic' = 'manual'): Promise<void> {
    if (this.finishing || !this.preferences || this.gap) { if (this.gap) this.callbacks.onNotice('Recording was interrupted. Review or edit the draft and send it as text.'); return; }
    const generation = this.generation; this.finishing = true; this.setPhase('finalizing');
    this.deferredAudio = []; this.deferredSamples = 0; this.deferredOnset = false; this.deferredEndpoint = false;
    const requestedAt = performance.now(); this.trace.record('endpoint-request', { provider: this.preferences.recognition });
    try {
      await this.recognizer?.finish();
      // Recognition and VAD use different workers. Fence the VAD frames that
      // existed at the final ACK before deciding whether speech has resumed.
      // The fixed sequence prevents a continuously moving capture tail.
      if (generation === this.generation && source === 'automatic' && this.recognizer?.capabilities.endpointing === 'local-vad') await this.waitForVad();
      if (generation === this.generation && this.active && !this.gap && !this.muted) {
        this.trace.record('endpoint-ready', { provider: this.preferences.recognition, durationMs: performance.now() - requestedAt });
        const continued = this.deferredOnset;
        const ended = this.deferredEndpoint;
        const buffered = this.deferredAudio;
        // A local silence endpoint is still tentative while recognition drains.
        // If speech resumes before acknowledgement, keep the stable words and
        // continue the same thought instead of submitting a premature prefix.
        if (source !== 'automatic' || !continued) this.commit();
        this.finishing = false; this.turnAudio = false;
        this.prebuffer = buffered; this.prebufferSamples = this.deferredSamples;
        this.deferredAudio = []; this.deferredSamples = 0; this.deferredOnset = false; this.deferredEndpoint = false;
        if (this.recognizer?.capabilities.endpointing === 'provider-turn') for (const frame of buffered) this.recognizer.push(frame);
        if (continued) {
          this.speechStarted();
          if (ended) void this.finish('automatic');
        } else {
          while (this.prebufferSamples > 8000 && this.prebuffer.length > 1) this.prebufferSamples -= this.prebuffer.shift()!.length;
        }
      }
    } catch (error) {
      if (generation === this.generation) this.captureFailure(error instanceof Error ? error.message : String(error));
    } finally { if (generation === this.generation && this.phase !== 'finalizing') this.finishing = false; }
  }
  private commit() {
    clearTimeout(this.maxTurnTimer); this.turnAudio = false; this.prebuffer = []; this.prebufferSamples = 0;
    const draft = this.transcript.text, text = this.transcript.take();
    if (!text) {
      this.callbacks.onDraft(draft); this.setPhase(this.ready ? 'listening' : 'paused');
      if (draft) this.callbacks.onNotice('Only an unconfirmed draft was returned. Review it and send as text.');
      return;
    }
    if (this.outputActive || this.output) this.interrupt('speech-onset', false);
    this.callbacks.onDraft(''); this.awaitReply(); this.callbacks.onTurn(text);
  }
  mute(muted: boolean) {
    this.muted = muted;
    this.vadIgnoreBefore = this.vadSequence;
    this.lastCaptureAt = 0;
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    if (muted) {
      if (this.recognizer?.capabilities.input === 'browser-managed') { this.recognizer.stop(); this.ready = false; this.closeCapture(); }
      this.prebuffer = []; this.prebufferSamples = 0;
      this.callbacks.onSignal({ energy: 0, speechProbability: 0, noiseFloor: 0, pitch: null, confidence: 0 });
      if (this.turnAudio || this.transcript.text) { this.gap = true; this.callbacks.onNotice('Recording paused. Review the unsent draft before continuing.'); }
      this.setPhase('paused');
    } else if (this.recognizer?.capabilities.input === 'browser-managed' || this.gap) this.callbacks.onNotice('Tap the microphone to start a new recording. Your draft is preserved.');
    else if (this.active && this.ready) { this.vad?.postMessage({ type: 'reset' }); this.setPhase(this.outputActive ? 'speaking' : this.responseOpen ? 'thinking' : 'listening'); }
  }
  private captureFailure(message: string) {
    if (!this.active || this.gap) return;
    this.gap = true; this.callbacks.onNotice(message); this.stop(); this.setPhase('paused');
  }
  /** A deliberate End has its own sound. Shut capture/output first; never wait
   * for a sound to load, and never play it for a failure or cancelled startup. */
  endSession() {
    const wasReady = this.active && this.ready;
    this.interrupt('manual', false); this.stop();
    // Messenger suppresses turn cues; the explicit End action still gets its
    // sleep confirmation. The saved audio-cues preference silences both kinds.
    if (wasReady && this.preferences?.audioCues !== false) this.cues?.play('sleep');
  }
  stop() {
    ++this.generation; this.active = false; this.ready = false; this.finishing = false;
    this.cues?.cancel();
    clearTimeout(this.maxTurnTimer); this.recognizer?.stop(); this.recognizer = undefined;
    this.closeCapture();
    this.prebuffer = []; this.prebufferSamples = 0; this.analysisBuffer = []; this.turnAudio = false;
    this.deferredAudio = []; this.deferredSamples = 0; this.deferredOnset = false; this.deferredEndpoint = false;
    this.protectReply(false);
    void this.wakeLock?.release().catch(() => {}); this.wakeLock = undefined;
    this.callbacks.onSignal({ energy: 0, speechProbability: 0, noiseFloor: 0, pitch: null, confidence: 0 });
    this.setPhase(!this.outputActive && !this.responseOpen ? 'off' : this.phase);
  }
  private closeCapture() {
    this.lastCaptureAt = 0;
    if (this.vadFence) { clearTimeout(this.vadFence.timeout); this.vadFence.reject(new Error('Capture stopped before the turn boundary was confirmed.')); this.vadFence = undefined; }
    this.vad?.terminate(); this.vad = undefined; this.vadPending = 0;
    this.worklet?.disconnect(); this.worklet = undefined; this.source?.disconnect(); this.source = undefined;
    this.stream?.getTracks().forEach((track) => { track.onended = null; track.onmute = null; track.stop(); }); this.stream = undefined;
  }
  speak(text: string, replace = false) {
    if (!this.preferences || !text || this.disposed) return;
    if (!this.responseOpen) { this.sentences.reset(); this.outputFailed = false; this.responseOpen = true; this.responseSilenced = this.speakerMuted; this.protectReply(!this.responseSilenced); }
    const pieces = this.sentences.append(text, replace);
    for (const piece of pieces) this.enqueue(piece);
  }
  private enqueue(text: string) {
    if (this.outputFailed || this.speakerMuted || this.responseSilenced) return;
    if (!this.output) {
      const playbackGeneration = ++this.playbackGeneration;
      this.outputRequestedAt = performance.now();
      const events = {
        started: () => { if (playbackGeneration !== this.playbackGeneration) return; this.outputActive = true; this.outputStartedAt = performance.now(); this.trace.record('output-start', { provider: this.preferences?.output, durationMs: this.outputStartedAt - this.outputRequestedAt }); this.setPhase('speaking'); },
        ended: () => { if (playbackGeneration !== this.playbackGeneration) return; this.outputActive = false; this.trace.record('output-end', { provider: this.preferences?.output, durationMs: this.outputStartedAt ? performance.now() - this.outputStartedAt : 0 }); if (!this.responseOpen) { this.output?.dispose(); this.output = undefined; this.protectReply(false); this.setPhase(this.active && this.ready && this.recognizer?.running ? 'listening' : this.active ? 'paused' : 'off'); } },
        reference: this.playbackReference,
        cancelled: (atTime: number) => this.vad?.postMessage({ type: 'cancel-reference', atTime }),
        error: (message: string) => { if (playbackGeneration === this.playbackGeneration) { this.outputFailed = true; this.outputActive = false; this.trace.record('output-error', { provider: this.preferences?.output, reason: 'provider-error' }); this.callbacks.onNotice(message); } },
      };
      this.output = this.preferences!.output !== 'browser'
        ? new PremiumOutput(this.warmContext(), this.conversationId, this.preferences!.fishVoice || '', events)
        : new BrowserOutput(this.preferences!, events);
    }
    this.trace.record('output-request', { provider: this.preferences?.output });
    this.output.enqueue(text);
  }
  responseDone() {
    for (const piece of this.sentences.finish()) this.enqueue(piece);
    this.responseOpen = false;
    if (this.outputFailed) { ++this.playbackGeneration; this.output?.dispose(); this.output = undefined; this.outputActive = false; this.protectReply(false); this.setPhase(this.active && this.ready ? 'listening' : this.active ? 'paused' : 'off'); }
    else if (this.output) this.output.finish();
    else { this.protectReply(false); this.setPhase(this.active && this.ready ? 'listening' : this.active ? 'paused' : 'off'); }
  }
  interrupt(reason: 'manual' | 'speech-onset' = 'manual', resumeListening = true) {
    ++this.playbackGeneration;
    const pending = this.outputActive || this.responseOpen || Boolean(this.output);
    const requestedAt = performance.now();
    this.output?.cancel(); this.output?.dispose(); this.output = undefined;
    this.outputActive = false; this.responseOpen = false; this.sentences.reset();
    this.protectReply(false);
    if (pending) this.trace.record('output-interrupt', { provider: this.preferences?.output, durationMs: performance.now() - requestedAt, reason });
    if (pending) this.callbacks.onInterrupt();
    if (this.active && resumeListening) this.setPhase(this.ready && this.recognizer?.running ? 'listening' : 'paused');
    else if (!this.active) this.setPhase('off');
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
    if (this.active && this.recognizer?.capabilities.processing !== 'local') this.captureFailure('Network disconnected. Your unsent draft is preserved. Tap to reconnect when online.');
  };
  dispose() {
    this.disposed = true; ++this.playbackGeneration; this.stop(); this.output?.dispose(); this.output = undefined; this.cues?.dispose(); this.cues = undefined;
    this.releaseContext();
    document.removeEventListener('visibilitychange', this.visibility); window.removeEventListener('offline', this.offline);
  }
}
