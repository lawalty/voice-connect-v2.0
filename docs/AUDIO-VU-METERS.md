# Orb microphone VU meters

Settings → Orb ears → Audio VU meters turns the two ears on or off. Use Save
preferences to apply the choice. The meters default on and are remembered in
this browser on this device, independently of shared orb packs and providers.

Both ears mirror the mono microphone, with 16 segments, a fast attack and a
short release. Unlit segments are muted slate grey (#53616b). The full-strength colors follow
the supplied reference: red at the bottom, orange/yellow in the middle, green
at the top. The compact ears scale with the classic orb's wake, sleep, breath
and acoustic movement. Face-orb ears share the renderer's drift and roll. They
stay attached in both Orb and Messenger views, including reduced motion.

The engine measures the existing capture stream before speech classification
or playback-echo rejection. Non-speech sounds can light the ears without
becoming a conversational turn. No additional microphone capture is opened
for this feature. Browser echo cancellation, noise suppression and automatic
gain still apply; the display is relative input strength, not calibrated dB.

Muted, paused, stopped, suspended or stale input returns to grey. The animation
pauses when the page is hidden and respects reduced motion. Browser speech's
existing best-effort visualization can be unavailable on devices that cannot
share capture; the meters then stay grey.

The previous [ear meter](https://github.com/lawalty/vc-v2-opus/blob/main/src/components/EarMeter.tsx)
and decay hook were consulted for segmented fill and envelope behavior. This
implementation uses the current engine and the supplied visual references.

Validation: `npm run build`, `npm test`, and
`npx playwright test checks/browser/audio-vu-meters.spec.ts checks/browser/orb-voice.spec.ts`.
The browser scenarios use controlled PCM and isolated provider transport to
verify rendering, non-speech input, mono mirroring, preference persistence,
standby/End cleanup, and existing orb motion. Physical phone/microphone
acceptance remains a separate check.
