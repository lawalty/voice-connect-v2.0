# Reusable vector face packs

`vector-face-v1` is a live SVG artwork **and rig** format. Each character supplies its own head silhouette, facial shapes, deformation targets, gradients and state poses. VC supplies the animation clock, voice lifecycle, speech levels, gaze, blinks and head motion. No character ID is special-cased in the renderer.

Classic, `glass-face-v1` image packs and `status-orb-v1` palettes remain supported. This vector contract replaces the earlier proposed palette-only vector JSON; that incomplete format was never a supported import format.

## Give these files to another AI

- [AI-PROMPT.md](AI-PROMPT.md): ready-to-copy authoring instructions.
- [vector-face-v1.schema.json](vector-face-v1.schema.json): machine-readable structural contract. The VC validator additionally checks references, topology and budgets.
- [examples/my-expressive-face.orb.json](examples/my-expressive-face.orb.json): the complete Hermes-based rig, ready to customize and import.
- [examples/copper-companion.orb.json](examples/copper-companion.orb.json): a different head silhouette and eye/nose artwork, with embedded gradient resources.
- [examples/copper-companion-source](examples/copper-companion-source): an editable SVG + rig JSON authoring folder. Both files compile into one self-contained pack.

## Two authoring routes, one portable file

An AI can write the complete `.orb.json` directly, or produce `artwork.svg` plus `rig.json`. A working folder may contain sketches, SVG sources and a `resources/` folder. The deliverable is always **one `.orb.json` containing every runtime vector resource**. There are no runtime file paths, image textures, network URLs, fonts, scripts or audio. Reference photos can guide the artist but are not runtime artwork in this format.

From the repository root, with its existing Node dependencies installed:

```sh
npm run orb:validate -- my-character.orb.json
npm run orb:extract -- my-character.orb.json my-character-source
npm run orb:compile -- my-character-source/artwork.svg my-character-source/rig.json my-character.orb.json
npm run orb:preview -- my-character.orb.json my-character-review.html
npm run orb:evidence -- my-character.orb.json my-character-evidence
```

The offline review HTML contains trusted application renderer code and the validated pack, with all eight states, silent speech, wake, Movement, reduced motion and a seekable millisecond clock. It needs no provider, server or microphone. It is a review artifact, not pack content. Open it in a browser. Import the final JSON in **Settings → Orb appearance** to test the actual VC lifecycle.

Uncheck **Animate speech** to test the Open, Round and Wide sliders independently.
The optional evidence command uses the repository's Playwright Chromium to capture
all states and a wake/speech/yawn recording, including an unchanged-frame write check.

## Contract

The top-level fields are `version`, `renderer`, `id`, `name`, `colors`, `ink`, `motion`, `artwork`, `rig`, `poses`, and optional `resources`. Unknown fields are rejected. Identity, 6 MiB size, eight custom packs and installation sharing use the existing orb contract. `expressive-face` is a reserved built-in identity; its export is `my-expressive-face.orb.json`.

- `artwork.viewBox` must be `"0 0 100 100"`. `artwork.nodes` is the back-to-front paint order, with 8–64 unique nodes. Aim for 25–35 visible shapes for a polished phone result.
- A node has `id`, `geometry`, `fill`, optional `stroke`, `strokeWidth`, `opacity`, `clip`, `layer`, `anchor`, `morphs`, and `bindings`.
- Geometry is a circle (`cx`, `cy`, `r`), ellipse (`cx`, `cy`, `rx`, `ry`), or path with explicit numeric command arrays: `["M",x,y]`, `["L",x,y]`, `["Q",cx,cy,x,y]`, `["C",c1x,c1y,c2x,c2y,x,y]`, `["Z"]`. Paths begin with M and have at most 64 commands. Coordinates are bounded to −150…250 and radii to 0…100; keep visible artwork near 4…96 for comfortable margins.
- Paint is `#RRGGBB`, `none`, `$features`, `$pupils`, `$state`, or `@gradient:id`. The three tokens resolve to pack inks and the current state palette. Strokes have round caps/joins and width 0…8. Gradients are limited to 16 local linear/radial definitions, each with 2–8 ordered stops.
- `resources.gradients` embeds reusable shading resources. Gradients use viewBox coordinates and `userSpaceOnUse`; their stops contain `offset` (0…1), a solid paint/token `color`, and optional `opacity`. Linear gradients use `x1`, `y1`, `x2`, `y2`; radial gradients use `cx`, `cy`, `r`, `fx`, `fy`. No filters, patterns or linked resources are evaluated.
- `layer:"body"` avoids facial yaw/pitch shifts; face and accent layers receive those shifts. All nodes share whole-head roll, breathing scale and float. `anchor` sets a node's rotation/scale pivot, default `[50,50]`.
- `clip` names another node's live geometry. Clips are generated and namespaced by VC. No self-reference, missing target or nested clipping is allowed. Pupils and catchlights must clip to their eye outline; the clip stays with the eye while the pupils move.

### Deformation and bindings

`morphs` maps a channel name to a **full target geometry**, not an image or arbitrary SVG string. Targets must use the same shape type and identical path command topology as the neutral geometry. Runtime coordinates equal the neutral coordinates plus each active channel's weighted target-minus-neutral difference. Multiple targets combine additively: design them together and test extremes. Eye and mouth topology never changes mid-frame.

