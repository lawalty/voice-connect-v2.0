# VPS cloud desktop

The upper-right monitor icon opens `/desktop` in a separate browser tab using the
same Voice Connect owner sign-in. It shows the Ubuntu Gateway's managed XFCE
desktop and a dedicated, persistent Google Chrome Stable profile. The VPS host
is Ubuntu; the desktop's Gateway container uses Debian 12 and XFCE. Opening starts view-only.
**Take control** reconnects with manual input enabled; **Release control** returns
to watching. Reconnect is explicit after connection loss or control takeover.
**Voice Connect** focuses the original window and closes this desktop tab. The
same-origin monitor link retains its opener for this return action. If the desktop
was opened directly or its original window has closed, the button returns to Voice
Connect within the current tab, without opening another window.

The green wrapper has a fixed application area and a centered three-icon dock:
Browser, Terminal and Files. Files opens Shared files. Take control enables these
buttons; view-only and disconnected viewers cannot send dock input. Dock clicks
send only the fixed Super+B, Super+T and Super+E shortcuts over the existing RFB
connection, so native control arbitration applies to them too. No command API is
exposed. Clipboard controls are available in a collapsible section below.

This uses OpenClaw **Host Desktop**, not **Cloud Worker Desktop**. The latter
provisions separate Crabbox workers. This workspace runs inside the existing
Gateway container; it is not an isolated VM. Chrome uses the container's existing
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
preserving its computer capability repair and bundled testing browser for other
OpenClaw uses. It installs regular Google Chrome Stable system-wide from Google's
official Debian package, owned by root and run as the desktop's `node` account.
It adds TigerVNC, XFCE and D-Bus, plus an autostart launcher. VNC and Chrome CDP listen only inside
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

## Personal desktop and incoming files

XFCE settings are persisted at `/root/.openclaw/desktop/xfce4`, linked to
`/home/node/.config/xfce4`. The Chrome migration preserves existing background,
panel and dock settings, removes the workspace switcher, and sets one workspace.
The dock, application menu, autostart and XFCE preferred browser all use the same
root-owned launcher and persistent Chrome profile. `upgrade.py` checks the active
host/version and idle VC turns, preserves desktop settings and user-local files,
takes a stopped Gateway snapshot and retains a rollback image before switching.

Home contains **Shared files**, with **Images** and **Documents**. This is a
read/write bind of `/opt/voice-connect-v2/shared-files`; these files remain across
container recreation. The `voice-connect-desktop-files` host service copies new
VC image attachments and native OpenClaw `media/inbound` files there within
seconds. Images go to Images; other native incoming files go to Documents.
Existing incoming files are copied on the first run. This does not add a document
upload feature to VC, which currently accepts images; files sent through native
OpenClaw channels are supported when they enter `media/inbound`.

Original attachment records and native incoming storage remain intact for chat
history and native processing. These visible copies are destinations, not a
restriction on the agent's existing permissions. The copier records completed
files; it does not overwrite user edits or recreate a visible copy after the user
deletes it. Files over 100 MiB from native channels are not copied. Destination
creation uses directory handles, exclusive writes and no-follow checks to reject
symlink redirection. Agent guidance identifies the visible paths for received
files and user-facing document/image work.

## Fixed application area

`cloud-workspace.py` supplies fixed launchers and an XFCE autostart watcher. It
focuses existing main windows, serializes launches to avoid duplicate instances,
keeps Browser/Terminal/Files borderless at the display size, and recovers the last
dock-selected application if its final window closes. Modal dialogs and unrelated
applications are excluded. Chrome retains its tabs and address bar; its profile
uses the system frame so native move/minimize/close controls can be removed.
The normal XFCE panel and desktop icons are hidden; wallpaper colors remain.
Window-management shortcuts and Alt-drag are disabled in this managed workspace.
This affects presentation, not the agent's existing file or terminal permissions.

The wrapper opt-in migration uses `VC_DESKTOP_IMAGE=openclaw-desktop:2026.9.7-wrapper`
and `VC_DESKTOP_WRAPPER=true` with `python3 upgrade.py` from the reviewed root-owned
build context. It preserves the original configuration in the stopped Gateway
snapshot, and installs the updater revision that hashes all five image-context
files. Retain a distinct image tag for each verified build so replacing a local
tag does not discard a running image's manifest. If that manifest is already
missing, `VC_DESKTOP_ROLLBACK_IMAGE` must explicitly identify a retained desktop
image with the same installed version; it is validated before the Gateway stops.
The browser launcher remains sandbox-disabled under the existing container
restrictions. Appearance changes do not remove that limitation.
