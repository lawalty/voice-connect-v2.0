#!/usr/bin/env python3
"""Fixed-function host updater. No caller-supplied commands, images, or paths."""
import argparse
import datetime
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import socket
import socketserver
import struct
import subprocess
import tarfile
import threading
import time
import urllib.request
import uuid

STATE = Path('/var/lib/openclaw-updater')
CONTROL = Path('/run/openclaw-updater/control.sock')
PROJECT = Path('/root/openclaw')
CONFIG = Path('/root/.openclaw')
AUTH = Path('/root/.openclaw-auth-profile-secrets')
CONTAINER = 'openclaw-openclaw-gateway-1'
OFFICIAL = 'ghcr.io/openclaw/openclaw'
VERSION = re.compile(r'^202\d\.\d{1,2}\.\d{1,2}$')
TERMINAL = {'completed', 'failed', 'rolled_back', 'rollback_failed'}
COMPOSE = ['docker', 'compose', '--project-directory', str(PROJECT), '-f', str(PROJECT/'docker-compose.yml'), '-f', str(PROJECT/'compose.override.yaml')]


class UpdateError(Exception):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def run(argv, timeout=120, env=None):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        raise UpdateError('command_timeout') from None
    if result.returncode:
        # Command output can contain provider configuration. Never return or log it.
        raise UpdateError('command_failed:' + Path(argv[0]).name)
    return result.stdout


def fetch_json(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'OpenClaw-Host-Updater/1', 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read(2_000_000))


def stable_release(fetch=fetch_json):
    release = fetch('https://api.github.com/repos/openclaw/openclaw/releases/latest')
    tag = release.get('tag_name', '')
    version = tag.removeprefix('v')
    if release.get('draft') is not False or release.get('prerelease') is not False or not VERSION.fullmatch(version):
        raise UpdateError('official_stable_release_invalid')
    ref = fetch('https://api.github.com/repos/openclaw/openclaw/git/ref/tags/' + tag)['object']
    for _ in range(3):
        if ref.get('type') == 'commit':
            break
        if ref.get('type') != 'tag' or not re.fullmatch('[0-9a-f]{40}', ref.get('sha', '')):
            raise UpdateError('official_release_revision_invalid')
        ref = fetch('https://api.github.com/repos/openclaw/openclaw/git/tags/' + ref['sha'])['object']
    if ref.get('type') != 'commit' or not re.fullmatch('[0-9a-f]{40}', ref.get('sha', '')):
        raise UpdateError('official_release_revision_invalid')
    return {'version': version, 'revision': ref['sha'], 'releaseUrl': 'https://github.com/openclaw/openclaw/releases/tag/' + tag}


def version_tuple(version):
    if not VERSION.fullmatch(version):
        raise UpdateError('installed_version_invalid')
    return tuple(int(part) for part in version.split('.'))


def inspect_image(image):
    return json.loads(run(['docker', 'image', 'inspect', image]))[0]


def current_image():
    image_id = run(['docker', 'inspect', CONTAINER, '--format', '{{.Image}}']).strip()
    metadata = inspect_image(image_id)
    labels = metadata['Config'].get('Labels', {})
    version = labels.get('org.opencontainers.image.version', '')
    version_tuple(version)
    return image_id, version


def pin_candidate(metadata, release):
    labels = metadata['Config'].get('Labels', {})
    if labels.get('org.opencontainers.image.version') != release['version'] or labels.get('org.opencontainers.image.revision') != release['revision'] or labels.get('org.opencontainers.image.source') != 'https://github.com/openclaw/openclaw':
        raise UpdateError('official_image_identity_mismatch')
    for value in metadata.get('RepoDigests', []):
        if re.fullmatch(re.escape(OFFICIAL) + r'@sha256:[0-9a-f]{64}', value):
            return value
    raise UpdateError('official_image_digest_missing')


