import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import time
import xml.etree.ElementTree as ET

assert socket.gethostname() == 'srv2003889' and os.geteuid() == 0
source = Path('/opt/voice-connect-v2/desktop-build')
spec = importlib.util.spec_from_file_location('updater', '/opt/openclaw-updater/current/updater.py')
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
try:
    old_image, version = updater.current_image()
except updater.UpdateError:
    # Rebuilding a local Docker tag can discard its previous manifest even
    # while that container runs. Require an explicitly supplied, verified
    # desktop recovery image before touching the running installation.
    recovery = os.environ.get('VC_DESKTOP_ROLLBACK_IMAGE')
    if not recovery:
        raise
    metadata = updater.inspect_image(recovery)
    old_image = metadata['Id']
    labels = metadata['Config'].get('Labels', {})
    version = labels.get('org.opencontainers.image.version', '')
    running_version = updater.run(['docker', 'inspect', updater.CONTAINER, '--format', '{{index .Config.Labels "org.opencontainers.image.version"}}']).strip()
    assert version == running_version == '2026.9.7'
    assert labels.get('org.voice-connect.desktop') == 'true'
    updater.run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'sh', old_image, '-c', 'test -x /usr/local/bin/vc-cloud-browser && test -L /home/node/.config/xfce4'])
    env = updater.PROJECT / '.env'
    env.write_text(updater.set_environment_image(env.read_text(), old_image))
    env.chmod(0o600)
old_updater_release = Path('/opt/openclaw-updater/current').resolve()
assert version == '2026.9.7'
status = json.loads((updater.STATE / 'status.json').read_text())
assert status.get('phase') in updater.TERMINAL | {'idle'}
with sqlite3.connect('file:/opt/voice-connect-v2/state/voice-connect.sqlite?mode=ro', uri=True) as db:
    assert not db.execute("SELECT id FROM turns WHERE delivery IN ('pending','accepted') LIMIT 1").fetchone(), 'Wait for the current VC turn'
