# Microphone expression and sleep

The full-size and Messenger orbs use the same canvas and existing microphone
signal. Confident speech expands and brightens the orb, increases surface motion,
and distorts three light contours around it. Quiet speech remains visible; the
expression settles between words. Uncertain noise and stale evidence fade to
neutral. These effects do not classify feelings or alter speech detection.

Energy follows a 45 ms attack and 180 ms release smoothing constant; those are
visual filter settings, not measured microphone-to-screen latency. Pitch movement
and rhythm retain their slower, confidence-gated smoothing. There is no additional
microphone stream, network request, provider call, or audio retention for visuals.
Rendering remains capped near 30 fps, with bounded geometry at every orb size.

End stops voice immediately. Over the next 1.5 seconds, an exhale and inward
ripples settle into a smaller, dimmer orb with slower idle motion. Waking during
that transition cancels the sleep effect. The full-size canvas holds its position
when the status label disappears. Reduced motion shows static state changes
without voice pulses or wake/sleep animation; hidden pages stop rendering.

Verification covers microphone capture through the engine into the rendered
canvas with controlled acoustic evidence, in desktop and Android layouts. Pixel
checks confirm visible body and atmosphere response, noise rejection, sleep,
immediate microphone release, uninterrupted capture across views, and reduced
motion. Physical phone responsiveness and the owner's artistic preference still
require device testing; these browser checks do not establish mobile frame-time
or noise-rejection guarantees.
