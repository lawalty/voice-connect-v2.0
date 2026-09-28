# Orb standby

Tap the active orb to enter standby. It turns light grey and shows **On standby**
and **Tap to resume**. This replaces the speaker mute button in Orb and Messenger.
Tap it again to reopen listening in the same conversation. Keyboard Enter and
Space perform the same action. End voice is still available while on standby.

Standby immediately stops recognition, releases microphone tracks, and cancels
browser or Fish playback and queued progress speech. Unsubmitted words remain in
the shared draft. Late recognition callbacks cannot submit bystander speech, and
late reply events cannot restart audio from an interrupted turn. Settings, view
switches, and reconnection do not resume standby; resuming requires a gesture.
The grey state takes precedence over connection and agent activity colours.

The client posts a fixed `standby` or `resume` status to the authenticated,
CSRF-protected presence endpoint. The service uses OpenClaw's `chat.inject` to
append a labelled, gateway-authored context record in the existing transcript.
This creates no agent run, user turn, pending reply, or empty-answer retry.
Resume reopens listening and waits for the user's next words without a greeting,
recap, acknowledgement, or replay. In Messenger these records appear as compact
Voice Connect status entries, not generated NorthPointe replies. Typed messages
remain available during standby and their replies stay silent.

The installed OpenClaw 2026.9.6 handler writes these records as assistant-role
`openclaw/gateway-injected` messages, with zero usage. They retain native context
and parent links. The method is supported but omitted from the advertised method
list and requires the installation's existing admin opt-in. VC does not escalate
permissions or fall back to `chat.send` if injection fails. A brand-new empty
conversation has no agent context to notify, so it needs no remote record.

Control notes and message delivery are serialized so a pending send cannot
overtake standby/resume. The client requests cancellation of the prior run once
its receipt is known. This uses existing OpenClaw cancellation: it cannot undo
completed tool actions or guarantee that an already-running external action
stops. Local audio privacy does not depend on that remote cancellation.

If recording the status fails or times out, the app displays a notice and
keeps local standby. It does not retry or request an answer. A failed
microphone restart leaves the orb on standby and permits another tap to retry.
Standby is local to the current page; reloading starts with voice off as before.
This feature does not detect incoming telephone calls automatically.

Verification: `checks/browser/standby.spec.ts` exercises the actual built client,
authenticated service, and isolated Gateway fixture in desktop and Android
layouts. Speech recognition and audio providers are controlled test doubles.
It covers grey pixels, capture release, stale recognition, preserved drafts and
session, ordered notices, reconnect, delayed receipts, browser/Fish playback
cancellation, keyboard controls, and failure recovery. Physical phone/Bluetooth
and live native context retention require acceptance on the deployed build.

Local verification on September 28, 2026 passed the production build,
TypeScript check, all 293 unit tests, and 42 desktop/Android-layout browser
checks across standby, wake, Messenger, progress commentary, and clipboard
sharing. Desktop and Android standby screenshots were visually reviewed.
Deployment identity and live verification are recorded separately in release evidence;
physical phone and Bluetooth acceptance remain a distinct gate.
