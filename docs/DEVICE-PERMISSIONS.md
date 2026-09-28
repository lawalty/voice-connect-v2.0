# Device permission shortcut

Open **Grant permissions** during **Set up Voice Connect** or from **Settings →
Device permissions**. Each row requests access from a separate tap so Chrome's
user gesture reaches the relevant browser API. Microphone is required for voice;
camera and clipboard are optional. Text chat and setup remain available without
granting these permissions. Location is never requested.

**Approved** means the browser reports `granted`. It is read again when the panel
opens and when the page regains focus or becomes visible, and updated on browser
permission change events. Closing the panel or reloading VC does not clear a
Chrome grant. VC does not store a separate approval flag or share device grants
with other devices. If a browser permits one operation but does not report a
grant, the row says **Allowed this time**, not Approved.

Microphone/camera checks immediately stop every returned track, including results
that arrive after closing the panel or timing out. No recording, recognition,
upload, agent turn, or playback starts. Clipboard checks use `read()` (or
`readText()` where necessary) and discard the result without rendering it,
storing it, overwriting the clipboard, or sending it to the service. There is no
permission request when opening onboarding, Settings, or the access panel.

An unanswered prompt stops blocking the panel after 20 seconds. VC cannot cancel
the browser's prompt; the UI asks the user to dismiss it before retrying. Retry,
Refresh status, and Chrome/Android recovery steps cover rejected requests, absent
APIs, unavailable hardware, and insecure origins. Native paste remains available
when programmatic clipboard access is unavailable.

## Browser limits and sources

JavaScript cannot force approval, override Android or browser policy, or promise
that a grant never expires. Resetting site permissions, temporary grants, private
browsing, and browser permission cleanup can require another prompt. Site-level
approval alone also cannot prove that Android permits or can open the hardware.

- [Chrome Android camera and microphone permissions](https://support.google.com/chrome/answer/2693767?co=GENIE.Platform%3DAndroid&hl=en)
- [Chrome Android site permissions](https://support.google.com/chrome/answer/114662?co=GENIE.Platform%3DAndroid&hl=en)
- [Clipboard API permission and user activation differences](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API#security_considerations)
- [Media capture permission and error behavior](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

## Verification boundary

Local verification passed: production build, 290 unit tests, and 32 browser tests
covering permissions plus existing camera, clipboard, and onboarding flows on
desktop and Android layouts. Manual browser inspection found no page errors and
confirmed the mobile access panel. Deployment receipts are recorded separately
under the ignored `.local/release-evidence` directory; physical acceptance remains
pending until tested on an Android device.

`checks/browser/device-permissions.spec.ts` covers gesture-driven requests, media
cleanup, clipboard privacy, real browser grant reads across reopen/reload,
onboarding and unsaved choices, denied access and permission changes, unsupported
queries/APIs, insecure contexts, unanswered prompts, and late media results.
Browser fixtures use synthetic media and clipboard data. Android-layout tests
verify responsive Chromium layout, not physical Chrome/Android permission dialogs.

Physical acceptance still requires an Android Chrome device: grant all three,
reopen and reload VC, check the persistent Approved indicators, revoke one in site
settings and verify recovery, then exercise real voice, camera, and clipboard
sharing. This shortcut does not establish Bluetooth or background audio behavior.
