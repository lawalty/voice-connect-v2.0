# Independent implementation decisions

This repository began empty on September 24, 2026. Historical Voice Connect
repositories were research sources only. No application code, components, CSS,
prompts, implementation structures, or file layouts were imported from them.

## Requirements learned from history

- Recognition segments are not conversational turns. Buffer fragments into a committed utterance before invoking the agent; acoustic pauses cannot prove a thought is complete.
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

Full Orb mode has voice controls and the Conversation link; its text composer and
footer caption are not mounted. Waking voice reveals a camera control alongside
End. Tapping the active orb enters light grey standby; tapping again resumes
listening in the same conversation (see [Standby](STANDBY.md)).
The camera dialog captures a photo, accepts an optional caption,
and sends both as one turn. Messenger retains its composer and camera, sharing
the same conversation, capture, and playback across view switches. Photo turns
appear inline in Messenger even when sent from Orb mode.

Vosk with hands-free mode is the default for fresh devices. Its approximately 40 MB
local recognition download requires an explicit one-time setup action. The primary
interaction is one Start, followed by speaking and pausing to send a turn, hearing
the assistant, and speaking again when listening resumes. Automatic mode hides
Finish; it is shown only in manual mode. Browser recognition remains a manual
fallback; it is not the default
conversation design. Existing saved browser or manual preferences are preserved,
with a visible local setup action for switching to the continuous flow.

Deepgram is opt-in premium recognition only. Voice output offers device voices and
Fish Audio. Retired Deepgram output preferences become device voices with a visible
notice; migration never enables paid Fish processing. Recognition switches preserve
the cached Vosk model, selected output and existing conversation. The UI discloses browser/vendor speech
processing. OpenClaw connectivity remains necessary even when Vosk can recognize offline.

