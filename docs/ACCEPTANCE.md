# Acceptance evidence

Measured September 24, 2026. This is a working release candidate, not a physically
qualified Android/car release. All agent checks used clearly labeled synthetic turns.

## Recorded implementation and deployment checks

| Check | Evidence |
| --- | --- |
| Independent implementation | Fresh Git root and history; requirements provenance in DECISIONS.md. No historical application implementation imported. |
| Build and dependencies | Strict TypeScript, production Vite/Node build, and npm vulnerability audit pass. Linux CI repeats them. Node and Caddy container bases are digest pinned. |
| Backend, audio and orb regressions | 56 tests pass: authentication/origin/CSRF, native targeting, duplicate delivery, terminal ordering, cancellation, question ownership, provider lifecycle, resampling, model boundaries, uncertainty and reduced motion. |
| Desktop/mobile browser flows | 14 checks pass: private sign-in, same conversation after refresh, camera capture/upload and track cleanup, settings, keyboard dialogs, offline drafts, reconnect, local speech, voice-to-text handoff and delayed receipts. Six speech runtime/ownership checks run on desktop only and are explicitly skipped in the mobile layout project. Mobile is Chromium viewport emulation, not a phone. |
| Input handoff | Focusing the composer, Edit as text, and direct typed Send stop capture and preserve typed plus unsent spoken words. Late recognition cannot submit stale speech. Delayed voice/text receipts cannot erase newer typing; submitted voice text is not duplicated into the composer. |
| Native OpenClaw | Actual 2026.9.6 Gateway with signed, approved application identity; read/write/approval/question scopes. NorthPointe name confirmed by live exchange. Existing OpenClaw deployment and persona preserved. |
| Text and image continuity | Native follow-up recalled ORBIT 482; actual uploaded test image was read as VC2 739 with a red circle. Repeated turn identity produced one native user message. |
| Cancellation | Native run-specific cancellation confirmed; subsequent cancelled output did not resume. A rejection reports that agent cancellation is unconfirmed while keeping local playback stopped. |
| Reconnect | Control WebSocket reconnected and native history restored. Browser outage fixture preserves unsent draft and replaces a stale OPEN socket on return. No blind resend or historical speech replay. |
| Assets | Served JS and CSS SHA-256 matched the local production build. Published Vosk archive verified at 41,706,199 bytes, SHA-256 11eb98a5c7b13eb78dce01d4936215409f13e97fac507e9da74b6a4f51e2bccb. Windows and Linux archives match. |
| Local speech | Real Chromium AudioWorklet, Silero and Vosk startup under production security headers; cached offline sample recognition; model removal. Actual HTTPS deployment also passed: 7,030 ms startup, 2.5 seconds synthetic silence, zero submissions and page errors, successful download/removal. This is a startup observation, not a turn-latency benchmark. |
| Voice to native agent | A verified public number-recording WAV passed through the actual HTTPS browser microphone path, AudioWorklet, Silero and Vosk. Finish submitted exactly one full turn, and NorthPointe returned VOICE-TEST-ACK in the same conversation as the typed prelude. No interim submission, duplicate, premium connection or page error occurred. |
| Security boundaries | Encoded API route aliases require authentication, origin and CSRF checks. HTTP and WebSocket regression coverage plus actual HTTPS probes pass. Dynamic evaluation is allowed only on the exact Vosk broker Worker response; application documents remain strict. |

Run `node ops/verify-live.mjs` for authenticated deployment evidence, using a
restricted, ignored owner-credential file. It writes sanitized results and screenshots
under `.local/release-evidence/`. `node ops/verify-live-audio.mjs` exercises the real
HTTPS page with a synthetic silent microphone; it must submit no agent turns.
Neither script belongs in an unattended job with a real microphone.
`node ops/verify-live-voice.mjs <expected-sha>` uses a verified public WAV as a fake
microphone and makes two clearly labeled synthetic native turns. It records no
real microphone input and writes results to `live-voice.json` in the evidence directory.
Run `node checks/audio-browser.mjs` first to fetch and verify that public WAV fixture.

