import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcousticSignal, RecognizerCapabilities, RecognizerEvents, SpeechPreferences, VoicePhase } from '../contract/types';

const fixture = vi.hoisted(() => ({ recognizers: [] as FakeRecognizer[], outputs: [] as FakeOutput[], cues: [] as ('on' | 'off')[] }));
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
  readonly events: OutputEvents;
  constructor(_preferences: SpeechPreferences | AudioContext, eventsOrConversation: OutputEvents | string, _voice?: string, premiumEvents?: OutputEvents) {
    this.events = typeof eventsOrConversation === 'string' ? premiumEvents! : eventsOrConversation; fixture.outputs.push(this);
  }
  enqueue(text: string) { this.words.push(text); this.events.started(); }
  finish() { this.finished = true; }
  cancel = vi.fn(); dispose = vi.fn();
  end() { this.events.ended(); }
}
vi.doMock('../client/audio/vosk', () => ({ LocalRecognizer: FakeRecognizer }));
vi.doMock('../client/audio/output', () => ({ BrowserOutput: FakeOutput, PremiumOutput: FakeOutput, audioURL: () => 'wss://voice.test/audio' }));
vi.doMock('../client/audio/cues', async () => ({
  ...await vi.importActual<typeof import('../client/audio/cues')>('../client/audio/cues'),
  ListeningCues: class {
    async prepare() {}
    play(kind: 'on' | 'off') { fixture.cues.push(kind); }
    dispose() {}
  },
}));
const { VoiceEngine } = await import('../client/audio/engine');

