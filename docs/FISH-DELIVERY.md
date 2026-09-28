# Fish Audio emotion and delivery

Settings places a single Emotion & delivery selector beside the Fish voice ID. The default is Calm, warm, measured. Off sends the original speech passage. Calm, Soft tone, Empathetic, Relaxed, Confident and Happy are also available. Provider, voice and delivery selections are installation settings shared across devices; old settings without a delivery selection receive the restrained default. Existing explicit Off choices remain Off.

The server requests `s2.1-pro` by default, as before. `VC_FISH_MODEL` can override that model at server startup. The same resolved model is reported in authenticated `/api/settings` and passed in Fish's WebSocket `model` header. The voice reference ID does not determine the synthesis model.

Before each text passage goes upstream, the bridge checks the actual requested model against the documented capability list:

| Requested model | Default cue | Other selections |
| --- | --- | --- |
| `s2.1-pro`, `s2.1-pro-free`, `s2-pro` | `[calm, warm, measured voice]` | Square brackets |
| `s1` | `(calm)` | Parentheses, fixed supported tags |
| Any other or unreported model | No added cue | Selector unavailable |

This is a capability check against the configured request model, not a remote account/model-discovery call or verification of a provider's internal routing. Unknown models require an explicit capability update. No extra provider request, automatic model switch, or latency-producing probe is added.

The cue is added once per coherent speech passage, only in the server's Fish bridge after the client speech cleanup. Both final answers and ephemeral spoken progress updates use that bridge. Browser speech, generated answer text, Messenger history, and prompts are not changed. The selector sends a validated preset ID, never arbitrary markup. A speaker preview uses the unsaved selection without saving it or sending a conversational turn; changing the selection clears the previous playback confirmation.

Delivery changes expression, not playback gain. Voices may respond differently; use Test speaker to listen. No subjective listening quality is guaranteed. ElevenLabs is outside this change.

References checked September 27, 2026:

- [Fish emotion control, including legacy S1](https://docs.fish.audio/developer-guide/core-features/emotions)
- [Fish models and their cue syntax](https://docs.fish.audio/developer-guide/models-pricing/models-overview)

Validation covers model/cue formatting, provider frames, original client text, streaming, old settings, persistence, rejected invalid presets, and desktop/mobile browser selection and preview. Live Fish output and physical listening acceptance require an actual listening test.

Local results: production build passed; all 269 unit/service tests passed; all 18 selected desktop/Android-layout browser checks passed (delivery, speaker preview, host speech setup, Markdown speech, and progress commentary). Desktop and phone screenshots were inspected. Browser synthesis used fixture audio; these results do not establish live voice quality or a deployed release. Docker Compose validation was unavailable locally because the Docker CLI is not installed; the added model environment mapping was reviewed in source.
