# Reply stream recovery

The reported symptom was a tablet Messenger screen remaining on “NorthPointe is
thinking” while another device or a page refresh showed the completed reply.
A local fault-injection test reproduced that symptom on the pre-fix application:
the event socket stayed open, “Connected” remained visible, and authoritative
history contained the answer while the screen did not.

The reply subscription code was unchanged by the clipboard releases (camera
release `5ca9749`, clipboard releases `5deaea2` and `54ad6b0`). This identifies an
existing recovery gap; it does not establish the physical tablet's exact trigger.

## Behavior

- Authenticated page-level ping/pong verifies that JavaScript can exchange event
  messages. The existing native WebSocket heartbeat continues independently.
- Visible pages probe every 15 seconds. Sending and returning through focus,
  pageshow, visibility change, or resume also trigger a nonblocking check.
- An unanswered probe times out after four seconds and enters the existing
  reconnect path. Initial reconnect backoff is one second; subsequent failures
  back off up to four seconds. These are timer settings, not an end-to-end latency
  guarantee on an offline, sleeping, or overloaded device.
- Per-connection event revisions detect missing events even if probes still work.
  Foreground return also reconciles authoritative history. A second read after
  subscription covers updates between the initial history read and socket setup.
- Reconciliation preserves drafts, the selected conversation and unfinished
  streamed text. A delayed history read cannot overwrite a newer live update.
- Recovered completed turns clear stale waiting/playback silently. Recovery never
  resubmits the user's turn or replays saved replies. A healthy socket does not
  require restarting voice. Actual connection loss retains the existing explicit
  microphone-resume behavior.
- Probes accept only a bounded nonce, require the existing owner session and
  origin checks, and are rate limited. No message text or microphone audio is
  added to diagnostics.

## Verification

`checks/browser/stream-recovery.spec.ts` exercises silent sockets, missing events,
late history responses, active partial replies and missing completion events at
tablet dimensions in both desktop and Android browser projects. It checks draft
and conversation continuity, one submission per turn, silent recovery and a
subsequent normal spoken reply. `checks/service.test.ts` verifies independent
event delivery/probe revisions for two authenticated connections.

`node ops/verify-live-recovery.mjs FULL_COMMIT_SHA` performs an explicitly labeled
synthetic native OpenClaw exchange in two isolated browser sessions. It injects
event loss into one session and verifies restored text, draft retention, no
duplicate turn, no abort and no replay. Evidence is saved under the ignored
`.local/release-evidence` directory. It uses the existing private credential file
without printing credentials.

These checks do not reproduce Samsung's physical OS/app suspension or network
conditions. Acceptance on the user's installed tablet app remains separate.
