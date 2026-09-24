# Native OpenClaw integration operations

Voice Connect uses native Gateway protocol 4. Its `GatewayPort` implements the shared
`HarnessAdapter`; OpenClaw owns model execution and canonical history. Each local
conversation has an independently generated native session key under the discovered
default agent. Never substitute a guessed `main` agent or a null `sessionId`.

## First connection and device approval

OpenClaw 2026.9.6 on the verified VPS requires approval of the application device,
even when the shared Gateway token is correct and the connection is local. A valid
signature alone does not establish permission. The native rejection is
`NOT_PAIRED`, with `details.code = PAIRING_REQUIRED`.

Voice Connect reports this condition as requiring one-time device approval. Until
approval, `/health` can report the HTTP service ready while `openclaw` is false;
this is not an end-to-end readiness claim. Approvals remain unavailable, and a new
installation cannot create a conversation before discovering the native agent.
Existing uncertain messages are never automatically resent.

The application generates its own persistent Ed25519 key and encrypts it in SQLite
using the deployment master key. This is separate from every SSH identity. Preserve
the SQLite state and master key through upgrades to avoid generating a new device.
The authenticated `/api/diagnostics` response contains only the public `deviceId`,
capability state, and bounded timing samples; it never returns the private key or
Gateway token. Copy that full public device ID for the comparison below.

Connect using the authorized dedicated SSH identity, first checking the hostname:

```powershell
ssh -i "C:\Users\lawal\.ssh\id_ed25519_astra" -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=yes root@2.25.242.221 "hostname && pwd"
```

The expected hostname is `srv2003889`. Run the following Python block on that server.
Keep `action = 'list'` for the first run, then review the filtered pending entry and
replace the two placeholder IDs before changing the action to `approve`. The native
CLI output may contain device tokens; the block captures it in memory and prints
only explicitly selected public fields. Do not run the raw JSON commands in a
terminal, redirect them to artifacts, or paste their output into a task.

```python
import json
import subprocess

action = 'list'  # Change only after reviewing the exact pending VC device.
expected_device = 'FULL_PUBLIC_DEVICE_ID_FROM_AUTHENTICATED_VC_DIAGNOSTICS'
request_id = 'EXACT_REVIEWED_PENDING_REQUEST_ID'
scopes = {'operator.read', 'operator.write',
          'operator.approvals', 'operator.questions'}
base = ['docker', 'exec', 'openclaw-openclaw-gateway-1',
        'node', 'openclaw.mjs', 'devices']

def native(*args):
    result = subprocess.run(base + list(args) + ['--json'],
                            capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise SystemExit('Native device operation failed; raw output withheld.')
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise SystemExit('Unexpected native response; raw output withheld.')

devices = native('list')
pending = devices.get('pending', [])
safe_fields = ('requestId', 'deviceId', 'clientId', 'clientMode', 'roles', 'scopes')
if action == 'list':
    print(json.dumps([{key: row.get(key) for key in safe_fields}
                      for row in pending], indent=2))
elif action == 'approve':
    matches = [row for row in pending
               if row.get('requestId') == request_id
               and row.get('deviceId') == expected_device]
    if len(matches) != 1:
        raise SystemExit('Exact pending request/device match required.')
    row = matches[0]
    if (row.get('clientId') != 'gateway-client'
            or row.get('clientMode') != 'backend'
            or set(row.get('scopes', [])) != scopes
            or set(row.get('roles', [row.get('role')])) != {'operator'}):
        raise SystemExit('Device identity or requested permission mismatch.')
    native('approve', request_id)  # Intentionally discard token-bearing response.
    paired = [row for row in native('list').get('paired', [])
              if row.get('deviceId') == expected_device]
    if len(paired) != 1:
        raise SystemExit('Approval confirmation unavailable; do not retry blindly.')
    print(json.dumps({'approvedDeviceId': expected_device,
                      'scopes': paired[0].get('scopes', [])}))
else:
    raise SystemExit('Use list or approve.')
```

Approve only the exact VC request. Do not use `--latest`, approve every pending
request, add `operator.admin`, reset other devices, or edit OpenClaw source/config
or SSH `authorized_keys`. The service reconnects automatically; a restart is not
needed merely to complete pairing. Verify `openclaw: true`, an authenticated
conversation history request, and then a synthetic native turn. Approval capability
becomes true only after the signed connection successfully opts into the session's
approval subscription; advertising an RPC method is insufficient evidence.

## Recovery and diagnostic limits

Reconnect delays progress through 1, 2, and 4 seconds, capped at 4 seconds. This
allows a retry within the five-second recovery target once disconnection is known;
handshake latency, Gateway startup, and silent network failure detection still add
time. Browser sockets use a 20-second ping/pong heartbeat, so a silent transport
failure is not promised to recover within five seconds. Device pairing failures
also require the administrative step above.

Native history reconciles exact terminal run IDs, live run IDs, and local delivery
receipts. A missing run remains uncertain without appearing permanently active.
Cancellation is persisted before contacting the Gateway and replayed after restart.
Approvals/questions from unrelated sessions are not exposed. Authentication protects
image previews; uploaded images are decoded, size checked, re-encoded and stripped
of metadata before storage or forwarding.

`/api/diagnostics` holds the latest 200 in-memory timing samples for submission,
admission, first text, completion, cancellation and reconciliation. It excludes
message text, audio, command arguments and credentials. These server timings do not
measure microphone-to-ear latency or constitute physical Android/car validation.
