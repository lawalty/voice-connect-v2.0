# OpenClaw self-updates on the VPS

The owner can ask their agent to update OpenClaw to the latest official stable
release. The `openclaw_update` tool queues a host job; it does not grant the
container a root shell, Docker socket, SSH key, or permission to choose arbitrary
commands or images. There is no second approval prompt. No scheduled updates are
enabled.

## Authority and installation

The OpenClaw plugin uses the version 2 tool context. Update tools are available
only to a trusted owner invocation and assert current authority at the final
request boundary. The host receives only fixed operations and the native session
key used for the completion notice. Instructions in retrieved pages/documents
do not authorize an update; the tool description explicitly limits updates to
owner requests. This semantic distinction still depends on the agent following
its instructions; the service's enforced boundary is update-only authority.

The root service runs from `/opt/openclaw-updater/current` with its own durable
state under `/var/lib/openclaw-updater`. It exposes a Unix socket only, at
`/run/openclaw-updater/control.sock`; Linux peer credentials admit root or the
gateway UID 1000. The socket directory and plugin are mounted read-only into the
gateway. Code, deployment policy, and backup data remain outside agent-writable
state. The existing Windows PC node and its routing are not changed.

To install from a staged directory containing `updater.py`, `install.py`, the
systemd unit, and `plugin/`, run `python3 install.py STAGED_DIRECTORY` through the
authorized dedicated SSH route. The installer verifies the expected host,
creates a full stopped-state backup, adds the plugin and two private mounts,
pins the currently running image, and verifies the gateway and VC reconnection.
It does not itself upgrade OpenClaw.

## Update transaction

1. Resolve GitHub's official non-draft, non-prerelease release and tag commit.
2. Pull that version's official browser image. Require matching source, version,
   and revision labels; pin its repository digest. Reject downgrade requests.
3. Prepare the existing computer-capability repair in a derived image using
   checked module/function/serialization contracts. Validate JavaScript syntax
   and the plugin against the actual candidate SDK. Changed or ambiguous
   contracts fail before stopping the gateway. The old hashed module is never
   mounted over a different release.
4. Stop only the OpenClaw gateway and take a full state/auth/configuration
   snapshot with an integrity manifest. Keep the previous immutable image.
5. Replace only the gateway image, retaining Compose settings, identities,
   sessions, credentials, workspace, browser routing, and unrelated services.
6. Verify version, Docker health, authenticated native Gateway health, and VC's
   restored native connection. Record completed status only after these pass.
7. On failure after stopping, restore both image and pre-migration state, then
   verify the previous version. Recovery is also attempted after an interrupted
   updater process. Failed recovery is reported honestly; backups are retained.

The job outlives the gateway restart. The plugin polls its durable terminal
result and queues a native system event for the requesting session, with an
immediate wake request. The event reports only the verified result. A queued job
is not success. `openclaw_update_status` remains available after reconnection.

## Limits and maintenance

Updates briefly disconnect the gateway and active voice session. They cannot
guarantee that an in-flight model/tool run survives the restart. Conversation
history persists. Never imply that completed external tool effects were undone.

The paired-PC repair is compatibility-checked, not a guarantee that every future
OpenClaw release will preserve its internal API. An incompatible future release
is rejected before replacement and needs updater maintenance. Physical PC
observation should be qualified after a new release; connected-node inventory
alone does not prove desktop actions work. Runtime health does not prove every
provider/plugin behaves correctly.

Backups include private credentials and conversation state. Keep them root-only
on the VPS and outside Git. Do not delete the prior image or backups until a
replacement has passed acceptance. No Docker prune, host OS upgrade, VC deploy,
SSH-key changes, or unrelated service restart belongs to this updater.

The independent regression commands are:

```sh
python3 ops/openclaw-updater/test_updater.py
node --test integrations/openclaw-updater/tools.test.mjs
```

Python tests require Linux because execution locking and Unix peer credentials
are native parts of the host contract.