The measurements below were repeated against immutable application source
`d973af7b869d4515a5aa7922b8d3cdd5b944683a`. Its [Linux CI run](https://github.com/lawalty/voice-connect-v2.0/actions/runs/36066112065)
includes the actual production-header browser test and cached offline speech check.
The current release identity and post-rollback preserved state are checked with
`node ops/verify-release.mjs <full-sha>` and recorded in the ignored evidence directory.

## Observed timing sample

Three live synthetic turns on the deployed native path produced:

- Request admission: **78, 93, 137 ms**.
- First assistant text: **6,443, 4,750, 3,534 ms**.
- Completed answer: **7,260, 5,171, 4,188 ms**.
- Run-cancellation API acknowledgement: **95 ms**.
- Control reconnect plus authoritative history: **415 ms**.

These are a small functional sample, not p95 estimates. First text preceded full
completion in each turn. They do not measure microphone endpointing, speech synthesis,
physical playback, or onset-to-audible-stop latency. Local diagnostics record endpoint
drain, provider startup, and playback callbacks separately without retaining audio or
transcripts. Browser TTS callbacks are not acoustic measurements.

The separate prerecorded voice check observed 7,530 ms initial model/capture startup
and 5,163 ms from voice submission to native completion. Recognized text was
`one zero zero zero one nah no to i know zero one eight zero three`; the middle
substitutions remain visible. This is functional integration evidence, not speech
accuracy or physical playback qualification.

## Required automated gates

- Strict TypeScript and production builds; dependency vulnerability audit.
- Authentication, expired/invalid sessions, CSRF and origin rejection; secret redaction.
- Stable send identity, duplicate prevention, owned cancellation, stale-output rejection.
- Native stream deltas versus replacements; no private reasoning or raw tool speech.
- Reconnection before acknowledgement and during an active run; authoritative history.
- Browser UI on desktop and mobile sizes, keyboard access, settings, camera lifecycle.
- Vosk download integrity, cached recognition, actual sample-rate conversion, bounded queues.
- VAD startup speech, changing noise, transcript accumulation, explicit finish, cancellation.
- Real deployed native NorthPointe turn, same-session follow-up, and camera understanding.
- Source SHA, container image, served identity, authenticated API, and rollback.

## Physical and credential-dependent gates

These remain open until measured; do not mark them passed from simulated audio:

- 100 annotated noisy-car turns with at least 98 avoiding premature split, plus ten
  minutes of non-speech background noise without an agent submission.
- p95 audible interruption within 250 ms on the actual Android audio route.
- Fresh Android Chrome/PWA setup, ten consecutive turns, 30-minute session, and
  intended headset/car Bluetooth routing and reconnection.
- Live Deepgram STT/TTS with owner-supplied credentials; provider availability and
  paid-provider latency cannot be established using a mocked WebSocket.

Record endpoint, inference, gateway, first-text, first-audio, audible-stop, and reconnect
timings separately. No controlled historical baseline exists; do not claim a numeric
improvement over old implementations without matched evidence.

## Operational limits

- Browser recognition uses explicit Finish/tap-to-talk; no continuous Android claim.
- Returning from a connection loss restores text/history automatically; resuming the
  microphone requires an explicit Start talking.
- Vosk's older browser binding remains a compatibility risk. Functional sample
  recognition is not a language/accent/noise accuracy evaluation.
- No live Deepgram credential was available. Its adapters and failure paths are
  implemented; live provider entitlement, speech quality, and cost remain unverified.
- The transcript currently loads the latest 200 native messages. OpenClaw retains its
  canonical history. Image storage is bounded to 250 MiB; there is no image-library
  management/deletion interface in this release.
- The app does not implement Hermes, native Android software, continuous video,
  guaranteed background capture, or emotion classification.
