# Vector rig review evidence

These artifacts were generated from the example packs using the shared live SVG
model and renderer. They are review evidence; the installed avatar renders live
geometry and does not use these images or video.

- [Expressive Face: all eight states](expressive-states.png)
- [Expressive Face: wake, speaking, warm smile and sleep/yawn](expressive-wake-speaking.webm)
- [Copper Companion: all eight states](copper-states.png)
- [Expressive Face capture checks](expressive-evidence.json)
- [Copper Companion capture checks](copper-evidence.json)

The video uses a silent, estimated speech signal. It proves artwork response to
mouth controls, not synchronization with a recorded person's phonemes. Both
capture reports show zero SVG attribute writes when an identical frame is drawn
twice and no page errors.

## Validation recorded on this branch

- `npm run check`: passed.
- `npm test`: 32 files, 400 tests passed.
- `npm run build`: passed; existing main-bundle size warning remains.
- Relevant Playwright specs: 20 cases passed across desktop and Android layout
  runs, covering the new vector renderer and the existing orb/status/meter flows.
- SVG/source extraction and compilation: validated round trips for both example
  packs, plus gradient and semantic-ink strokes.

Browser checks cover import/export, installation sharing across independent
browser contexts, switching all existing styles, commentary, microphone meters,
standby/resume, visibility suspension, reduced motion, console errors and width.
Android layout emulation is Chromium at phone dimensions, not a physical phone.

## Remaining acceptance

No production deployment or hosted preview has been made. PR review must precede
the isolated preview; the owner must approve smoothness and speaking appearance
on their physical Android phone before production deployment. Real-device frame
timing and perceived realism are not established by these automated tests.

Regenerate with:

```sh
npm run orb:evidence -- docs/vector-face/examples/my-expressive-face.orb.json .local/expressive-evidence
npm run orb:evidence -- docs/vector-face/examples/copper-companion.orb.json .local/copper-evidence
```

For interactive inspection, generate offline review HTML with `orb:preview` as
documented in [the authoring guide](../README.md).
