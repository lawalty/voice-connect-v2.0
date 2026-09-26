# Interruption sensitivity and listening cues

Settings → Conversation rhythm contains two device preferences. Save preferences
and start voice again to apply them; the conversation and downloaded Vosk model
are preserved.

- **Interruption sensitivity**: 0 means less sensitive, 100 means more sensitive.
  The default is 50. This changes only interruption qualification, not silence
  endpointing or recognition provider. At 50, four qualifying 32 ms frames are
  required (128 ms). The extremes require 224 ms and 96 ms respectively. Lower
  values also require higher model speech confidence and speech-to-background
  energy. These windows are not measured microphone-to-speaker stop latency.
- **Subtle Audio Cues**: enabled by default. The supplied `vc-cue-listening.wav`
  marks a ready green listening turn; `vc-cue-sent.wav` marks the end of listening
  when the completed turn is submitted, or listening explicitly stops.
  Tentative Vosk finalization keeps the listening window open while final words
  drain; resumed speech does not trigger another pair of cues.
  Listening → hearing does not play another cue. Hands-free capture remains
  available for interruption during a reply; an off cue does not mean the
  microphone has been released. Disabling cues does not alter microphone policy.
  Messenger suppresses both cues regardless of the saved preference. Switching
  views preserves capture, agent playback, and the conversation; returning to
  Orb does not replay a missed cue. The next actual turn transition uses the
  saved setting. Auto mode in Messenger starts the same automatic voice pipeline;
  Auto off closes capture and keeps any unsent words without stopping the reply.

## Local playback check

Fish's scheduled 24 kHz PCM and cue PCM are referenced against microphone frames
on the same AudioContext clock. Matching uses a bounded 2 kHz reference ring,
zero-mean normalized waveform correlation, and a 0–500 ms delay search with
fractional-delay refinement. Before masking input, the candidate must also match
the full microphone band, so quieter high-frequency phonemes cannot be hidden
by a low-frequency playback match. The coarse ring uses approximately 2.08 MB;
original playback PCM is separately bounded to 6.24 MB and pruned after its short
echo tail. Both accommodate the player's bounded 60-second queue.
Cancellation discards future reference samples but preserves the played tail.
It stores no microphone recording on disk or in a database.

A frame is masked only when both correlations are at least 0.97, unexplained
energy is at most 25% of microphone RMS, and the full-band residual is no louder
than `max(0.0005, noise floor × 1.5)`. Ambiguous overlap passes through. This is an
additional echo guard, not voice identification or a replacement for browser AEC.
Nonlinear loudspeakers, acoustic filtering, long Bluetooth delays and very quiet
speech near the noise floor remain physical qualification limits. Browser-native
voices provide no PCM reference and receive confidence/noise/sensitivity gating
only; the recorded cues still provide a reference.

The VAD worker qualifies interruptions locally. A Deepgram StartOfTurn event
cannot bypass that gate, and neither provider acknowledgement nor a network
request delays local playback cancellation. While a reply is protected, Deepgram
receives silence and potential user input is held in a bounded 500 ms prefix.
On approval, that prefix and already-captured continuation frames are delivered
once; reference-matched echo is excluded. Deepgram's EndOfTurn still owns premium
turn completion. Local Vosk still uses the existing automatic silence endpoint.

Cues use the owner's unmodified mono 44.1 kHz WAV recordings: 480 ms listening
and 260 ms sent. Vite publishes versioned assets that the service worker caches.
They decode once on the existing audio context alongside recognizer startup;
there is no fetch, decoding, or server acknowledgement to wait for at each turn.
Disabled cues skip loading. Unavailable files time out after 1.5 seconds without
failing voice startup, and late loads never replay an old state transition.
Their exact decoded PCM participates in the same echo check. Cue playback does
not pause capture; unsupported/suspended audio fails silently for cues.

## Evidence and remaining qualification

Deterministic tests cover delayed/scaled echo, fan-like noise, overlapping user
speech, sensitivity extremes, reference bounds and cancellation, retained
interruption words, provider events that try to bypass the gate, and cue state
transitions. The browser checks exercise the real pinned Silero WASM worker with
public recorded speech; they do not measure a physical phone or audible stop time.

Test the owner's actual Android speaker with Fish, the normal fan running, and
both quiet and deliberate interruptions. Start at 50, then move left if false
interruptions persist. Also test the cue toggle, mute/unmute during a reply, and
headset/Bluetooth routes. Do not claim the 250 ms audible p95 target from the
software onset window or desktop processing benchmark.

Technical references: [Web Audio clock and worklet model](https://www.w3.org/TR/webaudio/)
and [browser echo cancellation constraints](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/echoCancellation).
