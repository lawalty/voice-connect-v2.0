# OpenClaw sessions and Messenger history

## Diagnosed behavior

The September 27 investigation used the running OpenClaw 2026.9.6 image
(`eb377ac59e6c9fd6c7705028034812becf00271b`), not the host checkout.
The affected native session remained intact. A read-only comparison found 657
transcript records and 383 readable user/assistant messages. VC requested only
200 records, leaving 65 readable messages after filtering tools and commentary.
It ignored `hasMore`, and appended an older failed local turn after the latest
messages. That made an old failure appear to be the end of the conversation.

The correction pages native history, orders local failures chronologically, and
uses transcript identities for stable rows. Nothing is resent or reset. Private
reasoning, raw tool payloads, and ephemeral commentary remain outside Messenger.

## Session practices

- Keep one logical session key and its returned backing session ID across Orb,
  Messenger, providers, devices, refreshes, and reconnects. Voice controls do not
  start a new chat. Use New conversation deliberately for a separate topic.
- Let OpenClaw own context, compaction, tools, and durable history. A bounded
  model context is different from the readable conversation history.
- Reconcile delivery before retrying an uncertain send. A failed turn does not
  imply that later messages are unavailable, or authorize replaying a request.
- Subscribe before reading history, and re-subscribe after reconnecting.
  Persisted `session.message` notifications also invalidate VC history when a
  dashboard or another client writes the same session. They never grant VC
  ownership of a foreign run or permission to speak its old replies.
- Use `hasMore` and `nextOffset` for pages; offsets are not durable bookmarks.
  VC fences older reads with the backing session, native delta cursor, and an
  overlapping record. Appends adjust the offset; reset/branch changes or an
  expired cursor require a fresh tail. No archived branch is silently stitched
  into the current conversation.
- Loading earlier messages stays silent and preserves the draft and reading
  position. Foreground reconciliation refreshes the tail while retaining loaded
  earlier pages only while their native history window remains valid.

References: [Gateway clients](https://docs.openclaw.ai/gateway/clients),
[WebChat](https://docs.openclaw.ai/web/webchat),
[session lifecycle](https://docs.openclaw.ai/concepts/session),
[pinned history contract](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/gateway/server-methods/chat-history-handler.ts).
