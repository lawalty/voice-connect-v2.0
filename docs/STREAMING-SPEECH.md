# Outbound speech streaming

The user microphone path and agent speech path have different boundaries. VAD and
recognition drain into one complete user turn. Assistant text streams through
sentence/clause extraction into speech immediately; `responseDone` only flushes
the final unfinished text and closes synthesis input.

## Reply length versus playback memory

The original Fish player cancelled speech when synthesis got more than 60 seconds
ahead of playback. A normal long answer could hit this because Fish generates
audio faster than real time. Raising the limit would retain the same failure mode.

The authenticated bridge now advertises a four-second PCM window. The player opts
in with `playback { playedBytes: 0 }`, then sends monotonically increasing consumed
byte counts only after scheduled audio ends. The bridge sends at most that window
ahead, in frames of at most 200 ms. The first frame plays without waiting for the
window to fill. Duplicate progress never adds credit; impossible progress fails.

When credit runs out the bridge pauses its provider WebSocket receiver, applying
transport backpressure. Its bounded queue accommodates already received frames.
Resuming playback releases credit and continues the same synthesis session. Final
completion waits for queued PCM delivery, and the player waits for actual playback
completion before ending the reply. There is no cumulative audio/text counter or
absolute five-minute deadline that cancels an otherwise progressing reply.

Connection, provider inactivity, stalled playback, per-frame sizes and outstanding
memory remain bounded. Provider watchdogs do not count time spent deliberately
paused by playback pacing. Silence between spoken passages during tool work does
not trigger a playback failure. A ten-minute completely inactive stream still
closes; provider/network failures are visible and do not silently replay speech.

Interruption stops local sources and invalidates callbacks before closing the
provider connection. Pending audio is discarded, never drained after cancellation.
Old cached clients can still use the bridge; refreshed clients negotiate pacing.

## Verification

- `checks/fish-streaming.test.ts`: real local WebSockets, accelerated playback of
  three minutes of PCM, byte-for-byte integrity, at most 4.1 seconds ahead, and
  playback before the second text passage and final response boundary.
- `checks/fish.test.ts`: ten-minute progress, burst delivery, delayed completion,
  cancellation while paused, tool gaps, missing progress, malformed credit and
  authentication expiry.
- `checks/audio-output.test.ts`: credit only after playback, cancellation ordering,
  window enforcement and provider failures.
- `checks/audio.test.ts`: incremental sentences, decimal/abbreviation boundaries,
  closing quotes, long clauses and final-tail preservation.

These automated tests do not prove audibility, Bluetooth routing, or latency on a
physical Android phone. Live provider timing is recorded separately in ignored
release evidence, without provider credentials or retained microphone audio.

Provider protocol reference: https://docs.fish.audio/api-reference/endpoint/websocket/tts-live
