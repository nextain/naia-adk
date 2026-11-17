import contextlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('gateway_operation', ROOT / 'scripts/gateway-runner/gateway-operation.py')
gw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gw)


class RunnerFixture:
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='gateway-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        old = {k: os.environ.get(k) for k in ('NAIA_GW_TEST_MODE', 'NAIA_GW_TEST_ROOT')}
        def restore():
            for key, value in old.items():
                if value is None: os.environ.pop(key, None)
                else: os.environ[key] = value
        self.addCleanup(restore)
        os.environ['NAIA_GW_TEST_MODE'] = '1'
        os.environ['NAIA_GW_TEST_ROOT'] = str(self.root)
        self.op = gw.Operation('dev', '20261117T120000Z-test')
        d = self.root / 'opt/naia-gateway/env-sources'
        d.mkdir(parents=True, mode=0o700)
        (self.root / "opt").chmod(0o755)
        (self.root / "opt/naia-gateway").chmod(0o755)
        d.chmod(0o700)
        self.sources = d

    @contextlib.contextmanager
    def capture_safe_output(self, label):
        stdout, stderr = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                yield
        finally:
            log_path = self.root / (label + '.log')
            log_path.write_text(stdout.getvalue() + stderr.getvalue())
            for text in (stdout.getvalue(), stderr.getvalue(), log_path.read_text()):
                for secret in ('fake-test-key', 'fake-motif-key-1234', 'fake-secret'):
                    self.assertNotIn(secret, text)

