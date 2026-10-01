# Orb packs

## Live vector artwork and reusable rigs

**Expressive Face** is the fourth style, using renderer `vector-face-v1`. It draws
and recomputes SVG shapes live, without image morphing. Custom vector packs can
replace the head silhouette, eyes, brows, nose, mouth, gradients and state poses
through data, without application code changes. Existing Classic, Luminous Glass,
imported image packs and Voice Connect v1 remain supported.

See the [vector format and authoring guide](vector-face/README.md), the
[ready-to-copy external-AI prompt](vector-face/AI-PROMPT.md), and two complete
[example packs](vector-face/examples/). An AI may author one JSON directly or
compile supported SVG artwork plus rig JSON. The installed `.orb.json` embeds
all runtime artwork and gradient resources; a working resource folder is optional.
SVG alone is not a rig, and arbitrary SVG features/scripts are not supported.

The full vector schema requires geometry, rig roles and all eight poses in addition
to the palette/ink/motion fields. It replaces earlier handmade palette-only vector
JSON. Export **Expressive Face** to get `my-expressive-face.orb.json`; its built-in
ID `expressive-face` is reserved. Vector packs show Movement and silent previews
for all states; State colors is hidden because vector packs use their semantic
palette. OS reduced motion renders a fixed illustration per state, including speech.

This is a 2D vector rig with small head motions, not a 3D or guaranteed
photorealistic renderer. PR review and physical Android acceptance precede production
deployment. Browser screenshots alone do not prove phone frame smoothness.

The web app has replaceable orb renderers and artwork. Open **Settings → Orb appearance** and select **Luminous Glass** for an animated face or **Voice Connect v1** for the original microphone orb. Appearance changes immediately and saves to this VC installation, so signed-in devices share the selected pack, movement, and State colors. The classic floating orb remains the default. Silent previews cover all eight original states without using a microphone or contacting a voice provider.

For built-in or imported faces, switch **State colors** off to preserve the
artwork's original colors in every state. This bypasses the added hue,
saturation, and sleep-color effects and uses a neutral glow. Expressions, head
movement and lip-sync continue. The preview updates immediately, including with
reduced motion enabled. Colors baked into individual atlas images remain part
of those images; use consistent colors across expressions for a natural head.
State colors defaults to on for existing installations. The choice is shared
across devices and applies across face packs; it does not alter the exported
pack or the classic orb.

## Voice Connect v1 pack

This built-in pack recreates the supplied `orb-archive/pre-expression` images:
solid circular microphone button, separate glow halo, and two 12-segment meters.
The reference contact sheet identifies Hermes commit `6fe6a67`; the cited
`lawalty/voice-connect` baseline `03d49f0b7865fd9a64eaf375fe460ed35e54e81a`
also defines the eight-state palette. The current VC 2.0 voice engine, device
identity, settings, sessions, VAD, STT/TTS, interruption and sentence speech
remain the runtime; the older SPA and its state store are not transplanted.

| State | Appearance and behavior |
| --- | --- |
| Idle | Dark grey, dim microphone, no halo |
| Standby | Dark grey, emerald resume halo |
| Connecting | Lighter grey, subtle pulse |
| Listening | Emerald green, reactive meters |
| Thinking | Amber, subtle pulse |
| Working | Orange, stronger orange halo, **no added background audio** |
| Speaking | Violet, larger pulsing halo, microphone rotates every two seconds |
| Error | Red, dim microphone, no animated halo |

Actual tool lifecycle events drive Working. Spoken progress displays Speaking
while the status caption retains the tool context. Starting/reconnecting map to
Connecting, hearing to Listening, finalizing to Thinking, and paused to Standby.
Tap controls retain the current app's wake, standby and resume behavior.

The meters fill bottom-up through emerald (3), lime (4), amber (3) and red (2)
segments. Their geometry and color order are specific to this pack; other packs
retain the existing 16-segment meters. Each side has its own level accumulator,
but both receive the same real mono capture level today. No stereo input or
fake audio motion is claimed. The existing **Orb ears → Audio VU meters** setting
controls visibility. Muted/stopped input returns to zero; idle/standby/working
meters remain unlit. Hidden pages suspend the meter loop. Reduced motion stops
decorative pulsing and rotation while retaining the live level display.

