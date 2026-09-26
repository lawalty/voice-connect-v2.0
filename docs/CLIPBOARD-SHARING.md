# Clipboard sharing

Full Orb mode has a Clipboard control beside Camera while voice is awake. A
clipboard button click reads copied text or an image into **Share from clipboard**.
Pasting directly on the Orb screen (Ctrl+V / Command+V) opens the same preview,
including while the orb is asleep. Add an optional caption, then send explicitly.
Copied text and its caption form one message, separated by a blank line; images
use the existing authenticated attachment endpoint and native OpenClaw image turn.

Messenger has no clipboard button. Text paste retains the browser's normal caret
and selection behavior. A pasted image appears above the composer; the composer
becomes its optional caption. Send submits the image and caption together. Moving
back to Orb while an image is pending opens its preview, preserving the caption.

## Lifecycle

- Previewing does not upload content. Clipboard contents are read only after a
  button click or paste, never at page load or during automatic voice turns.
- A preview or pending Messenger image pauses recognition and automatic turn
  submission. Current agent playback can finish. Sending or cancelling resumes
  only the voice session that remains active, using the camera pause/resume path.
- Clipboard content cannot be accidentally sent by a late recognition callback.
- A typed draft in Messenger becomes the pasted image's caption. Sharing from
  Orb preserves any separate Messenger draft.
- A lost acknowledgement retains the exact turn ID, caption, and uploaded image
  for delivery checking; it does not upload or execute a duplicate turn.
- Sent images and captions remain in the same conversation across view switches
  and reload. Unsent images remain in memory and do not survive page reload.

## Limits and fallbacks

- One PNG, JPEG, or WebP image per paste, up to 5 MB and 40 megapixels, matching
  server validation. Copied text plus caption is limited to 20,000 characters.
- When a clipboard image offers alternate text/HTML representations, the actual
  image takes precedence. HTML is never injected, and image URLs are not fetched.
- Image sending still requires the harness's qualified image capability.
- If direct clipboard access is unavailable or denied, the dialog offers a paste
  field. On mobile, touch and hold that field to use the browser/keyboard paste UI.
- During microphone startup, image/Orb paste asks the user to paste again once
  listening begins; native text paste in Messenger remains available.
- Browser permissions vary. See [MDN Clipboard API](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API)
  and [paste events](https://developer.mozilla.org/en-US/docs/Web/API/Element/paste_event).

## Verification scope

`checks/browser/clipboard.spec.ts` covers desktop and Android layouts: text and
image preview, optional caption, explicit send, pause/resume, Messenger with and
without automatic voice, permission denial, malformed/oversized content, an
uncertain text-send retry, and image history after refresh. Tests use synthetic
clipboard data and microphone/provider fixtures. They do not qualify physical
Android clipboard permissions, keyboard integration, or acoustic behavior.

Camera regressions and the continuous-audio lifecycle suite remain applicable
because both sharing flows use the same input hold and turn submission path.
