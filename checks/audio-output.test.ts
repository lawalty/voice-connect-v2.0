import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioURL, BrowserOutput, PremiumOutput } from '../client/audio/output';
import { PLAYBACK_WINDOW_BYTES, PLAYBACK_FRAME_BYTES } from '../contract/audio-flow';

const BROWSER_PREFERENCES = { browserVoice: '' };

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('playback cancellation', () => {
  it('discards queued browser speech and ignores late native callbacks', () => {
    const utterances: { onstart?(): void; onend?(): void }[] = [];
    const synthesis = { speak: (utterance: object) => utterances.push(utterance), cancel: vi.fn(), getVoices: () => [] };
    vi.stubGlobal('window', { speechSynthesis: synthesis }); vi.stubGlobal('speechSynthesis', synthesis);
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(readonly text: string) {} });
    const events = { started: vi.fn(), ended: vi.fn(), error: vi.fn() };
    const output = new BrowserOutput(BROWSER_PREFERENCES, events);
    output.enqueue('First sentence.'); output.enqueue('Queued second sentence.'); output.finish();
    const stale = utterances[0]!;
    output.cancel(); stale.onstart?.(); stale.onend?.();
    expect(synthesis.cancel).toHaveBeenCalledOnce(); expect(utterances).toHaveLength(1);
    expect(events.started).not.toHaveBeenCalled(); expect(events.ended).not.toHaveBeenCalled();
  });

  it('silences PCM locally before network interrupt and never plays late provider bytes', () => {
    const operations: string[] = [], sockets: FakeSocket[] = [], sources: { stop: ReturnType<typeof vi.fn> }[] = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 1; binaryType = ''; onmessage?: (event: { data: string | ArrayBuffer }) => void;
      onerror?: () => void; onclose?: () => void;
      constructor(readonly url: string) { sockets.push(this); }
      send(value: string) { operations.push(JSON.parse(value).type); }
      close() { operations.push('close'); }
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('location', { href: 'https://voice.test/', protocol: 'https:' });
    const context = {
      currentTime: 2, destination: {},
      createBuffer: (_channels: number, length: number, rate: number) => ({ duration: length / rate, getChannelData: () => new Float32Array(length) }),
      createBufferSource: () => {
        const source = { buffer: undefined, connect() {}, disconnect() {}, start() {}, stop: vi.fn(() => operations.push('stop')) };
        sources.push(source); return source;
      },
    } as unknown as AudioContext;
    const events = { started: vi.fn(), ended: vi.fn(), error: vi.fn(), reference: vi.fn(), cancelled: vi.fn() };
    const output = new PremiumOutput(context, 'conversation', 'fish-reference-id', events);
    output.enqueue('A reply.'); output.finish();
    const socket = sockets[0]!;
    socket.onmessage!({ data: JSON.stringify({ type: 'ready', sampleRate: 24000 }) });
    expect(operations).toEqual(['speak', 'flush']);
    const pcm = new ArrayBuffer(4800); new DataView(pcm).setInt16(0, 16384, true);
    socket.onmessage!({ data: pcm });
    expect(sources).toHaveLength(1);
    expect(events.reference).toHaveBeenCalledOnce();
    expect(events.reference.mock.calls[0]![0]).toMatchObject({ sampleRate: 24000, startTime: 2.025 });
    expect(events.reference.mock.calls[0]![0].samples[0]).toBe(0.5);
    output.cancel();
    expect(events.cancelled).toHaveBeenCalledWith(2);
    expect(operations.indexOf('stop')).toBeLessThan(operations.indexOf('interrupt'));
    socket.onmessage!({ data: new ArrayBuffer(4800) });
    socket.onmessage!({ data: JSON.stringify({ type: 'speech-done' }) });
    expect(sources).toHaveLength(1); expect(sources[0]!.stop).toHaveBeenCalledOnce();
    expect(events.reference).toHaveBeenCalledOnce();
    expect(events.ended).not.toHaveBeenCalled();
  });
});