`bindings` is an array of `{channel, property, amount, when?}`. Supported properties are `x`, `y`, `rotate`, `scaleX`, `scaleY`, `opacity`. Translation/rotation start at zero, scale at one, opacity at the node's declared opacity (default one). Optional `when` multiplies by another channel, useful for state-specific accents. Amounts are bounded −150…150; use modest values. Runtime opacity and scale are clamped. There is no expression language or code execution.

| Channels | Meaning |
| --- | --- |
| `blinkLeft`, `blinkRight` | 0 open → 1 shut; state lid poses and scheduled blinks combine |
| `gazeX`, `gazeY` | −1…1 pupil direction; always centered during speaking |
| `browLeft`, `browRight`, `browInnerLeft`, `browInnerRight` | Pack-defined brow deformation controls |
| `mouthOpen` | Scheduled/estimated speech openness, or resting/yawn pose |
| `mouthRound`, `mouthWide` | Speech round/wide features multiplied by speech openness |
| `smile`, `focus`, `sleep`, `error`, `sparkle` | Pack-defined expression deformation/visibility controls |
| `zzz`, `ears`, `thought`, `work` | State-specific accents controlled by poses |
| `breath` | Slow −1…1 breathing clock; zero in reduced motion |
| `accentPulse`, `accentRise` | Shared decorative clocks; fixed/zero in reduced motion |
| `vowel` | Speech openness for subtle vowel-linked brow lift |

### Rig and poses

`rig.leftEye` and `rig.rightEye` each specify an `outline` node ID and a `pupils` list including catchlights. Each outline must define its side's blink morph. Pupil nodes need gazeX/gazeY bindings and the matching eye clip. `rig.brows` names distinct left/right nodes. `rig.mouth.outline` must have mouthOpen/mouthRound/mouthWide morphs; an optional tongue node appears only above wide-open mouth levels. Core role nodes must be distinct.

`poses` contains **all eight states**: idle, standby, connecting, listening, thinking, working, speaking, error. Each contains `channels`, whose values are −1…1. Optional `variants` contains 2–8 entries, each with `channels` overrides and `holdMs` 1500–2600. The runtime blends adjacent variants over 420 ms. Thinking and working examples show coordinated brow/lid/mouth/gaze changes. Base channels provide each reduced-motion illustration; choose an appealing fixed speaking mouth in the speaking base pose.

All motion uses one animation clock and no per-frame React state. Given identical explicit inputs, scenes are identical, including transition anchors. The renderer retains nodes, skips unchanged writes and pauses offscreen/hidden. State color blends last 720 ms. Idle/error have no halo; standby has an emerald halo. Movement zero stops head turns/roll/float/scale but retains facial expressions; OS reduced motion fixes geometry, gaze, blinks, mouth and halo per state.

## SVG + rig authoring folder

Supported SVG elements: `svg`, `g`, `defs`, `path`, `circle`, `ellipse`, `rect`, `polygon`, `polyline`, `linearGradient`, `radialGradient`, `stop`. Every shape has a unique lowercase ID. Paths accept absolute/relative M/L/H/V/C/Q/Z; H/V become L. Convert arcs, S/T smooth shorthand, transforms, fonts and styles to supported explicit paths before compiling. Group fill/stroke inherit; put opacity on individual shapes. Flattening composited group opacity would change overlapping artwork, so it is rejected. SVG is parsed as data and is never inserted into the DOM as markup.

`rig.json` holds pack metadata, rig and poses, plus `animation` keyed by visible shape IDs. Each animation entry can supply the corresponding node's semantic paint, layer, clip, opacity, morphs and bindings. Optional `morphSources` maps `{nodeId:{channel:targetShapeId}}` to target paths/shapes placed in SVG defs. Defs target shapes are not painted. Their topology must match the visible neutral shape. Use the rig JSON's `clip` field to name eye outlines; the compiler does not accept raw `<clipPath>` or `<use>` markup.

The compiler rejects unsupported elements/attributes rather than silently dropping them. It validates the resulting pack and checks import identity/size before writing. Compilation errors show field paths, missing shape IDs or unsupported constructs. Use the supplied example folder as the executable starting point.

## Quality and limits

Expressive Face preserves the Hermes proportions, cream/pupil inks, tongue and recognizable accents, with deliberately relaxed sleeping lids, wake/yawn acting, forward speaking gaze, waiting sub-poses and a warm post-speech smile. Copper Companion proves artwork interchangeability with the same runtime.

Gradients, layered contours and consistent highlights can make vector artwork dimensional, but this is 2D artwork with small head motions, not a 3D mesh or profile-view renderer. Acoustic mouth shapes are estimates, not exact phoneme recognition. Complex photorealistic SVG can exceed the phone budget; simplify it instead of embedding a raster portrait. The current format intentionally excludes arbitrary SVG features and author-supplied animation scripts.

Automated browser and synthetic speech checks do not prove physical Android smoothness. Review the PR and use the isolated preview before owner Android acceptance. Do not deploy this change to production until review acceptance and the owner's Android approval.