class RunnerTests(RunnerFixture, unittest.TestCase):
    def test_source_names_cannot_conflict_with_forced_values(self):
        from unittest.mock import patch
        for name in (*gw.CANDIDATE_ENV, *gw.CANDIDATE_SECRET_KEYS, 'FORWARDED_ALLOW_IPS', 'NVA_MEDIA_WORKER_URL'):
            with patch.object(gw, 'SOURCES', {'unsafe': name}), self.assertRaises(gw.Refused):
                gw.parse_additions('unsafe')
        with patch.object(gw, 'SOURCES', {'one': 'AZURE_TTS_KEY', 'two': 'AZURE_TTS_KEY'}), self.assertRaises(gw.Refused):
            gw.parse_additions('one')

    def test_names_never_print_values_and_duplicate_refused(self):
        secret = 'fake-secret-DO-NOT-PRINT'
        self.op.inspect = lambda: {'Config': {'Env': ['AZURE_TTS_KEY=' + secret, 'AZURE_TTS_REGION=']}}
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.op.env_names()
        self.assertNotIn(secret, out.getvalue())
        self.assertIn('AZURE_TTS_KEY=PRESENT', out.getvalue())
        self.assertIn('AZURE_TTS_REGION=EMPTY', out.getvalue())
        self.assertIn('AZURE_SPEECH_KEY=ABSENT', out.getvalue())
        self.op.inspect = lambda: {'Config': {'Env': ['AZURE_TTS_KEY=x', 'AZURE_TTS_KEY=y']}}
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(gw.Refused):
            self.op.env_names()
        self.assertEqual(out.getvalue(), '')
        self.op.inspect = lambda: {'Config': {'Env': ['AZURE_TTS_KEY']}}
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(gw.Refused):
            self.op.env_names()
        self.assertEqual(out.getvalue(), '')
        self.op.inspect = lambda: None
        with self.assertRaises(gw.Refused):
            self.op.env_names()

    def test_sources_and_validation(self):
        key = self.sources / 'azure-tts-key-v1'
        region = self.sources / 'azure-tts-region-v1'
        key.write_text('fake-key-value\n'); key.chmod(0o600)
        region.write_text('eastus2\n'); region.chmod(0o600)
        ids = gw.parse_additions('azure-tts-key-v1,azure-tts-region-v1')
        values = self.op.source_values(ids)
        self.assertEqual(values['AZURE_TTS_REGION'], 'eastus2')
        key.write_text('changed-value')
        self.assertEqual(values['AZURE_TTS_KEY'], 'fake-key-value')
        for bad in ('azure-tts-key-v1,azure-tts-key-v1', 'other', 'azure-tts-region-v1,azure-tts-key-v1'):
            with self.assertRaises(gw.Refused): gw.parse_additions(bad)
        for data in ('', 'wrong-region', 'eastus2\nsecret', 'eastus2\0'):
            region.write_text(data)
            with self.assertRaises(gw.Refused): self.op.source_values(ids)
        region.write_text('eastus2'); region.chmod(0o644)
        with self.assertRaises(gw.Refused): self.op.source_values(ids)
        region.unlink(); region.symlink_to(key)
        with self.assertRaises(gw.Refused): self.op.source_values(ids)

    def test_source_missing_oversized_parent_and_replacement(self):
        from unittest.mock import patch
        key = self.sources / 'azure-tts-key-v1'
        with self.assertRaises(gw.Refused): self.op.source_values(['azure-tts-key-v1'])
        key.write_text('x' * 258); key.chmod(0o600)
        with self.assertRaises(gw.Refused): self.op.source_values(['azure-tts-key-v1'])
        key.write_text('fake-secret'); self.sources.chmod(0o777)
        with self.assertRaises(gw.Refused): self.op.source_values(['azure-tts-key-v1'])
        self.sources.chmod(0o700)
        read = os.read
        def swapped(fd, count):
            data = read(fd, count)
            key.rename(self.sources / 'old-key')
            key.write_text('replacement'); key.chmod(0o600)
            return data
        with patch.object(gw.os, 'read', side_effect=swapped):
            with self.assertRaises(gw.Refused): self.op.source_values(['azure-tts-key-v1'])

    def test_source_rejects_wrong_owner_and_group(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        key = self.sources / 'azure-tts-key-v1'
        key.write_text('fake-secret'); key.chmod(0o600)
        actual_fstat = os.fstat
        for field in ('st_uid', 'st_gid'):
            reached = []
            def bad(fd):
                info = actual_fstat(fd)
                attrs = {name: getattr(info, name) for name in ('st_uid', 'st_gid', 'st_mode', 'st_size', 'st_dev', 'st_ino', 'st_mtime_ns', 'st_ctime_ns')}
                if info.st_ino == key.stat().st_ino and info.st_dev == key.stat().st_dev:
                    attrs[field] += 1
                    reached.append(True)
                return SimpleNamespace(**attrs)
            with patch.object(gw.os, 'fstat', side_effect=bad):
                with self.assertRaises(gw.Refused): self.op.source_values(['azure-tts-key-v1'])
            self.assertTrue(reached, field)

    def test_preflight_rejects_current_and_backup_stage(self):
        current = 'sha256:' + 'a' * 64
        image = gw.REPO + '@sha256:' + 'b' * 64
        self.op.inspect = lambda: {'Image': 'sha256:' + 'c' * 64, 'State': {'Running': True}}
        with self.assertRaises(gw.Refused): self.op.preflight(image, current, 'rev')
        self.op.directory.mkdir(parents=True)
        (self.op.directory / 'state.json').write_text('{"phase":"DEPLOYING"}')
        self.op.load_backup = lambda: ({}, {})
        with self.assertRaises(gw.Refused): self.op.deploy()

    def test_preflight_revision_rejection_does_not_print_secrets(self):
        current = 'sha256:' + 'a' * 64
        image = gw.REPO + '@sha256:' + 'b' * 64
        secret = 'fake-super-secret'
        self.op.runs.mkdir(parents=True)
        self.op.inspect = lambda: {'Image': current, 'State': {'Running': True, 'Health': {'Status': 'healthy'}},
                                   'Config': {'Env': ['AZURE_STORAGE_CONTAINER=user-data', 'AZURE_TTS_KEY=' + secret, 'NVA_MEDIA_WORKER_MODE=' + secret]}}
        self.op.previous_named = lambda _: None
        self.op.pg_env = lambda _: {}
        self.op.identity = lambda _: {'server_major': 16}
        self.op.tools = lambda *a, **kw: None
        self.op.pg = lambda *a, **kw: 'wrong-revision'
        self.op.gateway_network = lambda: '127.0.0.1'
        output, error = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error), self.assertRaises(gw.Refused):
            self.op.preflight(image, current, 'expected-revision')
        self.assertNotIn(secret, output.getvalue() + error.getvalue())

    def test_inspect_error_has_no_secret_output(self):
        def fail(): raise gw.Refused('docker_failed')
        self.op.inspect = fail
        output, error = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error), self.assertRaises(gw.Refused):
            self.op.env_names()
        self.assertEqual(output.getvalue() + error.getvalue(), '')


