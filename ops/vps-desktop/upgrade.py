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
old_image, version = updater.current_image()
assert version == '2026.9.7'
status = json.loads((updater.STATE / 'status.json').read_text())
assert status.get('phase') in updater.TERMINAL | {'idle'}
with sqlite3.connect('file:/opt/voice-connect-v2/state/voice-connect.sqlite?mode=ro', uri=True) as db:
    assert not db.execute("SELECT id FROM turns WHERE delivery IN ('pending','accepted') LIMIT 1").fetchone(), 'Wait for the current VC turn'
candidate = json.loads(subprocess.check_output(['docker', 'image', 'inspect', 'openclaw-desktop:2026.9.7-chrome-stable']))[0]['Id']
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
    shutil.copytree(backup / 'xfce4', desktop / 'xfce4', dirs_exist_ok=True, symlinks=True)
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
    shutil.copy2(source / 'voice-connect-desktop-files.service', '/etc/systemd/system/voice-connect-desktop-files.service')
    updater.run(['systemctl', 'daemon-reload'])
    updater.run(['systemctl', 'enable', '--now', 'voice-connect-desktop-files.service'])
    print(json.dumps({'installed': True, 'chromeImage': candidate, 'backup': str(backup), 'workspaceSwitcherRemoved': True, 'greenSettingsPreserved': True, 'sharedFilesService': True}))
except Exception:
    if stopped:
        updater.run(updater.COMPOSE + ['stop', '-t', '30', 'openclaw-gateway'])
        updater.restore(backup)
        updater.run(updater.COMPOSE + ['up', '-d', '--no-build', '--no-deps', 'openclaw-gateway'], env=updater.compose_env(old_image), timeout=180)
        updater.run(['docker', 'cp', str(backup / 'xfce4'), updater.CONTAINER + ':/home/node/.config/xfce4'])
        updater.run(['docker', 'cp', str(backup / 'user-local') + '/.', updater.CONTAINER + ':/home/node/.local'])
        updater.run(['docker', 'exec', '-u', 'root', updater.CONTAINER, 'chown', '-R', '1000:1000', '/home/node/.config/xfce4', '/home/node/.local'])
    raise
finally:
    updater.run(['systemctl', 'start', 'openclaw-host-updater.service'])
