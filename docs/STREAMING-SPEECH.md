# Outbound speech streaming

The user microphone path and agent speech path have different boundaries. VAD and
recognition drain into one complete user turn. Assistant text streams through
sentence/clause extraction into speech immediately; `responseDone` only flushes
the final unfinished text and closes synthesis input.

## First phrase latency

Fish transport preparation now starts when the first answer text arrives, while
the opening sentence is still forming. Preparation sends no text and starts no
audio inactivity watchdog. An expired prepared connection retries on real input;
a text-free response closes it silently. Playback status still starts only when
PCM is scheduled, and interruption invalidates both prepared and active output.

An opening phrase has a 300-ms deadline. With at least six complete words and
40 spoken characters available, VC may release up to 160 source characters at
a word boundary instead of waiting for a long first sentence. Partial words,
unfinished inline code, and unfinished Markdown links remain buffered. If there
is not enough text at the deadline, a later update can try again. Subsequent
chunks keep their sentence/clause boundaries; completion drains the exact tail.

The native Gateway's sequence numbers cover item, tool, and lifecycle events as
well as answer text, and native text events can be coalesced. Numeric gaps in
that shared sequence no longer cause a history fetch per text update. Native
reconnection, durable history notifications, foreground checks, and gaps in VC's
own client event revisions continue to reconcile the conversation.

Short answers can still finish generating before provider synthesis produces
audio. Likewise, VC cannot speak text the agent/provider has not emitted. The
contract is incremental delivery without an added whole-answer wait, rather
than a guarantee that every one-sentence answer starts sounding before its last
token arrives.

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

Speech chunks remove common emphasis markers (`**`, `*`, `__`, `_`, `~~`)
and heading, quote, and bullet prefixes before either speech provider receives
them. The original reply and raw snapshot offsets remain unchanged, so OpenClaw
can use Markdown and history keeps it. Sentence boundaries recognize closing
emphasis markers without waiting for the rest of the answer. Explicit inline
code and escaped symbols remain literal content.

- `checks/speech-text.test.ts`: split Markdown markers, character-at-a-time
  delivery, long chunks, snapshot corrections, abbreviations and literal symbols.
- `checks/browser/markdown-speech.spec.ts`: browser speech and Fish transport
  receive clean sentences before completion; persisted history retains Markdown.
- `checks/browser/early-speech.spec.ts`: the actual Messenger/engine path displays
  partial native text and sends an opening Fish phrase before completion, without
  redundant history reads or replaying speech on refresh.
- `checks/audio-continuous.test.ts`: the opening deadline preserves the suffix
  through both providers and cannot restart cancelled output.
- `checks/service.test.ts`: sparse native text sequences stream immediately
  without mistaking hidden item events for missing answer packets.

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