if __name__ == '__main__': unittest.main()

class LocalParserTests(unittest.TestCase):
    def setUp(self):
        import subprocess
        self.subprocess = subprocess
        self.tmp = tempfile.TemporaryDirectory(prefix='gateway-az-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        az = self.root / 'az'
        az.write_text('#!/bin/sh\nprintf "%s" "$FAKE_RESPONSE"\nprintf "%s" "$FAKE_ERROR" >&2\nexit "${FAKE_EXIT:-0}"\n')
        az.chmod(0o700)
        self.env = dict(os.environ, PATH=str(self.root) + ':' + os.environ['PATH'])
        self.run_id = '20261117T120000Z-test'

    def invoke(self, phase, response, error='', code='0'):
        env = dict(self.env, FAKE_RESPONSE=response, FAKE_ERROR=error, FAKE_EXIT=code)
        return self.subprocess.run(['bash', str(ROOT / 'scripts/gateway-runner/operation-local.sh'), 'dev', self.run_id, phase],
                                   env=env, capture_output=True, text=True)

    def test_status_parser_and_no_raw_output(self):
        names = gw.ENV_NAMES
        body = '\n'.join(n + '=ABSENT' for n in names) + '\nENV_NAMES_OK run_id=' + self.run_id + '\nREMOTE_EXIT=0'
        wrap = lambda x, err='': 'Enable succeeded:\n[stdout]\n' + x + '\n[stderr]\n' + err
        ok = self.invoke('env-names', wrap(body))
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertEqual(ok.stdout.splitlines(), body.splitlines()[:-1])
        secret = 'fakeSECRET123'
        timed_out = self.invoke('env-names', secret, secret, '124')
        self.assertNotIn(secret, timed_out.stdout + timed_out.stderr)
        self.assertNotEqual(timed_out.returncode, 0)
        for phase in ('env-names', 'status', 'deploy', 'verify', 'rollback', 'installed-hashes'):
            for response, error, code in ((wrap(secret, 'OPERATION_FAILED reason=' + secret), '', '0'),
                                           (secret, secret, '1'),
                                           (wrap(body.replace('ABSENT', secret, 1)), '', '0')):
                result = self.invoke(phase, response, error, code)
                log_path = self.root / 'operator.log'
                log_path.write_text(result.stdout + result.stderr)
                self.assertNotIn(secret, log_path.read_text())
                self.assertNotEqual(result.returncode, 0)

    def test_remote_rejects_mixed_bundle(self):
        import shutil
        remote = self.root / 'remote'
        remote.mkdir()
        for name in ('naia-gw-deploy.sh', 'gateway-operation.py'):
            shutil.copyfile(ROOT / 'scripts/gateway-runner' / name, remote / name)
        # Stub az executes the exact wrapper with only its remote paths redirected to
        # a temporary fake host. The modified file must never reach Python execution.
        az = self.root / 'az'
        az.write_text(r"""#!/usr/bin/env python3
import os, subprocess, sys
args = sys.argv
script = args[args.index('--scripts') + 1]
script = script.replace('/opt/naia-gateway/deploy-runner', os.environ['FAKE_REMOTE'])
script = script.replace('/run/lock/naia-gateway-runner-install.lock', os.environ['FAKE_LOCK'])
r = subprocess.run(['bash', '-c', script], capture_output=True, text=True)
print('Enable succeeded:\n[stdout]\n' + r.stdout.rstrip('\n') + '\n[stderr]\n' + r.stderr)
""")
        az.chmod(0o700)
        self.env['FAKE_REMOTE'] = str(remote)
        self.env['FAKE_LOCK'] = str(self.root / 'lock')
        good = self.invoke('installed-hashes', '')
        self.assertEqual(good.returncode, 0, good.stderr)
        self.assertIn('INSTALL_VERIFIED', good.stdout)
        (remote / 'gateway-operation.py').write_text('raise Exception("must-not-run")')
        result = self.invoke('env-names', '')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('must-not-run', result.stdout + result.stderr)

class BackupDeployTests(RunnerFixture, unittest.TestCase):
    def test_backup_deploy_and_rollback_environment(self):
        import json
        for prior in (None, '', 'old-value', 'duplicate'):
            op = gw.Operation('dev', '20261117T120000Z-' + ('none' if prior is None else prior or 'empty'))
            for name in ('config.yml', '.env.azure', 'gcp-wif.json'):
                (op.config / name).write_text('config')
            source = self.sources / 'azure-tts-key-v1'
            source.write_text('fake-test-key'); source.chmod(0o600)
            entries = ['OTHER=kept', 'DATABASE_URL=unused']
            if prior is not None:
                entries.append('AZURE_TTS_KEY=' + prior)
            if prior == 'duplicate': entries.append('AZURE_TTS_KEY=second')
            env_text = '\n'.join(entries) + '\n'
            live = {'Image': 'sha256:' + 'a' * 64, 'Config': {'Env': entries}, 'State': {'Running': True}}
            op.preflight = lambda *a: (live, env_text, {}, {'server_major': 16})
            op.pg_image, op.pg_major = 'postgres:16', 16
            def pg(tool, args, **kwargs):
                if tool == 'pg_dump': kwargs['output'].write(b'fake dump')
                if tool == 'psql': return 'rev'
                return ''
            op.pg = pg
            op.load_backup = lambda: (json.loads((op.directory / 'backup.json').read_text()), {})
            image = gw.REPO + '@sha256:' + 'b' * 64
            # Capture operator-visible logs as files and inspect persisted receipts;
            # the protected environment and snapshot intentionally contain values.
            label = 'backup-' + ('none' if prior is None else prior or 'empty')
            log_path = self.root / (label + '.log')
            with self.capture_safe_output(label):
                op.backup(image, live['Image'], 'rev', 'azure-tts-key-v1', secrets={'MOTIF_API_KEY': 'fake-motif-key-1234'})
            for path in (log_path, op.directory / 'backup.json', op.directory / 'backup.sha256', op.directory / 'state.json'):
                content = path.read_text()
                self.assertNotIn('fake-test-key', content)
                self.assertNotIn('fake-motif-key-1234', content)
            self.assertEqual((op.directory / 'environment').read_text(), env_text)
            source.write_text('changed-source')
            rec, _ = op.load_backup()
            op.pg_env = lambda _: {}
            op.identity = lambda _: {'server_major': 16}
            op.tools = lambda *a, **kw: None
            op.previous_named = lambda _: None
            gw.Operation.load_backup(op)
            self.assertEqual(op.candidate_secrets(rec)['AZURE_TTS_KEY'], 'fake-test-key')
            op.owned = lambda rec: live
            op.gateway_network = lambda: '127.0.0.1'
            op.stop = lambda live: None
            op.docker = lambda *args, **kw: 'rev' if args[:4] == ('run', '--rm', '--entrypoint', 'python') else 'auto_migrate: false' if args[:4] == ('run', '--rm', '--entrypoint', 'cat') else ''
            created = []
            op.create = lambda image, path: created.append((image, Path(path).read_text()))
            with self.capture_safe_output('deploy'): op.deploy()
            self.assertIn('AZURE_TTS_KEY=fake-test-key', created[-1][1])
            self.assertIn('OTHER=kept', created[-1][1])
            op.verify = lambda rec, restored=False: None
            with self.capture_safe_output('rollback'): op.rollback()
            self.assertEqual(created[-1][1], env_text)
            (op.directory / gw.SECRET_FILE).write_text('tampered')
            with self.assertRaises(gw.Refused): op.candidate_secrets(rec)

    def test_real_verify_checks_additions_and_restoration(self):
        op = self.op
        op.directory.mkdir(parents=True)
        (op.directory / 'environment').write_text('AZURE_TTS_KEY=old\nAZURE_TTS_KEY=second\n')
        source = self.sources / 'azure-tts-key-v1'
        source.write_text('fake-secret'); source.chmod(0o600)
        secret_path = op.directory / gw.SECRET_FILE
        secret_path.write_text('MOTIF_API_KEY=fake-motif-key-1234\nAZURE_TTS_KEY=fake-secret\n'); secret_path.chmod(0o600)
        rec = {'candidate': gw.REPO + '@sha256:' + 'b' * 64, 'previous_digest': 'sha256:' + 'a' * 64,
               'environment_additions': ['azure-tts-key-v1'],
               'candidate_secret_keys': ['MOTIF_API_KEY', 'AZURE_TTS_KEY'],
               'candidate_secrets_sha256': gw.sha(secret_path), 'previous_nva_media_worker_mode': None, 'revision': 'rev'}
        entries = [k + '=' + v for k, v in gw.CANDIDATE_ENV.items()] + ['MOTIF_API_KEY=fake-motif-key-1234', 'AZURE_TTS_KEY=fake-secret']
        live = {'Image': rec['previous_digest'], 'Config': {'Env': entries}, 'State': {'Running': True, 'Health': {'Status': 'healthy'}}}
        op.owned = lambda _: live
        op.digest = lambda _: 'sha256:' + 'b' * 64
        op.http = lambda path: (200, b'{"paths":{"/v1/studio/speech-plan":{}}}')
        op.pg_env = lambda _: {}
        op.pg = lambda *a, **kw: 'rev'
        with self.capture_safe_output('verify-ok'):
            op.verify(rec, record=False)
        live['Config']['Env'][-1] = 'AZURE_TTS_KEY=wrong'
        with self.capture_safe_output('verify-failed'), self.assertRaises(gw.Refused): op.verify(rec, record=False)
        live['Config']['Env'] = ['AZURE_TTS_KEY=old', 'AZURE_TTS_KEY=second']
        with self.capture_safe_output('verify-restore-ok'):
            op.verify(rec, restored=True, record=False)
        live['Config']['Env'].pop()
        with self.capture_safe_output('verify-restore-failed'), self.assertRaises(gw.Refused): op.verify(rec, restored=True, record=False)

class CleanupTests(RunnerFixture, unittest.TestCase):
    def test_classification_and_container_parse(self):
        cid = 'a' * 64
        old = 'sha256:' + 'b' * 64
        info = {'Id': old, 'RepoTags': ['naia-gateway:old'], 'RepoDigests': []}
        line = f'{cid} /old {old} exited 2026-11-17T12:00:00.123Z'
        entry = gw.Operation.cleanup_parse_container_rows(line)[0]
        self.assertEqual(entry['Name'], 'old')
        for malformed in (line + ' extra', line.replace(cid, 'oops'), line.replace('2026-', 'oops-')):
            self.assertIsNone(gw.Operation.cleanup_parse_container_rows(malformed))
        classify = gw.Operation.cleanup_classify
        self.assertEqual(classify(info, {old}, set()), 'keep')
        self.assertEqual(classify(info, set(), {old}), 'in_use')
        self.assertEqual(classify(info, set(), set()), 'gateway_old')
        self.assertEqual(classify({'Id': old, 'RepoTags': [], 'RepoDigests': []}, set(), set()), 'dangling')
        self.assertEqual(classify({'Id': old, 'RepoTags': ['other:tag'], 'RepoDigests': []}, set(), set()), 'other')
        self.assertEqual(classify({'Id': old, 'RepoTags': ['naia-gateway:old', 'other:tag']}, set(), set()), 'other')
        c = gw.Operation.cleanup_classify_container
        self.assertEqual(c(entry, set(), {old: info}), 'gateway_stopped')
        self.assertEqual(c(entry, {old}, {old: info}), 'keep_image')
        self.assertEqual(c(dict(entry, Status='running'), set(), {old: info}), 'gateway_active')
        self.assertEqual(c(dict(entry, Name='naia-gateway'), set(), {old: info}), 'naia_gateway')
        self.assertEqual(c(dict(entry, Image='unknown'), set(), {old: info}), 'other')
        self.assertEqual(gw.Operation.cleanup_container_priority('gateway_stopped'), '1')
        self.assertEqual(gw.Operation.cleanup_container_priority('gateway_active'), '2')
        self.assertEqual(gw.Operation.cleanup_container_priority('other'), 'none')

    def test_keep_set_requires_matching_live_candidate_and_postgres(self):
        import json
        current = 'sha256:' + 'a' * 64
        candidate = gw.REPO + '@sha256:' + 'b' * 64
        self.op.inspect = lambda: {'Image': current, 'State': {'Running': True}}
        self.op.pg_images = lambda: ['postgres:16', 'postgres:15', 'postgres:16-bookworm']
        replies = {current: {'Id': current, 'RepoTags': ['naia-gateway:live']},
                   candidate: {'Id': 'candidate-id', 'RepoDigests': [candidate]},
                   'postgres:15': {'Id': 'pg15'}, 'postgres:16': {'Id': 'pg16'}}
        self.op.try_command = lambda argv, **kw: (True, json.dumps(replies[argv[-1]]))
        keep, _, _, db_names, _ = self.op.cleanup_keep(candidate, current)
        self.assertEqual(keep, {current, 'candidate-id', 'pg15', 'pg16'})
        self.assertEqual(db_names, ['postgres:15', 'postgres:16'])
        replies[candidate]['RepoDigests'] = []
        with self.assertRaises(gw.Refused): self.op.cleanup_keep(candidate, current)

    def test_container_removal_precedes_images_and_failure_stops_cleanup(self):
        for fail in (False, True):
            op = gw.Operation('dev', '20261117T120000Z-' + ('fail' if fail else 'success'))
            current = 'sha256:' + 'a' * 64
            image = gw.REPO + '@sha256:' + 'b' * 64
            old = 'sha256:' + 'c' * 64
            cid = 'd' * 64
            entry = {'Id': cid, 'Name': 'old', 'Image': old, 'Status': 'exited', 'Created': '2026-11-17T12:00:00Z'}
            info = {'Id': old, 'RepoTags': ['naia-gateway:old'], 'RepoDigests': [], 'Size': 1}
            events = []
            removed = [False]
            op.cleanup_disk = lambda: {'total': 20 * 1024**3, 'free': 10 * 1024**3, 'used': 10 * 1024**3}
            op.cleanup_keep = lambda *args: ({current, 'candidate', 'pg'}, ['naia-gateway:live'], 'candidate', ['postgres:16'], ['pg'])
            op.cleanup_image_table = lambda: (set() if removed[0] else {old}, [info], [] if removed[0] else [entry])
            op.cleanup_inventory_lines = lambda *args: []
            op.cleanup_deadline_ok = lambda: True
            def command(argv, **kwargs):
                events.append(argv)
                if argv[:3] == ['docker', 'container', 'inspect']:
                    if removed[0]: return False, ''
                    return True, f'{cid} /old {old} exited 2026-11-17T12:00:00Z'
                if argv[:3] == ['docker', 'container', 'rm']:
                    if fail: return False, ''
                    removed[0] = True
                    return True, ''
                if argv[:3] == ['docker', 'image', 'inspect']: return False, ''
                return True, ''
            op.try_command = command
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                if fail:
                    with self.assertRaises(gw.Refused): op.cleanup(image, current, 'rev')
                else: op.cleanup(image, current, 'rev')
            container_rm = next(i for i, cmd in enumerate(events) if cmd[:3] == ['docker', 'container', 'rm'])
            image_rms = [i for i, cmd in enumerate(events) if cmd[:3] == ['docker', 'image', 'rm']]
            if fail:
                self.assertEqual(image_rms, [])
                self.assertFalse(any(cmd[:3] == ['docker', 'builder', 'prune'] for cmd in events))
            else:
                self.assertTrue(image_rms)
                self.assertGreater(min(image_rms), container_rm)

    def test_recent_and_full_log_are_legacy_status_aliases(self):
        import subprocess, shutil
        tmp = tempfile.TemporaryDirectory(prefix='gw-status-alias-')
        self.addCleanup(tmp.cleanup)
        d = Path(tmp.name)
        shutil.copyfile(ROOT / 'scripts/gateway-runner/status-local.sh', d / 'status-local.sh')
        (d / 'operation-local.sh').write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
        for mode in ('recent', 'full-log'):
            r = subprocess.run(['bash', str(d / 'status-local.sh'), 'dev', '20261117T120000Z-test', mode], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0)
            self.assertEqual(r.stdout.splitlines(), ['dev', '20261117T120000Z-test', 'status'])
