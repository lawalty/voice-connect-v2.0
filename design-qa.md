# Orb and messenger UI review

final result: passed

## Scope and visual truth

The supplied Messenger Style Format screenshot is a layout reference for the existing product. The user's requirements take precedence over a literal clone: preserve the animated orb, existing brand, camera/composer, and voice behavior; give the conversation its own screen; replace microphone mute with agent mute. Standby is excluded.

- Source: `C:/Users/lawal/AppData/Local/Temp/codex-clipboard-ba6dd5f6-4ee5-43c1-9ae6-966d14479003.png` (874 × 744 pixels). The top approximately 56 pixels are window chrome and annotation, leaving approximately 874 × 688 app pixels.
- Original annotated UI: `C:/Users/lawal/AppData/Local/Temp/codex-clipboard-1dc6562d-978a-4d1c-8d3f-906c84893afd.png`.
- Implementation: `.local/messenger-qa/desktop-final.png` (874 × 688), `.local/messenger-qa/mobile-final.png` (390 × 844), and `.local/messenger-qa/orb-desktop-final.png` (1440 × 960).
- CSS viewports matched those implementation dimensions; the in-app browser emitted screenshots at those pixel dimensions without an additional density conversion. Narrow mobile was also inspected at 320 × 740. Browser capture rendering is softer than the supplied screenshot; DOM geometry was checked separately.
- State: authenticated local fixture, existing conversation, messenger open, orb asleep. Dynamic conversation text, timestamps, and orb animation frame differ from the reference. Controls are functional, including an explicit back button and composer absent from the reference's static lower panel.

## Comparison and corrections

The reference and final desktop screenshot were opened together for a full-view comparison. Both use a small orb/identity rail beside a large conversation panel, assistant bubbles on the left, and blue user bubbles on the right. The product keeps its existing header and adds a shared composer aligned with the message panel. Main orb mode contains no transcript panel at any viewport.

Initial desktop inspection found two P2 issues: the small orb overlapped its identity/control rail because a flex item had zero height, and legacy user-message CSS tinted an entire row. Fixes gave the rail an intrinsic height and explicitly cleared row backgrounds. The final desktop capture shows separated identity, orb, mute, and message bubbles.

The first behavioral browser run found that the large orb could overlap active voice controls. Its sizing now uses available height in a size container, reserving room for state text. Final main-screen capture and desktop interaction tests verify usable controls. Initial typed-interruption testing also found a stale speaking phase; stopping typed playback now returns the inactive engine to its resting phase.

Mobile inspection confirms a compact orb/identity/control row above a scrollable messenger and fixed composer. At 320 CSS pixels, document scroll width equals viewport width, and the mute, back, new-conversation, camera, and send targets measure approximately 44 × 44 CSS pixels. Mobile control captions collapse to accessible icons; long agent names truncate instead of overlapping them.

No additional image-region crop was needed: there are no new raster assets or decorative artwork to compare. Full-view captures and DOM bounds resolve the actual rail, bubble, and control issues. The existing real-time canvas orb and icon library remain in use.

## Interaction evidence and limits

- Provider-specific regression fixtures cover browser speech and Fish output for typed and voice turns in both views, preserving one native conversation and the shared draft.
- Switching views and focusing the composer preserve ongoing speech. Agent mute stops current playback, fences late callbacks, persists per device, and leaves capture running without aborting the agent run. Unmute applies to future responses; muted audio is not replayed.
- Keyboard back/Escape, focus restoration, camera attachment, history refresh, cancellation, and connection recovery remain covered. Scrolling up stops automatic following; Latest messages returns to the newest content.
- In-app browser error log: zero errors during final visual inspection.
- The initial full regression run exposed an old test that expected the desktop transcript to be visible automatically. It now opens Conversation before checking reconciled history; its speech ownership assertion remains intact.
- Physical Android sound, hardware routing, and background behavior are not established by browser fixtures. This change does not claim new physical-device acceptance. Existing Markdown remains intact in the log and continues through the existing speech-only cleanup pipeline.

No actionable P0/P1/P2 visual findings remain. Future standby behavior is deliberately outside this change.
