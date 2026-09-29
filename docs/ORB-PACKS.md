# Orb face packs

The web app has a shared animation runtime and replaceable artwork. Open **Settings → Orb appearance**, select **Luminous Glass**, and adjust Movement. Appearance changes immediately and is saved in that browser. The classic orb remains the default. Silent previews show resting, listening, thinking, and speaking without using a microphone or contacting a voice provider.

## Plugging in a face

1. Export Luminous Glass from Settings, then use the **Save** link to download a complete, portable `.orb.json` file.
2. Give the copy a unique `id` and `name`; replace its prepared expression atlas. Rebuild or remove the optional flow map when replacing artwork.
3. Import the new pack. It appears in the same selector and uses the existing animation and speech timing automatically.

Exported built-in artwork is named `my-luminous-glass`, so the export can be imported immediately. Custom packs live in IndexedDB; selection and movement live in localStorage. They are specific to a browser/origin, are not account-synced, and are removed if the browser's site data is cleared. Export packs before clearing site data. Up to eight custom packs are supported.

This first version accepts **prepared face packs**. It does not generate expressions or a face rig from a single uploaded portrait. A character creator can be built later to output this same format without changing the voice engine.

## Version 1 contract

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

The placeholders above are illustrative; export a pack for actual usable PNG data. Imports must contain embedded, still PNGs, not remote URLs, scripts, SVGs, or executable plug-ins. JSON must be at most 6 MiB. IDs use 2–48 lowercase letters, digits, or hyphens, starting with a letter. `classic` and `luminous-glass` are reserved. Names are at most 48 characters. Unknown fields and renderer versions are rejected. Artwork is decoded before storage.

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

- `client/orbs/packs.ts` owns the contract and built-in registration.
- `OrbProvider.tsx` owns preferences and local pack storage.
- `FaceOrb.tsx`, `motion.ts`, and `renderer.ts` own rendering, continuous movement, expressions, and cleanup. The renderer loads only when selected, runs at about 30 fps, caps pixel density at 1.5, and suspends animation when hidden/offscreen.
- `speech.ts` extracts small visual features from the PCM that the existing Fish output already schedules. The face reads those features against the same AudioContext clock. It adds no TTS requests and retains no audio samples. Cancellation, mute, output failure, and end of playback clear mouth movement. Audio cues do not drive the mouth.
- Browser-native TTS does not expose PCM through this app; it uses an explicitly estimated speaking animation between its playback callbacks.

This is a **2.5D animated face**, using hemisphere warping and expression morphing. It supports expressive small turns, not a fully rigged 3D head or profile views. Mouth timing follows Fish playback, but vowel shapes are acoustic estimates, not recognized phonemes or exact visemes. The shader falls back to the classic orb if WebGL/artwork fails. Existing wake and standby controls remain available.

## Preparing the built-in assets

The approved generated expression sheet is retained in `design-assets/luminous-glass/expression-source.png`. `ops/build-orb-assets.py` normalizes the nine cells, applies masks, and computes optical-flow maps offline using Python, NumPy, and OpenCV. Install those libraries in a separate environment when regenerating; the application has no Python runtime dependency. Run the script from the checkout and commit the resulting `client/public/orb-packs/luminous-glass/*.png` files.

For another identity, prepare and align its expression sheet first. The current extraction/masks are calibrated to Luminous Glass; they are not a universal portrait converter.

## Acceptance boundaries

The automated suite checks scheduled audio versus arrival time, silence and cancellation, long background playback, stale output callbacks, reduced motion, and import validation. Browser QA covers real WebGL rendering and local pack persistence. The first release still needs a human check with the user's live Fish voice on the intended browser/hardware; silent Settings previews and synthetic PCM tests do not prove that experience.
