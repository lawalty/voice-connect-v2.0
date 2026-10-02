# VPS cloud desktop

The upper-right monitor icon opens `/desktop` in a separate browser tab using the
same Voice Connect owner sign-in. It shows the Ubuntu Gateway's managed XFCE
desktop and a dedicated, persistent Chromium profile. Opening starts view-only.
**Take control** reconnects with manual input enabled; **Release control** returns
to watching. Reconnect is explicit after connection loss or control takeover.
**Voice Connect** focuses the original window and closes this desktop tab. The
same-origin monitor link retains its opener for this return action. If the desktop
was opened directly or its original window has closed, the button returns to Voice
Connect within the current tab, without opening another window.

This uses OpenClaw **Host Desktop**, not **Cloud Worker Desktop**. The latter
provisions separate Crabbox workers. This workspace runs inside the existing
Gateway container; it is not an isolated VM. Chromium uses the container's existing
sandbox-disabled deployment model. Browser data lives under
`/root/.openclaw/browser/vps-desktop` on the VPS and is separate from Windows and
the existing headless server browser.

For the agent, request “use the cloud desktop.” Native `computer` uses
`target="gateway"`; native `browser` uses `target="host", profile="vps-desktop"`.
Observe the managed desktop first so autostart Chromium is running. The existing
Windows PC browser pin and explicit computer node selector stay intact. The
workspace instructions document both routes. Enabling Gateway CUA makes explicit
target selection important because native computer discovery can prefer it.

The viewer uses fixed-source Gateway `desktop.observe`/`desktop.release` RPCs.
The native observer token remains server-side. A 30-second single-use VC ticket
is bound to the owner cookie and an exact-Origin WebSocket. Creating/releasing
it requires owner authentication, Origin and CSRF. Native view-only filtering
and control arbitration remain authoritative. Sign-out/session revocation closes
the viewer within the service's 10-second session check interval. Connections
have bounded buffering, heartbeats and explicit cleanup. The ephemeral native
VNC password reaches only the authenticated viewer for its RFB handshake.

The viewer does not forward microphones or desktop audio. Text clipboard controls
are available during manual control. A narrow mobile viewport can watch the
scaled desktop; physical phone interaction requires separate acceptance.

## Host setup and recovery

`ops/vps-desktop/Dockerfile` derives from the currently verified OpenClaw image,
preserving its computer capability repair and bundled Chromium. It adds TigerVNC,
XFCE and D-Bus, plus an autostart launcher. VNC and Chromium CDP listen only inside
the Gateway container on loopback; no new public listener is published.

Prepare the fixed root-owned context at `/opt/voice-connect-v2/desktop-build`,
build `openclaw-desktop:2026.9.7`, and run the reviewed `install.py` there. The
installer checks host/version, takes a full OpenClaw backup while stopped, retains
the previous image, preserves existing routes, enables managed Host Desktop and
Gateway CUA, and verifies Gateway health plus an isolated agent turn. Setup failure
restores the snapshot, workspace instructions, updater and previous image.

The root-owned `/var/lib/openclaw-updater/desktop-enabled` marker makes future
OpenClaw updater candidates derive the desktop layer after the existing computer
repair and before stopping the running Gateway. Missing context or failed package
preparation fails before stopping it. To disable this workspace deliberately,
disable `desktop.host.enabled` and `plugins.entries.cua-computer.enabled`, then
remove that marker; retain the profile and backups unless deletion is requested.
