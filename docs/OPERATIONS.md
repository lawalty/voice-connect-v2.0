# Operations

## Deployment boundary

Voice Connect lives under `/opt/voice-connect-v2`; existing OpenClaw remains under
`/root/openclaw` with its own state and container. The application binds only
`127.0.0.1:18880`, reaches the native gateway at `127.0.0.1:18789`, and is exposed by
its own Caddy service at `https://srv2003889.hstgr.cloud`.

Upload a `git archive` of a reviewed full commit to
`/opt/voice-connect-v2/releases/<full-sha>`, then run `bash ops/deploy.sh <full-sha>`
inside that release. The script verifies the host, locks the deployment, preserves
the previous image, makes an online SQLite backup before migration, and starts the
separate Compose project. Use only the explicitly authorized Astra SSH identity.
No private key belongs in this project or on the application server.

The first deployment creates files under `/opt/voice-connect-v2/secrets`: gateway
token, encryption master key, and a one-time bootstrap token. These are mode 600,
owned by the application's unprivileged user. The token is read on the VPS from
the existing gateway configuration; it is never embedded into client assets.
The app creates a separate persistent Ed25519 application identity for native
gateway challenge signatures. That identity is unrelated to the SSH identity.

## Initial owner

Owner setup is a one-time operation using the SSH-controlled bootstrap token.
Submit the bootstrap token and a password of at least 12 characters to the HTTPS
setup screen. Once an owner exists, setup is disabled. The password is stored as
an Argon2id hash. Change it in Settings. Session cookies are Secure and HttpOnly;
authenticated mutations require exact Origin and the per-session CSRF token.
Do not include passwords, bootstrap values, cookies, or provider keys in logs.

Provider credentials are entered in authenticated Settings and encrypted in
SQLite using the separate master key. Removing the key disables premium speech;
it does not silently select another paid service. Back up the master key with
restricted access separately from source and ordinary diagnostics.

## Verification and rollback

Confirm `/health` and authenticated `/api/status` build identity against the Git
commit and container image. Verify an authenticated native text response, same
conversation after reload, deliberate image understanding, and cancellation. The
public health endpoint alone is not a release gate.

To roll back the application, execute `bash ops/rollback.sh <previous-full-sha>`
from a release directory. It verifies the image already exists, replaces only the
application service, preserves state, and checks health. If a future migration is
incompatible, stop the application before restoring the corresponding SQLite
backup together with its matching master key; do not overwrite a live database.
The initial schema uses additive creation only.

Use `docker compose -f ops/compose.yaml logs --tail 100 app` with the release's
`VC_RELEASE` set. Diagnostics contain bounded operational events and timings,
not microphone recordings or raw provider payloads. Keep backups and previous
images until their replacements have passed acceptance; do not prune OpenClaw
or unrelated Docker resources.

## Configuration

| Variable | Purpose |
| --- | --- |
| `VC_ORIGIN` | Exact public origin, including HTTPS |
| `VC_HOST`, `VC_PORT` | Private listener, default loopback 18880 |
| `VC_STATE_DIR` | SQLite, upload and delivery state |
| `VC_GATEWAY_URL` | Native Gateway WebSocket, loopback only on deployment |
| `VC_GATEWAY_TOKEN_FILE` | Server-only Gateway credential file |
| `VC_MASTER_KEY_FILE` | 32-byte encryption key encoded as hexadecimal |
| `VC_BOOTSTRAP_TOKEN_FILE` | One-time owner setup credential file |
| `VC_BUILD` | Immutable source commit identity |
| `VC_GATEWAY_MODEL` | Default model name when Gateway omits it from handshake |
| `VC_IMAGE_MODEL_ALLOWLIST` | Models independently verified with real image input |

The current allowlist is limited to the live `openai/gpt-6-astra` model. Requalify
camera support when changing models; a model name alone is not proof of vision.

Text/history reconnect automatically. Microphone capture requires another explicit
Start talking after connectivity loss; old assistant speech is never replayed.
Uncertain submissions reconcile against native history and are never blindly resent.
