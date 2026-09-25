import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcousticSignal, RecognizerCapabilities, RecognizerEvents, SpeechPreferences, VoicePhase } from '../contract/types';

const fixture = vi.hoisted(() => ({ recognizers: [] as FakeRecognizer[], outputs: [] as FakeOutput[] }));
class FakeRecognizer {
  readonly capabilities: RecognizerCapabilities = { provider: 'vosk', available: true, input: 'pcm16k', processing: 'local', handsFree: true, endpointing: 'local-vad' };
  running = false; frames: Float32Array[] = []; finals: string[] = []; barrier?: Promise<void>;
  constructor(readonly events: RecognizerEvents) { fixture.recognizers.push(this); }
  async start() { this.running = true; }
  push(frame: Float32Array) { this.frames.push(frame.slice()); }
  finish = vi.fn(async () => {
    const final = this.finals.shift() ?? '';
    if (this.barrier) await this.barrier;
    this.events.result({ text: final, final: true, turnComplete: false });
  });
  stop() { this.running = false; }
  partial(text: string) { this.events.result({ text, final: false, turnComplete: false }); }
}
interface OutputEvents { started(): void; ended(): void; error(message: string): void }
class FakeOutput {
  words: string[] = []; finished = false;
  constructor(_preferences: SpeechPreferences, readonly events: OutputEvents) { fixture.outputs.push(this); }
  enqueue(text: string) { this.words.push(text); this.events.started(); }
  finish() { this.finished = true; }
  cancel = vi.fn(); dispose = vi.fn();
  end() { this.events.ended(); }
}
vi.doMock('../client/audio/vosk', () => ({ LocalRecognizer: FakeRecognizer }));
vi.doMock('../client/audio/output', () => ({ BrowserOutput: FakeOutput, PremiumOutput: FakeOutput, audioURL: () => 'wss://voice.test/audio' }));
const { VoiceEngine } = await import('../client/audio/engine');