Voice Connect v1 always uses its semantic state palette. Face-only State colors
and Movement controls are hidden for this renderer; their saved values remain
available when switching back to a face. There is no working music asset,
additional AudioContext, microphone owner, or speech provider request.

Export this pack to download `my-voice-connect-v1.orb.json`. It uses renderer
`status-orb-v1`, the common version/id/name fields and a `colors` object containing
all eight state names with six-digit hex colors. Give a copy a unique ID and
name to import a personalized palette. No artwork, scripts, URLs or audio fields
are accepted for this renderer. It shares the same installation storage, limits,
revision checks and export/removal controls as face packs.

## Plugging in a face

1. Export Luminous Glass from Settings, then use the **Save** link to download a complete, portable `.orb.json` file.
2. Give the copy a unique `id` and `name`; replace its prepared expression atlas. Rebuild or remove the optional flow map when replacing artwork.
3. Import the new pack. It appears in the same selector and uses the existing animation and speech timing automatically.

Exported built-in artwork is named `my-luminous-glass`, so the export can be imported immediately. Custom packs and appearance are stored in the VC server's SQLite database, included in its existing deployment backups, and served only to authenticated sessions. Clearing a browser's site data does not delete server packs. Up to eight custom packs are supported per installation, at most 6 MiB each. Export a portable copy before removing a pack; removal affects all devices.

## Moving existing phone packs to the server

Open or refresh VC in the **original browser on the phone where the pack was imported**, then sign in. The app automatically copies its old IndexedDB packs to the server and keeps the local originals. Open **Settings → Orb appearance** to see progress or **Retry orb sync** if copying fails. Wait for saving to finish, then open or refresh VC on the PC. An offline phone's local storage cannot be retrieved by the server.

If the installation has no saved appearance yet, the selected migrated custom pack also supplies the initial shared selection, movement and color setting. An already-saved shared choice wins over an older device's preferences. Different legacy packs with the same ID receive separate IDs, retries do not duplicate them, and a stale device cannot automatically restore a pack deleted from the installation. Normal imports with a conflicting ID must be renamed.

Devices refresh on sign-in, opening Orb appearance, returning to the tab or reconnecting, and every 30 seconds while visible. Concurrent stale edits show a conflict and restore the server's choice rather than silently overwriting it. Sharing is scoped to one VC installation and its database; separate VC installations connected to the same OpenClaw gateway do not share this storage automatically.

Face renderers accept **prepared face packs**. They do not generate expressions or a face rig from a single uploaded portrait. A character creator can be built later to output this same format without changing the voice engine.

## Version 1 face contract

```json
{
  "version": 1,
  "renderer": "glass-face-v1",
  "id": "my-character",
  "name": "My Character",
  "atlas": "data:image/png;base64,...",
  "flow": "data:image/png;base64,...",
  "motion": { "yaw": 14, "pitch": 7, "roll": 7 }
}
```

The placeholders above are illustrative; export a face pack for actual usable PNG data. Face artwork must contain embedded, still PNGs, not remote URLs, scripts, SVGs, or executable plug-ins. JSON must be at most 6 MiB. IDs use 2–48 lowercase letters, digits, or hyphens, starting with a letter. `classic`, `luminous-glass` and `voice-connect-v1` are reserved. Names are at most 48 characters. Unknown fields and renderer versions are rejected. Artwork is decoded before storage.

Each texture is a square 3 × 3 atlas, 384–1536 pixels wide, divisible by three. Both textures must have the same dimensions. Cell coordinates start at the top left:

| Row | Left | Center | Right |
| --- | --- | --- | --- |
| 1 | Neutral | Blink / closed eyes | Listening / eye glance |
| 2 | Open mouth (AH) | Rounded mouth (OO) | Wide mouth (EE) |
| 3 | Reserved FV mouth | Smile / delighted | Thinking |

