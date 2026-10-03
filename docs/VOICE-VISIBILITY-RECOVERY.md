# Voice continuity while using Cloud Desktop

On October 2, 2026, two owner diagnostic captures on build `cad2afd` recorded
`Page became hidden · thinking` immediately followed by a capture failure.
Cloud Desktop opens a separate tab, hiding the original Voice Connect page.
The former visibility handler deliberately stopped input in that case. A
capture failure during a reply also changed to `off` when playback finished,
obscuring the recoverable microphone interruption.

Page visibility changes now record local timing events without stopping or
restarting capture, recognition, or playback. Actual microphone, audio context,
capture backlog, and provider failures retain their existing safeguards. After
such a failure, reply completion leaves voice `paused` and displays **Resume
microphone**. Resume requires a user gesture, preserves the conversation and
draft, and does not issue another greeting. End, Standby, and Auto mode off
remain deliberate stop actions; foregrounding never reverses them.

Background capture remains subject to browser/OS restrictions. This change
does not guarantee phone screen-off, locked-screen, or physical audio-route
behavior. It does not change native OpenClaw task execution or desktop lifetime.
The separate October 2 `Auto mode turned off` report was explained by the owner
and is not evidence of the visibility defect.

Regression tests first failed against the deployed baseline: hidden pages
stopped the microphone in listening/thinking/speaking, and microphone interruption
during playback ended in `off`. Engine tests exercise a subsequent voice turn
while hidden and deliberate stops. Browser fixtures exercise thinking/playback,
same-conversation next turns, microphone recovery by gesture, and End on desktop
and Android layouts. These use synthetic input and visibility events; owner
acceptance with physical audio and the real Cloud Desktop remains pending.