const signal: AcousticSignal = { energy: 0.4, speechProbability: 0.95, noiseFloor: 0.005, pitch: null, confidence: 0.7 };
const preferences: SpeechPreferences = { recognition: 'vosk', output: 'browser', browserVoice: '', handsFree: true, keepAwake: false };
let detector: FakeWorker, capture: FakeWorklet, engine: InstanceType<typeof VoiceEngine> | undefined;
let microphone: ReturnType<typeof vi.fn>;
class FakeWorker {
  onmessage?: (event: { data: object }) => void; onerror?: () => void; holdSignals = false;
  nextTransition: 'start' | 'end' | null = null; nextInterruption = false;
  pending: { samples: Float32Array; sequence: number; epoch: number; transition: 'start' | 'end' | null; interruption: boolean }[] = [];
  constructor() { detector = this; }
  postMessage(message: { type: string; sequence?: number; samples?: Float32Array; epoch?: number }) {
    if (message.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
    if (message.type === 'frame') {
      const frame = { samples: message.samples!, sequence: message.sequence!, epoch: message.epoch!, transition: this.nextTransition, interruption: this.nextInterruption };
      this.pending.push(frame); this.nextTransition = null; this.nextInterruption = false;
      if (!this.holdSignals) queueMicrotask(() => { if (this.pending.includes(frame)) this.deliver(frame); });
    }
  }
  private deliver(frame: FakeWorker['pending'][number]) {
    this.pending.splice(this.pending.indexOf(frame), 1);
    this.onmessage?.({ data: { type: 'signal', signal, ...frame } });
  }
  transition(transition: 'start' | 'end' | null, interruption = false) {
    const frame = this.pending[0];
    if (!frame) throw new Error('A VAD transition must acknowledge an actual captured frame');
    frame.transition = transition; frame.interruption = interruption; this.deliver(frame);
  }
  terminate() {}
}
class FakeWorklet {
  port = { onmessage: undefined as ((event: { data: object }) => void) | undefined, postMessage() {} };
  constructor() { capture = this; }
  connect() {} disconnect() {}
  frame(value = 0.25) { this.port.onmessage?.({ data: { samples: new Float32Array(512).fill(value), dropped: 0 } }); }
}
async function drain() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
async function frame(transition: 'start' | 'end' | null = null, value = transition === 'end' ? 0 : 0.25, interruption = false) {
  detector.nextTransition = transition; detector.nextInterruption = interruption;
  capture.frame(value); await drain();
}
function installFluxSocket() {
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1; readyState = 1; bufferedAmount = 0;
    onmessage?: (event: { data: string }) => void; onclose?: () => void;
    send = vi.fn(); close = vi.fn();
    constructor() { sockets.push(this); queueMicrotask(() => this.event({ type: 'ready', sampleRate: 16000 })); }
    event(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
    pcm() { return this.send.mock.calls.flatMap(([payload]) => typeof payload === 'string' ? [] : Array.from(new Int16Array(payload))); }
  }
  vi.stubGlobal('WebSocket', Socket);
  return sockets;
}
function setup() {
  const phases: VoicePhase[] = [], turns: string[] = [], drafts: string[] = [], notices: string[] = [];
  const callbacks = { onPhase: (value: VoicePhase) => phases.push(value), onTurn: (value: string) => turns.push(value), onDraft: (value: string) => drafts.push(value), onSignal: vi.fn(), onError: vi.fn(), onInterrupt: vi.fn(), onNotice: (value: string) => notices.push(value) };
  engine = new VoiceEngine(callbacks);
  return { engine, phases, turns, drafts, notices, callbacks };
}
beforeEach(() => {
  fixture.recognizers.length = 0; fixture.outputs.length = 0; fixture.cues.length = 0;
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
  it('opens Android playback after capture and replaces the route when voice restarts', async () => {
    Object.assign(navigator, { userAgent: 'Mozilla/5.0 (Linux; Android 16)' });
    let captureReady = false;
    const contexts: RoutedContext[] = [];
    class RoutedContext {
      readonly route = captureReady ? 'call' : 'media';
      state = 'running'; sampleRate = 48000; destination = {}; audioWorklet = { addModule: async () => {} };
      onstatechange: (() => void) | null = null;
      close = vi.fn(async () => { this.state = 'closed'; });
      async resume() {}
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      constructor() { contexts.push(this); }
    }
    vi.stubGlobal('AudioContext', RoutedContext);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); microphone.mockClear();
    let allowCapture!: () => void;
    microphone.mockImplementationOnce(() => new Promise(resolve => { allowCapture = () => { captureReady = true; resolve(stream); }; }));
    const run = setup();
    const starting = run.engine.start(preferences, 'one-conversation');
    expect(contexts).toHaveLength(0); // Permission/route selection is still pending.
    allowCapture(); await starting;
    expect(contexts.map(context => context.route)).toEqual(['call']);
    const lateOldEvent = contexts[0]!.onstatechange;
    run.engine.speak('The reply uses this session clock.'); run.engine.responseDone();
    fixture.outputs[0]!.end();
    expect(contexts).toHaveLength(1); // No per-turn restart or extra playback delay.
    run.engine.stop(); captureReady = false;
    microphone.mockImplementationOnce(async () => { captureReady = true; return stream; });
    await run.engine.start(preferences, 'one-conversation');
    expect(contexts.map(context => context.route)).toEqual(['call', 'call']);
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
    lateOldEvent?.(); // A retired output must not stop the new microphone session.
    expect(run.phases.at(-1)).toBe('listening');
    expect(run.callbacks.onError).not.toHaveBeenCalled();
  });

  it('does not open Android playback for denied or cancelled microphone requests', async () => {
    Object.assign(navigator, { userAgent: 'Mozilla/5.0 (Linux; Android 16)' });
    const createContext = vi.fn(); vi.stubGlobal('AudioContext', createContext);
    const run = setup();
    microphone.mockRejectedValueOnce(new Error('Permission denied'));
    await run.engine.start(preferences, 'one-conversation');
    expect(createContext).not.toHaveBeenCalled();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    let resolveCapture!: (value: typeof stream) => void;
    microphone.mockImplementationOnce(() => new Promise(resolve => { resolveCapture = resolve; }));
    const pending = run.engine.start(preferences, 'one-conversation');
    run.engine.stop(); resolveCapture(stream); await pending;
    expect(stream.getTracks()[0].stop).toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
  });

  it('keeps a new recording alive when a cancelled browser microphone request rejects late', async () => {
    vi.stubGlobal('SpeechRecognition', class {});
    let rejectOld!: (reason: Error) => void;
    microphone.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
    const run = setup();
    const oldStart = run.engine.start({ ...preferences, recognition: 'browser', handsFree: false }, 'one-conversation');
    run.engine.stop();
    await run.engine.start(preferences, 'one-conversation');
    const currentDetector = detector;
    const terminate = vi.spyOn(currentDetector, 'terminate');
    const currentStream = await microphone.mock.results[1]!.value;
    rejectOld(new Error('Old microphone permission request was denied.'));
    await oldStart;
    expect(currentStream.getTracks()[0].stop).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
    expect(run.phases.at(-1)).toBe('listening');
    expect(run.notices).not.toContain('Live microphone visualization is unavailable with browser speech on this device.');
    await frame('start'); fixture.recognizers[0]!.finals.push('The new recording survives.'); await frame('end');
    expect(run.turns).toEqual(['The new recording survives.']);
    expect(run.callbacks.onError).not.toHaveBeenCalled();
  });

  it('keeps the new speech detector when a cancelled detector startup rejects late', async () => {
    let created = 0;
    vi.stubGlobal('Worker', class extends FakeWorker {
      private readonly holdReady = created++ === 0;
      override postMessage(message: Parameters<FakeWorker['postMessage']>[0]) {
        if (message.type === 'init' && this.holdReady) return;
        super.postMessage(message);
      }
    });
    const run = setup();
    const oldStart = run.engine.start(preferences, 'one-conversation');
    await drain();
    const oldDetector = detector;
    run.engine.stop();
    await run.engine.start(preferences, 'one-conversation');
    const terminate = vi.spyOn(detector, 'terminate');
    oldDetector.onerror?.();
    await oldStart;
    expect(terminate).not.toHaveBeenCalled();
    expect(run.phases.at(-1)).toBe('listening');
    await frame('start'); fixture.recognizers[1]!.finals.push('The new detector survives.'); await frame('end');
    expect(run.turns).toEqual(['The new detector survives.']);
    expect(run.callbacks.onError).not.toHaveBeenCalled();
  });

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
      await frame('start');
      recognition.partial(words.slice(0, 12)); recognition.finals.push(words);
      await frame('end');
      expect(run.turns.at(-1)).toBe(words);
      expect(run.phases.at(-1)).toBe('thinking');
      run.engine.speak('A streamed '); run.engine.speak('reply.'); run.engine.responseDone();
      expect(run.phases.at(-1)).toBe('speaking');
      fixture.outputs.at(-1)!.end();
      expect(run.phases.at(-1)).toBe('listening');
      await frame('end');
    }
    expect(run.turns).toEqual(['The first complete thought.', 'The second complete thought.']);
    expect(recognition.finish).toHaveBeenCalledTimes(2);
    expect(microphone).toHaveBeenCalledTimes(1); expect(recognition.running).toBe(true);
    expect(run.callbacks.onError).not.toHaveBeenCalled(); expect(run.notices).not.toContain(expect.stringMatching(/interrupted|unconfirmed/));
  });

  it('keeps interrupting user words and ignores late playback callbacks while the next turn is heard', async () => {
    const run = setup(); await run.engine.start(preferences, 'one-conversation');
    const recognition = fixture.recognizers[0]!;
    await frame('start'); recognition.finals.push('First request.');
    await frame('end'); run.engine.speak('An unfinished assistant response.');
    const staleOutput = fixture.outputs[0]!;
    await frame('start', 0.4, true); recognition.partial('Actually change');
    expect(staleOutput.cancel).toHaveBeenCalledTimes(1); expect(run.callbacks.onInterrupt).toHaveBeenCalledTimes(1);
    staleOutput.events.started(); staleOutput.end();
    expect(run.phases.at(-1)).toBe('hearing'); expect(run.drafts.at(-1)).toBe('Actually change');
    recognition.finals.push('Actually change the destination.'); await frame('end');
    expect(run.turns).toEqual(['First request.', 'Actually change the destination.']);
    expect(run.callbacks.onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('retracts a tentative endpoint when speech resumes during finalization and preserves buffered initial words', async () => {
    const run = setup(); await run.engine.start(preferences, 'one-conversation');
    const recognition = fixture.recognizers[0]!;
    let release!: () => void; recognition.barrier = new Promise<void>((resolve) => { release = resolve; });
    await frame('start', 0.1); recognition.partial('Please take'); recognition.finals.push('Please take');
    await frame('end'); expect(run.phases.at(-1)).toBe('finalizing');
    const before = recognition.frames.length;
    await frame('start', 0.6); await frame(null, 0.7);
    expect(recognition.frames).toHaveLength(before); expect(run.turns).toEqual([]);
    recognition.barrier = undefined; release(); await drain();
    expect(run.turns).toEqual([]); expect(run.phases.at(-1)).toBe('hearing');
    expect(recognition.frames.slice(before).map((frame) => Number(frame[0]!.toFixed(1)))).toEqual([0.6, 0.7]);
    recognition.partial('the next exit'); recognition.finals.push('the next exit.'); await frame('end');
    expect(run.turns).toEqual(['Please take the next exit.']);
    expect(recognition.finish).toHaveBeenCalledTimes(2);
  });

  it('does not commit an in-flight automatic finalization after capture is stopped', async () => {
    const run = setup(); await run.engine.start(preferences, 'one-conversation');
    const recognition = fixture.recognizers[0]!;
    let release!: () => void; recognition.barrier = new Promise<void>((resolve) => { release = resolve; });
    await frame('start'); recognition.finals.push('Do not submit.');
    await frame('end'); run.engine.stop(); release(); await drain();
    expect(run.turns).toEqual([]); expect(run.phases.at(-1)).toBe('off');
  });

  it('completes a continuation that starts and ends while the earlier finalization is pending', async () => {
    const run = setup(); await run.engine.start(preferences, 'one-conversation');
    const recognition = fixture.recognizers[0]!;
    let release!: () => void; recognition.barrier = new Promise<void>((resolve) => { release = resolve; });
    await frame('start'); recognition.finals.push('Keep the');
    await frame('end'); await frame('start', 0.6);
    await frame('end', 0.7); recognition.finals.push('whole thought.');
    recognition.barrier = undefined; release(); await drain();
    expect(run.turns).toEqual(['Keep the whole thought.']); expect(recognition.finish).toHaveBeenCalledTimes(2);
    expect(run.phases.at(-1)).toBe('thinking');
  });

  it('waits for already-captured VAD frames when recognition acknowledges before the resumed-speech event', async () => {
    const run = setup(); await run.engine.start(preferences, 'one-conversation');
    const recognition = fixture.recognizers[0]!;
    let release!: () => void; recognition.barrier = new Promise<void>((resolve) => { release = resolve; });
    await frame('start'); recognition.finals.push('Please keep');
    await frame('end'); detector.holdSignals = true; capture.frame(0.6); await drain();
    recognition.barrier = undefined; release(); await drain();
    expect(run.turns).toEqual([]); expect(run.phases.at(-1)).toBe('finalizing');
    detector.holdSignals = false; detector.transition('start'); await drain();
    expect(run.turns).toEqual([]); expect(run.phases.at(-1)).toBe('hearing');
    expect(recognition.frames.at(-1)![0]).toBeCloseTo(0.6);
    recognition.finals.push('these words together.'); await frame('end');
    expect(run.turns).toEqual(['Please keep these words together.']);
  });

  it('pauses without submitting if the bounded VAD fence cannot confirm the endpoint', async () => {
    vi.useFakeTimers();
    const run = setup(); await run.engine.start(preferences, 'one-conversation');
    const recognition = fixture.recognizers[0]!;
    let release!: () => void; recognition.barrier = new Promise<void>((resolve) => { release = resolve; });
    await frame('start'); recognition.finals.push('Keep this draft.');
    await frame('end'); detector.holdSignals = true; capture.frame();
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
    await frame('start'); recognition.finals.push('Draft stays here.');
    await frame('end'); run.engine.mute(true); release(); await drain();
    expect(run.turns).toEqual([]); expect(run.phases.at(-1)).toBe('paused');
    run.engine.speak('Closing output.'); const stale = fixture.outputs[0]!; run.engine.dispose();
    const previous = [...run.phases]; stale.events.started(); stale.end();
    expect(run.phases).toEqual(previous);
  });

  it('uses two complete Flux provider endpoints on one socket and never submits local-VAD partials', async () => {
    const sockets = installFluxSocket();
    const run = setup(); await run.engine.start({ ...preferences, recognition: 'deepgram' }, 'one-conversation');
    const socket = sockets[0]!;
    for (const text of ['One coherent premium turn.', 'Another coherent premium turn.']) {
      await frame('start');
      socket.event({ type: 'stt', text: '', final: false, turnComplete: false, started: true });
      socket.event({ type: 'stt', text: text.slice(0, 8), final: false, turnComplete: false });
      const before = run.turns.length; await frame('end');
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

  it('holds local microphone candidates during Fish playback and releases the approved prefix exactly once', async () => {
    const run = setup(); await run.engine.start({ ...preferences, output: 'fish', fishVoice: 'fixture-voice' }, 'one-conversation');
    const recognition = fixture.recognizers[0]!;
    run.engine.speak('The agent is still speaking this sentence.');
    const output = fixture.outputs[0]!;
    await frame('start', 0.1); await frame(null, 0.2); await frame(null, 0.3);
    recognition.partial('Echo must not become a user draft.');
    expect(recognition.frames).toEqual([]);
    expect(run.turns).toEqual([]); expect(run.drafts.at(-1)).toBe('');
    expect(output.cancel).not.toHaveBeenCalled(); expect(run.phases.at(-1)).toBe('speaking');

    await frame('start', 0.4, true);
    expect(output.cancel).toHaveBeenCalledTimes(1); expect(run.callbacks.onInterrupt).toHaveBeenCalledTimes(1);
    expect(recognition.frames.map(samples => Number(samples[0]!.toFixed(1)))).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(recognition.frames.every(samples => samples.length === 512)).toBe(true);
    recognition.partial('Actually please wait');
    output.events.started(); output.end();
    expect(run.phases.at(-1)).toBe('hearing'); expect(run.drafts.at(-1)).toBe('Actually please wait');
    await frame(null, 0.5);
    expect(recognition.frames.map(samples => Number(samples[0]!.toFixed(1)))).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
    recognition.finals.push('Actually please wait for me.'); await frame('end');
    expect(run.turns).toEqual(['Actually please wait for me.']);
  });

  it('rejects raw Deepgram onset, update, and endpoint during playback until local approval preserves the microphone prefix', async () => {
    const sockets = installFluxSocket();
    const run = setup(); await run.engine.start({ ...preferences, recognition: 'deepgram', output: 'fish', fishVoice: 'fixture-voice' }, 'one-conversation');
    const socket = sockets[0]!;
    run.engine.speak('An assistant reply should finish unless the user interrupts.');
    const output = fixture.outputs[0]!;
    await frame('start', 0.1); await frame(null, 0.2); await frame(null, 0.3);
    socket.event({ type: 'stt', text: '', final: false, turnComplete: false, started: true });
    socket.event({ type: 'stt', text: 'An assistant reply', final: false, turnComplete: false });
    socket.event({ type: 'stt', text: 'An assistant reply.', final: true, turnComplete: true });
    expect(socket.pcm()).toHaveLength(1280);
    expect(socket.pcm().every(sample => sample === 0)).toBe(true);
    expect(output.cancel).not.toHaveBeenCalled(); expect(run.callbacks.onInterrupt).not.toHaveBeenCalled();
    expect(run.turns).toEqual([]); expect(run.drafts.at(-1)).toBe(''); expect(run.phases.at(-1)).toBe('speaking');

    await frame('start', 0.4, true); await frame(null, 0.5); await frame(null, 0.6);
    const samples = socket.pcm();
    expect(samples.slice(0, 1536).every(sample => sample === 0)).toBe(true);
    for (const [index, value] of [0.1, 0.2, 0.3, 0.4].entries()) {
      const prefix = samples.slice(1536 + index * 512, 1536 + (index + 1) * 512);
      expect(prefix).toHaveLength(512);
      expect(prefix.every(sample => Math.abs(sample / 32767 - value) < 0.0001)).toBe(true);
      expect(samples.filter(sample => Math.abs(sample / 32767 - value) < 0.0001)).toHaveLength(512);
    }
    expect(output.cancel).toHaveBeenCalledTimes(1); expect(run.callbacks.onInterrupt).toHaveBeenCalledTimes(1);
    socket.event({ type: 'stt', text: '', final: false, turnComplete: false, started: true });
    socket.event({ type: 'stt', text: 'Actually please', final: false, turnComplete: false });
    output.events.started(); output.end();
    expect(run.phases.at(-1)).toBe('hearing'); expect(run.drafts.at(-1)).toBe('Actually please');
    socket.event({ type: 'stt', text: 'Actually please keep those first words.', final: true, turnComplete: true });
    socket.event({ type: 'stt', text: 'Actually please keep those first words.', final: true, turnComplete: true });
    expect(run.turns).toEqual(['Actually please keep those first words.']);
    expect(run.callbacks.onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('ignores detector decisions captured before the reply protection epoch changes', async () => {
    const run = setup(); await run.engine.start(preferences, 'one-conversation');
    detector.holdSignals = true; capture.frame(0.6); await drain();
    run.engine.speak('This reply started after the frame was captured.');
    detector.transition('start', true);
    expect(fixture.outputs[0]!.cancel).not.toHaveBeenCalled();
    expect(fixture.recognizers[0]!.frames).toEqual([]);
    expect(run.phases.at(-1)).toBe('speaking'); expect(run.callbacks.onInterrupt).not.toHaveBeenCalled();
  });

  it.each(['vosk', 'deepgram'] as const)('preserves queued %s frames from the interrupted reply epoch exactly once', async recognitionProvider => {
    const sockets = recognitionProvider === 'deepgram' ? installFluxSocket() : [];
    const run = setup(); await run.engine.start({ ...preferences, recognition: recognitionProvider, output: 'fish', fishVoice: 'fixture-voice' }, 'one-conversation');
    run.engine.speak('A reply with several microphone frames already awaiting analysis.');
    const output = fixture.outputs[0]!;
    await frame(null, 0.1);
    detector.holdSignals = true;
    capture.frame(0.2); capture.frame(0.3); capture.frame(0.4); await drain();
    expect(detector.pending).toHaveLength(3);
    expect(new Set(detector.pending.map(pending => pending.epoch)).size).toBe(1);
    detector.transition('start', true); await drain();
    expect(output.cancel).toHaveBeenCalledTimes(1);
    // These decisions were computed while reply protection was active. They
    // belong to the accepted utterance even though cancellation advanced epoch.
    detector.transition(null, true); detector.transition(null, true); await drain();
    detector.holdSignals = false; await frame(null, 0.5);
    expect(run.callbacks.onInterrupt).toHaveBeenCalledTimes(1); expect(output.cancel).toHaveBeenCalledTimes(1);
    expect(run.phases.at(-1)).toBe('hearing'); expect(detector.pending).toEqual([]);
    if (recognitionProvider === 'vosk') {
      expect(fixture.recognizers[0]!.frames.map(samples => Number(samples[0]!.toFixed(1)))).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
      expect(fixture.recognizers[0]!.frames.every(samples => samples.length === 512)).toBe(true);
    } else {
      // Drain the adapter's real 1280-sample framing with silent continuation.
      await frame(null, 0); await frame(null, 0);
      const samples = sockets[0]!.pcm();
      expect(samples.slice(0, 512).every(sample => sample === 0)).toBe(true);
      for (const [index, value] of [0.1, 0.2, 0.3, 0.4, 0.5].entries()) {
        expect(samples.slice(512 + index * 512, 512 + (index + 1) * 512)
          .every(sample => Math.abs(sample / 32767 - value) < 0.0001)).toBe(true);
        expect(samples.filter(sample => Math.abs(sample / 32767 - value) < 0.0001)).toHaveLength(512);
      }
    }
  });

  it('does not invite a new turn when unmuting during playback or ending the voice session', async () => {
    const run = setup(); await run.engine.start({ ...preferences, output: 'fish', fishVoice: 'fixture-voice', audioCues: true }, 'one-conversation');
    run.engine.speak('The reply is speaking while the microphone is muted and unmuted.');
    const output = fixture.outputs[0]!;
    expect(fixture.cues).toEqual(['on', 'off']); expect(run.phases.at(-1)).toBe('speaking');
    run.engine.mute(true); run.engine.mute(false);
    expect(run.phases.at(-1)).toBe('speaking'); expect(fixture.cues).toEqual(['on', 'off']);
    expect(output.cancel).not.toHaveBeenCalled();
    run.engine.interrupt('manual', false); run.engine.stop();
    expect(run.phases.at(-1)).toBe('off'); expect(fixture.cues).toEqual(['on', 'off']);
    expect(output.cancel).toHaveBeenCalledTimes(1);
    output.events.started(); output.end();
    expect(run.phases.at(-1)).toBe('off'); expect(fixture.cues).toEqual(['on', 'off']);
  });

  it('cues readiness once per turn, submission, playback completion, mute, unmute, and end', async () => {
    const run = setup(); await run.engine.start({ ...preferences, audioCues: true }, 'one-conversation');
    expect(fixture.cues).toEqual(['on']);
    await frame('start'); fixture.recognizers[0]!.partial('One thought');
    expect(fixture.cues).toEqual(['on']);
    fixture.recognizers[0]!.finals.push('One thought.'); await frame('end');
    expect(fixture.cues).toEqual(['on', 'off']);
    run.engine.speak('Here is a reply.'); run.engine.responseDone();
    expect(fixture.cues).toEqual(['on', 'off']);
    fixture.outputs[0]!.end(); expect(fixture.cues).toEqual(['on', 'off', 'on']);
    run.engine.mute(true); expect(fixture.cues).toEqual(['on', 'off', 'on', 'off']);
    run.engine.mute(false); expect(fixture.cues).toEqual(['on', 'off', 'on', 'off', 'on']);
    run.engine.stop(); run.engine.stop();
    expect(fixture.cues).toEqual(['on', 'off', 'on', 'off', 'on', 'off']);
  });

  it('emits no readiness sounds after cues are disabled for the next voice session', async () => {
    const run = setup(); await run.engine.start({ ...preferences, audioCues: true }, 'one-conversation');
    run.engine.stop(); expect(fixture.cues).toEqual(['on', 'off']); fixture.cues.length = 0;
    await run.engine.start({ ...preferences, audioCues: false }, 'one-conversation');
    await frame('start'); fixture.recognizers.at(-1)!.finals.push('A silent cue setting.'); await frame('end');
    run.engine.speak('The reply still uses speech.'); run.engine.responseDone(); fixture.outputs[0]!.end();
    run.engine.mute(true); run.engine.mute(false); run.engine.stop();
    expect(fixture.cues).toEqual([]);
  });
});
