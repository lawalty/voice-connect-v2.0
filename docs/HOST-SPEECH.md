# Installation speech providers

This decision supersedes the original browser Vosk deployment. Provider selections
remain independent of the harness and of each other; Settings remains available
after onboarding. Supporting an additional provider still requires a tested adapter,
not simply accepting an arbitrary API key.

## Persistent versus device and session choices

- `/opt/voice-connect-v2/state/preferences.json`: schema version, revision, setup
  completion, STT provider, TTS provider, Fish voice ID and delivery, and the
  `showTranscriptions` display preference. Owner-only writes use an
  atomic replacement and revision check. Credentials never enter this JSON.
- Settings → Show Transcriptions, below Device diagnostics, controls only the
  Orb-mode live transcription popup. It defaults off, including for older files
  without the field. Save preferences persists it across devices and restarts;
  Messenger's inline transcription and automatic turn submission are unaffected.
- Existing encrypted SQLite credential storage and separate master key remain.
- The client reads installation settings before voice starts. Browser storage
  cannot migrate or overwrite provider choices implicitly. Wake refreshes the
  installation choice; changing providers never changes the conversation mapping.
- Browser voice, cues, interruption sensitivity, hands-free preference and screen
  wake remain device settings. Muting the agent and ending a session are independent.
- Allow interruptions defaults on and is saved on the device alongside its
  sensitivity. Turning it off prevents voice from interrupting an active reply;
  the microphone stays connected, automatic turns resume afterward, and the
  manual Interrupt button remains available. The disabled slider retains its value.
- A fresh installation requires explicit provider setup. Installing a model or
  saving credentials does not open a microphone or silently choose paid processing.

## Capture stalls

The worklet sends healthy 32-ms blocks immediately, with eight in flight. It
reserves up to 32 additional blocks during a consumer stall (1.28 seconds total,
80 KiB PCM maximum). Capture credit returns after VAD processes each block, keeping
a UI catch-up burst out of the worker queue. Source timestamps distinguish missing
audio from late delivery; continuous queued audio is drained without restarting
capture or cancelling playback. This capacity adds no deliberate steady-state wait.

Sustained overload still fails closed: an early overflow notification fences the
recognizer, keeps the unsent text, and prevents a late endpoint from committing a
damaged turn. Larger buffers cannot restore audio that was actually lost. Browser
stall simulations are regression evidence, not physical-device latency acceptance.

## Host Vosk

The private `vosk` Compose service binds loopback port 27017, uses a separate
service token, and mounts only that token and `/opt/voice-connect-v2/models`.
The application remains the authenticated browser entry point. It forwards PCM
through the existing separate audio WebSocket; OpenClaw stays untouched.

The user explicitly installs `vosk-model-en-us-0.22-lgraph` from Settings/onboarding.
The versioned manifest pins the official HTTPS URL, 130557655 downloaded bytes and
SHA-256 measured from that download. This is integrity pinning, not a publisher signature.
Extraction checks paths, symlinks and expanded size. Model files are outside the app
image; subsequent image upgrades retain them. Runtime RAM is larger than the download.
The service has a 2 GiB container limit and allows at most two concurrent recognizers.
Those bounds do not promise two simultaneous real-time streams on every host.

Recognition uses 16 kHz mono signed PCM16, bounded to four seconds of unacknowledged
audio. On overload or a mid-turn transport failure, preserve the text draft and
pause rather than silently dropping words or submitting an incomplete transcript.
Idle WebSocket heartbeats retain the connection while the agent works or speaks.
No recordings or transcripts are logged or persisted by this service.

VC retains model VAD, background estimation, prefix audio, echo-aware interruption,
and resumed-speech handling. Vosk segment finals are not conversational endpoints.
Only a matching acknowledgement after FinalResult releases the complete-turn barrier.
Deepgram Flux retains its provider turn-end contract. Browser recognition retains its
separate manual capability contract. TTS choice does not determine endpointing.

Removal refuses while any recognition session or installation is active. It removes
only the versioned model and its download within the configured model root.
The small browser model, JS binding, worker and CSP exception are retired. Existing
clients remove the old model cache and Vosk IDB database on their next updated visit.
Unvisited devices cannot be remotely purged; rollback images may retain old assets.

## Deployment and rollback

`ops/deploy.sh` builds immutable app and recognizer images, creates the service token
only if absent, backs up SQLite and preferences.json, and retains the previous
release. Never replace the encryption master key. The model download is independent
of image building and never happens implicitly on a fresh installation.

To roll back, use the previous release's Compose project/image and its configuration.
If that older release predates the recognizer service, stop only the VC vosk service;
do not prune Docker or alter OpenClaw. Preserve models and preference backups for a
forward recovery. Restore a settings backup only deliberately, with owner-only permissions.

## Google candidate

As of this review, Google documents a dedicated
[Gemini Live transcription API](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe)
using `gemini-3.5-transcribe-live`, with interim/final transcripts and automatic or
hybrid VAD. That provides a plausible recognition-only adapter: Google supplies text,
OpenClaw/Hermes remains the agent, and Fish/device speech remains independently selected.
VC would still distinguish recognition segments from complete user turns and apply its
playback-aware interruption guard. Start with verbatim output to avoid silently
rewriting the user's words.

This is research, not implemented support. Account access, pricing, real latency,
noise accuracy, reconnect behavior and endpoint reliability have not been qualified.
No Google credential is configured or used by this release.
