#!/usr/bin/env python3
"""Install the authorized managed VPS desktop without replacing existing routes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time


def install():
    if socket.gethostname() != 'srv2003889' or os.geteuid() != 0:
        raise RuntimeError('Expected the authorized VPS root process')
    source=Path('/opt/voice-connect-v2/desktop-build')
    current=Path('/opt/openclaw-updater/current')
    spec=importlib.util.spec_from_file_location('updater',source/'updater.py')
    updater=importlib.util.module_from_spec(spec);spec.loader.exec_module(updater)
    state=updater.STATE
    status=state/'status.json'
    if status.exists() and json.loads(status.read_text()).get('phase') not in updater.TERMINAL|{'idle'}:
        raise RuntimeError('An OpenClaw update is active')
    old_image,version=updater.current_image()
    image='openclaw-desktop:2026.9.7'
    metadata=json.loads(subprocess.check_output(['docker','image','inspect',image]))[0]
    if version!='2026.9.7' or metadata['Config']['Labels'].get('org.voice-connect.desktop')!='true':
        raise RuntimeError('Desktop image/version mismatch')
    pinned=metadata['Id']
    subprocess.run(['docker','run','--rm','--network','none','--entrypoint','sh',pinned,'-c',
                    'command -v Xtigervnc && command -v startxfce4 && test -x /usr/local/bin/vc-cloud-browser'],check=True)
    backup=Path('/opt/voice-connect-v2/backups')/('desktop-'+time.strftime('%Y%m%dT%H%M%SZ',time.gmtime()))
    backup.mkdir(mode=0o700)
    old_link=current.resolve()
    destination=Path('/opt/openclaw-updater/releases')/hashlib.sha256((source/'updater.py').read_bytes()).hexdigest()
    shutil.copytree(old_link,destination,dirs_exist_ok=True)
    shutil.copy2(source/'updater.py',destination/'updater.py')
    workspace=Path('/root/.openclaw/workspace/AGENTS.md')
    shutil.copy2(workspace,backup/'AGENTS.md')
    updater.run(updater.COMPOSE+['stop','-t','30','openclaw-gateway'])
    updater.snapshot(backup)
    try:
        config_path=Path('/root/.openclaw/openclaw.json')
        config=json.loads(config_path.read_text())
        config.setdefault('desktop',{}).setdefault('host',{}).update({'enabled':True,'managed':True})
        config['desktop']['host'].pop('port',None)
        config.setdefault('plugins',{}).setdefault('entries',{}).setdefault('cua-computer',{})['enabled']=True
        if isinstance(config['plugins'].get('allow'),list) and config['plugins']['allow'] and 'cua-computer' not in config['plugins']['allow']:
            config['plugins']['allow'].append('cua-computer')
        browser=config.setdefault('browser',{})
        browser.setdefault('profiles',{})['vps-desktop']={'cdpUrl':'http://127.0.0.1:18802','attachOnly':True,'color':'#51B8A4'}
        allowed=browser.setdefault('ssrfPolicy',{}).setdefault('allowedHostnames',[])
        if '127.0.0.1' not in allowed:allowed.append('127.0.0.1')
        config_path.write_text(json.dumps(config,indent=2)+'\n')
        guidance='''
### Separate Ubuntu cloud desktop

Lloyd explicitly authorized a separate persistent Chromium desktop on this VPS.
The Voice Connect monitor icon opens it at /desktop, initially view-only.
- When Lloyd says cloud desktop, VPS desktop, or server computer, use `computer`
  with `target="gateway"`. Observe first; use the returned frame/window references.
- For browser automation in that same visible Chromium, use `browser` with
  `target="host"`, `profile="vps-desktop"`. First observe the managed desktop so
  its autostart Chromium is running. Do not select the older headless `openclaw`
  profile when Lloyd expects to see the browser in the desktop viewer.
- Preserve the existing Windows PC default and its explicit node selector in the
  guidance above. Never silently move a PC request to this VPS or the reverse.
  Use explicit selectors on computer calls now that both computers exist.
- A manual controlling viewer pauses agent input. Do not steal manual control;
  ask Lloyd to Release control before resuming if the tool reports contention.
- Chromium cookies and tabs use a dedicated VPS profile, separate from the PC.
  This desktop shares the Gateway container and is not a separate virtual machine.
'''
        if '### Separate Ubuntu cloud desktop' not in workspace.read_text():
            workspace.write_text(workspace.read_text()+guidance)
        env=updater.PROJECT/'.env'
        env.write_text(updater.set_environment_image(env.read_text(),pinned));os.chmod(env,0o600)
        current.unlink();current.symlink_to(destination)
        (state/'desktop-enabled').write_text('true\n')
        updater.run(['systemctl','restart','openclaw-host-updater.service'])
        updater.run(updater.COMPOSE+['config','--quiet'])
        updater.run(updater.COMPOSE+['up','-d','--no-build','--no-deps','openclaw-gateway'],timeout=180)
        updater.verify_gateway(version)
        print(json.dumps({'desktopConfigured':True,'openclawVersion':version,'backup':str(backup),'image':pinned}))
    except Exception:
        updater.run(updater.COMPOSE+['stop','-t','30','openclaw-gateway'])
        updater.restore(backup)
        shutil.copy2(backup/'AGENTS.md',workspace)
        current.unlink();current.symlink_to(old_link)
        (state/'desktop-enabled').unlink(missing_ok=True)
        updater.run(['systemctl','restart','openclaw-host-updater.service'])
        updater.run(updater.COMPOSE+['up','-d','--no-build','--no-deps','openclaw-gateway'],env=updater.compose_env(old_image))
        updater.verify_gateway(version)
        raise


if __name__=='__main__':install()