candidate = json.loads(subprocess.check_output(['docker', 'image', 'inspect', os.environ.get('VC_DESKTOP_IMAGE', 'openclaw-desktop:2026.9.7-chrome-stable')]))[0]['Id']
updater.run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'sh', candidate, '-c', 'google-chrome-stable --version && test -x /usr/local/bin/vc-cloud-browser && test -L /home/node/.config/xfce4'])
backup = Path('/opt/voice-connect-v2/backups') / ('chrome-stable-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))
backup.mkdir(mode=0o700)
# Flush the desktop preference daemon before preserving its green background.
updater.run(['docker', 'exec', updater.CONTAINER, 'sh', '-c', 'pkill -TERM -x xfconfd || true'])
time.sleep(1)
updater.run(['docker', 'cp', updater.CONTAINER + ':/home/node/.config/xfce4/.', str(backup / 'xfce4')])
updater.run(['docker', 'cp', updater.CONTAINER + ':/home/node/.local', str(backup / 'user-local')])
updater.run(['systemctl', 'stop', 'openclaw-host-updater.service'])
stopped = False
try:
    updater.run(updater.COMPOSE + ['stop', '-t', '30', 'openclaw-gateway'])
    stopped = True
    updater.snapshot(backup)
    desktop = updater.CONFIG / 'desktop'
    desktop.mkdir(exist_ok=True)
    # A desktop with the persistent XFCE link already uses this exact directory.
    # Recursively merging a second copy would collide with its own icon links.
    if not (desktop / 'xfce4').exists():
        shutil.copytree(backup / 'xfce4', desktop / 'xfce4', symlinks=True)
    xml_dir = desktop / 'xfce4/xfconf/xfce-perchannel-xml'
    panel_file = xml_dir / 'xfce4-panel.xml'
    tree = ET.parse(panel_file)
    root = tree.getroot()
    plugins = root.find("property[@name='plugins']")
    removed = {p.attrib['name'].split('-')[-1] for p in plugins if p.attrib.get('value') == 'pager'}
    for ids in root.findall(".//property[@name='plugin-ids']"):
        for value in list(ids):
            if value.attrib.get('value') in removed:
                ids.remove(value)
    for plugin in list(plugins):
        if plugin.attrib.get('value') == 'pager':
            plugins.remove(plugin)
    tree.write(panel_file, encoding='UTF-8', xml_declaration=True)
    wm_file = xml_dir / 'xfwm4.xml'
    wm = ET.parse(wm_file)
    prop = wm.find(".//property[@name='workspace_count']")
    if prop is not None:
        prop.set('value', '1')
    wm.write(wm_file, encoding='UTF-8', xml_declaration=True)
    if os.environ.get('VC_DESKTOP_WRAPPER') == 'true':
        # Keep the existing wallpaper and desktop preferences. Hide only the
        # ordinary desktop icons and panel, which the web dock now replaces.
        desktop_file = xml_dir / 'xfce4-desktop.xml'
        background = ET.parse(desktop_file)
        icons = background.find("property[@name='desktop-icons']")
        if icons is None:
            icons = ET.SubElement(background.getroot(), 'property', name='desktop-icons', type='empty')
        icon_style = icons.find("property[@name='style']")
        if icon_style is None:
            icon_style = ET.SubElement(icons, 'property', name='style', type='int')
        icon_style.set('value', '0')
        background.write(desktop_file, encoding='UTF-8', xml_declaration=True)
        # The default failsafe session starts a panel at client 2. Override only
        # that client; keep the window manager, settings, file daemon and backdrop.
        session = ET.Element('channel', name='xfce4-session', version='1.0')
        general = ET.SubElement(session, 'property', name='general', type='empty')
        ET.SubElement(general, 'property', name='SaveOnExit', type='bool', value='false')
        failsafe = ET.SubElement(ET.SubElement(session, 'property', name='sessions', type='empty'), 'property', name='Failsafe', type='empty')
        command = ET.SubElement(failsafe, 'property', name='Client2_Command', type='array')
        ET.SubElement(command, 'value', type='string', value='/usr/bin/true')
        ET.ElementTree(session).write(xml_dir / 'xfce4-session.xml', encoding='UTF-8', xml_declaration=True)
        shortcuts_file = xml_dir / 'xfce4-keyboard-shortcuts.xml'
        shortcuts = ET.parse(shortcuts_file)
        commands = shortcuts.find("property[@name='commands']")
        custom = commands.find("property[@name='custom']")
        for key, app in [('b', 'browser'), ('t', 'terminal'), ('e', 'files')]:
            name = '<Super>' + key
            existing = custom.find("property[@name='" + name + "']")
            if existing is None:
                existing = ET.SubElement(custom, 'property', name=name, type='string')
            existing.set('value', '/usr/local/bin/vc-cloud-workspace ' + app)
        window_commands = shortcuts.find("property[@name='xfwm4']")
        blocked = {'close_window_key', 'hide_window_key', 'move_window_key', 'resize_window_key', 'maximize_window_key', 'unmaximize_window_key', 'shade_window_key', 'popup_menu_key', 'fullscreen_key'}
        for group in window_commands:
            for shortcut in group:
                if shortcut.attrib.get('value') in blocked:
                    shortcut.set('value', '')
        shortcuts.write(shortcuts_file, encoding='UTF-8', xml_declaration=True)
        settings = wm.find("property[@name='general']")
        easy_click = settings.find("property[@name='easy_click']")
        if easy_click is None:
            easy_click = ET.SubElement(settings, 'property', name='easy_click', type='string')
        easy_click.set('value', 'None')
        wm.write(wm_file, encoding='UTF-8', xml_declaration=True)
        preferences_file = updater.CONFIG / 'browser/vps-desktop/Default/Preferences'
        preferences = json.loads(preferences_file.read_text())
        preferences.setdefault('browser', {})['custom_chrome_frame'] = False
        # This was a controlled maintenance stop, not a failed browser session.
        preferences.setdefault('profile', {})['exit_type'] = 'Normal'
        preferences['profile']['exited_cleanly'] = True
        preferences_file.write_text(json.dumps(preferences))
    helpers = desktop / 'xfce4/helpers.rc'
    content = helpers.read_text() if helpers.exists() else ''
    helpers.write_text('\n'.join(line for line in content.splitlines() if not line.startswith('WebBrowser=')) + '\nWebBrowser=vc-cloud-browser\n')
    updater.run(['chown', '-R', '1000:1000', str(desktop)])
    # Keep the same profile, but move obsolete singleton handles out of the way
    # only after the container and all its Chrome processes are stopped.
    profile = updater.CONFIG / 'browser/vps-desktop'
    locks = backup / 'browser-locks'
    locks.mkdir()
    for name in ['SingletonLock', 'SingletonCookie', 'SingletonSocket']:
        path = profile / name
        if path.is_symlink() or path.exists():
            path.rename(locks / name)
    shared = Path('/opt/voice-connect-v2/shared-files')
    shared.mkdir(mode=0o755, exist_ok=True)
    for name in ['Images', 'Documents']:
        directory = shared / name
        directory.mkdir(exist_ok=True)
        os.chown(directory, 1000, 0)
        directory.chmod(0o770)
    override = updater.PROJECT / 'compose.override.yaml'
    text = override.read_text()
    mount = '      - /opt/voice-connect-v2/shared-files:/home/node/Shared files\n'
    if mount.strip() not in text:
        assert '    volumes:\n' in text
        override.write_text(text.replace('    volumes:\n', '    volumes:\n' + mount, 1))
    workspace = updater.CONFIG / 'workspace/AGENTS.md'
    guidance = '''
### Visible desktop incoming files

Lloyd selected Home -> Shared files -> Images and Documents as the destination
for incoming files, not as a restriction on existing agent file permissions.
- Incoming Voice Connect images and OpenClaw media/inbound files are copied by
  the host service into /home/node/Shared files/Images or Documents within seconds.
- Use these visible paths when referring to received files or saving user-facing
  image/document work. Preserve their contents and user edits; do not put received
  files only into hidden OpenClaw infrastructure folders.
- This is regular Google Chrome Stable installed system-wide by root, launched
  as node through /usr/local/bin/vc-cloud-browser. No root shell is needed to open it.
'''
    if '### Visible desktop incoming files' not in workspace.read_text():
        workspace.write_text(workspace.read_text() + guidance)
    env = updater.PROJECT / '.env'
    env.write_text(updater.set_environment_image(env.read_text(), candidate))
    env.chmod(0o600)
    updater.run(updater.COMPOSE + ['config', '--quiet'])
    updater.run(updater.COMPOSE + ['up', '-d', '--no-build', '--no-deps', 'openclaw-gateway'], timeout=180)
    updater.verify_gateway(version)
    if os.environ.get('VC_DESKTOP_WRAPPER') == 'true':
        # Future Gateway updates must hash and retain every wrapper source file.
        import hashlib
        current = Path('/opt/openclaw-updater/current')
        old_release = current.resolve()
        new_release = Path('/opt/openclaw-updater/releases') / hashlib.sha256((source / 'updater.py').read_bytes()).hexdigest()
        if new_release != old_release:
            shutil.copytree(old_release, new_release, dirs_exist_ok=True)
            shutil.copy2(source / 'updater.py', new_release / 'updater.py')
            current.unlink()
            current.symlink_to(new_release)
    shutil.copy2(source / 'voice-connect-desktop-files.service', '/etc/systemd/system/voice-connect-desktop-files.service')
    updater.run(['systemctl', 'daemon-reload'])
    updater.run(['systemctl', 'enable', '--now', 'voice-connect-desktop-files.service'])
    print(json.dumps({'installed': True, 'chromeImage': candidate, 'backup': str(backup), 'workspaceSwitcherRemoved': True, 'greenSettingsPreserved': True, 'sharedFilesService': True}))
except Exception:
    if stopped:
        updater.run(updater.COMPOSE + ['stop', '-t', '30', 'openclaw-gateway'])
        updater.restore(backup)
        updater.run(updater.COMPOSE + ['up', '-d', '--no-build', '--no-deps', 'openclaw-gateway'], env=updater.compose_env(old_image), timeout=180)
        persistent = updater.run(['docker', 'exec', updater.CONTAINER, 'sh', '-c', 'if test -L /home/node/.config/xfce4; then echo persistent; else echo local; fi']).strip()
        if persistent != 'persistent':
            updater.run(['docker', 'cp', str(backup / 'xfce4') + '/.', updater.CONTAINER + ':/home/node/.config/xfce4'])
        updater.run(['docker', 'cp', str(backup / 'user-local') + '/.', updater.CONTAINER + ':/home/node/.local'])
        updater.run(['docker', 'exec', '-u', 'root', updater.CONTAINER, 'chown', '-R', '1000:1000', '/home/node/.config/xfce4', '/home/node/.local'])
        current = Path('/opt/openclaw-updater/current')
        if current.resolve() != old_updater_release:
            current.unlink()
            current.symlink_to(old_updater_release)
    raise
finally:
    updater.run(['systemctl', 'start', 'openclaw-host-updater.service'])
