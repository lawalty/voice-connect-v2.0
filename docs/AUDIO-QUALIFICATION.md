# Audio qualification

Measured on September 24, 2026 with the repository's pinned dependencies, Windows host, headless Playwright Chromium, and a fake microphone. These results qualify the implementation and browser WASM integration; they do **not** qualify a physical Android phone, car, Bluetooth route, speaker echo cancellation, or production speech-provider account.

## Reproduce

```sh
npm run prepare:assets
npm run check
npx vitest run checks/audio.test.ts checks/audio-output.test.ts checks/audio-scenarios.test.ts
node checks/audio-browser.mjs
```

The browser check starts its own Vite server on `127.0.0.1:5192`. It downloads the public [Vosk example WAV](https://github.com/alphacep/vosk-api/blob/master/python/example/test.wav) into ignored `.local/audio-check/`, uses a temporary browser profile, and never submits a turn to OpenClaw or calls a paid speech provider. Fixture SHA-256: `dcfea5712c43a43ba7ae8083afb39d36993e5a69c46e88b68aaa72b65cb615bb`.

## Proven results

- TypeScript check passes. Thirteen deterministic tests pass: streaming resampling across block boundaries, signed PCM encoding, noise-floor adaptation, speech hysteresis, evidence-only acoustic signals, coherent transcript accumulation, unresolved-tail rejection, cumulative speech snapshots, final sentence flushing, cancellation of late native/provider playback callbacks, and the annotated scenario replays below.
- Real Chromium loaded the verified 41,706,199-byte Vosk archive, initialized its WASM recognizer and the Silero ONNX worker, captured through `AudioWorklet`, and reached listening only after both engines were ready. A 1.2-second silent capture produced 39–40 signal callbacks across successful runs and no submitted turn. Callback count includes lifecycle signals; it is not a latency benchmark.
- With browser network access disabled after the first initialization, a new Vosk recognizer loaded the cached archive and transcribed the official WAV. Actual result: `one zero zero zero one nah no to i know zero one eight zero three`. The first and last number sequences are asserted. The middle substitutions remain visible: this is a functional test, not an accuracy claim.
- Removing the downloaded model cleared its verified archive cache and Vosk's extracted `/vosk` IndexedDB database. Conversation storage is untouched.

The offline check proves a **warm application can initialize a fresh recognizer from cached model bytes**. It does not prove a cold offline page load, service-worker update recovery, or offline NorthPointe replies. Those require separate qualification; NorthPointe still needs connectivity.

### Annotated scenario counts

Both seeded replays run the production noise estimator, turn detector, and transcript commit gate with a simulated 32 ms audio clock and no wall-clock sleeps.

| Replay | Measured result |
| --- | --- |
| 100 annotated turns, seven changing ambient levels, brief low-confidence phonemes, 224–704 ms thinking pauses, and isolated 64 ms false-probability spikes | 100 speech starts, 100 endpoints, 100 complete submissions; **0 false starts, 0 premature endpoints, 0 missed turns, 0 duplicate submissions**. Every submitted phrase matches its complete annotated turn. |
| 600,000 ms of nonspeech, changing ambient levels, isolated probability spikes, and loud low-probability thumps | **0 speech starts, 0 endpoints, 0 submissions**. |
| Native speech and PCM cancellation mocks | Native cancellation occurs synchronously; local PCM stop occurs before the provider interrupt command. Late native callbacks and late provider bytes produce **0 resumed utterances or new playback sources**. |

These are acoustic-feature fixtures with supplied RMS levels, speech probabilities, and transcript segments. They test boundary policy and accumulation under known evidence; they do **not** measure Silero's real-noise classification, STT hallucinations, semantic completeness, physical cancellation latency, or noisy-car accuracy. The fixture intentionally does not claim that longer thinking pauses or sustained classifier false positives are solved. Cancellation checks prove synchronous call ordering and stale-generation rejection, not a measured microphone-to-speaker delay.

## Supported paths and deliberate limits

| Selection | Behavior and qualification limit |
| --- | --- |
| Browser recognition + either output | Tap-to-talk. The browser may process audio through its vendor. Native recording duration, availability, concurrent microphone capture, and audio-track input differ by browser. Unexpected native end preserves the draft for explicit send; it never blindly restarts or submits a partial. If microphone sharing fails, the next attempt disables the independent visualizer. |
| Local Vosk + either output | Explicit model download; browser WASM, 16 kHz mono input, worker recognition, local Silero VAD, noise adaptation, bounded onset prebuffer. Recognizer endpoints accumulate into one application turn. Hands-free uses a 900 ms silence candidate after speech detection. This does not prove semantic completeness or noisy-car accuracy. |
| Deepgram recognition + either output | Same controlled microphone capture; 16 kHz PCM in 80 ms WebSocket frames through the authenticated server. Provider end-of-turn events can commit in hands-free mode; manual mode retains segments until Finish. Only protocol and local lifecycle behavior are tested without a provider key. Live quality, availability, latency, billing, and current account entitlement remain unverified. |
| Browser output | Sentence-sized native utterances; cancellation is immediate locally. Native voices expose no PCM, dependable acoustic echo reference, or uniformly reliable word timing. No synthetic playback measurements are presented as real acoustic evidence. |
| Deepgram output | PCM playback at the provider's declared sample rate, local source cancellation before the network interrupt, bounded buffering, and generation guards that reject late audio. No live premium voice was used in these tests. |

Recognition and output are independently selectable. Browser recognition is not advertised as hands-free. Local or premium recognition with browser speech can attempt hands-free interruption, but native TTS echo cancellation depends on the device. Headphones and speakerphone must each be tested physically; no browser API guarantees that the native voice is part of its echo-cancellation reference.

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
