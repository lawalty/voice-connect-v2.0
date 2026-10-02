import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('updater', Path(__file__).with_name('updater.py'))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class Contracts(unittest.TestCase):
    def test_desktop_is_preserved_only_for_the_existing_installation_opt_in(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(updater, 'STATE', Path(folder)), patch.object(updater, 'run') as run:
                self.assertEqual(updater.preserve_desktop_image('pinned', {'version':'2026.9.7'}, Path(folder)), 'pinned')
                run.assert_not_called()
                (Path(folder)/'desktop-enabled').touch()
                with patch.object(updater.Path, 'is_file', return_value=True), patch.object(updater.Path, 'read_bytes', return_value=b'fixed desktop context'):
                    image=updater.preserve_desktop_image('pinned', {'version':'2026.9.7'}, Path(folder))
                self.assertRegex(image, r'^openclaw-verified:2026\.9\.7-desktop-[0-9a-f]{12}$')
                self.assertIn('BASE_IMAGE=pinned',run.call_args_list[0].args[0])
                self.assertIn('/opt/voice-connect-v2/desktop-build',run.call_args_list[0].args[0])
                self.assertIn(image,updater.set_environment_image('KEEP=value\n',image))
                self.assertEqual(run.call_count,2)
    def test_docker_build_cache_uses_writable_service_state(self):
        unit = Path(__file__).with_name('openclaw-host-updater.service').read_text()
        self.assertIn('ProtectHome=read-only', unit)
        self.assertIn('Environment=DOCKER_CONFIG=/var/lib/openclaw-updater/docker-config', unit)
        self.assertIn('/var/lib/openclaw-updater', unit.split('ReadWritePaths=')[1])

    def test_command_failure_identifies_operation_without_exposing_output(self):
        with tempfile.TemporaryDirectory() as folder:
            result = SimpleNamespace(returncode=1, stdout='private configuration', stderr='synthetic secret')
            with patch.object(updater, 'STATE', Path(folder)), patch.object(updater.subprocess, 'run', return_value=result):
                with self.assertRaises(updater.UpdateError) as caught:
                    updater.run(['docker', 'build', '--label', 'private argument'])
            self.assertIn('command_failed:docker_build:exit=1:diagnostic=', str(caught.exception))
            self.assertNotIn('secret', str(caught.exception))
            self.assertNotIn('private', str(caught.exception))
            records = list((Path(folder)/'diagnostics').glob('*.json'))
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0].stat().st_mode & 0o777, 0o600)
            self.assertEqual(records[0].parent.stat().st_mode & 0o777, 0o700)
            record = json.loads(records[0].read_text())
            self.assertEqual(record['operation'], 'docker_build')
            self.assertEqual(record['stderr'], 'synthetic secret')
            self.assertNotIn('argv', record)

    def test_only_official_stable_release_and_commit_are_admitted(self):
        release = {'tag_name': 'v2026.9.7', 'draft': False, 'prerelease': False}
        commit = {'object': {'type': 'commit', 'sha': 'a'*40}}
        result = updater.stable_release(lambda url: release if url.endswith('/latest') else commit)
        self.assertEqual(result['version'], '2026.9.7')
        for changed in [{'prerelease': True}, {'draft': True}, {'tag_name': 'v2026.9.7-beta'}, {'tag_name': 'latest;whoami'}]:
            with self.assertRaises(updater.UpdateError):
                updater.stable_release(lambda _url: dict(release, **changed))

    def test_annotated_release_tag_is_resolved(self):
        replies = iter([{'tag_name': 'v2026.9.7', 'draft': False, 'prerelease': False}, {'object': {'type': 'tag', 'sha': 'b'*40}}, {'object': {'type': 'commit', 'sha': 'a'*40}}])
        self.assertEqual(updater.stable_release(lambda _url: next(replies))['revision'], 'a'*40)

    def test_image_identity_is_pinned_and_must_match_release(self):
        release = {'version': '2026.9.7', 'revision': 'a'*40}
        metadata = {'Config': {'Labels': {'org.opencontainers.image.version': release['version'], 'org.opencontainers.image.revision': release['revision'], 'org.opencontainers.image.source': 'https://github.com/openclaw/openclaw'}}, 'RepoDigests': ['ghcr.io/openclaw/openclaw@sha256:' + 'b'*64]}
        self.assertEqual(updater.pin_candidate(metadata, release), metadata['RepoDigests'][0])
        metadata['Config']['Labels']['org.opencontainers.image.revision'] = 'c'*40
        with self.assertRaises(updater.UpdateError):
            updater.pin_candidate(metadata, release)

    def test_request_cannot_supply_commands_images_or_paths(self):
        for value in [None, [], {'action': 'shell'}, {'action': 'update'}, {'action': 'status', 'command': 'docker rm'}, {'action': 'update', 'sessionKey': 'agent:northpointe:test', 'image': 'evil'}, {'action': 'update', 'sessionKey': 'agent:northpointe:a\nwhoami'}]:
            with self.assertRaises(updater.UpdateError):
                updater.validate_request(value)
        self.assertEqual(updater.validate_request({'action': 'update', 'sessionKey': 'agent:northpointe:vc-qa'}), 'update')

    def test_env_image_is_immutable_and_other_settings_are_preserved(self):
        original = 'OTHER=value\nOPENCLAW_IMAGE=latest\n'
        image = 'sha256:' + 'a'*64
        changed = updater.set_environment_image(original, image)
        self.assertIn('OTHER=value', changed)
        self.assertEqual(changed.count('OPENCLAW_IMAGE='), 1)
        for image in ['latest', 'other/image:1', 'sha256:abc\nFOO=bad']:
            with self.assertRaises(updater.UpdateError):
                updater.set_environment_image(original, image)

    def test_repair_ports_only_a_known_computer_surface_contract(self):
        dynamic = '\tconst allTools = input.resolveCronCreatorToolAuthority ? runWithCronCreatorAuthorityCapabilityResolver({}) : buildOpenClawCodingTools();\n\ttoolBuildStages.mark("create-openclaw-coding-tools");'
        for name in ['loadCodexPairedComputerUseAvailability', 'loadPairedComputerUseAvailabilityForSurface']:
            computer = f'async function {name}(params) {{}}\nexport {{ {name} as r }};'
            result, contract = updater.portable_computer_patch(dynamic, computer, 'computer-tool-Ab12.mjs')
            self.assertEqual(contract, name)
            self.assertLess(result.index('await loadAvailability'), result.index('toolBuildStages.mark'))
            self.assertIn('options.pairedNodeComputerUse = availability.prepared', result)
            self.assertIn('{ r: loadAvailability }', result)
        for changed in [dynamic.replace('const allTools', 'const unrelated'), dynamic + dynamic]:
            with self.assertRaises(updater.UpdateError):
                updater.portable_computer_patch(changed, computer, 'computer-tool-Ab12.mjs')
        with self.assertRaises(updater.UpdateError):
            updater.portable_computer_patch(dynamic, 'export {}', 'computer-tool-Ab12.mjs')

    def test_old_patch_removal_keeps_other_mounts_and_networking(self):
        original = 'services:\n  openclaw-gateway:\n    extra_hosts:\n      - host.docker.internal:host-gateway\n    volumes:\n      - /root/.openclaw/runtime-fixes/codex-computer-capabilities-20260929/dynamic-tools-old.mjs:/app/dist/dynamic-tools-old.mjs:ro\n      - /run/openclaw-updater:/run/openclaw-updater:ro\n'
        changed = updater.remove_old_patch(original)
        self.assertNotIn('runtime-fixes', changed)
        self.assertIn('host.docker.internal:host-gateway', changed)
        self.assertIn('/run/openclaw-updater:/run/openclaw-updater:ro', changed)

    def test_duplicate_requests_share_one_durable_job(self):
        with tempfile.TemporaryDirectory() as folder:
            gate = threading.Event()
            calls = []
            def worker(job, report):
                calls.append(job['id'])
                gate.wait(2)
                report('completed')
            manager = updater.Manager(Path(folder), worker)
            first = manager.start('agent:northpointe:test')
            second = manager.start('agent:northpointe:another')
            self.assertEqual(first['id'], second['id'])
            gate.set()
            for _ in range(100):
                if manager.status()['phase'] == 'completed':
                    break
                time.sleep(.01)
            self.assertEqual(len(calls), 1)
            self.assertEqual(json.loads((Path(folder)/'status.json').read_text())['phase'], 'completed')

    def test_failed_preparation_never_calls_compose_or_stops_gateway(self):
        with tempfile.TemporaryDirectory() as folder:
            reports, commands = [], []
            with patch.object(updater, 'STATE', Path(folder)), patch.object(updater, 'current_image', return_value=('sha256:old', '2026.9.6')), patch.object(updater, 'run', side_effect=lambda argv, **_kwargs: commands.append(argv)):
                with self.assertRaises(updater.UpdateError):
                    updater.perform_update({'id': 'a'*32}, reports.append, release_lookup=lambda: (_ for _ in ()).throw(updater.UpdateError('release_unavailable')))
            self.assertEqual(commands, [])
            self.assertNotIn('stopping', reports)

    def test_noop_does_not_touch_the_deployment(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(updater, 'STATE', Path(folder)), patch.object(updater, 'current_image', return_value=('sha256:old', '2026.9.7')), patch.object(updater, 'run') as run:
                reports = []
                updater.perform_update({'id': 'a'*32}, reports.append, release_lookup=lambda: {'version': '2026.9.7', 'releaseUrl': 'official'})
                run.assert_not_called()
                self.assertEqual(reports[-1], 'completed')

    def test_failed_new_gateway_restores_both_state_and_previous_image(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            project = root/'project'
            project.mkdir()
            (project/'compose.override.yaml').write_text('services:\n  openclaw-gateway:\n    volumes:\n      - /run/openclaw-updater:/run/openclaw-updater:ro\n')
            (project/'.env').write_text('KEEP=value\n')
            release = {'version': '2026.9.7', 'releaseUrl': 'official'}
            reports = []
            commands = []
            def command(argv, **kwargs):
                commands.append((argv, kwargs.get('env', {})))
                return ''
            with patch.object(updater, 'STATE', root), patch.object(updater, 'PROJECT', project), patch.object(updater.shutil, 'disk_usage', return_value=SimpleNamespace(free=10*1024**3)), patch.object(updater, 'current_image', return_value=('sha256:'+'a'*64, '2026.9.6')), patch.object(updater, 'run', side_effect=command), patch.object(updater, 'inspect_image'), patch.object(updater, 'pin_candidate', return_value='pinned'), patch.object(updater, 'prepare_candidate', return_value=('openclaw-verified:2026.9.7-'+'b'*12, 'prepared')), patch.object(updater, 'snapshot') as backup, patch.object(updater, 'restore') as restore, patch.object(updater, 'verify_gateway', side_effect=[updater.UpdateError('new_gateway_failed'), None]) as verify:
                with self.assertRaises(updater.UpdateError):
                    updater.perform_update({'id': 'c'*32}, reports.append, release_lookup=lambda: release)
                backup.assert_called_once()
                restore.assert_called_once()
                self.assertEqual(verify.call_args_list[-1].args, ('2026.9.6',))
                self.assertEqual(reports[-1], 'rolled_back')
                starts = [(argv, env) for argv, env in commands if 'up' in argv]
                self.assertEqual(starts[-1][1]['OPENCLAW_IMAGE'], 'sha256:'+'a'*64)

    def test_interrupted_committed_job_recovers_on_service_start(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            job_dir = root/'jobs'/('a'*32)
            job_dir.mkdir(parents=True)
            (root/'status.json').write_text(json.dumps({'id': 'a'*32, 'phase': 'verifying'}))
            (job_dir/'backup.json').write_text('{}')
            (job_dir/'recovery.json').write_text(json.dumps({'oldImage': 'sha256:old', 'oldVersion': '2026.9.6'}))
            manager = updater.Manager(root)
            with patch.object(updater, 'run'), patch.object(updater, 'restore') as restore, patch.object(updater, 'verify_gateway') as verify:
                manager.recover_interrupted()
                restore.assert_called_once_with(job_dir)
                verify.assert_called_once_with('2026.9.6')
                self.assertEqual(manager.status()['phase'], 'rolled_back')

    def test_full_backup_restore_preserves_auth_and_configuration(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            state, auth, project, backup = [root/name for name in ['state', 'auth', 'project', 'backup']]
            for path in [state, auth, project, backup]:
                path.mkdir()
            (state/'openclaw.json').write_text('{"original":true}')
            (state/'history.jsonl').write_text('original conversation')
            (auth/'test-credential').write_text('synthetic credential')
            (project/'compose.override.yaml').write_text('original mounts')
            (project/'docker-compose.yml').write_text('original compose')
            (project/'.env').write_text('original environment')
            with patch.object(updater, 'CONFIG', state), patch.object(updater, 'AUTH', auth), patch.object(updater, 'PROJECT', project):
                updater.snapshot(backup)
                (state/'openclaw.json').write_text('changed')
                (state/'new-migration-file').write_text('new')
                (auth/'test-credential').write_text('changed')
                (project/'.env').write_text('changed')
                updater.restore(backup)
            self.assertEqual((state/'openclaw.json').read_text(), '{"original":true}')
            self.assertEqual((auth/'test-credential').read_text(), 'synthetic credential')
            self.assertEqual((project/'.env').read_text(), 'original environment')
            self.assertFalse((state/'new-migration-file').exists())
            self.assertTrue((backup/'failed-state/new-migration-file').exists())
            self.assertEqual((backup/'before.tar').stat().st_mode & 0o777, 0o600)

    def test_corrupt_backup_is_rejected_before_touching_state(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root/'before.tar').write_bytes(b'changed')
            (root/'backup.json').write_text(json.dumps({'sha256': 'invalid'}))
            with self.assertRaises(updater.UpdateError):
                updater.restore(root)
            self.assertFalse((root/'restored').exists())

    def test_runtime_verification_requires_a_real_successful_agent_reply(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root/'openclaw.json').write_text(json.dumps({'agents': {'entries': {'northpointe': {}}}}))
            for value, passes in [({'status': 'ok', 'result': {'payloads': [{'text': 'HOST_UPDATER_OK'}]}}, True), ({'status': 'error'}, False), ({'status': 'ok', 'result': {'payloads': [{'text': 'Something failed'}]}}, False)]:
                with patch.object(updater, 'CONFIG', root), patch.object(updater, 'run', return_value=json.dumps(value)) as run:
                    if passes:
                        updater.verify_agent_runtime('2026.9.7')
                        command = run.call_args.args[0]
                        self.assertNotIn('--deliver', command)
                        self.assertIn('host-updater-health-', command[command.index('--session-key')+1])
                    else:
                        with self.assertRaises(updater.UpdateError):
                            updater.verify_agent_runtime('2026.9.7')


if __name__ == '__main__':
    unittest.main()