All cells must share the same face alignment, sphere size, and lighting. The renderer expects the sphere centered at `(0.5, 0.5)` with radius approximately `0.427` of a cell. Use a dark background. The built-in atlas preserves the neutral sphere outside soft face/eyes/mouth masks so additive expression blends do not change the outline. Cell 6 is reserved for a future phoneme driver; the current acoustic driver blends cells 3–5.

`flow` is optional. Without it, expressions crossfade. With it, four channels encode neutral-to-expression XY and expression-to-neutral XY, respectively. The shader decodes each channel as `(byte - 128) / 508` in cell-relative units. This texture contains data, not visible artwork; keep its RGBA values unchanged, including alpha. It must be regenerated for a different face.

Motion values are base amplitudes in degrees: yaw 0–20, pitch/roll 0–12. The user's Movement multiplier is 0–1.5. “Head still” stops turns, tilts, and drift while retaining facial expression and speech. The OS reduced-motion preference stops continuous animation and mouth motion, leaving a static state illustration.

## Runtime and audio

- `contract/orb-packs.ts` owns the portable pack contract and built-in registration; `client/orbs/packs.ts` re-exports it.
- `service/orbs.ts` owns authenticated pack storage, artwork routes, revision-checked appearance writes, and legacy migration. Metadata responses contain private image URLs; portable imported/exported files still contain embedded PNGs.
- `OrbProvider.tsx` mounts after authentication. `sync.ts` serializes shared preference writes, refreshes state, and transfers legacy browser packs. IndexedDB is retained only for migration and recovery of those older local copies.
- `FaceOrb.tsx`, `motion.ts`, and `renderer.ts` own rendering, continuous movement, expressions, and cleanup. The renderer loads only when selected, runs at about 30 fps, caps pixel density at 1.5, and suspends animation when hidden/offscreen.
- `speech.ts` extracts small visual features from the PCM that the existing Fish output already schedules. The face reads those features against the same AudioContext clock. It adds no TTS requests and retains no audio samples. Cancellation, mute, output failure, and end of playback clear mouth movement. Audio cues do not drive the mouth.
- Browser-native TTS does not expose PCM through this app; it uses an explicitly estimated speaking animation between its playback callbacks.

This is a **2.5D animated face**, using hemisphere warping and expression morphing. It supports expressive small turns, not a fully rigged 3D head or profile views. Mouth timing follows Fish playback, but vowel shapes are acoustic estimates, not recognized phonemes or exact visemes. The shader falls back to the classic orb if WebGL/artwork fails. Existing wake and standby controls remain available.

## Preparing the built-in assets

The approved generated expression sheet is retained in `design-assets/luminous-glass/expression-source.png`. `ops/build-orb-assets.py` normalizes the nine cells, applies masks, and computes optical-flow maps offline using Python, NumPy, and OpenCV. Install those libraries in a separate environment when regenerating; the application has no Python runtime dependency. Run the script from the checkout and commit the resulting `client/public/orb-packs/luminous-glass/*.png` files.

For another identity, prepare and align its expression sheet first. The current extraction/masks are calibrated to Luminous Glass; they are not a universal portrait converter.

## Acceptance boundaries

The automated suite checks scheduled audio versus arrival time, silence and cancellation, long background playback, stale output callbacks, reduced motion, and import validation. Service tests cover durable shared storage, private artwork access, migration retries, ID collisions, deletion tombstones, limits and revision conflicts. Browser QA covers real WebGL rendering, legacy migration, fresh-browser access, cross-device appearance changes and retained local recovery copies in desktop and Android-sized Chromium contexts.

The owner accepted the animation, forward gaze, brief waiting glances and improved volume on Android after release `a14258c`. This is device-specific acceptance; silent Settings previews and synthetic PCM tests do not prove that experience on other devices. Migration of the owner's actual avatar and its State colors appearance still need confirmation in the original phone browser and on the PC.
