# Acceptance evidence

Status is updated with measured evidence at release. A supported capability is not
automatically a tested capability. All tests use clearly labeled synthetic turns.

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
