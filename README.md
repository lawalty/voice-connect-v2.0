# Voice Connect 2.0

A private, single-owner web space for talking, typing, and deliberately sharing
camera snapshots with your existing OpenClaw agent. One conversation survives
changes in input, speech provider, refresh, and network connection.

This is a new implementation. Historical Voice Connect repositories supplied
requirements and failure lessons only. See [architecture decisions](docs/DECISIONS.md),
[acceptance evidence](docs/ACCEPTANCE.md), and [operations](docs/OPERATIONS.md).

## Speech

Recognition and speech output are independent, per-device preferences:

- **Browser recognition:** quick start where supported. The browser may use an
  online speech service. Tap-to-talk with explicit Finish is the safe default;
  continuous recognition and interruption depend on the browser/audio route.
- **Vosk:** downloadable, hash-verified English recognition on your device.
  Approximately 40 MB download; runtime memory is substantially larger. No raw
  microphone audio goes to the application server in this mode.
- **Deepgram Flux:** optional paid recognition and speech output through the
  authenticated server. Requires a credential in Settings. No silent fallback.
- **Browser speech:** default output, with local voices preferred when available.

Local acoustic measurements move the orb; they do not establish emotions or enter
agent memory. The app requests echo cancellation/noise suppression. A Silero model
and recognition progress inform local turn detection; loudness alone cannot commit
a turn. OpenClaw always requires connectivity. Android support is foreground-first;
locked-screen and background capture are not guaranteed.

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
