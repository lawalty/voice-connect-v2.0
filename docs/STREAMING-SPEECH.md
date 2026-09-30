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

## Messenger speech presentation

Messenger shows an ephemeral three-dot waiting bubble from submission until the
first public answer text. Tool/work commentary remains outside message history;
active voice/Auto mode can speak it using its separate output queue. An empty
answer bubble with a caret replaces the dots while its first audio is preparing.

Refreshed clients request `timing=words`. The bridge uses Fish's streaming
`/v1/tts/live/with-timestamp` endpoint and forwards validated cumulative alignment
snapshots, including corrections carried in empty audio frames. PCM still flows
immediately through the same four-second credit window. Old clients retain the
existing endpoint. No second transcription request or full-answer buffer is used.

Word offsets map onto concatenated PCM and then onto the AudioContext's actual
scheduled buffers. Underruns and suspension cannot advance the text using wall
time. Replaced snapshots cannot rewind already revealed words. Provider content
maps to the speech text after delivery cues/Markdown cleanup; Messenger retains
the original Markdown. If the provider verbalizes a numeral differently, that
unaligned portion becomes readable at its completed chunk boundary. Timestamps
can arrive after their audio, so an initial word or late correction can catch up;
this does not claim sample-accurate phoneme synchronization.

Browser speech uses native word-boundary callbacks when provided by the selected
OS voice. Voices that omit them reveal coherent utterances at playback rather
than fake per-word timing. Reduced motion displays the available full text and
static dots. Screen readers receive the original available text, not each visual
word animation. Muting, standby, interruption, output failure, and actual playback
completion release the full readable reply. Native answer completion alone does
not end the reveal while queued audio is still playing. History/reload is fully
readable and never starts a speech replay. View switching preserves the timeline.
Native persisted assistant rows can omit the live turn ID. During playback only,
history reconciliation retains the presentation association when exactly one
identical reply follows the owned user's message, before the next user turn.
The native row ID remains authoritative; unrelated/repeated answers cannot claim
the association. Actual playback completion releases it, and reload stays silent.

`checks/speech-caption.test.ts`, `checks/audio-output.test.ts`, and
`checks/browser/messenger-typing.spec.ts` cover cumulative corrections, repeated
words across chunks, invalid metadata, actual playback clock/underruns, cancellation,
waiting/commentary separation, view continuity, drafts, standby, and reduced motion.
`checks/history.test.ts` covers native rows without turn IDs, duplicate answers,
and next-turn boundaries. The real-socket pacing test also checks full caption
coverage alongside all three minutes of PCM.

Timestamp protocol reference:
https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech-live-with-timestamps

## Regression coverage

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
- `checks/browser/early-speech.spec.ts`: the actual Messenger/engine path receives
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