Fish Audio is an additional, explicitly selected output provider. Its documented
[WebSocket contract](https://docs.fish.audio/api-reference/endpoint/websocket/tts-live)
accepts incremental text in MessagePack. The VPS uses `s2.1-pro`, the user's
`reference_id`, and 24 kHz mono 16-bit PCM. Coherent sentence chunks are flushed
as they arrive; response completion sends Fish's `stop` event to drain synthesis.
Interruption closes the upstream socket instead: `stop` is not a cancellation
command. The API key stays encrypted in server settings, separate from the
per-device voice ID and STT selection. No provider is selected as a silent fallback.

Automatic turn closure combines acoustic speech/silence evidence with recognition
progress. It estimates an utterance boundary rather than inferring semantic intent:
a person can pause before finishing a sentence. Interruption must stop local playback
before awaiting network cancellation, but echo rejection, barge-in through physical
speakers or Bluetooth, and noisy-car turn timing still require real-device acceptance.
Enabling hands-free by default is a product interaction choice, not evidence that
those physical audio conditions have been qualified.

HTTPS/WSS is the selected initial transport: most speech modes send only text to our
server. Separate audio sockets keep audio backpressure away from control messages.
Mandatory WebRTC/TURN infrastructure would not improve the default text-only server
path. Revisit transport only using measured loss/latency evidence.

Capture and stateful resampling run in the AudioWorklet, keeping the UI thread out
of per-sample work. Silero and Vosk run in Workers. Premium output uses bounded,
scheduled Web Audio PCM sources with generation-based cancellation; browser speech
uses native utterances. A playback worklet is not needed to obtain local stop
control, and cannot repair device-level echo cancellation for browser voices.

Vosk's third-party WASM binding is pinned and isolated. New AudioWorklets feed it;
deprecated ScriptProcessor examples were not adopted. Model assets are separately
downloadable, verified, and removable. Audio and inferred emotions are not recorded
by default. The app is foreground-first and does not promise Android lock-screen capture.

The binding's generated JavaScript requires dynamic evaluation. It executes only
inside an external broker Worker and its descendant Worker; the exact broker asset
has a dedicated CSP response. Application documents retain their stricter CSP and
never load the binding. Production-header and cached-offline tests cover this boundary.

## Camera turns (2026-09-26)

Opening Share a moment pauses recognition and automatic endpoints in Orb,
Messenger, and Messenger Auto mode. An existing spoken reply can finish; its
completion cannot reopen listening behind the dialog. Caption entry is optional.
Send photo uploads and submits one image turn immediately, then returns to the
same view and restores only previously active voice input. Cancelling sends
nothing and restores that same input state. Separate text drafts remain intact.
Recognition callbacks and pending finalization are invalidated at pause. The
microphone track is disabled while composing and retained to preserve the Android
audio route; STT restarts on resume, including reloading cached Vosk if selected.
Lost acknowledgements reuse the same attachment and immutable turn ID. Submitted
images and captions appear together in Messenger, including after refresh.

GPT-6 Luna was visually qualified through the deployed OpenClaw 2026.9.6 Gateway
on 2026-09-26 (run 9278d019-5fe0-48db-ad0d-69a2949963ba). It correctly identified
a blue circle, an orange square, and three black dots whose values were supplied
only in the image. Native history confirmed openai/gpt-6-luna. The Gateway model
catalog omitted input modalities, so the explicit VC image allowlist now includes
that exact model. This proves the native image path, not general visual accuracy
or physical Android camera/audio behavior. The user's selected model is unchanged.

GPT-6 Sol was visually qualified through the same deployed Gateway on 2026-09-28
(run 813d0b36-012a-4ebe-8f1d-efdafe259444). It read the image-only code `739204`
and identified a red circle and blue square. The native catalog still omitted
input modalities. Sol was missing from VC's explicit image allowlist, so VC
reported `harness.images=false` and disabled both camera buttons before requesting
device permission. The deployment now includes `openai/gpt-6-sol`; no Android
permission or model selection is changed. This verifies image input through the
installed harness, not general visual accuracy or physical camera capture.

## Image capability is advisory (2026-09-28)

At the owner's request, camera access, clipboard previews, and image submission
no longer require VC's model qualification flag. Missing or stale model metadata
must not disable the camera before Android can request permission. The existing
catalog/qualification flag is diagnostic only; it is not an authorization gate.
Images are forwarded intact to the selected native session. VC does not switch
models, strip the image, or resend the caption as a text-only fallback. OpenClaw
can respond normally or reject the request. A synchronous rejection retains the
image and caption and reports that OpenClaw declined it, without exposing raw
provider diagnostics or guessing that the model lacks vision. Browser permissions,
authentication, upload format/size validation, and duplicate-send protection remain.

## Agent display names (2026-09-29)

The heading names the current conversation's agent; its dropdown selects saved
conversations. VC reads `agent.identity.get` for the stable agent ID in the native
session key, with `agents.list` identity/name metadata as the compatibility fallback.
VC does not rename the agent, change its ID, or migrate/reset sessions. Names update
on returning to a visible tab, on connection changes, and every 30 seconds while
visible. A temporary lookup failure retains the last name; before discovery the
neutral fallback is Assistant. Headings, assistant labels, status text, captions,
settings, and accessibility names share the same display name. Static app metadata
and permission guidance use generic wording. Existing message contents are untouched.

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

## Standby is context-only, not a reply request (2026-09-28)

The first standby implementation used `chat.send` plus a request to stay silent.
Live testing showed the harness recovered an intentionally empty answer and
produced acknowledgements. Presence now uses the native `chat.inject` handler:
a labelled app status is appended to the existing transcript without an agent
run. No delivery receipt or reply expectation is created. Only the user's next
actual message uses `chat.send`. Native status records are presented separately
from assistant replies. Failed injection never falls back to generation, retries,
or a request for the user to speak. Existing cancellation and local capture/audio
privacy still apply; already-completed external actions cannot be undone.