const signal: AcousticSignal = { energy: 0.4, speechProbability: 0.95, noiseFloor: 0.005, pitch: null, confidence: 0.7 };
const preferences: SpeechPreferences = { recognition: 'vosk', output: 'browser', browserVoice: '', premiumVoice: 'flux-haley-en', handsFree: true, keepAwake: false };
let detector: FakeWorker, capture: FakeWorklet, engine: InstanceType<typeof VoiceEngine> | undefined;
let microphone: ReturnType<typeof vi.fn>;
class FakeWorker {
  onmessage?: (event: { data: object }) => void; onerror?: () => void; sequence = 0; holdSignals = false;
  constructor() { detector = this; }
  postMessage(message: { type: string; sequence?: number }) {
    if (message.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
    if (message.type === 'frame') {
      this.sequence = message.sequence!;
      if (!this.holdSignals) queueMicrotask(() => this.transition(null));
    }
  }
  transition(transition: 'start' | 'end' | null) { this.onmessage?.({ data: { type: 'signal', sequence: this.sequence, signal, transition } }); }
  terminate() {}
}
class FakeWorklet {
  port = { onmessage: undefined as ((event: { data: object }) => void) | undefined, postMessage() {} };
  constructor() { capture = this; }
  connect() {} disconnect() {}
  frame(value = 0.25) { this.port.onmessage?.({ data: { samples: new Float32Array(512).fill(value), dropped: 0 } }); }
}
async function drain() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function setup() {
  const phases: VoicePhase[] = [], turns: string[] = [], drafts: string[] = [], notices: string[] = [];
  const callbacks = { onPhase: (value: VoicePhase) => phases.push(value), onTurn: (value: string) => turns.push(value), onDraft: (value: string) => drafts.push(value), onSignal: vi.fn(), onError: vi.fn(), onInterrupt: vi.fn(), onNotice: (value: string) => notices.push(value) };
  engine = new VoiceEngine(callbacks);
  return { engine, phases, turns, drafts, notices, callbacks };
}
beforeEach(() => {
  fixture.recognizers.length = 0; fixture.outputs.length = 0;
  const track = { enabled: true, stop: vi.fn(), getSettings: () => ({ sampleRate: 48000, channelCount: 1 }), onended: null, onmute: null };
  microphone = vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: microphone } });
  vi.stubGlobal('window', { isSecureContext: true, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' });
  vi.stubGlobal('Worker', FakeWorker); vi.stubGlobal('AudioWorkletNode', FakeWorklet);
  vi.stubGlobal('AudioContext', class {
    state = 'running'; sampleRate = 48000; destination = {}; audioWorklet = { addModule: async () => {} };
    async resume() {} async close() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  });
});
afterEach(() => { engine?.dispose(); engine = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('automatic continuous VoiceEngine orchestration', () => {
  it('ends a failed speech response without retrying fragments and allows the next response', async () => {
    const run = setup(); await run.engine.start(preferences, 'one-conversation');
    run.engine.speak('An initial complete sentence.');
    const failed = fixture.outputs[0]!;
    failed.events.error('Native speech never started.'); failed.end();
    run.engine.speak('Do not retry this fragment.'); run.engine.responseDone();
    expect(failed.words).toEqual(['An initial complete sentence.']);
    expect(run.notices).toContain('Native speech never started.');
    expect(run.phases.at(-1)).toBe('listening');
    expect(run.engine.diagnostics().some(item => item.event === 'output-error')).toBe(true);
    failed.events.started(); expect(run.phases.at(-1)).toBe('listening');
    run.engine.speak('A new response can be tried.'); run.engine.responseDone();
    expect(fixture.outputs).toHaveLength(2);
    fixture.outputs[1]!.end(); expect(run.phases.at(-1)).toBe('listening');
  });
  it('submits two complete VAD-ended turns and rearms after playback without a Finish action or recapture', async () => {
    const run = setup(); await run.engine.start(preferences, 'one-conversation');
    const recognition = fixture.recognizers[0]!;
    for (const words of ['The first complete thought.', 'The second complete thought.']) {
      capture.frame(); await drain(); detector.transition('start');
      recognition.partial(words.slice(0, 12)); recognition.finals.push(words);
      detector.transition('end'); await drain();
      expect(run.turns.at(-1)).toBe(words);
      expect(run.phases.at(-1)).toBe('thinking');
      run.engine.speak('A streamed '); run.engine.speak('reply.'); run.engine.responseDone();
      expect(run.phases.at(-1)).toBe('speaking');
      fixture.outputs.at(-1)!.end();
      expect(run.phases.at(-1)).toBe('listening');
      detector.transition('end'); await drain();
    }
    expect(run.turns).toEqual(['The first complete thought.', 'The second complete thought.']);
    expect(recognition.finish).toHaveBeenCalledTimes(2);
    expect(microphone).toHaveBeenCalledTimes(1); expect(recognition.running).toBe(true);
    expect(run.callbacks.onError).not.toHaveBeenCalled(); expect(run.notices).not.toContain(expect.stringMatching(/interrupted|unconfirmed/));
  });

  it('keeps interrupting user words and ignores late playback callbacks while the next turn is heard', async () => {
    const run = setup(); await run.engine.start(preferences, 'one-conversation');
    const recognition = fixture.recognizers[0]!;
    capture.frame(); await drain(); detector.transition('start'); recognition.finals.push('First request.');
    detector.transition('end'); await drain(); run.engine.speak('An unfinished assistant response.');
    const staleOutput = fixture.outputs[0]!;
    capture.frame(0.4); await drain(); detector.transition('start'); recognition.partial('Actually change');
    expect(staleOutput.cancel).toHaveBeenCalledTimes(1); expect(run.callbacks.onInterrupt).toHaveBeenCalledTimes(1);
    staleOutput.events.started(); staleOutput.end();
    expect(run.phases.at(-1)).toBe('hearing'); expect(run.drafts.at(-1)).toBe('Actually change');
    recognition.finals.push('Actually change the destination.'); detector.transition('end'); await drain();
    expect(run.turns).toEqual(['First request.', 'Actually change the destination.']);
    expect(run.callbacks.onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('retracts a tentative endpoint when speech resumes during finalization and preserves buffered initial words', async () => {
    const run = setup(); await run.engine.start(preferences, 'one-conversation');
    const recognition = fixture.recognizers[0]!;
    let release!: () => void; recognition.barrier = new Promise<void>((resolve) => { release = resolve; });
    capture.frame(0.1); await drain(); detector.transition('start'); recognition.partial('Please take'); recognition.finals.push('Please take');
    detector.transition('end'); await drain(); expect(run.phases.at(-1)).toBe('finalizing');
    const before = recognition.frames.length;
    capture.frame(0.6); await drain(); detector.transition('start'); capture.frame(0.7); await drain();
    expect(recognition.frames).toHaveLength(before); expect(run.turns).toEqual([]);
    recognition.barrier = undefined; release(); await drain();
    expect(run.turns).toEqual([]); expect(run.phases.at(-1)).toBe('hearing');
    expect(recognition.frames.slice(before).map((frame) => Number(frame[0]!.toFixed(1)))).toEqual([0.6, 0.7]);
    recognition.partial('the next exit'); recognition.finals.push('the next exit.'); detector.transition('end'); await drain();
    expect(run.turns).toEqual(['Please take the next exit.']);
    expect(recognition.finish).toHaveBeenCalledTimes(2);
  });

  it('does not commit an in-flight automatic finalization after capture is stopped', async () => {
    const run = setup(); await run.engine.start(preferences, 'one-conversation');
    const recognition = fixture.recognizers[0]!;
    let release!: () => void; recognition.barrier = new Promise<void>((resolve) => { release = resolve; });
    capture.frame(); await drain(); detector.transition('start'); recognition.finals.push('Do not submit.');
    detector.transition('end'); run.engine.stop(); release(); await drain();
    expect(run.turns).toEqual([]); expect(run.phases.at(-1)).toBe('off');
  });

  it('completes a continuation that starts and ends while the earlier finalization is pending', async () => {
    const run = setup(); await run.engine.start(preferences, 'one-conversation');
    const recognition = fixture.recognizers[0]!;
    let release!: () => void; recognition.barrier = new Promise<void>((resolve) => { release = resolve; });
    capture.frame(); await drain(); detector.transition('start'); recognition.finals.push('Keep the');
    detector.transition('end'); capture.frame(0.6); await drain(); detector.transition('start');
    capture.frame(0.7); await drain(); detector.transition('end'); recognition.finals.push('whole thought.');
    recognition.barrier = undefined; release(); await drain();
    expect(run.turns).toEqual(['Keep the whole thought.']); expect(recognition.finish).toHaveBeenCalledTimes(2);
    expect(run.phases.at(-1)).toBe('thinking');
  });

  it('waits for already-captured VAD frames when recognition acknowledges before the resumed-speech event', async () => {
    const run = setup(); await run.engine.start(preferences, 'one-conversation');
    const recognition = fixture.recognizers[0]!;
    let release!: () => void; recognition.barrier = new Promise<void>((resolve) => { release = resolve; });
    capture.frame(); await drain(); detector.transition('start'); recognition.finals.push('Please keep');
    detector.transition('end'); detector.holdSignals = true; capture.frame(0.6); await drain();
    recognition.barrier = undefined; release(); await drain();
    expect(run.turns).toEqual([]); expect(run.phases.at(-1)).toBe('finalizing');
    detector.holdSignals = false; detector.transition('start'); await drain();
    expect(run.turns).toEqual([]); expect(run.phases.at(-1)).toBe('hearing');
    expect(recognition.frames.at(-1)![0]).toBeCloseTo(0.6);
    recognition.finals.push('these words together.'); detector.transition('end'); await drain();
    expect(run.turns).toEqual(['Please keep these words together.']);
  });

  it('pauses without submitting if the bounded VAD fence cannot confirm the endpoint', async () => {
    vi.useFakeTimers();
    const run = setup(); await run.engine.start(preferences, 'one-conversation');
    const recognition = fixture.recognizers[0]!;
    let release!: () => void; recognition.barrier = new Promise<void>((resolve) => { release = resolve; });
    capture.frame(); await drain(); detector.transition('start'); recognition.finals.push('Keep this draft.');
    detector.transition('end'); detector.holdSignals = true; capture.frame();
    recognition.barrier = undefined; release(); await drain();
    await vi.advanceTimersByTimeAsync(601);
    expect(run.turns).toEqual([]); expect(run.phases.at(-1)).toBe('paused');
    expect(run.drafts.at(-1)).toBe('Keep this draft.'); expect(recognition.running).toBe(false);
    expect(run.notices.at(-1)).toMatch(/turn boundary/);
  });

  it('does not submit after mute interrupts an automatic finalization or accept disposed output callbacks', async () => {
    const run = setup(); await run.engine.start(preferences, 'one-conversation');
    const recognition = fixture.recognizers[0]!;
    let release!: () => void; recognition.barrier = new Promise<void>((resolve) => { release = resolve; });
    capture.frame(); await drain(); detector.transition('start'); recognition.finals.push('Draft stays here.');
    detector.transition('end'); run.engine.mute(true); release(); await drain();
    expect(run.turns).toEqual([]); expect(run.phases.at(-1)).toBe('paused');
    run.engine.speak('Closing output.'); const stale = fixture.outputs[0]!; run.engine.dispose();
    const previous = [...run.phases]; stale.events.started(); stale.end();
    expect(run.phases).toEqual(previous);
  });

  it('uses two complete Flux provider endpoints on one socket and never submits local-VAD partials', async () => {
    const sockets: Socket[] = [];
    class Socket {
      static OPEN = 1; readyState = 1; bufferedAmount = 0;
      onmessage?: (event: { data: string }) => void; onclose?: () => void;
      send = vi.fn(); close = vi.fn();
      constructor() { sockets.push(this); queueMicrotask(() => this.event({ type: 'ready', sampleRate: 16000 })); }
      event(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
    }
    vi.stubGlobal('WebSocket', Socket);
    const run = setup(); await run.engine.start({ ...preferences, recognition: 'deepgram' }, 'one-conversation');
    const socket = sockets[0]!;
    for (const text of ['One coherent premium turn.', 'Another coherent premium turn.']) {
      capture.frame(); await drain(); detector.transition('start');
      socket.event({ type: 'stt', text: '', final: false, turnComplete: false, started: true });
      socket.event({ type: 'stt', text: text.slice(0, 8), final: false, turnComplete: false });
      const before = run.turns.length; detector.transition('end'); await drain();
      expect(run.turns).toHaveLength(before);
      socket.event({ type: 'stt', text, final: true, turnComplete: true });
      socket.event({ type: 'stt', text, final: true, turnComplete: true });
      expect(run.turns).toHaveLength(before + 1);
      run.engine.speak('An answer.'); run.engine.responseDone(); fixture.outputs.at(-1)!.end();
      expect(run.phases.at(-1)).toBe('listening');
    }
    expect(run.turns).toEqual(['One coherent premium turn.', 'Another coherent premium turn.']);
    expect(microphone).toHaveBeenCalledTimes(1); expect(sockets).toHaveLength(1);
    expect(socket.send.mock.calls.some(([message]) => typeof message === 'string')).toBe(false);
  });
});
