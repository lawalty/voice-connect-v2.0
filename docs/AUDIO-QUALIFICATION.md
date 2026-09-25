# Audio qualification

Measured on September 24, 2026 with the repository's pinned dependencies, Windows host, headless Playwright Chromium, and synthetic capture. These results qualify the implementation and browser WASM integration; they do **not** qualify a physical Android phone, car, Bluetooth route, speaker echo cancellation, or production speech-provider account.

## Reproduce

```sh
npm run prepare:assets
npm run check
npx vitest run checks/audio.test.ts checks/audio-output.test.ts checks/audio-scenarios.test.ts checks/audio-adapters.test.ts checks/audio-continuous.test.ts checks/audio-diagnostics.test.ts checks/audio-vosk-broker.test.ts
node checks/audio-browser.mjs
```

The browser check starts its own Vite server on `127.0.0.1:5192`. It downloads the public [Vosk example WAV](https://github.com/alphacep/vosk-api/blob/master/python/example/test.wav) into ignored `.local/audio-check/`, uses a temporary browser profile, and never submits a turn to OpenClaw or calls a paid speech provider. Fixture SHA-256: `dcfea5712c43a43ba7ae8083afb39d36993e5a69c46e88b68aaa72b65cb615bb`.

## Proven results

- TypeScript and production Vite build pass. Fifty-four deterministic tests cover streaming resampling across block boundaries, signed PCM encoding, noise-floor adaptation, speech hysteresis, evidence-only acoustic signals, coherent transcript accumulation, unresolved-tail rejection, cumulative speech snapshots, final sentence flushing, cancellation of late native/provider playback callbacks, independent recognizer lifecycle races, broker drain/final acknowledgements, diagnostics privacy/bounds, continuous automatic turns, and the annotated scenario replays below.
- Real Chromium loaded the verified 41,706,199-byte Vosk archive, initialized its WASM recognizer and the Silero ONNX worker, captured through `AudioWorklet`, and reached listening only after both engines were ready. A 1.2-second silent capture produced 39–40 signal callbacks across successful runs and no submitted turn. Callback count includes lifecycle signals; it is not a latency benchmark.
- Real Chromium also passed **two automatic turns in one capture session, with no Finish call**. An `AudioContext` played the first 3.5 seconds of the public WAV into a `MediaStreamAudioDestinationNode` supplied to `getUserMedia`. Real capture Worklet, Silero inference, Vosk recognition, and `VoiceEngine` produced `one zero zero zero one` once per turn, then returned to listening after each streamed synthetic reply. There were two finalizations, two submitted turns, one capture acquisition, and no engine errors. Browser synthesis start/end callbacks were simulated; this checks playback lifecycle integration, not audible output or acoustic echo cancellation.
- With browser network access disabled after the first initialization, a new Vosk recognizer loaded the cached archive and transcribed the official WAV. Actual result: `one zero zero zero one nah no to i know zero one eight zero three`. The first and last number sequences are asserted. The middle substitutions remain visible: this is a functional test, not an accuracy claim.
- Removing the downloaded model cleared its verified archive cache and Vosk's extracted `/vosk` IndexedDB database. Conversation storage is untouched.

The offline check proves a **warm application can initialize a fresh recognizer from cached model bytes**. It does not prove a cold offline page load, service-worker update recovery, or offline NorthPointe replies. Those require separate qualification; NorthPointe still needs connectivity.

### Production security-policy regression

The initial developer-server check lacked CSP and did not expose a release-blocking incompatibility: the pinned Vosk binding's embedded Emscripten worker uses `new Function` for Embind wrappers. Allowing WebAssembly alone does not permit that JavaScript code generation.

The binding now loads only inside `/audio/vosk.worker.js`, an external classic broker worker. Only that exact worker response receives the limited `unsafe-eval` exception; its nested blob worker inherits the broker policy. The application document and ordinary runtime-script responses retain strict CSP without JavaScript `unsafe-eval`. The broker accepts a verified same-origin model blob, bounded PCM frames, finalize, and stop controls; it accepts no source code or arbitrary script URLs.

`audio-browser.mjs` now applies the production document and broker policies, COOP, and COEP. An externally loaded probe confirms that the document rejects `Function(...)`. Real capture/Vosk/Silero initialization then succeeds, `window.Vosk` remains absent, and a fresh broker transcribes the fixture after browser networking is disabled. The service worker preserves the broker response and its CSP headers in the exact runtime allowlist. These local policy checks are required alongside the real deployed HTTPS check; development-server success alone is insufficient.

### Annotated scenario counts

Both seeded replays run the production noise estimator, turn detector, and transcript commit gate with a simulated 32 ms audio clock and no wall-clock sleeps.

| Replay | Measured result |
| --- | --- |
| 100 annotated turns, seven changing ambient levels, brief low-confidence phonemes, 224–704 ms thinking pauses, and isolated 64 ms false-probability spikes | 100 speech starts, 100 endpoints, 100 complete submissions; **0 false starts, 0 premature endpoints, 0 missed turns, 0 duplicate submissions**. Every submitted phrase matches its complete annotated turn. |
| 600,000 ms of nonspeech, changing ambient levels, isolated probability spikes, and loud low-probability thumps | **0 speech starts, 0 endpoints, 0 submissions**. |
| Native speech and PCM cancellation mocks | Native cancellation occurs synchronously; local PCM stop occurs before the provider interrupt command. Late native callbacks and late provider bytes produce **0 resumed utterances or new playback sources**. |

These are acoustic-feature fixtures with supplied RMS levels, speech probabilities, and transcript segments. They test boundary policy and accumulation under known evidence; they do **not** measure Silero's real-noise classification, STT hallucinations, semantic completeness, physical cancellation latency, or noisy-car accuracy. The fixture intentionally does not claim that longer thinking pauses or sustained classifier false positives are solved. Cancellation checks prove synchronous call ordering and stale-generation rejection, not a measured microphone-to-speaker delay.

### Continuous-turn races

Nine deterministic `VoiceEngine` tests exercise automatic local endpoints and premium provider endpoints without a Finish action. They verify two complete turns on one capture session, return to listening after output, one callback per complete provider turn, no submission of provider partials, and preservation of words spoken during interruption. Late playback callbacks cannot overwrite the next listening/hearing state or reactivate a disposed engine.

Local finalization now retains up to four seconds of PCM while the recognizer drains and acknowledges. If speech resumes before that boundary is confirmed, it retains the stable transcript and replays the buffered continuation into the fresh recognizer, producing one complete turn. Recognition and VAD acknowledgements come from separate workers: automatic finalization therefore fences the fixed VAD sequence already submitted at recognition acknowledgement, with a 600 ms limit, before deciding whether speech resumed. Tests explicitly deliver recognition acknowledgement before the delayed VAD onset. A missing VAD acknowledgement, capture stop, or mute cannot send the draft; timeout pauses capture for review. This is a bounded race fix, not semantic endpoint detection or a guarantee for arbitrarily long thinking pauses.

## Supported paths and deliberate limits

| Selection | Behavior and qualification limit |
| --- | --- |
| Browser recognition + either output | Tap-to-talk. The browser may process audio through its vendor. Native recording duration, availability, concurrent microphone capture, and audio-track input differ by browser. Unexpected native end preserves the draft for explicit send; it never blindly restarts or submits a partial. If microphone sharing fails, the next attempt disables the independent visualizer. |
| Local Vosk + either output | Explicit model download; browser WASM, 16 kHz mono input, worker recognition, local Silero VAD, noise adaptation, bounded onset prebuffer. Automatic conversation uses a 900 ms silence candidate after speech detection, finalized recognition, and a bounded VAD fence. Recognition segments accumulate into one application turn. Capture stays available through thinking/playback and rearms after output; no repeated Finish action is required. This does not prove semantic completeness or noisy-car accuracy. |
| Deepgram recognition + either output | Same controlled microphone capture; 16 kHz PCM in 80 ms WebSocket frames through the authenticated server. Provider end-of-turn events can commit in hands-free mode; manual mode retains segments until Finish. Only protocol and local lifecycle behavior are tested without a provider key. Live quality, availability, latency, billing, and current account entitlement remain unverified. |
| Browser output | Sentence-sized native utterances; cancellation is immediate locally. Native voices expose no PCM, dependable acoustic echo reference, or uniformly reliable word timing. No synthetic playback measurements are presented as real acoustic evidence. |
| Fish Audio output | 24 kHz PCM playback, local source cancellation before the network interrupt, bounded buffering, and generation guards that reject late audio. Requires an explicitly configured API key and voice ID. Physical audibility remains a separate gate. |

Recognition and output are independently selectable. Deepgram is recognition-only; Vosk remains cached when switching providers. Automatic Vosk/Deepgram mode hides Finish, while manual/browser fallback retains explicit submission. Browser recognition is not advertised as hands-free. Local or premium recognition with browser speech can attempt hands-free interruption, but native TTS echo cancellation depends on the device. Headphones and speakerphone must each be tested physically; no browser API guarantees that the native voice is part of its echo-cancellation reference.

`BrowserRecognizer`, `LocalRecognizer`, and `FluxRecognizer` independently implement `SpeechRecognizer`: lifecycle, normalized PCM input, running status, and capability reporting. Browser session events and Flux WebSocket/framing logic live in their adapters. `VoiceEngine` handles shared capture, transcript accumulation, turn policy, and output orchestration. Capability `available` reports required browser primitives; it does not claim a downloaded model, valid provider credential, or physical hands-free qualification.

The tested stateful 16 kHz resampler now runs inside the bundled capture `AudioWorklet`, off the UI thread. It transfers bounded 512-sample blocks. The UI thread performs message routing and bounded buffering; the separate Silero worker performs inference. The production capture script is a hashed `/assets/capture.worklet-*.js` resource; the earlier `/audio/capture.js` is no longer used.

## Local device diagnostics

`VoiceEngine.diagnostics()` returns at most 160 in-memory, allowlisted events for the most recent voice session. They include reported microphone settings, provider initialization duration, endpoint request/acknowledgement timing, output callbacks, local cancellation-call duration, and capture/backpressure failures. Snapshots are defensive copies; nothing is persisted or uploaded by this buffer. Runtime validation rejects transcript/audio data, device identifiers, labels, arbitrary strings, unknown fields, nonfinite numbers, and caller-supplied getters.

These timings support device qualification but need precise interpretation: endpoint duration begins at the explicit finalization request and excludes the preceding VAD silence window; native output starts at its browser callback, while premium output starts when its first PCM buffer is scheduled; interruption duration measures the synchronous local cancellation call, not audible hardware stop latency. Missing microphone settings remain unknown. Six tests verify the diagnostics bounds, allowed fields, defensive snapshots, and monotonic relative timing.

## Failure behavior and remaining acceptance

Microphone loss, hidden-page capture, unexpected audio gaps, suspended audio, inference backlog, and provider disconnects pause capture and preserve an unsent draft. The engine does not automatically submit uncertain fragments or retry a turn that might already have been accepted. A stable prefix with an unresolved transcript tail also remains a draft. User-visible recovery requires review and an explicit recording restart. Browser background or locked-screen operation, Bluetooth routing, and car integration are not promised.

Noise-floor adaptation excludes probable foreground speech. The orb receives energy, speech probability, noise floor, pitch when measurable, and confidence; it receives **no emotion label**. Low-confidence audio produces little or no acoustic confidence. Visual idle motion is a separate presentation behavior, not evidence of a detected feeling.

Before claiming the requested mobile experience, run the physical acceptance scenarios on the owner's actual Android/browser/headset: parked noisy-car turn endings, short and emotional utterances, speakerphone self-echo, interruption while NorthPointe speaks, text/voice switching, short network drops, permission changes, lock/unlock, and Bluetooth route changes. Record false starts, missed words, premature endings, duplicate turns, and interruption latency. None of those physical results is inferred from headless tests.

## Material implementation risks

- The [Vosk browser binding](https://github.com/ccoreilly/vosk-browser) is community maintained and pinned to `0.0.8`; its browser binary is older than the native API. The adapter does not assume newer native endpoint-control methods exist. Vosk endpoint results are not semantic turn decisions.
- The small English model trades download size and device memory against accuracy. Proper names, accents, noisy microphones, and free conversational speech need evaluation. Warmup and memory pressure can be significant on low-end phones; overload pauses instead of dropping samples silently.
- The archive is served with a `.tar.gz.bin` suffix because generic static servers can otherwise assign `Content-Encoding: gzip` and transparently decompress bytes before hash verification. The manifest's URL, byte count, and SHA-256 are authoritative.
- ONNX uses a single-thread WASM backend. Its matching factory is bundled; only the WASM binary URL is overridden. No WebGPU requirement or cross-origin-isolated multithreading requirement is introduced.
- Downloaded artifacts and browser caches can be evicted. Missing or corrupt archives fail visibly; extracted binding data is isolated to the exact `/vosk` database. Closing other tabs may be necessary before deleting that database.

## Fish Audio and silent-output diagnosis

Fish Audio is a separately selected premium output provider using the owner's voice ID, an encrypted server-side API key, incremental text, and 24 kHz mono PCM playback. Eleven server-provider fixture tests verify MessagePack framing, flush versus cancellation, authentication expiry, bounded buffering and timeouts. Live Fish voice access and audio quality remain unverified without the owner's credential.

Device speech now has bounded voice-inventory initialization and no-start/end watchdogs. Native errors such as not-allowed stay visible; neither a reported start nor an ended event proves sound was audible. Settings provides an explicit speaker test and separate user audibility confirmation. Opening Settings stops capture and current playback while retaining the spoken draft.

An active voice reply discovered by history reconciliation is no longer marked as already spoken. The subsequent complete event can deliver its unsaid suffix; old history after reconnect remains silent. A browser regression exercises this ordering. This corrects a source-confirmed silence path, but is not a confirmed diagnosis of the Android user report.