def portable_computer_patch(dynamic, computer, module_name):
    """Port the existing narrow repair only when its known contract still matches."""
    for name in ['loadPairedComputerUseAvailabilityForSurface', 'loadCodexPairedComputerUseAvailability']:
        match = re.search(r'\b' + name + r' as (\w+)', computer)
        if match and ('function ' + name + '(') in computer:
            availability_name, export_name = name, match[1]
            break
    else:
        raise UpdateError('computer_capability_contract_changed')
    marker = '\ttoolBuildStages.mark("create-openclaw-coding-tools");'
    if dynamic.count(marker) != 1 or dynamic.count('const allTools = input.resolveCronCreatorToolAuthority ?') != 1:
        raise UpdateError('computer_surface_contract_changed')
    if 'pairedNodeComputerUse = availability.prepared' in dynamic:
        raise UpdateError('computer_repair_already_present')
    if not re.fullmatch(r'computer-tool-[A-Za-z0-9_-]+\.mjs', module_name):
        raise UpdateError('computer_module_invalid')
    dynamic = dynamic.replace('const allTools = input.resolveCronCreatorToolAuthority ?', 'const buildAuthorizedToolSurface = () => input.resolveCronCreatorToolAuthority ?', 1)
    addition = '''\tlet allTools = buildAuthorizedToolSurface();
\t// Preserve the paired-PC capability repair before Codex tool serialization.
\tif (modelHasVision && allTools.some((tool) => tool.name === "computer")) {
\t\tconst { EXPORT: loadAvailability } = await import("./MODULE");
\t\tconst availability = await loadAvailability({
\t\t\tcomputerAllowed: true, modelHasVision,
\t\t\tcomputerTransport: options.computerTransport,
\t\t\tsignal: input.runAbortController.signal
\t\t});
\t\tif (availability?.prepared) {
\t\t\toptions.pairedNodeComputerUse = availability.prepared;
\t\t\tallTools = buildAuthorizedToolSurface();
\t\t}
\t}
'''.replace('EXPORT', export_name).replace('MODULE', module_name)
    return dynamic.replace(marker, addition + marker, 1), availability_name


EXTRACT_MODULES = r'''
const fs=require('fs');
const files=fs.readdirSync('/app/dist');
const dynamic=files.filter(f=>/^dynamic-tools-[\w-]+\.mjs$/.test(f)).map(f=>({name:f,text:fs.readFileSync('/app/dist/'+f,'utf8')})).filter(x=>x.text.includes('Codex tool construction requires a current host capability'));
const computer=files.filter(f=>/^computer-tool-[\w-]+\.mjs$/.test(f)).map(f=>({name:f,text:fs.readFileSync('/app/dist/'+f,'utf8')})).filter(x=>x.text.includes('loadPairedComputerUseAvailabilityForSurface')||x.text.includes('loadCodexPairedComputerUseAvailability'));
console.log(JSON.stringify({dynamic,computer}));
'''


