import type { RecognizerCapabilities, RecognizerError, RecognizerEvents, SpeechRecognizer } from '../../contract/types';

interface RecognitionEvent { resultIndex: number; results: { length: number; [index: number]: { isFinal: boolean; 0: { transcript: string } } }; }
interface NativeRecognition {
  lang: string; interimResults: boolean; continuous: boolean;
  onstart: (() => void) | null; onend: (() => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void; stop(): void; abort(): void;
}
type RecognitionConstructor = new () => NativeRecognition;
function nativeConstructor(): RecognitionConstructor | undefined {
  const browser = globalThis as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

/** Native recognition owns its microphone and is deliberately qualified as tap-to-talk. */
export class BrowserRecognizer implements SpeechRecognizer {
  readonly capabilities: RecognizerCapabilities = {
    provider: 'browser', available: Boolean(nativeConstructor()), input: 'browser-managed', processing: 'browser-vendor',
    handsFree: false, endpointing: 'native-session',
    reason: 'Browser recognition may use vendor processing; microphone sharing, session duration, and continuous capture are browser-dependent.',
  };
  private recognition?: NativeRecognition;
  private active = false;
  private generation = 0;
  private finishing = false;
  private finishResolve?: () => void;
  private finishReject?: (error: Error) => void;
  private startReject?: (error: Error) => void;
  private startTimer?: ReturnType<typeof setTimeout>;
  private finishTimer?: ReturnType<typeof setTimeout>;
  constructor(private events: RecognizerEvents) {}
  get running() { return this.active; }
  start(): Promise<void> {
    const Constructor = nativeConstructor();
    if (!Constructor) return Promise.reject(new Error('Browser recognition is unavailable. Choose downloaded local Vosk or premium speech.'));
    this.stop(); const generation = ++this.generation;
    const recognition = this.recognition = new Constructor();
    recognition.lang = 'en-US'; recognition.interimResults = true; recognition.continuous = false;
    return new Promise((resolve, reject) => {
      this.startReject = reject;
      this.startTimer = setTimeout(() => { this.stop(); reject(new Error('Browser recognition did not start. Check microphone permission.')); }, 15000);
      recognition.onstart = () => {
        if (generation !== this.generation) return;
        clearTimeout(this.startTimer); this.startReject = undefined; this.active = true; resolve();
      };
      recognition.onresult = (event) => {
        if (generation !== this.generation) return;
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]!;
          this.events.result({ text: result[0].transcript, final: result.isFinal, turnComplete: false });
        }
      };
      recognition.onend = () => {
        if (generation !== this.generation) return;
        clearTimeout(this.startTimer); clearTimeout(this.finishTimer); this.active = false;
        const expected = this.finishing;
        if (this.startReject) { this.startReject(new Error('Browser recording ended before it became ready.')); this.startReject = undefined; }
        this.finishResolve?.(); this.finishResolve = undefined; this.finishReject = undefined; this.finishing = false;
        this.events.ended(expected);
      };
      recognition.onerror = (event) => {
        if (generation !== this.generation || event.error === 'aborted') return;
        const error = this.describeError(event.error);
        clearTimeout(this.startTimer);
        this.startReject?.(new Error(error.message)); this.startReject = undefined;
        if (error.fatal) { clearTimeout(this.finishTimer); this.finishReject?.(new Error(error.message)); this.finishResolve = undefined; this.finishReject = undefined; }
        this.events.error(error);
      };
      try { recognition.start(); } catch (error) { clearTimeout(this.startTimer); this.startReject = undefined; reject(error); }
    });
  }
  push(_samples: Float32Array): void { /* Native capture cannot consume portable PCM. */ }
  finish(): Promise<void> {
    if (!this.active || !this.recognition) return Promise.resolve();
    if (this.finishing) return Promise.reject(new Error('Browser recognition is already finalizing.'));
    this.finishing = true;
    return new Promise((resolve, reject) => {
      this.finishResolve = resolve; this.finishReject = reject;
      this.finishTimer = setTimeout(() => {
        this.finishReject = undefined; this.finishResolve = undefined; this.finishing = false;
        this.stop(); reject(new Error('Browser recognition did not finish. Review the draft and send as text.'));
      }, 2500);
      this.recognition!.stop();
    });
  }
  stop() {
    ++this.generation; clearTimeout(this.startTimer); clearTimeout(this.finishTimer);
    this.startReject?.(new Error('Browser speech startup cancelled.')); this.startReject = undefined;
    this.finishReject?.(new Error('Browser speech stopped.')); this.finishReject = undefined; this.finishResolve = undefined;
    this.finishing = false; this.active = false; this.recognition?.abort(); this.recognition = undefined;
  }
  private describeError(code: string): RecognizerError {
    if (code === 'not-allowed' || code === 'service-not-allowed') return { code: 'permission', fatal: true, message: 'Microphone permission was denied. Allow it in browser settings, then tap to retry.' };
    if (code === 'audio-capture') return { code: 'capture', fatal: true, message: 'This browser could not share the microphone. Tap to retry with the microphone visualizer disabled, or choose local Vosk or premium recognition.' };
    if (code === 'no-speech') return { code: 'no-speech', fatal: false, message: 'No speech was detected. Tap the microphone to try again.' };
    return { code: code === 'network' ? 'network' : 'unknown', fatal: true, message: 'Browser speech disconnected. Review the draft before sending.' };
  }
}