function browserFixture(activeGesture = false) {
  const utterances: FakeUtterance[] = [], listeners = new Set<() => void>();
  let voices: SpeechSynthesisVoice[] = [{ name: 'Device English', voiceURI: 'device-en', lang: 'en-US', localService: true, default: true }];
  class FakeUtterance {
    voice?: SpeechSynthesisVoice; lang = ''; volume = 1;
    onstart?: () => void; onend?: () => void; onerror?: (event: { error: string }) => void;
    constructor(readonly text: string) {}
  }
  const synthesis = {
    speak: vi.fn((utterance: FakeUtterance) => utterances.push(utterance)), cancel: vi.fn(), getVoices: () => voices,
    addEventListener: vi.fn((_name: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_name: string, listener: () => void) => listeners.delete(listener)),
  };
  vi.stubGlobal('window', { speechSynthesis: synthesis }); vi.stubGlobal('speechSynthesis', synthesis);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance); vi.stubGlobal('navigator', { userActivation: { isActive: activeGesture } });
  const events = { started: vi.fn(), ended: vi.fn(), error: vi.fn() };
  const output = new BrowserOutput(BROWSER_PREFERENCES, events);
  return { output, events, utterances, synthesis, listeners, setVoices: (value: SpeechSynthesisVoice[]) => { voices = value; }, voicesChanged: () => { for (const listener of [...listeners]) listener(); } };
}

