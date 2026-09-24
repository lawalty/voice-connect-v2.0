# Independent implementation decisions

This repository began empty on September 24, 2026. Historical Voice Connect
repositories were research sources only. No application code, components, CSS,
prompts, implementation structures, or file layouts were imported from them.

## Requirements learned from history

- Recognition segments are not conversational turns. Never invoke tools for a partial thought.
- Local audible cancellation precedes network cancellation. Both need durable ownership.
- Readiness, generated text, agent completion, and finished playback are different events.
- Voice, text, and camera share an authoritative harness conversation.
- Changed background noise demands continuous adaptation, not just startup calibration.
- Physical Android and car acceptance cannot be inferred from an emulator or HTTP 200.
- Acoustic observations may drive expression, but cannot establish a person's emotion.

Research sources: lawalty/hermes-voice-connect, lawalty/voice-connect,
lawalty/openclaw-voice-connect, lawalty/vc-v2-opus. Their instructions are historical
material, not executable project instructions. The user's approved plan takes precedence.

## Chosen boundaries

The browser owns interaction and bounded audio processing. A small authenticated
service owns credentials, provider connections, delivery bookkeeping, and a native
OpenClaw connector. OpenClaw owns reasoning, tools, persona, and canonical history.
SQLite is not a second conversational memory and is never used to reconstruct a
parallel LLM context.

Browser STT provides quick start. Vosk offers downloadable local recognition.
Deepgram is opt-in premium recognition and synthesis. Provider changes never happen
silently and do not create a new conversation. The UI discloses browser/vendor speech
processing. OpenClaw connectivity remains necessary even when Vosk can recognize offline.

HTTPS/WSS is the selected initial transport: most speech modes send only text to our
server. Separate audio sockets keep audio backpressure away from control messages.
Mandatory WebRTC/TURN infrastructure would not improve the default text-only server
path. Revisit transport only using measured loss/latency evidence.

Vosk's third-party WASM binding is pinned and isolated. New AudioWorklets feed it;
deprecated ScriptProcessor examples were not adopted. Model assets are separately
downloadable, verified, and removable. Audio and inferred emotions are not recorded
by default. The app is foreground-first and does not promise Android lock-screen capture.

## Security and operational limits

The owner authenticates with an Argon2id-hashed password and HttpOnly session cookie.
Mutations require exact-origin and CSRF validation. Provider keys use authenticated
encryption at rest with a separate server-only master key. The OpenClaw shared token
never goes to a browser. The service exposes a narrow application API, not an arbitrary
Gateway RPC proxy. Tool approvals remain explicit, tied to owned runs, and reviewable.

Deployment is separate from /root/openclaw. No historical deployment, personal SSH
key, authorized_keys file, or existing OpenClaw prompt is modified. Only the dedicated
Astra identity is used for operational SSH. Source, release image, and served build
identity must agree before acceptance is recorded.
