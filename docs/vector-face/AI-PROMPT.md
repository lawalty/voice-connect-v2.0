# Prompt for an external AI character artist

Copy the following prompt and provide the attached resources listed below it.

---

You are designing an expressive live vector avatar for Voice Connect 2.0. Create **original artwork and its complete animation rig**, not a recolor of the template and not a static portrait. Deliver a validated, self-contained `my-character.orb.json` using renderer `vector-face-v1`, version 1.

Read the supplied README, JSON Schema, complete example packs and SVG+rig authoring folder first. Follow the contract exactly. The machine-readable schema covers structure; the validator also enforces semantic rig references, topology, limits and reserved IDs. Do not invent fields, animation controls, SVG features or executable plug-ins.

## Artistic brief

Use the user's supplied character/reference and style. If identity/style is unspecified, ask the user rather than inventing their likeness. Aim for the most convincing dimensional vector portrait **within this renderer's 2D and phone performance limits**. Preserve identity across every expression. Use a distinct head silhouette, proportionate facial features, brows with expressive inner/outer ends, shaped eye whites, clipped moving pupils/irises, coherent catchlights, a modeled nose and lips, and subtle cheek/skin contour layers. Use a few well-chosen vector gradients for lighting and depth, not hundreds of tracing paths. Keep the lighting direction consistent as the face acts.

Prioritize believable movement and a readable face at small Android sizes over detail that only looks good enlarged. Avoid flat sticker eyes, giant generic pupils, exaggerated speaking holes, disconnected floating lips, uncanny asymmetry, noisy highlights and extreme head motion. Do not promise photorealism or 3D behavior that the format cannot provide. If a reference cannot be represented credibly within the budget, explain that limitation and produce the strongest clean vector approximation.

Keep the character front-facing, framed comfortably in a `0 0 100 100` viewBox. Small yaw/pitch motions are feature shifts, not true rotations through profile views. Keep important features inside approximately 4…96. Aim for 25–35 visible nodes; the hard limit is 64. Use paint order thoughtfully so contour, facial features and tongue overlap correctly.

## Rig the artwork

Create your own SVG paths/circles/ellipses and numeric deformation targets. A `morphs` target is actual vector geometry, not a PNG, crossfade or SVG string. Neutral and target shapes must have exactly matching command types and counts. Make deformation targets coherent so intermediate frames are smooth and multiple channels can combine safely.

- Rig each eye outline with its side's blink morph. Close eyelids over pupils using the matching live outline clip; do not squash the pupils or move the clip with gaze. Include pupils and catchlights in their eye rig's pupil list with gazeX/gazeY bindings.
- Rig distinct left/right brows. Provide subtle lifts, inner-end changes, focused narrowing and relaxed sleep positions. Bind vowel peaks conservatively to brow lift.
- Rig the mouth with **all three** speech controls: mouthOpen, mouthRound and mouthWide. MouthOpen opens the lips; round narrows/rounds them; wide broadens them. Keep the lip contour continuous and the corners attached to the face across combinations. Optional mouth interior and tongue should share appropriate deformation and clipping/visibility. The designated tongue appears only above wide-open levels.
- Bind head/shell artwork to `layer:"body"`; facial and accent artwork follows feature yaw/pitch shifts. Provide stable pivots when scaling/rotating individual elements.
- Use the named channels from the contract. Add no expressions, JavaScript, animation CSS, URLs, images, audio, filters or fonts. VC owns the clock and voice behavior.

## Design all eight state poses

1. **Idle/asleep:** closed relaxed `‿` eyelids, lowered brows, small breathing mouth, gentle droop and tasteful rising zzz. Closed sleep eyes must differ from happy smiling arcs.
2. **Standby:** calm and drowsy, half-open lids. VC supplies the green standby halo.
3. **Connecting:** friendly readiness with subtle continuing movement.
4. **Listening:** attentive eyes looking mostly toward the user, warm neutral mouth and listening accent.
5. **Thinking:** use variants with 1500–2600 ms holds. Coordinate an up-right glance and raised brow/one-sided "hmm" mouth, narrowed focused eyes and pressed lips, an up-left glance, and a brighter idea expression. Include thought dots.
6. **Working:** focused brows/lids, left-to-right reading poses and occasional upward glances, with a restrained work accent. It must keep moving while waiting.
7. **Speaking:** centered forward gaze; mouth artwork must respond naturally to all three audio controls. Keep a pleasing fixed speaking illustration in the base channels for reduced motion. VC adds a warm 1.7-second post-speech smile.
8. **Error:** clear worried mouth, X-eye artwork and a wave accent. Preserve the requested red semantic state signal.

VC supplies the wake moment, yawn, blink schedule, saccades, head motion, color transitions, reduced-motion behavior and audio input. Your artwork must respond well to those channels; do not build competing animation clocks.

## Packaging and resources

You may work in a folder like:

```text
my-character/
  artwork.svg
  rig.json
  resources/            # optional vector sources/design references
  my-character.orb.json # final portable runtime file
  review.html           # generated review artifact
  validation.txt
```

Everything the installed avatar needs must be embedded in the final JSON: artwork nodes, rig, poses, inks, motion and optional `resources.gradients`. A working resource folder is an authoring convenience, not an external runtime dependency. Reference photos stay outside the installed pack. The pack cannot contain scripts or audio; the generated review HTML is a separate trusted tool artifact.

You can author the JSON directly. Alternatively, prepare supported SVG artwork plus rig JSON, then compile them. The SVG compiler accepts only the documented subset and rejects unsupported constructs. Flatten transforms/styles, outline text, normalize unsupported curves, and use uniquely identified explicit geometry. Do not claim compatibility merely because an SVG displays in a browser.

## Validate and review

Run these from the supplied VC checkout:

```sh
npm run orb:compile -- artwork.svg rig.json my-character.orb.json # SVG route only
npm run orb:validate -- my-character.orb.json
npm run orb:preview -- my-character.orb.json review.html
```

Use a unique nonreserved ID. Inspect all eight states, a full blink, wake, sleep/yawn, ten seconds of thinking and working, and a sustained speaking sequence. Seek exact frames around transitions. Test mouthOpen at 0/.5/1 and round/wide combinations, gaze extremes, Movement 0/1/1.5 and reduced motion. Check lids occlude pupils, catchlights stay coherent, lip contours do not tear or self-intersect, tongue stays in the mouth, brows do not detach and silhouette remains readable. Validate at Android width and small orb size, not just a large artboard.

Return the complete final `.orb.json`, optional authoring folder, review evidence and a short validation report. State exactly which tools/tests you ran. If you cannot run the validator or inspect animation, say so; do not fabricate a successful validation result. Describe intentional tradeoffs, unsupported reference details and remaining physical Android acceptance.

---

Attach these resources to the external AI:

- `docs/vector-face/README.md`
- `docs/vector-face/vector-face-v1.schema.json`
- `docs/vector-face/examples/my-expressive-face.orb.json`
- `docs/vector-face/examples/copper-companion.orb.json`
- Both files in `docs/vector-face/examples/copper-companion-source/`
- The user's identity/style reference, if supplied

For an AI with repository access, give it the Node authoring commands and instruct it to inspect `contract/vector-art.ts`, `contract/orb-packs.ts` and the two example rigs. No new application dependencies or renderer edits are needed to create a character.
