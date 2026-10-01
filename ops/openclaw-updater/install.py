#!/usr/bin/env python3
"""Install the fixed-function updater, retaining the current OpenClaw image."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

from updater import COMPOSE, CONFIG, CONTAINER, PROJECT, STATE, current_image, run, set_environment_image, snapshot, verify_gateway


def install(source):
    if socket.gethostname() != 'srv2003889' or os.geteuid() != 0:
        raise RuntimeError('Expected the authorized VPS root setup process.')
    image, version = current_image()
    digest = hashlib.sha256()
    files = [source/'updater.py', source/'openclaw-host-updater.service', *(path for path in (source/'plugin').rglob('*') if path.is_file())]
    for path in sorted(files):
        digest.update(str(path.relative_to(source)).encode())
        digest.update(path.read_bytes())
    release = digest.hexdigest()
    destination = Path('/opt/openclaw-updater/releases')/release
    destination.mkdir(parents=True, exist_ok=True)
    for name in ['updater.py', 'openclaw-host-updater.service']:
        shutil.copy2(source/name, destination/name)
        os.chmod(destination/name, 0o644)
    shutil.copytree(source/'plugin', destination/'plugin', dirs_exist_ok=True)
    for path in destination.rglob('*'):
        os.chown(path, 0, 0)
        os.chmod(path, 0o755 if path.is_dir() else 0o644)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    status_file = STATE/'status.json'
    if status_file.exists() and json.loads(status_file.read_text()).get('phase') not in {'idle', 'completed', 'failed', 'rolled_back', 'rollback_failed'}:
        raise RuntimeError('A host update is active; finish it before replacing the updater.')
    Path('/run/openclaw-updater').mkdir(mode=0o750, exist_ok=True)
    os.chown('/run/openclaw-updater', 0, 1000)
    service_file = Path('/etc/systemd/system/openclaw-host-updater.service')
    backup = STATE/'setup-backups'/time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    backup.mkdir(parents=True, exist_ok=True)
    current_link = Path('/opt/openclaw-updater/current')
    old_link = os.readlink(current_link) if current_link.is_symlink() else None
    if service_file.exists():
        shutil.copy2(service_file, backup/'updater.service')
    run(COMPOSE + ['stop', '-t', '30', 'openclaw-gateway'])
    try:
        snapshot(backup)
        cfg_path = CONFIG/'openclaw.json'
        config = json.loads(cfg_path.read_text())
        plugin_path = '/openclaw-host-updater'
        plugins = config.setdefault('plugins', {})
        paths = plugins.setdefault('load', {}).setdefault('paths', [])
        if plugin_path not in paths:
            paths.append(plugin_path)
        plugins.setdefault('entries', {})['openclaw-host-updater'] = {'enabled': True, 'config': {}}
        if isinstance(plugins.get('allow'), list) and 'openclaw-host-updater' not in plugins['allow']:
            plugins['allow'].append('openclaw-host-updater')
        cfg_path.write_text(json.dumps(config, indent=2) + '\n')
        override = PROJECT/'compose.override.yaml'
        text = override.read_text()
        additions = []
        if '/run/openclaw-updater:/run/openclaw-updater:ro' not in text:
            additions.append('      - /run/openclaw-updater:/run/openclaw-updater:ro\n')
        if '/opt/openclaw-updater/current/plugin:/openclaw-host-updater:ro' not in text:
            additions.append('      - /opt/openclaw-updater/current/plugin:/openclaw-host-updater:ro\n')
        if additions:
            if text.count('    volumes:\n') != 1:
                raise RuntimeError('Unexpected Compose volumes structure; existing setup preserved in backup.')
            text = text.replace('    volumes:\n', '    volumes:\n' + ''.join(additions), 1)
        override.write_text(text)
        env_path = PROJECT/'.env'
        env_path.write_text(set_environment_image(env_path.read_text() if env_path.exists() else '', image))
        os.chmod(env_path, 0o600)
        current_link.unlink(missing_ok=True)
        current_link.symlink_to(destination)
        shutil.copy2(destination/'openclaw-host-updater.service', service_file)
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'enable', 'openclaw-host-updater.service'])
        run(['systemctl', 'restart', 'openclaw-host-updater.service'])
        # Check the existing version; installing the route does not upgrade it.
        run(COMPOSE + ['config', '--quiet'])
        run(COMPOSE + ['up', '-d', '--no-build', '--no-deps', 'openclaw-gateway'], timeout=180)
        verify_gateway(version)
        result = {'installed': True, 'runningVersion': version, 'updaterBuild': release, 'setupBackup': str(backup), 'gatewayVerified': True, 'updatedOpenClaw': False}
        (STATE/'installation.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result))
    except Exception:
        from updater import restore
        run(COMPOSE + ['stop', '-t', '30', 'openclaw-gateway'])
        if (backup/'backup.json').exists():
            restore(backup)
        run(['systemctl', 'stop', 'openclaw-host-updater.service'])
        if old_link:
            current_link.unlink(missing_ok=True)
            current_link.symlink_to(old_link)
        if (backup/'updater.service').exists():
            shutil.copy2(backup/'updater.service', service_file)
            run(['systemctl', 'daemon-reload'])
            run(['systemctl', 'start', 'openclaw-host-updater.service'])
        run(COMPOSE + ['up', '-d', '--no-build', '--no-deps', 'openclaw-gateway'], env=dict(os.environ, OPENCLAW_IMAGE=image))
        verify_gateway(version)
        raise


if __name__ == '__main__':
    install(Path(sys.argv[1]).resolve())
