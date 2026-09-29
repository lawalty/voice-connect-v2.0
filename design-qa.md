# Luminous Glass implementation QA

Date: 2026-09-28. Scope: the approved character inside the existing Voice Connect web UI, not a recreation of the standalone video's presentation frame.

## Evidence

- Source visual truth: `.local/orb-concept/luminous-glass-orb-demo-v2-more-motion.mp4`, represented by `.local/orb-concept/preview-v2-0348.jpg` (1280 × 720, speaking).
- Source character artwork: `design-assets/luminous-glass/expression-source.png`; prepared runtime atlas: `client/public/orb-packs/luminous-glass/atlas.png` (768 × 768).
- Implementation: isolated fixture at `http://127.0.0.1:5190/`, Settings → Orb appearance → Luminous Glass → Speaking, Lively movement.
- Desktop evidence: `.local/orb-qa/desktop-speaking-final.png` (1280 × 720). DOM-confirmed CSS viewport: 1280 × 720; screenshot-to-CSS density is 1:1.
- Narrow evidence: `.local/orb-qa/narrow-speaking.png` (390 × 844). The dialog is deliberately scrolled to its controls; no horizontal overflow or hidden action buttons were observed. Temporary viewport override was reset after QA.
- Combined full-view and focused comparison: `.local/orb-qa/comparison.png` (1280 × 620). The full views are scaled equally to 640 × 360. Square character crops are normalized to 190 × 190 to compare identity and materials. The demo and app use different animation instants, mouth drivers, and head poses; this is not a pixel-diff claim.

## Findings and iteration history

1. **P2, fixed: Movement label stacked in the center.** Existing settings label rules imposed a column layout. The appearance-specific rule now uses a row with label at left and value at right. Initial evidence: the first browser capture during QA; revised evidence: `desktop-speaking.png`, `narrow-speaking.png`, and the final screenshot.
2. **P2, fixed: overlapping listening and speaking poses.** A continuously blended listening face shifted the nose/lips while speech morphs used neutral alignment. The focused comparison exposed extra edges around the mouth. Waiting-state eye glances now stay in listening/thinking; speech uses its own mouth shapes. Before: `desktop-speaking-before-blend-fix.png`. After: `desktop-speaking-final.png` and regenerated `comparison.png`, captured at the same desktop viewport, speaking state, and Lively setting. The different instantaneous head angle is expected.
3. **P3: 2.5D limits remain.** The character is softer at its small Settings preview size than in the large demonstration. Side views, exact phonemes, and a fully modeled 3D head are outside this renderer's contract. These are documented limitations rather than claims of photorealistic accuracy.

No actionable P0/P1/P2 visual findings remain after the final combined comparison.

## Required fidelity surfaces

- **Fonts/typography:** existing Voice Connect fonts, sizes, and heading hierarchy are retained. The film's spaced title and captions are presentation elements, intentionally absent from Settings. Labels and controls remain legible on both tested widths.
- **Spacing/layout:** character is centered in a dedicated preview area; selector, expression controls, movement, and pack actions follow the settings layout. Small screens wrap actions and scroll vertically. Label alignment was corrected as above.
- **Colors/tokens:** teal listening, gold thinking, purple speaking, and silver sleeping preserve the approved direction. Existing app background, mint controls, focus rings, borders, and muted text are reused.
- **Image fidelity:** the actual approved generated artwork is used, with optical-flow morphs and bounded hemisphere turns. It was not replaced with a drawn emoji, CSS face, or unrelated model. Normalized crops confirm the mature male face, reflective rim, and glass material. The demo has a larger face and decorative atmosphere that are intentionally not copied into Settings.
- **Copy/content:** controls explain immediate device-local saving, silent previews, movement, and prepared expression packs. The interface does not promise automatic portrait-to-avatar conversion or exact lip reading.

## Functional and code checks

- Production build/typecheck passed.
- Full unit suite: 25 files, 307 tests passed. The final expression-only adjustment was followed by another build and the five relevant speech/motion tests, all passing.
- Fish feature timing, gaps, mute/interruption, stale callbacks, long offscreen playback, import validation, and reduced-motion behavior are covered by tests.
- Browser: classic → built-in face; real WebGL readiness; changing head yaw and mouth values; Head still sets yaw to zero while the mouth continues; Lively increases movement; valid pack import; imported selection survives reload; malformed pack rejected; export creates a visible Save link.
- Export file download could not be confirmed through the in-app browser's download API (timeout). A visible, explicit Save link replaced the original programmatic download. Download completion remains a target-browser check.
- No warning/error console entries were reported by the browser tool.
- React review: animation uses refs and GPU uniforms instead of frame-by-frame React state; renderer is lazy-loaded; effects cancel frames/loads and release resources; object URLs are revoked; pack data is bounded and validated; existing ClassicOrb controls remain available.

## Remaining acceptance checks

- Hear and watch a real Fish reply on the user's target browser/hardware. The isolated preview uses synthetic mouth motion and does not contact Fish or request microphone access.
- Confirm exported-file download in that browser, and assess reduced motion on the target OS.
- Hardware performance, battery cost, and physical mobile voice behavior are not established by desktop screenshots or unit tests.

The initial feature was subsequently deployed for owner mobile acceptance. The
owner approved the face animation on Android and reported persistent upward
gaze plus quiet audio with ineffective volume buttons.

## September 28 mobile feedback follow-up

- Speaking progress phases had retained the upward-looking thinking pose. All
  three speaking phases now ease promptly back to forward gaze, retaining head
  turns, nods, blinking and lip motion. Listening and waiting states use brief
  glances instead of continuously holding the upward pose.
- Browser evidence: `.local/orb-qa/forward-gaze-speaking.png`, 1280 x 720,
  silent Speaking preview with Lively movement. Eyes face forward; changing
  head yaw and mouth values were observed. No browser warnings/errors reported.
- Production build/typecheck and all 319 tests pass, including commentary gaze,
  predominantly forward waiting gaze, unchanged playback samples, and Android
  close/restart/cancel ordering. See `docs/ANDROID-AUDIO-ROUTING.md` for the audio
  correction and its limits. Actual Android volume acceptance remains pending.

## September 29 State colors toggle

- Added a device-local State colors toggle for all face packs, defaulting to on
  for existing preferences. Off bypasses added hue/saturation/sleep-color effects
  and uses a neutral glow. Embedded artwork colors are preserved. Preview and
  active face receive the same preference; reduced-motion previews invalidate
  immediately. Voice/audio code is unchanged.
- React review retained the existing ref-driven frame loop, lazy renderer and
  stable pack dependency. Changing the toggle does not recreate the renderer;
  the checkbox has an accessible name and help text.
- Production build/typecheck and all 319 unit/service tests passed.
- Visual check pending: the browser-control tool reported no available browser
  in this session. No new screenshot or live visual acceptance is claimed for
  this toggle. The owner accepted the preceding gaze/audio update on Android.

final result: prior animation accepted; State colors visual acceptance pending