describe('browser speech readiness and failure visibility', () => {
  it('reports a missing speech API rather than silently finishing', () => {
    const run = browserFixture(); vi.stubGlobal('SpeechSynthesisUtterance', undefined);
    run.output.enqueue('An audible reply.'); run.output.finish();
    expect(run.events.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('no speech output'));
    expect(run.events.ended).toHaveBeenCalledOnce(); expect(run.synthesis.speak).not.toHaveBeenCalled();
  });

  it('fails a no-callback speech request visibly and suppresses its queued text and late callbacks', async () => {
    vi.useFakeTimers(); const run = browserFixture();
    run.output.enqueue('First reply.'); run.output.enqueue('Queued reply.'); run.output.finish();
    const stale = run.utterances[0]!;
    await vi.advanceTimersByTimeAsync(8001);
    expect(run.events.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('did not report a start'));
    expect(run.synthesis.cancel).toHaveBeenCalledOnce(); expect(run.events.ended).toHaveBeenCalledOnce();
    stale.onstart?.(); stale.onend?.(); stale.onerror?.({ error: 'synthesis-failed' });
    run.output.enqueue('Late streamed fragment.'); run.output.finish();
    expect(run.utterances).toHaveLength(1); expect(run.events.started).not.toHaveBeenCalled();
    expect(run.events.error).toHaveBeenCalledOnce(); expect(run.events.ended).toHaveBeenCalledOnce();
  });

  it('keeps not-allowed distinct and never retries it as paid speech', () => {
    const run = browserFixture(); run.output.enqueue('A reply.');
    run.utterances[0]!.onerror?.({ error: 'not-allowed' }); run.output.finish();
    expect(run.events.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('not-allowed'));
    expect(run.events.error).toHaveBeenCalledWith(expect.stringContaining('Tap Test speaker'));
    expect(run.events.started).not.toHaveBeenCalled(); expect(run.events.ended).toHaveBeenCalledOnce();
  });

  it('reports synchronous platform rejection and unexpected cancellation as failures', () => {
    const rejected = browserFixture(); rejected.synthesis.speak.mockImplementation(() => { throw new DOMException('blocked', 'NotAllowedError'); });
    rejected.output.enqueue('A reply.'); expect(rejected.events.error).toHaveBeenCalledWith(expect.stringContaining('not-allowed'));
    const canceled = browserFixture(); canceled.output.enqueue('A reply.'); canceled.utterances[0]!.onerror?.({ error: 'canceled' });
    expect(canceled.events.error).toHaveBeenCalledWith(expect.stringContaining('(canceled)'));
  });

  it('waits for asynchronous voices outside a gesture and selects a local English voice when ready', () => {
    vi.useFakeTimers(); const run = browserFixture(); run.setVoices([]);
    run.output.enqueue('A reply.'); expect(run.utterances).toHaveLength(0); expect(run.listeners.size).toBe(1);
    const voice = { name: 'Offline English', voiceURI: 'offline-en', lang: 'en-US', localService: true, default: true };
    run.setVoices([voice]); run.voicesChanged();
    expect(run.utterances).toHaveLength(1); expect(run.utterances[0]!.voice).toBe(voice); expect(run.listeners.size).toBe(0);
    run.output.dispose();
  });

  it('preserves a direct gesture and uses a bounded default-voice attempt if inventory stays empty', async () => {
    vi.useFakeTimers(); const gesture = browserFixture(true); gesture.setVoices([]);
    gesture.output.enqueue('A speaker test.');
    expect(gesture.utterances).toHaveLength(1); expect(gesture.synthesis.addEventListener).not.toHaveBeenCalled(); gesture.output.dispose();
    const deferred = browserFixture(false); deferred.setVoices([]); deferred.output.enqueue('A reply.');
    await vi.advanceTimersByTimeAsync(1201);
    expect(deferred.utterances).toHaveLength(1); expect(deferred.utterances[0]!.voice).toBeUndefined();
    expect(deferred.events.error).not.toHaveBeenCalled(); deferred.output.dispose();
  });

  it('cancels a pending voice inventory wait without resurrecting speech', async () => {
    vi.useFakeTimers(); const run = browserFixture(); run.setVoices([]); run.output.enqueue('Do not play.');
    run.output.cancel(); run.voicesChanged(); await vi.advanceTimersByTimeAsync(10000);
    expect(run.listeners.size).toBe(0); expect(run.utterances).toHaveLength(0);
    expect(run.events.started).not.toHaveBeenCalled(); expect(run.events.error).not.toHaveBeenCalled();
  });

  it('bounds a started utterance that never ends and ignores stale events from an earlier chunk', async () => {
    vi.useFakeTimers(); const run = browserFixture();
    run.output.enqueue('First sentence.'); run.output.enqueue('Second sentence.'); run.output.finish();
    const first = run.utterances[0]!; first.onstart?.(); first.onend?.();
    expect(run.utterances).toHaveLength(2);
    first.onstart?.(); first.onend?.(); first.onerror?.({ error: 'synthesis-failed' });
    expect(run.events.started).toHaveBeenCalledOnce(); expect(run.events.error).not.toHaveBeenCalled();
    run.utterances[1]!.onstart?.(); await vi.advanceTimersByTimeAsync(60001);
    expect(run.events.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('stopped responding'));
    expect(run.events.ended).toHaveBeenCalledOnce();
  });

  it('does not label end-without-start as successful playback and clears healthy timers', async () => {
    vi.useFakeTimers(); const invalid = browserFixture(); invalid.output.enqueue('A reply.'); invalid.utterances[0]!.onend?.();
    expect(invalid.events.error).toHaveBeenCalledWith(expect.stringContaining('without reporting a start'));
    const healthy = browserFixture(); healthy.output.enqueue('An audible test.'); healthy.output.finish();
    healthy.utterances[0]!.onstart?.(); healthy.utterances[0]!.onend?.(); await vi.advanceTimersByTimeAsync(60001);
    expect(healthy.events.started).toHaveBeenCalledOnce(); expect(healthy.events.ended).toHaveBeenCalledOnce();
    expect(healthy.events.error).not.toHaveBeenCalled();
  });
});

