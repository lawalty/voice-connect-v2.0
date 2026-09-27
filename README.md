# Voice Connect 2.0

A private, single-owner web space for talking, typing, and deliberately sharing
camera snapshots with your existing OpenClaw agent. One conversation survives
changes in input, speech provider, refresh, and network connection.

This is a new implementation. Historical Voice Connect repositories supplied
requirements and failure lessons only. See [architecture decisions](docs/DECISIONS.md),
[acceptance evidence](docs/ACCEPTANCE.md), and [operations](docs/OPERATIONS.md).

## Speech

The primary flow is continuous conversation: choose providers during onboarding,
tap the orb once, speak, and pause. VC waits for complete recognition results,
the assistant replies, and listening resumes. Automatic mode has no Finish button.
Browser fallback and explicitly selected manual turns retain Finish.

Recognition and output are independently selectable after setup. Provider selections
and the Fish voice ID live in the installation's server-side preferences.json, shared
by all its devices. Browser voice, interruption sensitivity, audio cues, screen wake
and manual/automatic rhythm remain device preferences.

- **Vosk lgraph:** optional 128 MB English model downloaded separately onto the VC
  host. Recognition runs in a private Python service, never on your phone. Microphone
  audio travels to your VC host over authenticated HTTPS/WebSocket; it is not stored.
  VC's Silero VAD and playback-aware interruption guard remain in the browser.
- **Deepgram Flux:** optional premium streaming recognition. Uses its confirmed
  turn-end events. Switch to/from Vosk without removing the installed host model.
  An explicitly configured key is required; no silent paid fallback.
- **Browser recognition:** manual fallback where supported. The browser may send
  audio to its vendor; continuous capture and echo cancellation vary by device.
- **Fish Audio:** optional streaming speech output with an encrypted server-side
  API key and installation-persistent voice ID. This selection is independent of STT.
- **Browser speech:** default output, preferring local voices when available.

See [host speech setup](docs/HOST-SPEECH.md) for installation, migration, and provider
capability boundaries. Vosk still needs connectivity to the VC host.

During an active voice session, NorthPointe's public progress commentary is spoken
as it arrives, including while Messenger is open. Commentary is audio only: it
does not appear in final replies or the Messenger history. Pure text Messenger
does not speak progress updates. The orb blends yellow/purple while thinking and
orange/purple while working during these updates, then returns to the underlying
state. Mute, End and interruption stop the audio; the final answer takes priority
over any remaining commentary. Tasks without model/runtime commentary remain
quiet. See [progress commentary](docs/PROGRESS-COMMENTARY.md) for verification.

Local acoustic measurements move the orb; they do not establish emotions or enter
agent memory. The app requests echo cancellation/noise suppression. A Silero model
and recognition progress inform local turn detection; loudness alone cannot commit
a turn. Automatic boundaries estimate pauses in speech, not whether you have finished
a thought; a pause within a sentence can still end a turn. OpenClaw always requires
connectivity. Android support is foreground-first;
locked-screen and background capture are not guaranteed.

Physical echo rejection, interruption during speaker playback, and reliable turn
boundaries in a noisy car remain unqualified. Browser fixtures cannot establish
those real-device results.

## Shared document library

The authenticated Library panel connects to the existing Hermes RAG API for
collection browsing, cited passage search and expiring downloads. It uses the same
Supabase documents, groups, embeddings and private originals. The optional
OpenClaw adapter exposes those reads to the agent alongside conversational memory.
See [connection and activation](docs/SHARED-RAG-LIBRARY.md). Ingestion and document
management remain in the existing library portal.

## Development

Use Node 24 and npm. No historical repository is needed.

```powershell
npm ci
npm run prepare:assets
npm run bootstrap
$env:VC_MASTER_KEY_FILE = "$PWD/.state/master.key"
$env:VC_BOOTSTRAP_TOKEN_FILE = "$PWD/.state/bootstrap.token"
$env:VC_GATEWAY_TOKEN_FILE = 'C:/private/path/gateway-token'
$env:VC_GATEWAY_URL = 'ws://127.0.0.1:18789'
npm run dev
```

Open `http://127.0.0.1:5173`. Read the one-time bootstrap token locally from its
private file to establish the owner password. Never commit it. Use an SSH tunnel
for a remote gateway; never expose the gateway or its token to the browser.
Development without a gateway shows an explicit unavailable state.

```powershell
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
node checks/audio-browser.mjs
```

Browser tests use an isolated, synthetic gateway and temporary SQLite database.
They do not call the live agent. The audio check downloads an official Vosk sample
and exercises real WASM recognition with synthetic browser capture. It is not a
physical Android or noisy-car qualification.

## Boundaries

`client` owns presentation and device audio, `service` owns authentication,
encrypted provider secrets, delivery bookkeeping, and the native Gateway adapter.
`contract` defines shared events. `ops` builds and deploys a separate service.
OpenClaw remains authoritative for persona, tools, memory, and history.

No default microphone recording or emotion database exists. Uploaded camera images
are deliberately captured, decoded, stripped of metadata, and stored on the VPS;
submitted images may also be retained by OpenClaw and its configured model provider.
Deleting application state alone does not erase those downstream copies.
Drafts, provider selections, and downloaded speech models remain on the device.

The product is a release candidate until the physical and credential-dependent
gates in the acceptance document have been completed. Browser emulation and
successful HTTP requests do not establish Android audio quality or interruption
latency.

If a reply appears but is silent, open Settings and use **Test speaker**. The test
distinguishes a playback request, reported playback, provider/browser failure, and
your confirmation that sound was heard. It does not use the microphone or invoke
OpenClaw. Browser and premium failures remain visible rather than silently switching
providers. Enter provider keys only in the authenticated Settings form, never Git.