def prepare_candidate(pinned, release, job_dir, plugin=None):
    modules = json.loads(run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node', pinned, '-e', EXTRACT_MODULES]))
    if len(modules['dynamic']) != 1 or len(modules['computer']) != 1:
        raise UpdateError('computer_modules_ambiguous')
    dynamic, computer = modules['dynamic'][0], modules['computer'][0]
    # If upstream implements the exact pre-serialization preparation, retain it.
    if 'pairedNodeComputerUse = availability.prepared' in dynamic['text']:
        image, contract = pinned, 'upstream_preparation'
    else:
        if not re.search(r'\b(?:const|let) modelHasVision\b', dynamic['text']):
            raise UpdateError('computer_model_vision_contract_changed')
        patched, contract = portable_computer_patch(dynamic['text'], computer['text'], computer['name'])
        (job_dir/dynamic['name']).write_text(patched)
        (job_dir/'Dockerfile').write_text('FROM ' + pinned + '\nCOPY --chown=node:node ' + dynamic['name'] + ' /app/dist/' + dynamic['name'] + '\nRUN node --check /app/dist/' + dynamic['name'] + '\n')
        image = 'openclaw-verified:' + release['version'] + '-' + hashlib.sha256(patched.encode()).hexdigest()[:12]
        run(['docker', 'build', '--network', 'none', '--label', 'org.voice-connect.upstream=' + pinned, '-t', image, str(job_dir)], timeout=600)
    # Validate the isolated plugin against the actual candidate SDK without private state.
    plugin = plugin or Path('/opt/openclaw-updater/current/plugin')
    validate_js = "import fs from 'node:fs';fs.mkdirSync('/probe/node_modules',{recursive:true});fs.symlinkSync('/app','/probe/node_modules/openclaw');await import('file:///probe/plugin/index.mjs');"
    run(['docker', 'run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'node', '-v', str(plugin) + ':/probe/plugin:ro', image, '--input-type=module', '-e', validate_js])
    return image, contract


def compose_env(image=None):
    env = dict(os.environ)
    if image:
        env['OPENCLAW_IMAGE'] = image
    return env


def remove_old_patch(override):
    lines = override.splitlines(True)
    return ''.join(line for line in lines if not ('/root/.openclaw/runtime-fixes/codex-computer-capabilities-20260929/' in line and '/app/dist/dynamic-tools-' in line))


def set_environment_image(text, image):
    if not re.fullmatch(r'(?:ghcr\.io/openclaw/openclaw@sha256:[0-9a-f]{64}|openclaw-verified:202\d\.\d{1,2}\.\d{1,2}-[0-9a-f]{12}|sha256:[0-9a-f]{64})', image):
        raise UpdateError('pinned_image_invalid')
    lines = [line for line in text.splitlines() if not re.match(r'^\s*(?:export\s+)?OPENCLAW_IMAGE\s*=', line)]
    return '\n'.join(lines) + '\nOPENCLAW_IMAGE=' + image + '\n'


def snapshot(job_dir):
    archive = job_dir/'before.tar'
    with tarfile.open(archive, 'w') as tar:
        tar.add(CONFIG, arcname='state', recursive=True)
        if AUTH.exists():
            tar.add(AUTH, arcname='auth', recursive=True)
        for name in ['.env', 'docker-compose.yml', 'compose.override.yaml']:
            if (PROJECT/name).exists():
                tar.add(PROJECT/name, arcname='project/' + name)
    os.chmod(archive, 0o600)
    with tarfile.open(archive) as tar:
        if 'state/openclaw.json' not in tar.getnames() or 'project/compose.override.yaml' not in tar.getnames():
            raise UpdateError('backup_incomplete')
    write_json(job_dir/'backup.json', {'sha256': file_hash(archive), 'createdAt': now()})


def restore(job_dir):
    archive = job_dir/'before.tar'
    expected = json.loads((job_dir/'backup.json').read_text())['sha256']
    if file_hash(archive) != expected:
        raise UpdateError('backup_integrity_failed')
    staging = job_dir/'restored'
    staging.mkdir(exist_ok=False)
    with tarfile.open(archive) as tar:
        # This archive was created locally from allowlisted paths, never from a request.
        tar.extractall(staging, filter='fully_trusted')
    for source, target in [(staging/'state', CONFIG), (staging/'auth', AUTH)]:
        if not source.exists():
            continue
        failed = job_dir/('failed-' + source.name)
        shutil.copytree(target, failed, symlinks=True)
        for child in target.iterdir():
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child)
            else:
                child.unlink()
        run(['cp', '-a', str(source) + '/.', str(target) + '/'])
    for name in ['.env', 'docker-compose.yml', 'compose.override.yaml']:
        source = staging/'project'/name
        if source.exists():
            shutil.copy2(source, PROJECT/name)


def verify_gateway(version, timeout=180):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            _, running_version = current_image()
            if running_version != version:
                raise UpdateError('running_version_mismatch')
            health = run(['docker', 'inspect', CONTAINER, '--format', '{{if .State.Health}}{{.State.Health.Status}}{{end}}']).strip()
            if health != 'healthy':
                raise UpdateError('gateway_not_healthy')
            run(['docker', 'exec', CONTAINER, 'node', 'openclaw.mjs', 'gateway', 'call', 'health', '--json'], timeout=25)
            with urllib.request.urlopen('http://127.0.0.1:18880/health', timeout=5) as response:
                if json.load(response).get('openclaw') is not True:
                    raise UpdateError('voice_connect_not_reconnected')
            break
        except (UpdateError, OSError, ValueError):
            time.sleep(3)
    else:
        raise UpdateError('post_update_verification_failed')
    verify_agent_runtime(version)


def verify_agent_runtime(version):
    config = json.loads((CONFIG/'openclaw.json').read_text())
    entries = config.get('agents', {}).get('entries', {})
    if not isinstance(entries, dict) or not entries:
        raise UpdateError('agent_runtime_health_target_missing')
    agent_id = next(iter(entries))
    if not re.fullmatch(r'[a-z0-9_-]+', agent_id):
        raise UpdateError('agent_runtime_health_target_invalid')
    # An isolated, labeled native turn exercises real harness/tool construction.
    # It never delivers to an external channel or joins the owner's conversation.
    session = 'agent:' + agent_id + ':host-updater-health-' + version + '-' + uuid.uuid4().hex[:8]
    output = run(['docker', 'exec', CONTAINER, 'node', 'openclaw.mjs', 'agent', '--agent', agent_id, '--session-key', session, '--message', 'Automated OpenClaw host-update health check only. Do not use tools, modify memory, or take any other action. Reply with exactly HOST_UPDATER_OK.', '--thinking', 'low', '--timeout', '90', '--json'], timeout=120)
    try:
        result = json.loads(output[output.index('{'):])
        payloads = result.get('result', {}).get('payloads', result.get('payloads', []))
        if result.get('status') != 'ok' or not any(p.get('text', '').strip() == 'HOST_UPDATER_OK' for p in payloads):
            raise UpdateError('agent_runtime_health_failed')
    except (ValueError, TypeError, KeyError):
        raise UpdateError('agent_runtime_health_failed') from None


def perform_update(job, report, release_lookup=stable_release):
    job_dir = STATE/'jobs'/job['id']
    job_dir.mkdir(parents=True, exist_ok=True)
    old_image, old_version = current_image()
    job['previousVersion'] = old_version
    report('checking')
    release = release_lookup()
    job['targetVersion'] = release['version']
    job['releaseUrl'] = release['releaseUrl']
    if version_tuple(release['version']) <= version_tuple(old_version):
        job['message'] = 'OpenClaw is already on this stable release or a newer version. Nothing changed.'
        report('completed')
        return
    report('preparing')
    if shutil.disk_usage(STATE).free < 5 * 1024**3:
        raise UpdateError('insufficient_disk_space')
    tag = OFFICIAL + ':' + release['version'] + '-browser'
    run(['docker', 'pull', tag], timeout=1200)
    pinned = pin_candidate(inspect_image(tag), release)
    candidate, repair = prepare_candidate(pinned, release, job_dir)
    job['computerCompatibility'] = repair
    # Validate Compose structure before stopping anything; do not print its secrets.
    run(COMPOSE + ['config', '--quiet'], env=compose_env(candidate))
    write_json(job_dir/'recovery.json', {'oldImage': old_image, 'oldVersion': old_version, 'candidate': candidate})
    report('stopping')
    stopped = False
    backed_up = False
    try:
        stopped = True
        run(COMPOSE + ['stop', '-t', '30', 'openclaw-gateway'])
        report('backing_up')
        snapshot(job_dir)
        backed_up = True
        report('installing')
        override_path = PROJECT/'compose.override.yaml'
        override_path.write_text(remove_old_patch(override_path.read_text()))
        env_path = PROJECT/'.env'
        env_path.write_text(set_environment_image(env_path.read_text() if env_path.exists() else '', candidate))
        os.chmod(env_path, 0o600)
        run(COMPOSE + ['up', '-d', '--no-build', '--no-deps', 'openclaw-gateway'], timeout=180, env=compose_env(candidate))
        report('verifying')
        verify_gateway(release['version'])
        job['message'] = 'OpenClaw updated and verified; Voice Connect reconnected. Previous image and full pre-update state backup are retained.'
        report('completed')
    except Exception:
        if stopped:
            report('rolling_back')
            try:
                run(COMPOSE + ['stop', '-t', '30', 'openclaw-gateway'])
                if backed_up:
                    restore(job_dir)
                run(COMPOSE + ['up', '-d', '--no-build', '--no-deps', 'openclaw-gateway'], timeout=180, env=compose_env(old_image))
                verify_gateway(old_version)
                job['message'] = 'The update failed its checks. The previous OpenClaw image and pre-update state were restored and verified.'
                report('rolled_back')
            except Exception:
                job['message'] = 'Update and automatic recovery failed. The original image and backup remain available; host maintenance is required.'
                report('rollback_failed')
        raise


class Manager:
    def __init__(self, state=STATE, worker=perform_update):
        self.state, self.worker = state, worker
        self.lock = threading.RLock()
        self.status_file = state/'status.json'
        self.job = json.loads(self.status_file.read_text()) if self.status_file.exists() else {'phase': 'idle', 'message': 'No update has been requested.'}

    def report(self, phase):
        with self.lock:
            self.job.update(phase=phase, updatedAt=now())
            write_json(self.status_file, self.job)

    def status(self):
        with self.lock:
            return dict(self.job)

    def check(self):
        release = stable_release()
        _, current = current_image()
        return {'phase': 'checked', 'currentVersion': current, 'latestStableVersion': release['version'], 'updateAvailable': version_tuple(release['version']) > version_tuple(current), 'releaseUrl': release['releaseUrl']}

    def start(self, session_key):
        with self.lock:
            if self.job['phase'] not in TERMINAL | {'idle'}:
                return dict(self.job)
            self.job = {'id': uuid.uuid4().hex, 'sessionKey': session_key, 'phase': 'queued', 'requestedAt': now(), 'message': 'The host update is queued. A gateway restart will briefly disconnect the conversation. Use openclaw_update_status after reconnecting; queued is not success.'}
            write_json(self.status_file, self.job)
            thread = threading.Thread(target=self._run, daemon=False)
            thread.start()
            return dict(self.job)

    def _run(self):
        with (self.state/'update.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.worker(self.job, self.report)
            except Exception as error:
                if self.job['phase'] not in TERMINAL:
                    self.job['message'] = 'Update did not proceed. ' + (str(error) if isinstance(error, UpdateError) else 'host_update_failed') + '. The running setup was not confirmed changed.'
                    self.report('failed')

    def recover_interrupted(self):
        if self.job['phase'] in TERMINAL | {'idle'}:
            return
        job_dir = self.state/'jobs'/self.job['id']
        if self.job['phase'] in {'stopping', 'backing_up', 'installing', 'verifying', 'rolling_back'}:
            try:
                recovery = json.loads((job_dir/'recovery.json').read_text())
                run(COMPOSE + ['stop', '-t', '30', 'openclaw-gateway'])
                if (job_dir/'backup.json').exists():
                    restore(job_dir)
                run(COMPOSE + ['up', '-d', '--no-build', '--no-deps', 'openclaw-gateway'], env=compose_env(recovery['oldImage']))
                verify_gateway(recovery['oldVersion'])
                self.job['message'] = 'An interrupted host update was rolled back and the previous gateway verified.'
                self.report('rolled_back')
            except Exception:
                self.job['message'] = 'Interrupted update recovery needs host maintenance. Backups are retained.'
                self.report('rollback_failed')
        else:
            self.job['message'] = 'The host updater restarted during preparation. No update was committed; request the update again.'
            self.report('failed')


def validate_request(value):
    if not isinstance(value, dict) or value.get('action') not in ['check', 'update', 'status']:
        raise UpdateError('invalid_request')
    expected = {'action', 'sessionKey'} if value['action'] == 'update' else {'action'}
    if set(value) != expected:
        raise UpdateError('invalid_request')
    if value['action'] == 'update' and (not isinstance(value['sessionKey'], str) or not re.fullmatch(r'agent:[a-z0-9_-]+:[^\s\x00-\x1f]{1,200}', value['sessionKey'])):
        raise UpdateError('invalid_session')
    return value['action']


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        self.connection.settimeout(5)
        try:
            _, uid, _ = struct.unpack('3i', self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid not in {0, 1000}:
                self.respond(403, {'message': 'Caller is not authorized.'})
                return
            size = int(self.headers.get('Content-Length', '0'))
            if self.path != '/control' or not 0 < size <= 1024:
                raise UpdateError('invalid_request')
            value = json.loads(self.rfile.read(size))
            action = validate_request(value)
            manager = self.server.manager
            value = manager.start(value['sessionKey']) if action == 'update' else manager.check() if action == 'check' else manager.status()
            self.respond(202 if action == 'update' else 200, value)
        except (ValueError, KeyError, UpdateError):
            self.respond(400, {'message': 'Updater request or official release check failed.'})
        except Exception:
            self.respond(503, {'message': 'Host updater unavailable; update not confirmed.'})

    def respond(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['serve', 'check'])
    args = parser.parse_args()
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    manager = Manager()
    if args.command == 'check':
        print(json.dumps(manager.check()))
        return
    CONTROL.parent.mkdir(mode=0o750, exist_ok=True)
    os.chown(CONTROL.parent, 0, 1000)
    CONTROL.unlink(missing_ok=True)
    server = UnixServer(str(CONTROL), Handler)
    os.chmod(CONTROL, 0o660)
    os.chown(CONTROL, 0, 1000)
    server.manager = manager
    manager.recover_interrupted()
    server.serve_forever()


if __name__ == '__main__':
    main()
