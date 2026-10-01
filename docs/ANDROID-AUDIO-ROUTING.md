# Android reply volume

## Reproduction on a physical phone

On September 25, 2026, a Samsung SM-F956U running Android 16 and Chrome
153.0.8010.52 reproduced a split between playback and hardware volume controls.
The installed application was `15163f6c7ac440156d00f61c1d96ffdefec6f17c`.

With the same processed microphone constraints and interactive AudioContext used
by VC, opening output before capture produced:

- Android mode: `MODE_IN_COMMUNICATION`.
- Active Chrome AAudio playback: `USAGE_MEDIA`, routed to the speaker.
- A volume-button event adjusted `STREAM_VOICE_CALL`; `STREAM_MUSIC` stayed at 5/15.

Opening capture before a fresh AudioContext produced:

- Android mode: `MODE_IN_COMMUNICATION`.
- Active Chrome AAudio playback: `USAGE_VOICE_COMMUNICATION`, routed to the speaker.
- The volume button now adjusted the stream used by playback.

These were short, isolated graph probes on the physical phone. They did not
record microphone audio, run recognition, or submit an agent turn. The original
speaker call volume was restored after the button comparison. The user also
reported that the standalone Fish speaker sample was audible but quiet at the
existing media-volume setting.

## Change

On Android, every voice-session start retires its previous AudioContext, waits
for its asynchronous close to finish, then acquires microphone capture before
opening a fresh output context. The existing shared
clock is retained throughout that session for capture, playback, cues and echo
reference. No context restart occurs between conversational turns. Echo
cancellation, noise suppression, streaming, and playback pacing remain enabled.
Non-Android browsers retain early context activation in the initiating gesture.
Callbacks from retired contexts cannot pause a newer session.

The standalone speaker check has no microphone and therefore uses media volume;
an active hands-free conversation on the tested browser uses call volume. Web
code cannot directly set Android's system stream volume. No gain boost is added.

Chromium source explains this allocation behavior:
[AudioManagerAndroid](https://chromium.googlesource.com/chromium/src/+/main/media/audio/android/audio_manager_android.cc),
`MakeAudioInputStream` and `MakeLowLatencyOutputStream`. Browser/device behavior
can differ; the physical observations above are stronger evidence for this phone
than assuming all Android versions follow current Chromium main.

## Verification boundaries

Regression checks cover microphone permission delays, denial, cancellation,
fresh output on restart, one clock across turns, and late retired-context events.
Live deployment and physical Fish audibility must also be checked; an isolated
route probe or an automated desktop browser cannot establish either by itself.
Bluetooth, headsets, other Android models and iOS are outside this reproduction.

## September 28 follow-up: quiet playback after selecting a face

The owner reported quiet playback and ineffective volume buttons on Android
after deploying the animated face. The release comparison found no changes to
PCM scaling, playback gain, destination, or Fish synthesis settings. A new
regression check verifies that lip-sync feature extraction and sampling leave
the playback samples unchanged. This does not establish physical audibility.

The restart path did detach the previous context without awaiting `close()`.
A delayed-close regression reproduced new capture opening before that release
finished. Startup now waits, including when a second start supersedes the first;
cancelling during the wait cannot reopen capture. The non-Android activation
path and the shared clock between conversational turns remain unchanged.

This is a verified lifecycle correction, not a confirmed reproduction of the
owner's current volume symptom. Physical Android volume-button acceptance is
pending; no phone was attached during these follow-up checks.
