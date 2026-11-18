import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class AtomicInstallTest(unittest.TestCase):
    def test_legacy_migration_and_followup_preserve_previous_versions(self):
        script = (Path(__file__).parents[1] / 'launch-local.sh').read_text()
        code = script.split("<<'PYINSTALL'\n", 1)[1].split('\nPYINSTALL', 1)[0]
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            target = root / 'deploy-runner'
            target.mkdir()
            (target / 'version').write_text('legacy')
            first = root / 'v1'
            first.mkdir()
            (first / 'version').write_text('v1')
            subprocess.run(['python3', '-I', '-', str(first), str(target), 'run1'], input=code, text=True, check=True)
            self.assertTrue(target.is_symlink())
            self.assertEqual((target / 'version').read_text(), 'v1')
            self.assertEqual((root / 'deploy-runner.previous-run1' / 'version').read_text(), 'legacy')
            second = root / 'v2'
            second.mkdir()
            (second / 'version').write_text('v2')
            subprocess.run(['python3', '-I', '-', str(second), str(target), 'run2'], input=code, text=True, check=True)
            self.assertEqual((target / 'version').read_text(), 'v2')
            self.assertEqual((root / 'deploy-runner.previous-run2' / 'version').read_text(), 'v1')
            result = subprocess.run(['python3', '-I', '-', str(first), str(target), 'run2'], input=code, text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((target / 'version').read_text(), 'v2')

class InterruptedInstallTest(unittest.TestCase):
    def test_interrupted_switch_keeps_both_versions_for_recovery(self):
        import base64
        import hashlib
        script = (Path(__file__).parents[1] / 'launch-local.sh').read_text()
        remote = script.split("cat <<'REMOTE'\n", 1)[1].split('\nREMOTE', 1)[0]
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            old = root / 'deploy-runner'
            old.mkdir()
            (old / 'naia-gw-deploy.sh').write_text('legacy entry')
            (old / 'gateway-operation.py').write_text('legacy operation')
            entry = b'#!/bin/bash\nprintf "BACKUP_OK run_id=%s\\n" "$3"\n'
            operation = b'new operation'
            remote = remote.replace("'/opt/naia-gateway/deploy-runner'", repr(str(old)))
            remote = remote.replace("'/opt/naia-gateway/.deploy-runner-versions'", repr(str(root / 'versions')))
            remote = remote.replace("'/run'", repr(str(root)))
            remote = remote.replace('/run/lock/naia-gateway-runner-install.lock', str(root / 'lock'))
            remote = remote.replace('0:0:700', f'{os.getuid()}:{os.getgid()}:700')
            remote = remote.replace('PYINSTALL\nINSTALLED=1', 'PYINSTALL\nexit 42\nINSTALLED=1')
            assignments = {
                'RUN_ID': 'run1', 'STAGE': 'backup', 'ENVIRONMENT': 'dev', 'IMAGE': 'image',
                'CURRENT': 'current', 'REVISION': 'revision', 'ADDITIONS': '-', 'ACR_TOKEN': 'fake',
                'ENTRY_B64': base64.b64encode(entry).decode(), 'ENTRY_SHA': hashlib.sha256(entry).hexdigest(),
                'OPERATION_B64': base64.b64encode(operation).decode(), 'OPERATION_SHA': hashlib.sha256(operation).hexdigest(),
            }
            import shlex
            setup = '\n'.join(f'{k}={shlex.quote(v)}' for k, v in assignments.items())
            setup += '\ntimeout() { shift; "$@"; }\ndocker() { return 0; }\n'
            result = subprocess.run(['bash', '-eu'], input=setup + remote, text=True, capture_output=True)
            self.assertEqual(result.returncode, 42, result.stderr)
            self.assertNotIn('INSTALL_OK', result.stdout)
            self.assertEqual((old / 'naia-gw-deploy.sh').read_bytes(), entry)
            previous = root / 'deploy-runner.previous-run1'
            self.assertEqual((previous / 'naia-gw-deploy.sh').read_text(), 'legacy entry')
            self.assertEqual((previous / 'gateway-operation.py').read_text(), 'legacy operation')
            old.unlink()
            previous.rename(old)
            self.assertEqual((old / 'naia-gw-deploy.sh').read_text(), 'legacy entry')

class UntrustedResponseTest(unittest.TestCase):
    def test_az_output_and_failure_never_echo_untrusted_content(self):
        import hashlib
        import json
        import shutil
        bundle = Path(__file__).parents[1]
        secret = 'FAKE_SECRET_MALICIOUS_TOKEN_1234'
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / '.git').mkdir()
            (root / 'AGENTS.md').write_text('test')
            target = root / 'scripts' / 'gateway-runner'
            target.mkdir(parents=True)
            for name in ('launch-local.sh', 'naia-gw-deploy.sh', 'gateway-operation.py'):
                shutil.copy(bundle / name, target / name)
            source = root / 'data-private' / 'key'
            source.mkdir(parents=True, mode=0o700)
            (root / 'data-private').chmod(0o700)
            (source / 'motif-api-key.env').write_text(secret)
            (source / 'motif-api-key.env').chmod(0o600)
            config = root / 'config'
            config.mkdir(mode=0o700)
            gate_cfg = {
                'services': {
                    'azure:vm:sample-gateway-prod': {
                        'gatewayRunner': {
                            'subscriptionId': '00000000-0000-0000-0000-000000000000',
                            'location': 'koreacentral',
                            'acrName': 'myregistry',
                            'imageRepo': 'myregistry.azurecr.io/sample/gateway',
                            'environments': {
                                'prod': {'resourceGroup': 'rg-gateway-prod', 'vmName': 'sample-gateway-prod'},
                                'dev': {'resourceGroup': 'rg-gateway-dev', 'vmName': 'sample-gateway-dev'},
                            },
                        },
                    },
                },
            }
            (config / 'deploy-gate.json').write_text(json.dumps(gate_cfg))
            (config / 'deploy-gate.json').chmod(0o600)
            root.chmod(0o700)
            binary = root / 'bin'
            binary.mkdir()
            az = binary / 'az'
            az.write_text('''#!/bin/bash
printf '%s\\n' "$FAKE_SECRET" >&2
case "$1 $2 $3" in
  'acr repository show') printf '%s\\n' "$DIGEST" ;;
  'vm run-command list') : ;;
  'acr login '*) printf '%s\\n' "$FAKE_SECRET" ;;
  'vm run-command create') printf '%s\\n' "$FAKE_SECRET" ;;
  'vm run-command show') printf '%s\\n' "$AZ_RESULT" ;;
  'vm run-command delete') printf '%s\\n' "$FAKE_SECRET" ;;
  *) exit 1 ;;
esac
''')
            az.chmod(0o700)
            run = '20261117T120000Z-test'
            digest = 'sha256:' + 'a' * 64
            current = 'sha256:' + 'b' * 64
            entry = hashlib.sha256((target / 'naia-gw-deploy.sh').read_bytes()).hexdigest()
            operation = hashlib.sha256((target / 'gateway-operation.py').read_bytes()).hexdigest()
            receipts = f'BACKUP_OK run_id={run}\nINSTALL_OK run_id={run} entry={entry} operation={operation}'
            environment = dict(os.environ, PATH=str(binary) + ':' + os.environ['PATH'], TMPDIR=d,
                               FAKE_SECRET=secret, DIGEST=digest)
            for failure in (False, True):
                output = f'PREFLIGHT_OBSERVED {secret}\n{receipts}\n{secret}'
                error = f'OPERATION_FAILED reason={secret}' if failure else ''
                environment['AZ_RESULT'] = json.dumps({'executionState': 'Succeeded', 'exitCode': 0,
                                                        'output': output, 'error': error})
                result = subprocess.run(['bash', str(target / 'launch-local.sh'), 'dev', run, 'tag', digest,
                                         current, 'revision', 'backup', '-'], env=environment,
                                        text=True, capture_output=True)
                self.assertEqual(result.returncode == 0, not failure, result.stdout + result.stderr)
                self.assertNotIn(secret, result.stdout + result.stderr)
                if not failure:
                    self.assertEqual(result.stdout.strip(), receipts)
            environment['AZ_RESULT'] = json.dumps({'executionState':'Succeeded','exitCode':0,
                                                    'output':f'CLEANUP_OK run_id={run}', 'error':''})
            result = subprocess.run(['bash', str(target / 'launch-local.sh'), 'dev', run, 'tag', digest,
                                     current, 'revision', 'cleanup', '-'], env=environment,
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), f'CLEANUP_OK run_id={run}')
            result = subprocess.run(['bash', str(target / 'launch-local.sh'), 'dev', run, 'tag', digest,
                                     current, 'revision', 'backup', 'app-signing-public-key-v1'],
                                    env=dict(environment, AZ_RESULT=json.dumps({'executionState': 'Succeeded', 'exitCode': 0, 'output': receipts, 'error': ''})),
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            (config / 'deploy-gate.json').chmod(0o664)
            bad_cfg = subprocess.run(['bash', str(target / 'launch-local.sh'), 'dev', run, 'tag', digest,
                                      current, 'revision', 'backup', '-'], env=environment,
                                     text=True, capture_output=True)
            self.assertNotEqual(bad_cfg.returncode, 0)
            self.assertNotIn(secret, bad_cfg.stdout + bad_cfg.stderr)


class CleanupArgumentsTest(unittest.TestCase):
    def test_cleanup_rejects_additions_before_remote_work(self):
        script = Path(__file__).parents[1] / 'launch-local.sh'
        for bad_args in (('cleanup', 'azure-tts-key-v1'),
                         ('cleanup', 'app-signing-public-key-v1'),
                         ('backup', 'app-signing-public-key-v1,azure-tts-key-v1')):
            result = subprocess.run(
                ['bash', str(script), 'dev', '20261117T120000Z-test', 'tag',
                 'sha256:' + 'a' * 64, 'sha256:' + 'b' * 64, 'revision', *bad_args],
                text=True, capture_output=True)
            self.assertEqual(result.returncode, 64, bad_args)
            self.assertEqual(result.stdout + result.stderr, '')

class ProtectedEnvironmentTest(unittest.TestCase):
    def test_backup_secret_is_confined_on_success_and_failure(self):
        import base64
        import hashlib
        import shlex
        script = (Path(__file__).parents[1] / 'launch-local.sh').read_text()
        source = script.split("cat <<'REMOTE'\n", 1)[1].split('\nREMOTE', 1)[0]
        for backup_rc in (0, 27):
            with tempfile.TemporaryDirectory() as d:
                root = Path(d)
                target = root / 'deploy-runner'
                target.mkdir()
                fakebin = root / 'bin'
                fakebin.mkdir()
                marker = root / 'leak'
                for command in ('stat', 'sha256sum', 'python3'):
                    wrapper = fakebin / command
                    wrapper.write_text('#!/bin/bash\nif [[ -v MOTIF_API_KEY || -v ACR_TOKEN || -v MOTIF_SECRET || -v AUTH_TOKEN ]]; then printf leak >> "$MARKER"; fi\nexec /usr/bin/' + command + ' "$@"\n')
                    wrapper.chmod(0o700)
                entry = (f'#!/bin/bash\n[[ "$MOTIF_API_KEY" == fake_motif_secret ]] || exit 26\nexit {backup_rc}\n').encode()
                operation = b'new operation'
                remote = source.replace("'/opt/naia-gateway/deploy-runner'", repr(str(target)))
                remote = remote.replace("'/opt/naia-gateway/.deploy-runner-versions'", repr(str(root / 'versions')))
                remote = remote.replace("'/run'", repr(str(root)))
                remote = remote.replace('/run/lock/naia-gateway-runner-install.lock', str(root / 'lock'))
                remote = remote.replace('0:0:700', f'{os.getuid()}:{os.getgid()}:700')
                values = {'RUN_ID': 'run1', 'STAGE': 'backup', 'ENVIRONMENT': 'dev', 'IMAGE': 'image',
                          'CURRENT': 'current', 'REVISION': 'revision', 'ADDITIONS': '-',
                          'ENTRY_B64': base64.b64encode(entry).decode(), 'ENTRY_SHA': hashlib.sha256(entry).hexdigest(),
                          'OPERATION_B64': base64.b64encode(operation).decode(), 'OPERATION_SHA': hashlib.sha256(operation).hexdigest()}
                setup = '\n'.join(f'{k}={shlex.quote(v)}' for k, v in values.items())
                setup += '\ntimeout() { shift; "$@"; }\ndocker() { return 0; }\n'
                env = dict(os.environ, PATH=str(fakebin) + ':' + os.environ['PATH'], MARKER=str(marker),
                           MOTIF_API_KEY='fake_motif_secret', ACR_TOKEN='fake_acr_secret',
                           MOTIF_SECRET='inherited_fake', AUTH_TOKEN='inherited_fake')
                result = subprocess.run(['bash', '-eu'], input=setup + remote, env=env, text=True, capture_output=True)
                self.assertEqual(result.returncode, backup_rc, result.stderr)
                self.assertFalse(marker.exists(), 'protected parameter reached an unrelated child')
                self.assertNotIn('fake_motif_secret', result.stdout + result.stderr)
                self.assertNotIn('fake_acr_secret', result.stdout + result.stderr)

class CleanupThenBackupTest(unittest.TestCase):
    def test_cleanup_does_not_switch_install_before_backup_same_run(self):
        import base64, hashlib, shlex
        script = (Path(__file__).parents[1] / 'launch-local.sh').read_text()
        remote = script.split("cat <<'REMOTE'\n", 1)[1].split('\nREMOTE', 1)[0]
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); old = root / 'deploy-runner'; old.mkdir()
            (old / 'naia-gw-deploy.sh').write_text('old')
            (old / 'gateway-operation.py').write_text('old')
            entry = b'#!/bin/bash\nprintf "%s_OK run_id=%s\\n" "${1^^}" "$3"\n'
            operation = b'new operation'
            remote = remote.replace("'/opt/naia-gateway/deploy-runner'", repr(str(old))).replace("'/opt/naia-gateway/.deploy-runner-versions'", repr(str(root / 'versions'))).replace("'/run'", repr(str(root))).replace('/run/lock/naia-gateway-runner-install.lock', str(root / 'lock')).replace('0:0:700', f'{os.getuid()}:{os.getgid()}:700')
            values = {'RUN_ID':'same', 'ENVIRONMENT':'dev', 'IMAGE':'image', 'CURRENT':'current', 'REVISION':'revision', 'ADDITIONS':'-', 'ACR_TOKEN':'fake', 'ENTRY_B64':base64.b64encode(entry).decode(), 'ENTRY_SHA':hashlib.sha256(entry).hexdigest(), 'OPERATION_B64':base64.b64encode(operation).decode(), 'OPERATION_SHA':hashlib.sha256(operation).hexdigest()}
            def invoke(stage):
                setup='\n'.join(f'{k}={shlex.quote(v)}' for k,v in {**values,'STAGE':stage}.items()) + '\ntimeout() { shift; "$@"; }\ndocker() { return 0; }\n'
                return subprocess.run(['bash','-eu'],input=setup+remote,text=True,capture_output=True)
            first=invoke('cleanup')
            after_cleanup=(old/'naia-gw-deploy.sh').read_text()
            second=invoke('backup')
            self.assertEqual((first.returncode,second.returncode),(0,0),first.stderr+second.stderr)
            self.assertEqual(after_cleanup,'old')
            self.assertIn('BACKUP_OK run_id=same',second.stdout)
