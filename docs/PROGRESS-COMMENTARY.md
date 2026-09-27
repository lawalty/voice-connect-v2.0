# Progress commentary

Voice Connect speaks OpenClaw's public assistant commentary during active voice
sessions, at the orb or in Messenger. Pure text Messenger ignores this audio lane;
existing final-answer speech preferences are unchanged. No narration is generated
by VC, and generic tool/status labels are never sent to TTS.

The native adapter accepts phase-tagged assistant snapshots and keyed `item`
events with `kind: preamble`. Only locally owned, active runs in the matching
session are eligible. Native sequence numbers and item identities fence duplicate
or stale updates, including through a connection repair. Reasoning, hidden
progress and raw tool arguments/results are excluded. A bounded public-text check
also rejects code fences, reasoning tags and common credential assignments.

Commentary has a separate sentence buffer per item. Completed sentences can play
before the item ends; an explicit item end or tool boundary flushes the remaining
words. A maximum of three waiting speech chunks prevents a backlog of old updates.
Final-answer text cancels remaining commentary and owns speech from then on.
Commentary completion does not mark the agent turn complete or play a listening cue.
Output uses the selected device voice or Fish Audio, with the existing mute,
interruption, echo-reference and cancellation handling.

Playback callbacks select the yellow/purple or orange/purple orb. Waiting for TTS
alone does not show speaking. Tool lifecycle events control working versus thinking;
parallel tools keep working active until the last matching tool finishes.

Messenger history omits commentary tagged by message phase, signed text-block
phase, or the Codex app-server native commentary mirror identity. Filtering also
applies after reload and reconnect. This does not delete OpenClaw's own transcript
or change the dashboard's commentary-retention setting.

## Prior build comparison

The `lawalty/vc-v2-opus` repository at `3d3ee8ff04698ac63e41309fed68f7c3fddf901b`
contains streamed sentence TTS, tool-driven orange working state, and delayed
randomized acknowledgments in `src/lib/clientFiller.ts`. Its `onDelta` path puts
assistant text into history while `onSentence` sends it to speech. Its orb uses
separate solid thinking, working and speaking colors. No dedicated ephemeral
commentary lane or mixed commentary gradient was found in the fetched source
history or its four published branches. These are related pieces, but do not
establish that the same requested behavior shipped in that build.

## Verification and limits

- Unit/service coverage includes native phase and preamble routes, duplicate and
  stale suppression, session ownership, history filtering, both output providers,
  final-answer priority, mute, interruption, completion and provider failure.
- Browser fixtures exercise voice at the orb, voice in Messenger and pure text
  Messenger on desktop and Android layouts, including gradients and silent reload.
- A synthetic read-only server-time turn against the installed OpenClaw 2026.9.6
  emitted keyed `item/preamble` updates. It exposed a Codex transcript format where
  commentary has no top-level phase: `__openclaw.mirrorOrigin` is
  `codex-app-server`, and `mirrorIdentity` contains the commentary segment.
  The adapter filters that format too.
- The native probe used the existing application identity with an in-memory test
  store. It did not deploy VC, alter OpenClaw configuration, or migrate live state.
- Browser speech is simulated in these fixtures. Physical Android/Bluetooth
  audibility and commentary interruption have not been qualified. The model or
  runtime still decides whether to emit commentary for any particular request.
