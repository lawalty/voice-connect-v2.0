# Investigating voice stopping after a library answer

Reported on September 26, 2026: four PC conversations stopped accepting voice
after a library search and answer. The user stayed on the orb screen.

## Evidence and limits

- Live build `41c4139fd44685bbb4e2fab3f94d39e6b8f55e0a` completed four consecutive
  library-search, Fish playback, and return-to-listening cycles. Capture remained
  live on one track with zero stops. The tests included actual OpenClaw tool events.
- These tests used synthetic microphone silence and injected finalized recognition
  events. They exercised the real Deepgram connection, library retrieval, and Fish
  output, but did not establish physical microphone behavior or reproduce the report.
- Capture failures can stop input while leaving the current answer playing. This
  is a possible explanation, not an established cause of the reported incidents.
- Opening Settings or Library deliberately stops input. The user reported neither
  action during these incidents; this must not be presented as the diagnosis.

## Diagnostic release

Voice starts, explicit stop reasons, and input failures now appear under Settings
→ Device diagnostics → Recent voice events. Each failure records the operational
reason and voice phase. A bounded history survives waking the orb again, and a
separate 32-event reserve prevents ordinary audio measurements from displacing
recent lifecycle evidence. Refreshing or closing the page still clears it.

This release adds evidence collection, not a claimed fix for the disconnect.
It does not change capture recovery, interruption, turn submission, library
behavior, or speech output. The existing local whitelist rejects transcripts,
recordings, device identifiers, credentials, and arbitrary provider error text.
No diagnostic information is uploaded or persisted.

## Verification

- Unit coverage injects a microphone interruption during playback, restarts voice,
  opens settings, and verifies that the original failure and speaking phase remain.
- Diagnostic tests cover retention under noisy event volume, bounded memory,
  duplicate suppression, and rejection of private payloads.
- Browser coverage exercises the visible event list after the same failure and
  restart on both desktop and Android-sized layouts.
- Physical PC reproduction remains outstanding. On recurrence, inspect Recent
  voice events before refreshing the page; waking again preserves the evidence.