function pcmFixture() {
  const sockets: Socket[] = [], sources: Source[] = [], operations: string[] = [];
  class Socket {
    static OPEN = 1; readyState = 1; binaryType = '';
    onmessage?: (event: { data: string | ArrayBuffer }) => void; onclose?: () => void;
    send = vi.fn((message: string) => operations.push(JSON.parse(message).type)); close = vi.fn();
    constructor(readonly url: string) { sockets.push(this); }
    event(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
    pcm(bytes = 4800) { this.onmessage?.({ data: new ArrayBuffer(bytes) }); }
  }
  class Source {
    buffer?: object; onended?: () => void;
    connect() {} disconnect() {}
    start = vi.fn(); stop = vi.fn(() => operations.push('stop'));
  }
  vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('location', { href: 'https://voice.test/', protocol: 'https:' });
  const context = {
    currentTime: 2, state: 'running', destination: {},
    createBuffer: (_channels: number, length: number, rate: number) => ({ duration: length / rate, getChannelData: () => new Float32Array(length) }),
    createBufferSource: () => { const source = new Source(); sources.push(source); return source; },
  };
  const events = { started: vi.fn(), ended: vi.fn(), error: vi.fn() };
  const output = new PremiumOutput(context as unknown as AudioContext, 'conversation-id', 'voice-reference', events);
  return { output, sockets, sources, context, events, operations };
}

describe('Fish PCM output lifecycle', () => {
  it('streams a multi-minute reply through a four-second window and acknowledges only finished playback', () => {
    const run = pcmFixture(); run.output.enqueue('The beginning of a long reply.');
    const socket = run.sockets[0]!;
    socket.event({ type: 'ready', sampleRate: 24000, playbackWindowBytes: PLAYBACK_WINDOW_BYTES });
    expect(JSON.parse(socket.send.mock.calls[0]![0])).toEqual({ type: 'playback', playedBytes: 0 });
    socket.pcm(PLAYBACK_FRAME_BYTES);
    expect(run.events.started).toHaveBeenCalledOnce(); expect(run.events.ended).not.toHaveBeenCalled();
    expect(socket.send.mock.calls.filter(([value]) => JSON.parse(value).type === 'playback')).toHaveLength(1);
    run.output.enqueue('The ending of the long reply.'); run.output.finish();
    let consumed = 0;
    for (let n = 0; n < 900; n++) {
      if (n) socket.pcm(PLAYBACK_FRAME_BYTES);
      run.context.currentTime += 0.2; run.sources[n]!.onended?.(); consumed += PLAYBACK_FRAME_BYTES;
      expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({ type: 'playback', playedBytes: consumed });
    }
    socket.event({ type: 'speech-done' });
    expect(run.events.error).not.toHaveBeenCalled(); expect(run.events.ended).toHaveBeenCalledOnce();
  });

  it('does not time out in a tool gap or return playback credit after cancellation', async () => {
    vi.useFakeTimers(); const run = pcmFixture(); run.output.enqueue('Let me check.');
    const socket = run.sockets[0]!;
    socket.event({ type: 'ready', sampleRate: 24000, playbackWindowBytes: PLAYBACK_WINDOW_BYTES });
    socket.pcm(); run.sources[0]!.onended?.();
    await vi.advanceTimersByTimeAsync(60000); expect(run.events.error).not.toHaveBeenCalled();
    run.output.enqueue('I found the answer.'); socket.pcm(); run.output.cancel();
    const sends = socket.send.mock.calls.length; run.sources[1]!.onended?.();
    expect(socket.send.mock.calls.length).toBe(sends); expect(run.events.ended).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects audio beyond the negotiated window instead of allowing unbounded allocation', () => {
    const run = pcmFixture(); run.output.enqueue('A reply.');
    const socket = run.sockets[0]!;
    socket.event({ type: 'ready', sampleRate: 24000, playbackWindowBytes: PLAYBACK_WINDOW_BYTES });
    socket.pcm(PLAYBACK_WINDOW_BYTES); socket.pcm(2);
    expect(run.events.error).toHaveBeenCalledWith(expect.stringContaining('pacing was lost'));
    expect(run.sources).toHaveLength(1); expect(run.sources[0]!.stop).toHaveBeenCalledOnce();
  });
  it('routes every TTS request to Fish while preserving the existing Deepgram recognition route', () => {
    vi.stubGlobal('location', { href: 'https://voice.test/', protocol: 'https:' });
    const tts = new URL(audioURL('tts', 'conversation-id', 'fish-reference-id'));
    expect(tts.protocol).toBe('wss:'); expect(tts.searchParams.get('kind')).toBe('tts');
    expect(tts.searchParams.get('provider')).toBe('fish'); expect(tts.searchParams.get('voice')).toBe('fish-reference-id');
    const stt = new URL(audioURL('stt', 'conversation-id'));
    expect(stt.searchParams.get('kind')).toBe('stt'); expect(stt.searchParams.has('provider')).toBe(false);
    expect(stt.searchParams.has('voice')).toBe(false);
  });
  it('routes Fish explicitly and streams text through the same flush and local cancellation protocol', () => {
    const run = pcmFixture(); run.output.enqueue('One sentence.'); run.output.enqueue('Another sentence.'); run.output.finish();
    const socket = run.sockets[0]!, url = new URL(socket.url);
    expect(url.searchParams.get('provider')).toBe('fish'); expect(url.searchParams.get('voice')).toBe('voice-reference');
    expect(url.searchParams.get('conversationId')).toBe('conversation-id');
    socket.event({ type: 'ready', sampleRate: 24000 });
    expect(run.operations).toEqual(['speak', 'speak', 'flush']);
    socket.pcm(); expect(run.events.started).toHaveBeenCalledOnce();
    run.output.cancel();
    expect(run.operations.indexOf('stop')).toBeLessThan(run.operations.indexOf('interrupt'));
    socket.pcm(); socket.event({ type: 'speech-done' });
    expect(run.sources).toHaveLength(1); expect(run.events.ended).not.toHaveBeenCalled();
  });

  it('ends only after all received Fish audio finishes', () => {
    const run = pcmFixture(); run.output.enqueue('An answer.'); run.output.finish();
    const socket = run.sockets[0]!;
    socket.event({ type: 'ready', sampleRate: 24000 }); socket.pcm(); socket.event({ type: 'speech-done' });
    expect(run.events.ended).not.toHaveBeenCalled(); run.sources[0]!.onended?.();
    expect(run.events.ended).toHaveBeenCalledOnce(); expect(run.events.error).not.toHaveBeenCalled();
  });

  it('fails a ready connection that produces no playable audio and ignores late provider data', async () => {
    vi.useFakeTimers(); const run = pcmFixture(); run.output.enqueue('A reply.'); run.output.finish();
    const socket = run.sockets[0]!; socket.event({ type: 'ready', sampleRate: 24000 });
    socket.pcm(3); socket.pcm(0); await vi.advanceTimersByTimeAsync(15001);
    expect(run.events.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('no playable audio'));
    socket.pcm(); run.output.enqueue('A late fragment.'); run.output.finish();
    expect(run.sources).toHaveLength(0); expect(run.events.ended).toHaveBeenCalledOnce();
  });

  it('rejects unsupported sample rates and an empty finished stream', () => {
    const badRate = pcmFixture(); badRate.output.enqueue('A reply.'); badRate.sockets[0]!.event({ type: 'ready', sampleRate: 192000 });
    expect(badRate.events.error).toHaveBeenCalledWith(expect.stringContaining('unsupported audio rate'));
    const empty = pcmFixture(); empty.output.enqueue('A reply.'); empty.output.finish();
    empty.sockets[0]!.event({ type: 'ready', sampleRate: 24000 }); empty.sockets[0]!.event({ type: 'speech-done' });
    expect(empty.events.error).toHaveBeenCalledWith(expect.stringContaining('no playable audio'));
    expect(empty.events.started).not.toHaveBeenCalled();
  });

  it('reports suspended output instead of claiming scheduled audio played', () => {
    const run = pcmFixture(); run.context.state = 'suspended'; run.output.enqueue('A reply.');
    run.sockets[0]!.event({ type: 'ready', sampleRate: 24000 }); run.sockets[0]!.pcm();
    expect(run.events.error).toHaveBeenCalledWith(expect.stringContaining('suspended'));
    expect(run.events.started).not.toHaveBeenCalled(); expect(run.sources).toHaveLength(0);
  });

  it('bounds a provider stream that never finishes and cancels scheduled audio', async () => {
    vi.useFakeTimers(); const run = pcmFixture(); run.output.enqueue('A reply.'); run.output.finish();
    run.sockets[0]!.event({ type: 'ready', sampleRate: 24000 }); run.sockets[0]!.pcm();
    await vi.advanceTimersByTimeAsync(15001);
    expect(run.events.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('stopped responding'));
    expect(run.sources[0]!.stop).toHaveBeenCalledOnce(); expect(run.events.ended).toHaveBeenCalledOnce();
  });
});
