#!/usr/bin/env python3
"""Direct, operator-observed backup/deploy/verify/rollback/status.

PostgreSQL tools run in a VM-local postgres:<N> image container (N is the
smallest integer tag >= server major, rechecked at >= recorded N afterwards;
docker run --rm --pull=never --network host, secrets only via -e names).
There is no worker, slot, WATCH, automatic rollback, Caddy modification,
or candidate rename chain.

2026-10-20 local-previous variant: CURRENT/previous is the VM-local image ID
(docker inspect .Image) of the running container, not a registry digest. The
live image was built on the VM and has no registry digest; restore runs that
local image by ID and requires it to still carry at least one local tag.
Restore is container + three config files only (no database restore). The
database dump taken at backup is kept on the VM as a manual copy.

2026-10-20 envfix-gw3: NVA_MEDIA_WORKER_MODE is inherited from the running
container (never forced); the previous value is recorded and verified.

2026-10-20 pgfix-gw4: psql/pg_dump/pg_restore run in the VM-local
postgres:<server major> image container (--pull=never); host pg tools unused.

2026-10-20 pgfix-gw5: smallest integer postgres tag N >= server major (no pull,
--pull=never kept), pg_client_image/pg_client_major recorded in backup.json and
enforced as minimum afterwards, gateway net checked before mutation, extra
preflight observed line on refusal.

2026-10-20 diskclean-gw6: cleanup phase (reusable pre-deploy batch, not tied to a
specific candidate tag). Removes only gateway_old/dangling images, builder cache,
journal vacuum to 200M, and apt cache. Keeps the live image, the candidate image,
integer-tagged postgres tool images, and anything in use or outside gateway repos;
other images are listed only. Decides 6GiB free; no automatic recovery or retry.

2026-10-20 cleanupfix-gw7: cleanup removes stopped old-gateway containers before
removing images. Only containers classified gateway_stopped (stopped/created/dead
state, image not a keep image, image classified gateway_old) are removed with
`docker container rm <id>` in oldest-Created-first order; naia-gateway, running/paused/restarting, keep-image,
and other-repo/mixed/unnamed-image containers are only listed. Containers with a
gateway_old image that are still running are listed only as priority=2
(gateway_active, kept_active) and are never a rm/stop/kill/pause target, so after
priority=1 drains the stopped ones there is nothing left to delete. The first failed
removal stops the phase (no image/builder/journal/apt work afterwards) and refuses
with cleanup_container_remove_failed. used_ids and the image table are re-read
after container removal. The 6GiB bar and no automatic recovery or retry are kept.
"""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = 'acrnaia83b29893.azurecr.io/naia/gateway'
GATEWAY_IMAGE_REPOS = ('acrnaia83b29893.azurecr.io/naia/gateway', 'naia-gateway', 'gw-basefee-local')
CLEANUP_THRESHOLD_BYTES = 6 * 1024**3
CLEANUP_OBSERVED_PREFIXES = ('PREFLIGHT_OBSERVED', 'CLEANUP_OBSERVED', 'CLEANUP_INVENTORY', 'CLEANUP_REMOVED')
CLEANUP_CONTAINER_FORMAT = '{{.Id}} {{.Name}} {{.Image}} {{.State.Status}} {{.Created}}'
CLEANUP_CONTAINER_ID_FORMAT = '{{.Id}}'
CLEANUP_CREATED_RE = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$')
CLEANUP_CONTAINER_CLASS_ORDER = {'naia_gateway': 0, 'active': 1, 'keep_image': 2,
                                 'other': 3, 'gateway_active': 4, 'gateway_stopped': 5}
CLEANUP_STDOUT_CONTAINER_BEFORE_BYTES = 1100
CLEANUP_STDOUT_OTHER_BEFORE_BYTES = 700
CLEANUP_STDOUT_CONTAINER_REMOVED_BYTES = 550
CLEANUP_STDOUT_IMAGE_REMOVED_BYTES = 700
CLEANUP_STDOUT_CONTAINER_AFTER_BYTES = 250
CLEANUP_STDERR_AFTER_OTHER_BYTES = 1800
RUN = re.compile(r'\d{8}T\d{6}Z-[a-z0-9-]{1,32}')
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')
IDENTITY_SQL = "select current_database(), inet_server_addr()::text, (select system_identifier from pg_control_system())::text, current_setting('server_version_num')"
REVISION_SQL = 'select version_num from alembic_version order by version_num'
# q0 (2026-10-25, code review r4 condition): open and reserved nva_speech_set jobs, read just before deploy.
SPEECH_SET_SQL = ("select count(*) filter (where status in ('queued', 'assigned', 'running', 'cancel_requested')), "
                  "count(*) filter (where billing_status = 'reserved') from media_jobs where kind = 'nva_speech_set'")
FILES = ('database.dump', 'environment', 'config.yml', '.env.azure', 'gcp-wif.json')

# Studio export price (credits). The only place the price is set; decided 2026-10-20 01:41Z ("5로 하자").
STUDIO_EXPORT_CREDITS = '5'
# Media pool daily cost cap (USD). The only place the cap is set. The fit075 p1 read on 2026-10-25 found no
# NAIA_MEDIA_POOL_DAILY_COST_CAP_USD on production (unset = no cap); decision "가" = 5 USD per day.
# The gateway accepts 0 < Decimal(value) <= 1000 (media_pool/config.py).
MEDIA_POOL_DAILY_COST_CAP_USD = '5'
# Candidate generation: injected into the new container's env file at deploy and
# checked on the live new container at verify. Never required at preflight.
CANDIDATE_ENV = {'STUDIO_EXPORT_CREDITS': STUDIO_EXPORT_CREDITS,
                 'NAIA_VIDEO_AVATAR_MIN_START_CREDITS': '1500',
                 'AZURE_STORAGE_ACCOUNT_NAME': 'stnaia83b29893',
                 'NAIA_MEDIA_POOL_DAILY_COST_CAP_USD': MEDIA_POOL_DAILY_COST_CAP_USD}
# Candidate secrets (2026-10-25, fit075 decision "가"): values never live in this file, argv, logs or
# stdout. launch-local.sh reads them on the operator PC and sends them as Managed Run Command protected
# parameters; the backup phase takes them from its environment (and removes them there so no child
# process inherits them), stores them root-only in the run directory, and records only their sha256.
# deploy adds them to the new container; verify compares them on the live container without printing;
# rollback recreates the previous container from the untouched backed-up env, so they disappear again.
CANDIDATE_SECRET_KEYS = ('MOTIF_API_KEY',)
SECRET_FILE = 'candidate-secrets'
SECRET_VALUE = re.compile(r'[A-Za-z0-9._-]{16,256}')


def with_env(env_text, values):
    """Keep every other line of env_text; add or replace only the given keys (one line each)."""
    wanted = dict(values)
    out = []
    for body in env_text.splitlines():
        key, sep, _ = body.partition('=')
        if sep and not body.startswith('#') and key in values:
            if key in wanted:
                out.append(key + '=' + wanted.pop(key))
            # a repeated key is dropped so the new value is the only one
        else:
            out.append(body)
    for key, value in wanted.items():
        out.append(key + '=' + value)
    return '\n'.join(out) + '\n'


def with_candidate_env(env_text):
    """Keep every other line of the backed-up env; add or replace only CANDIDATE_ENV keys."""
    return with_env(env_text, CANDIDATE_ENV)


def take_candidate_secrets():
    """Remove the candidate secrets from this process environment and return them (never printed)."""
    return {key: os.environ.pop(key) for key in CANDIDATE_SECRET_KEYS if key in os.environ}


def valid_secrets(values):
    return (isinstance(values, dict) and set(values) == set(CANDIDATE_SECRET_KEYS)
            and all(isinstance(v, str) and SECRET_VALUE.fullmatch(v) for v in values.values()))


def live_env_values(live):
    lines = (live or {}).get('Config', {}).get('Env', []) or []
    values = {}
    for line in lines:
        key, sep, value = line.partition('=')
        if sep:
            values.setdefault(key, []).append(value)
    return values


def last_env_value(env_text, key):
    """Last value for key in an env file (what os.environ would see); (found, value)."""
    found = False
    value = None
    for line in env_text.splitlines():
        k, sep, v = line.partition('=')
        if sep and k == key:
            found = True
            value = v
    return found, value


def sanitize_observed(value):
    if value == '':
        return '<empty>'
    if re.fullmatch(r'[A-Za-z0-9._:/-]{0,64}', value):
        return value
    return '<unprintable>'


def cleanup_sanitize(text):
    """Replace every char outside the observed-line alphabet with _; cut to 300."""
    return re.sub(r'[^A-Za-z0-9 ._:/@<>=,+%()-]', '_', text)[:300]


class Refused(Exception):
    pass


def require(ok, reason):
    if not ok:
        raise Refused(reason)


def sha(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def atomic(path, data):
    """Every write/fsync/replace failure propagates to the stage caller."""
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def write_json(path, value):
    atomic(path, (json.dumps(value, sort_keys=True) + '\n').encode())


class Operation:
    def __init__(self, environment, run_id):
        require(environment in ('prod', 'dev') and RUN.fullmatch(run_id), 'invalid_arguments')
        self.test = os.environ.get('NAIA_GW_TEST_MODE') == '1'
        require(self.test or os.geteuid() == 0, 'root_required')
        root = Path(os.environ['NAIA_GW_TEST_ROOT']) if self.test else Path('/')
        self.config = root / 'opt/naia-gateway'
        self.runs = root / 'var/lib/naia-gw-deploy/runs'
        self.directory = self.runs / run_id
        self.lock = root / 'run/lock/naia-gw-deploy.lock'
        self.environment, self.run_id = environment, run_id
        self.host = f'pg-naia-{environment}-83b29893.postgres.database.azure.com'
        self.database = 'any_llm_gateway' + ('_dev' if environment == 'dev' else '')
        self.deadline = time.monotonic() + 600
        self.pg_image = None
        self.pg_major = None

    def command(self, argv, *, limit=15, env=None, stdin=None, output=None):
        remaining = self.deadline - time.monotonic()
        require(remaining > 0, 'operation_deadline_exceeded')
        try:
            result = subprocess.run(argv, stdin=stdin, stdout=output or subprocess.PIPE,
                                    stderr=subprocess.PIPE, env=env,
                                    timeout=min(limit, remaining), check=False)
        except FileNotFoundError:
            raise Refused(Path(argv[0]).name + '_missing') from None
        require(result.returncode == 0, Path(argv[0]).name + '_failed')
        return (result.stdout or b'').decode()

    def docker(self, *args, **kwargs):
        return self.command(['docker', *args], **kwargs)

    def try_command(self, argv, *, limit=15, ok_codes=(0,)):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            return (False, '')
        try:
            result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=min(limit, remaining), check=False)
        except FileNotFoundError:
            return (False, '')
        except subprocess.TimeoutExpired:
            return (False, '')
        except OSError:
            return (False, '')
        if result.returncode not in ok_codes:
            return (False, '')
        try:
            out = (result.stdout or b'').decode()
        except (ValueError, UnicodeDecodeError):
            return (False, '')
        return (True, out)

    def cleanup_deadline_ok(self):
        return (self.deadline - time.monotonic()) >= 90

    def pg_images(self):
        out = self.command(['docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', 'postgres'])
        images = []
        for line in out.splitlines():
            name = line.strip()
            if name.startswith('postgres:') and '<none>' not in name:
                images.append(name)
        images.sort()
        return images

    def host_pg_major(self):
        if not shutil.which('psql'):
            return 'absent'
        try:
            out = self.command(['psql', '--version'])
        except (Refused, OSError, ValueError, subprocess.SubprocessError):
            return 'unknown'
        major = re.search(r'PostgreSQL\)?\s+(\d+)', out)
        return major.group(1) if major else 'unknown'

    def emit_pg_observed(self, server_major, images):
        if isinstance(server_major, int):
            server_out = str(server_major)
        else:
            try:
                server_out = str(int(server_major))
            except (TypeError, ValueError):
                server_out = 'unknown'
        host_out = self.host_pg_major()
        if images:
            tags = [sanitize_observed(name) for name in sorted(images)[:20]]
            images_out = ','.join(tags) if tags else 'none'
        else:
            images_out = 'none'
        print(f'PREFLIGHT_OBSERVED pg_server_major={server_out} host_pg_major={host_out} local_postgres_images={images_out}', file=sys.stderr)

    def pg(self, tool, args, env=None, limit=15, stdin=None, output=None, image=None):
        chosen = image if image is not None else self.pg_image
        require(chosen, 'postgresql_client_server_major_mismatch')
        argv = ['docker', 'run', '--rm', '--pull=never', '--network', 'host']
        if stdin is not None:
            argv.append('-i')
        if env:
            for key in sorted(env):
                if key.startswith('PG'):
                    argv.extend(['-e', key])
        argv.extend([chosen, tool, *args])
        try:
            return self.command(argv, env=env, limit=limit, stdin=stdin, output=output)
        except Refused as error:
            if str(error) == 'docker_failed':
                raise Refused(tool + '_failed') from None
            raise

    def inspect(self):
        names = self.docker('ps', '-a', '--filter', 'name=^/naia-gateway$', '--format', '{{.Names}}').splitlines()
        require(all(n == 'naia-gateway' for n in names), 'unexpected_container_lookup')
        if not names:
            return None
        return json.loads(self.docker('inspect', '--format', '{{json .}}', 'naia-gateway'))

    def digest(self, container):
        refs = json.loads(self.docker('image', 'inspect', '--format', '{{json .RepoDigests}}', container['Image']))
        digests = {ref.split('@', 1)[1] for ref in refs if ref.startswith(REPO + '@')}
        require(len(digests) == 1 and DIGEST.fullmatch(next(iter(digests))), 'image_digest_unverified')
        return next(iter(digests))

    def is_previous(self, container, rec_or_id):
        previous = rec_or_id if isinstance(rec_or_id, str) else rec_or_id['previous_digest']
        return bool(container) and container.get('Image') == previous

    def previous_named(self, image_id):
        info = json.loads(self.docker('image', 'inspect', '--format', '{{json .}}', image_id))
        require(info.get('Id') == image_id, 'previous_image_missing_or_changed')
        require(any(isinstance(t, str) and t for t in (info.get('RepoTags') or [])), 'previous_image_untagged')

    def pg_env(self, env_text):
        values = dict(line.split('=', 1) for line in env_text.splitlines() if '=' in line)
        url = urllib.parse.urlsplit(values.get('DATABASE_URL', ''))
        require(url.scheme in ('postgresql', 'postgres', 'postgresql+psycopg', 'postgresql+psycopg2', 'postgresql+asyncpg'), 'unsupported_database_url')
        require(url.hostname == self.host and urllib.parse.unquote(url.path[1:]) == self.database and (url.port or 5432) == 5432, 'database_target_mismatch')
        query = urllib.parse.parse_qs(url.query, strict_parsing=True)
        require(set(query) <= {'sslmode', 'connect_timeout', 'application_name', 'channel_binding'}, 'unsupported_database_url_option')
        require(all(len(v) == 1 for v in query.values()), 'duplicate_database_url_option')
        env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
        env.update(PGHOST=self.host, PGPORT='5432', PGDATABASE=self.database,
                   PGUSER=urllib.parse.unquote(url.username or ''),
                   PGPASSWORD=urllib.parse.unquote(url.password or ''), PGSSLMODE='require',
                   PGCONNECT_TIMEOUT='10', PGOPTIONS='-c lock_timeout=5000 -c statement_timeout=120000')
        require(env['PGUSER'] and env['PGPASSWORD'], 'database_credentials_missing')
        for key, value in query.items():
            env['PG' + key.upper().replace('_', '')] = value[0]
        require(env['PGSSLMODE'] in ('require', 'verify-ca', 'verify-full'), 'database_tls_required')
        return env

    def identity(self, env):
        if shutil.which('psql'):
            fields = self.command(['psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', IDENTITY_SQL], env=env).strip().split('|')
        else:
            images = self.pg_images()
            best = None
            best_major = -1
            for name in images:
                tag = name.split(':', 1)[1] if ':' in name else ''
                if re.fullmatch(r'\d+', tag or ''):
                    number = int(tag)
                    if number > best_major:
                        best_major = number
                        best = name
            if best is None:
                self.emit_pg_observed(None, images)
                raise Refused('postgresql_client_server_major_mismatch')
            fields = self.pg('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', IDENTITY_SQL], env=env, image=best).strip().split('|')
        require(len(fields) == 4 and fields[0] == self.database and fields[1] and fields[2].isdigit() and fields[3].isdigit(), 'database_identity_unverified')
        return dict(database=fields[0], address=fields[1], system_identifier=fields[2], server_major=int(fields[3]) // 10000)

    def tools(self, identity, minimum=None):
        floor = max(identity['server_major'], minimum or 0)
        images = self.pg_images()
        best = None
        best_major = None
        for name in images:
            tag = name.split(':', 1)[1] if ':' in name else ''
            if re.fullmatch(r'\d+', tag or ''):
                number = int(tag)
                if number >= floor and (best_major is None or number < best_major):
                    best_major = number
                    best = name
        if best is None:
            self.emit_pg_observed(identity['server_major'], images)
            raise Refused('postgresql_client_server_major_mismatch')
        want = f'postgres:{best_major}'
        for tool in ('psql', 'pg_dump', 'pg_restore'):
            out = self.pg(tool, ['--version'], image=want)
            major = re.search(r'PostgreSQL\)?\s+(\d+)', out)
            if not major or int(major.group(1)) != best_major:
                self.emit_pg_observed(identity['server_major'], images)
                raise Refused('postgresql_client_server_major_mismatch')
        self.pg_image = want
        self.pg_major = best_major

    def record(self, phase):
        write_json(self.directory / 'state.json', dict(run_id=self.run_id, environment=self.environment,
                   phase=phase, at=datetime.datetime.now(datetime.timezone.utc).isoformat()))
        print(phase, 'run_id=' + self.run_id)

    def current_env(self, live):
        lines = live.get('Config', {}).get('Env', [])
        require(lines and all(isinstance(s, str) and '\n' not in s and '\0' not in s for s in lines), 'container_environment_unreadable')
        return '\n'.join(lines) + '\n'

    def preflight(self, image, current, revision):
        require(image.startswith(REPO + '@') and DIGEST.fullmatch(image.split('@', 1)[1]) and DIGEST.fullmatch(current), 'invalid_image')
        live = self.inspect()
        require(live and live.get('State', {}).get('Running') is True and self.is_previous(live, current), 'current_image_or_state_mismatch')
        require(live.get('State', {}).get('Health', {}).get('Status') == 'healthy', 'current_gateway_not_healthy')
        self.previous_named(current)
        env_text = self.current_env(live)
        actual = None
        try:
            values = dict(s.split('=', 1) for s in env_text.splitlines())
            containers = {values[k] for k in ('AZURE_STORAGE_CONTAINER', 'AZURE_STORAGE_CONTAINER_NAME') if k in values}
            require(containers == {'user-data'}, 'studio_storage_container_mismatch')
            env = self.pg_env(env_text)
            identity = self.identity(env)
            self.tools(identity)
            actual = self.pg('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', REVISION_SQL], env=env).strip()
            require(actual == revision, 'database_revision_mismatch')
            for file in ('config.yml', '.env.azure', 'gcp-wif.json'):
                require((self.config / file).is_file() and not (self.config / file).is_symlink(), 'configuration_missing')
            self.gateway_network()
            require(shutil.disk_usage(self.runs).free >= 6 * 1024**3 or self.test, 'disk_space_low')
        except Refused:
            found, nva = last_env_value(env_text, 'NVA_MEDIA_WORKER_MODE')
            nva_out = 'absent' if not found else sanitize_observed(nva)
            parts = []
            for k in ('AZURE_STORAGE_CONTAINER', 'AZURE_STORAGE_CONTAINER_NAME'):
                f, v = last_env_value(env_text, k)
                if f:
                    parts.append(k + '=' + sanitize_observed(v))
            storage_out = ','.join(parts) if parts else 'absent'
            print(f'PREFLIGHT_OBSERVED nva_media_worker_mode={nva_out} storage_container={storage_out}', file=sys.stderr)
            try:
                try:
                    self.gateway_network()
                    gw_out = 'ok'
                except Exception:
                    gw_out = 'invalid'
                try:
                    missing = [n for n in ('config.yml', '.env.azure', 'gcp-wif.json')
                               if not ((self.config / n).is_file() and not (self.config / n).is_symlink())]
                    cfg_out = 'ok' if not missing else 'missing:' + '+'.join(missing)
                except Exception:
                    cfg_out = 'unknown'
                try:
                    disk_out = str(shutil.disk_usage(self.runs).free // 1024**3)
                except Exception:
                    disk_out = 'unknown'
                try:
                    db_out = sanitize_observed(actual) if actual is not None else 'unknown'
                except Exception:
                    db_out = 'unknown'
                try:
                    pg_out = sanitize_observed(self.pg_image) if self.pg_image else 'none'
                except Exception:
                    pg_out = 'unknown'
                print(f'PREFLIGHT_OBSERVED gateway_network={gw_out} config_files={cfg_out} disk_free_gib={disk_out} db_revision={db_out} pg_client_image={pg_out}', file=sys.stderr)
            except Exception:
                pass
            raise
        return live, env_text, env, identity

    def backup(self, image, current, revision, secrets=None):
        # Checked before any read or write so a missing secret never leaves a half run.
        require(secrets and set(secrets) == set(CANDIDATE_SECRET_KEYS), 'candidate_secret_missing')
        require(valid_secrets(secrets), 'candidate_secret_invalid')
        self.runs.mkdir(parents=True, exist_ok=True)
        live, env_text, env, identity = self.preflight(image, current, revision)
        require(not self.directory.exists(), 'run_id_already_exists')
        self.directory.mkdir(mode=0o700)
        atomic(self.directory / 'environment', env_text.encode())
        atomic(self.directory / SECRET_FILE, ''.join(k + '=' + secrets[k] + '\n' for k in CANDIDATE_SECRET_KEYS).encode())
        os.chmod(self.directory / SECRET_FILE, 0o600)
        for name in ('config.yml', '.env.azure', 'gcp-wif.json'):
            atomic(self.directory / name, (self.config / name).read_bytes())
        dump = self.directory / 'database.dump'
        with open(dump, 'xb') as output:
            self.pg('pg_dump', ['-Fc'], limit=120, env=env, output=output)
            output.flush()
            os.fsync(output.fileno())
        require(dump.stat().st_size > 0, 'empty_database_dump')
        with open(dump, 'rb') as listed:
            self.pg('pg_restore', ['--list'], env=env, stdin=listed)
        found_prev, prev_worker = last_env_value(env_text, 'NVA_MEDIA_WORKER_MODE')
        manifest = dict(run_id=self.run_id, environment=self.environment, identity=identity,
                        previous_digest=current, candidate=image, revision=revision,
                        pg_client_image=self.pg_image, pg_client_major=self.pg_major,
                        previous_nva_media_worker_mode=prev_worker if found_prev else None,
                        config_mode=(self.config / 'config.yml').stat().st_mode & 0o777,
                        metadata={n: [(self.config / n).stat().st_mode & 0o777,
                                      (self.config / n).stat().st_uid,
                                      (self.config / n).stat().st_gid]
                                  for n in ('config.yml', '.env.azure', 'gcp-wif.json')},
                        files={n: sha(self.directory / n) for n in FILES},
                        candidate_environment_sha256=hashlib.sha256(with_candidate_env(env_text).encode()).hexdigest(),
                        candidate_secret_keys=list(CANDIDATE_SECRET_KEYS),
                        candidate_secrets_sha256=sha(self.directory / SECRET_FILE))
        write_json(self.directory / 'backup.json', manifest)
        atomic(self.directory / 'backup.sha256', (sha(self.directory / 'backup.json') + '\n').encode())
        self.load_backup()
        self.record('BACKUP_OK')

    def load_backup(self):
        manifest_file = self.directory / 'backup.json'
        require(manifest_file.is_file() and not manifest_file.is_symlink(), 'backup_missing')
        require(sha(manifest_file) == (self.directory / 'backup.sha256').read_text().strip(), 'backup_manifest_changed')
        rec = json.loads(manifest_file.read_text())
        require(rec['run_id'] == self.run_id and rec['environment'] == self.environment, 'backup_target_mismatch')
        require(set(rec['files']) == set(FILES), 'backup_file_list_invalid')
        for name, digest in rec['files'].items():
            p = self.directory / name
            require(p.is_file() and not p.is_symlink() and sha(p) == digest, 'backup_file_changed')
        require(DIGEST.fullmatch(rec['previous_digest']) and rec['candidate'].startswith(REPO + '@') and DIGEST.fullmatch(rec['candidate'].split('@', 1)[1]), 'backup_images_invalid')
        env = self.pg_env((self.directory / 'environment').read_text())
        identity = self.identity(env)
        require(identity == rec['identity'], 'database_identity_changed')
        pg_major = rec.get('pg_client_major')
        require(type(pg_major) is int and rec.get('pg_client_image') == f'postgres:{pg_major}' and pg_major >= identity['server_major'], 'backup_manifest_invalid')
        self.tools(identity, minimum=pg_major)
        with open(self.directory / 'database.dump', 'rb') as listed:
            self.pg('pg_restore', ['--list'], env=env, stdin=listed)
        self.previous_named(rec['previous_digest'])
        return rec, env

    def candidate_secrets(self, rec):
        """The secrets stored at backup, checked against the manifest. Values are never printed."""
        path = self.directory / SECRET_FILE
        require(rec.get('candidate_secret_keys') == list(CANDIDATE_SECRET_KEYS) and rec.get('candidate_secrets_sha256'),
                'candidate_secret_manifest_missing')
        require(path.is_file() and not path.is_symlink(), 'candidate_secret_missing')
        require(path.stat().st_mode & 0o077 == 0, 'candidate_secret_mode_invalid')
        require(sha(path) == rec['candidate_secrets_sha256'], 'candidate_secret_changed')
        values = {}
        for line in path.read_text().splitlines():
            key, sep, value = line.partition('=')
            require(sep and key not in values, 'candidate_secret_invalid')
            values[key] = value
        require(valid_secrets(values), 'candidate_secret_invalid')
        return values

    def owned(self, rec):
        live = self.inspect()
        if live:
            require(self.is_previous(live, rec) or self.digest(live) == rec['candidate'].split('@', 1)[1], 'current_container_not_owned')
        return live

    def stop(self, live):
        if live:
            self.docker('update', '--restart=no', 'naia-gateway')
            if live.get('State', {}).get('Running'):
                self.docker('stop', 'naia-gateway', limit=30)

    def gateway_network(self):
        try:
            out = self.docker('network', 'inspect', '--format', '{{json .IPAM.Config}}', 'naia-gateway-net')
        except Refused as error:
            if str(error) == 'operation_deadline_exceeded':
                raise
            raise Refused('gateway_network_invalid') from None
        try:
            networks = json.loads(out)
            require(len(networks) == 1 and re.fullmatch(r'\d+\.\d+\.\d+\.\d+', networks[0].get('Gateway', '') or ''), 'gateway_network_invalid')
            return networks[0]['Gateway']
        except Refused:
            raise
        except (ValueError, TypeError, AttributeError, KeyError, IndexError):
            raise Refused('gateway_network_invalid') from None

    def create(self, image, env_file):
        ip = self.gateway_network()
        args = ['run', '-d', '--name', 'naia-gateway', '--network', 'naia-gateway-net', '--restart', 'always',
                '--log-opt', 'max-size=100m', '--log-opt', 'max-file=3', '--memory=1536m', '--memory-swap=1536m',
                '--env-file', str(env_file), '-e', f'FORWARDED_ALLOW_IPS=127.0.0.1,::1,{ip}',
                '-e', 'NVA_MEDIA_WORKER_URL=',
                '-v', f'{self.config / "config.yml"}:/app/config.yml:ro',
                '-v', f'{self.config / "gcp-wif.json"}:/app/gcp-wif.json:ro', '-p', '8080:8080',
                '--health-cmd=python -c "import urllib.request; urllib.request.urlopen(\'http://localhost:8080/health\')"',
                '--health-interval=30s', '--health-timeout=3s', '--health-start-period=10s', '--health-retries=3',
                image, 'any-llm-gateway', 'serve', '--config', '/app/config.yml']
        self.docker(*args, limit=60)

    def deploy(self):
        rec, env = self.load_backup()
        state = json.loads((self.directory / 'state.json').read_text())
        require(state['phase'] == 'BACKUP_OK', 'backup_stage_required')
        live = self.owned(rec)
        require(live and self.is_previous(live, rec), 'previous_image_required')
        head_code = ('import os, any_llm.gateway; from alembic.config import Config; '
                     'from alembic.script import ScriptDirectory; '
                     'p=os.path.join(os.path.dirname(any_llm.gateway.__file__), "alembic.ini"); '
                     'print(",".join(sorted(ScriptDirectory.from_config(Config(p)).get_heads())))')
        heads = self.docker('run', '--rm', '--entrypoint', 'python', rec['candidate'], '-c', head_code, limit=30).strip()
        revision = self.pg('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', REVISION_SQL], env=env).strip()
        require(heads and revision == heads, 'candidate_migration_required')
        config = self.docker('run', '--rm', '--entrypoint', 'cat', rec['candidate'], '/app/config.yml', limit=30)
        require(config.strip(), 'candidate_configuration_empty')
        config = re.sub(r'(?m)^(\s*auto_migrate\s*:).*$', r'\1 false', config)
        require(re.search(r'(?m)^\s*auto_migrate\s*:\s*false\s*$', config), 'auto_migrate_false_required')
        candidate_env = with_candidate_env((self.directory / 'environment').read_text())
        require(hashlib.sha256(candidate_env.encode()).hexdigest() == rec.get('candidate_environment_sha256'),
                'candidate_environment_unexpected')
        # Secrets go in after the reviewed non-secret env is proven; refusal here stops nothing.
        candidate_env = with_env(candidate_env, self.candidate_secrets(rec))
        atomic(self.directory / 'candidate-environment', candidate_env.encode())
        self.gateway_network()
        self.record('DEPLOYING')
        self.stop(live)
        self.docker('rm', 'naia-gateway')
        atomic(self.config / 'config.yml', config.encode())
        os.chmod(self.config / 'config.yml', rec['config_mode'])
        self.create(rec['candidate'], self.directory / 'candidate-environment')
        self.record('DEPLOYED')

    def http(self, route):
        base = os.environ['NAIA_GW_TEST_URL'] if self.test else 'http://127.0.0.1:8080'
        remaining = self.deadline - time.monotonic()
        require(remaining > 0, 'operation_deadline_exceeded')
        try:
            with urllib.request.urlopen(base + route, timeout=min(3, remaining)) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as err:
            return err.code, err.read()
        except (OSError, urllib.error.URLError):
            return 0, b''

    def verify(self, rec, restored=False, record=True):
        expected = lambda c: self.is_previous(c, rec) if restored else self.digest(c) == rec['candidate'].split('@', 1)[1]
        live = self.owned(rec)
        require(live and expected(live) and live.get('State', {}).get('Running'), 'verification_image_or_state_failed')
        for i in range(2 if self.test else 30):
            live = self.owned(rec)
            healthy = live and live.get('State', {}).get('Health', {}).get('Status') == 'healthy'
            if healthy and self.http('/health')[0] == 200:
                break
            time.sleep(min(0.01 if self.test else 2, max(0, self.deadline - time.monotonic())))
        require(healthy and self.http('/health')[0] == 200, 'verification_health_failed')
        code, raw = self.http('/openapi.json')
        require(code == 200, 'verification_openapi_failed')
        paths = json.loads(raw).get('paths', {})
        # The restored previous image is proven by its local image ID; it may already serve this path.
        require(restored or '/v1/studio/speech-plan' in paths, 'verification_studio_paths_failed')
        require(self.http('/v1/models')[0] in (200, 401, 403), 'verification_models_failed')
        live = self.owned(rec)
        require(live and expected(live), 'verification_final_image_mismatch')
        if not restored:
            # The new values are checked on the live new container; every copy must match.
            values = live_env_values(live)
            require(all(values.get(k) and all(x == v for x in values[k]) for k, v in CANDIDATE_ENV.items()),
                    'candidate_environment_mismatch')
            require('previous_nva_media_worker_mode' in rec, 'worker_mode_not_inherited')
            worker_copies = values.get('NVA_MEDIA_WORKER_MODE')
            live_worker = worker_copies[-1] if worker_copies else None
            require(live_worker == rec['previous_nva_media_worker_mode'], 'worker_mode_not_inherited')
            # Every copy of each secret on the live container must equal the stored value (compared, not printed).
            secrets = self.candidate_secrets(rec)
            require(all(values.get(k) and all(x == v for x in values[k]) for k, v in secrets.items()),
                    'candidate_secret_mismatch')
        if restored:
            # The previous container comes back with the backed-up env: secret keys exactly as before.
            values = live_env_values(live)
            before = live_env_values({'Config': {'Env': (self.directory / 'environment').read_text().splitlines()}})
            require(all(sorted(values.get(k, [])) == sorted(before.get(k, [])) for k in CANDIDATE_SECRET_KEYS),
                    'restored_secret_mismatch')
            # The fixed candidate values return to the backed-up ones too (an absent cap stays absent).
            require(all(sorted(values.get(k, [])) == sorted(before.get(k, [])) for k in CANDIDATE_ENV),
                    'restored_environment_mismatch')
            env = self.pg_env((self.directory / 'environment').read_text())
            revision = self.pg('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', REVISION_SQL], env=env).strip()
            require(revision == rec['revision'], 'restored_revision_changed_after_start')
        if record:
            self.record('ROLLBACK_OK' if restored else 'DEPLOY_OK')

    def rollback(self):
        rec, env = self.load_backup()
        live = self.owned(rec)
        # No database restore: deploy refuses unless candidate heads equal the backed-up revision.
        # Check the DB before stopping anything so a DB failure leaves the running container alone.
        revision = self.pg('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', REVISION_SQL], env=env).strip()
        require(revision == rec['revision'], 'restored_revision_mismatch')
        self.gateway_network()
        self.record('RESTORING')
        self.stop(live)
        for name in ('config.yml', '.env.azure', 'gcp-wif.json'):
            atomic(self.config / name, (self.directory / name).read_bytes())
            mode, uid, gid = rec['metadata'][name]
            os.chmod(self.config / name, mode)
            os.chown(self.config / name, uid, gid)
        if live:
            self.docker('rm', 'naia-gateway')
        self.create(rec['previous_digest'], self.directory / 'environment')
        self.verify(rec, restored=True)

    def speech_set_jobs(self, env):
        """Counts only, in a read-only session. Never fatal: a failed read prints unread, not a guess."""
        ro = dict(env, PGOPTIONS=(env.get('PGOPTIONS', '') + ' -c default_transaction_read_only=on').strip())
        try:
            out = self.pg('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', SPEECH_SET_SQL], env=ro).strip()
        except (Refused, OSError, ValueError, subprocess.SubprocessError):
            return 'SPEECH_SET_JOBS=unread'
        m = re.fullmatch(r'(\d+)\|(\d+)', out)
        return f'SPEECH_SET_JOBS open={m[1]} reserved={m[2]}' if m else 'SPEECH_SET_JOBS=unread'

    def status(self):
        state = json.loads((self.directory / 'state.json').read_text())
        require(state['run_id'] == self.run_id and state['environment'] == self.environment, 'state_target_mismatch')
        print('PHASE=' + state['phase'], 'run_id=' + self.run_id)
        rec, env = self.load_backup()
        live = self.owned(rec)
        digest = 'missing' if not live else live['Image'] if self.is_previous(live, rec) else self.digest(live)
        print('LIVE_DIGEST=' + digest, 'RUNNING=' + str(bool(live and live.get('State', {}).get('Running'))).lower())
        if state['phase'] == 'BACKUP_OK':
            # q0: the plan sends deploy only when this reads open=0 reserved=0.
            print(self.speech_set_jobs(env))
        if state['phase'] in ('DEPLOY_OK', 'ROLLBACK_OK'):
            self.verify(rec, restored=state['phase'] == 'ROLLBACK_OK', record=False)
            print('STATUS_VERIFIED=1')
        else:
            print('STATUS_VERIFIED=0')

    def cleanup_disk(self):
        base = (Path(os.environ['NAIA_GW_TEST_ROOT']) if self.test else Path('/')) / 'var/lib/naia-gw-deploy'
        if self.test:
            path = os.environ.get('NAIA_GW_TEST_DISK_FILE')
            if not path:
                raise Refused('test_disk_file_missing')
            try:
                data = json.loads(Path(path).read_text())
                total = int(data['total'])
                free = int(data['free'])
            except (OSError, ValueError, KeyError, TypeError):
                raise Refused('test_disk_file_missing') from None
            return {'total': total, 'free': free, 'used': total - free}
        base.mkdir(parents=True, exist_ok=True)
        usage = shutil.disk_usage(base)
        return {'total': usage.total, 'free': usage.free, 'used': usage.used}

    def cleanup_keep(self, image, current):
        try:
            live = self.inspect()
        except Refused as error:
            if str(error) == 'operation_deadline_exceeded':
                raise
            raise Refused('current_image_or_state_mismatch') from None
        require(live and live.get('State', {}).get('Running') is True and self.is_previous(live, current),
                'current_image_or_state_mismatch')
        ok, out = self.try_command(['docker', 'image', 'inspect', '--format', '{{json .}}', current], limit=15)
        require(ok, 'cleanup_keep_image_missing')
        try:
            info = json.loads(out.strip().splitlines()[0])
        except (ValueError, IndexError):
            raise Refused('cleanup_keep_image_missing') from None
        require(info.get('Id') == current, 'cleanup_keep_image_missing')
        current_tags = [t for t in (info.get('RepoTags') or []) if isinstance(t, str) and t]
        require(bool(current_tags), 'cleanup_keep_image_missing')
        ok, out = self.try_command(['docker', 'image', 'inspect', '--format', '{{json .}}', image], limit=15)
        require(ok, 'cleanup_keep_image_missing')
        try:
            candidate = json.loads(out.strip().splitlines()[0])
        except (ValueError, IndexError):
            raise Refused('cleanup_keep_image_missing') from None
        require(image in (candidate.get('RepoDigests') or []), 'cleanup_keep_image_missing')
        candidate_id = candidate.get('Id')
        require(isinstance(candidate_id, str) and candidate_id, 'cleanup_keep_image_missing')
        try:
            names = self.pg_images()
        except Refused:
            raise Refused('cleanup_keep_image_missing') from None
        int_names = sorted(n for n in names if re.fullmatch(r'postgres:\d+', n))
        require(bool(int_names), 'cleanup_keep_image_missing')
        db_ids = []
        for name in int_names:
            ok, out = self.try_command(['docker', 'image', 'inspect', '--format', '{{json .}}', name], limit=15)
            require(ok, 'cleanup_keep_image_missing')
            try:
                entry = json.loads(out.strip().splitlines()[0])
            except (ValueError, IndexError):
                raise Refused('cleanup_keep_image_missing') from None
            entry_id = entry.get('Id')
            require(isinstance(entry_id, str) and entry_id, 'cleanup_keep_image_missing')
            db_ids.append(entry_id)
        keep_ids = {current, candidate_id} | set(db_ids)
        return keep_ids, current_tags, candidate_id, int_names, db_ids

    @staticmethod
    def cleanup_created_key(created):
        """Sort key: second-precision prefix + fraction zero-padded to 9 digits."""
        base = created[:19]
        if '.' in created:
            frac = created.split('.', 1)[1][:-1] if created.endswith('Z') else ''
        else:
            frac = ''
        return base + '.' + (frac.ljust(9, '0') if frac else '000000000')

    @staticmethod
    def cleanup_created_display(created):
        """Truncate RFC3339Nano to second precision for output lines."""
        if isinstance(created, str) and len(created) >= 19:
            return created[:19] + 'Z'
        return 'unavailable'

    @staticmethod
    def cleanup_container_priority(cls):
        if cls == 'gateway_stopped':
            return '1'
        if cls == 'gateway_active':
            return '2'
        return 'none'

    @staticmethod
    def cleanup_parse_container_rows(out):
        """Parse the five-column container inspect output; None when malformed."""
        rows = []
        for line in out.splitlines():
            if not line.strip():
                continue
            parts = line.split()
            if len(parts) != 5:
                return None
            cid, name, image, status, created = parts
            if not re.fullmatch(r'[0-9a-f]{64}', cid):
                return None
            if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
                return None
            if not CLEANUP_CREATED_RE.match(created):
                return None
            if name.startswith('/'):
                name = name[1:]
            rows.append({'Id': cid, 'Name': name, 'Image': image,
                         'Status': status, 'Created': created})
        return rows

    def cleanup_container_table(self):
        ok, out = self.try_command(['docker', 'ps', '-a', '-q', '--no-trunc'], limit=15)
        if not ok:
            raise Refused('cleanup_inventory_failed')
        cids = []
        for line in out.splitlines():
            line = line.strip()
            if line and line not in cids:
                cids.append(line)
        if not cids:
            return []
        ok, out = self.try_command(['docker', 'container', 'inspect', '--format',
                                    CLEANUP_CONTAINER_FORMAT] + cids, limit=15)
        if not ok:
            raise Refused('cleanup_inventory_failed')
        rows = self.cleanup_parse_container_rows(out)
        if rows is None or len(rows) != len(cids) or {r['Id'] for r in rows} != set(cids):
            raise Refused('cleanup_inventory_failed')
        return rows

    @staticmethod
    def cleanup_infos_by_id(infos):
        by_id = {}
        for info in infos:
            iid = info.get('Id')
            if isinstance(iid, str) and iid not in by_id:
                by_id[iid] = info
        return by_id

    @staticmethod
    def cleanup_classify_container(entry, keep_ids, infos_by_id):
        if entry.get('Name') == 'naia-gateway':
            return 'naia_gateway'
        if entry.get('Status') not in ('exited', 'created', 'dead'):
            info = infos_by_id.get(entry.get('Image'))
            if info is not None and Operation.cleanup_classify(info, keep_ids, set()) == 'gateway_old':
                return 'gateway_active'
            return 'active'
        if entry.get('Image') in keep_ids:
            return 'keep_image'
        info = infos_by_id.get(entry.get('Image'))
        if info is not None and Operation.cleanup_classify(info, keep_ids, set()) == 'gateway_old':
            return 'gateway_stopped'
        return 'other'

    def cleanup_image_table(self):
        containers = self.cleanup_container_table()
        used_ids = {c['Image'] for c in containers}
        ok, out = self.try_command(['docker', 'image', 'ls', '-q', '--no-trunc'], limit=15)
        if not ok:
            raise Refused('cleanup_inventory_failed')
        ids = []
        for line in out.splitlines():
            line = line.strip()
            if line and line not in ids:
                ids.append(line)
        infos = []
        if ids:
            ok, out = self.try_command(['docker', 'image', 'inspect', '--format', '{{json .}}'] + ids, limit=30)
            if not ok:
                raise Refused('cleanup_inventory_failed')
            for line in out.splitlines():
                if not line.strip():
                    continue
                try:
                    infos.append(json.loads(line))
                except ValueError:
                    raise Refused('cleanup_inventory_failed') from None
        return used_ids, infos, containers

    @staticmethod
    def cleanup_classify(info, keep_ids, used_ids):
        iid = info.get('Id')
        if iid in keep_ids:
            return 'keep'
        if iid in used_ids:
            return 'in_use'
        tags = info.get('RepoTags') or []
        digests = info.get('RepoDigests') or []
        rt = [t for t in tags if isinstance(t, str) and t and t != '<none>:<none>']
        rd = [d for d in digests if isinstance(d, str) and d and d != '<none>@<none>']
        if not rt and not rd:
            return 'dangling'
        for t in rt:
            if t.rsplit(':', 1)[0] not in GATEWAY_IMAGE_REPOS:
                return 'other'
        for d in rd:
            if d.split('@', 1)[0] not in GATEWAY_IMAGE_REPOS:
                return 'other'
        return 'gateway_old'

    @staticmethod
    def cleanup_display_names(info):
        tags = info.get('RepoTags') or []
        digests = info.get('RepoDigests') or []
        names = [t for t in tags if isinstance(t, str) and t and t != '<none>:<none>']
        names += [d for d in digests if isinstance(d, str) and d and d != '<none>@<none>']
        return names

    @staticmethod
    def cleanup_keep_line(stage, current, current_tags, candidate_id, db_names):
        tags_out = '+'.join(current_tags) if current_tags else 'none'
        db_out = '+'.join(db_names) if db_names else 'none'
        return cleanup_sanitize(f'CLEANUP_OBSERVED keep stage={stage} current={current[:19]} '
                                f'current_tags={tags_out} candidate={candidate_id[:19]} '
                                f'db_tool_images={db_out} result=ok')

    @staticmethod
    def cleanup_summary_line(total, used_after, free_before, free_after, keep_ok, removed,
                             removed_mib, failed, removed_containers=0, failed_containers=0,
                             kept_active=0):
        gib = 1024**3
        mib = 1024**2
        return cleanup_sanitize(f'CLEANUP_OBSERVED disk_total_gib={total // gib} '
                                f'disk_used_gib_after={used_after // gib} '
                                f'disk_free_gib_before={free_before // gib} '
                                f'disk_free_gib_after={free_after // gib} '
                                f'disk_free_mib_after={free_after // mib} threshold_gib=6 '
                                f'keep_images={"ok" if keep_ok else "missing"} removed_images={removed} '
                                f'removed_mib={removed_mib} failed_images={failed} '
                                f'removed_containers={removed_containers} '
                                f'failed_containers={failed_containers} '
                                f'kept_active_gateway_containers={kept_active}')

    @staticmethod
    def cleanup_removed_record(stage, cls, names, iid, size_mib, result):
        name_out = '+'.join(names) if names else 'none'
        short = iid[:19] if isinstance(iid, str) else 'unavailable'
        return cleanup_sanitize(f'CLEANUP_INVENTORY stage={stage} kind=removed class={cls} '
                                f'name={name_out} id={short} size_mib={size_mib} result={result}')

    @staticmethod
    def cleanup_container_removed_line(entry, result):
        name = entry.get('Name') if isinstance(entry.get('Name'), str) else ''
        cid = entry.get('Id') if isinstance(entry.get('Id'), str) else ''
        image = entry.get('Image') if isinstance(entry.get('Image'), str) else ''
        created = Operation.cleanup_created_display(entry.get('Created'))
        return cleanup_sanitize(f'CLEANUP_REMOVED class=container priority=1 name={name} id={cid[:12]} '
                                f'image={image[:19]} created={created} result={result}')

    @staticmethod
    def cleanup_container_removed_record(entry, result):
        name = entry.get('Name') if isinstance(entry.get('Name'), str) else ''
        cid = entry.get('Id') if isinstance(entry.get('Id'), str) else ''
        image = entry.get('Image') if isinstance(entry.get('Image'), str) else ''
        short_id = cid[:12] if cid else 'unavailable'
        short_image = image[:19] if image else 'unavailable'
        created = Operation.cleanup_created_display(entry.get('Created'))
        return cleanup_sanitize(f'CLEANUP_INVENTORY stage=after kind=removed_container priority=1 name={name} '
                                f'id={short_id} image={short_image} created={created} result={result}')

    @staticmethod
    def cleanup_gateway_active_kept_record(entry):
        name = entry.get('Name') if isinstance(entry.get('Name'), str) else ''
        cid = entry.get('Id') if isinstance(entry.get('Id'), str) else ''
        image = entry.get('Image') if isinstance(entry.get('Image'), str) else ''
        short_id = cid[:12] if cid else 'unavailable'
        short_image = image[:19] if image else 'unavailable'
        created = Operation.cleanup_created_display(entry.get('Created'))
        state = entry.get('Status') if isinstance(entry.get('Status'), str) else ''
        return cleanup_sanitize(f'CLEANUP_INVENTORY stage=after kind=removed_container priority=2 name={name} '
                                f'id={short_id} image={short_image} created={created} '
                                f'state={state} result=kept_active')

    @staticmethod
    def cleanup_priority2_stdout_line(kept):
        return cleanup_sanitize(f'CLEANUP_REMOVED class=container priority=2 kept_active={kept}')

    @staticmethod
    def cleanup_emit_block(lines, budget, truncated, file=None, keep_first=False):
        """Print lines within budget bytes; the overflow marker counts toward the budget."""
        if file is None:
            file = sys.stdout
        total = sum(len((line + '\n').encode()) for line in lines)
        if total <= budget:
            for line in lines:
                print(line, file=file)
            return
        floor = 1 if (keep_first and lines) else 0
        for keep in range(len(lines), floor - 1, -1):
            marker = truncated(len(lines) - keep)
            size = sum(len((line + '\n').encode()) for line in lines[:keep])
            size += len((marker + '\n').encode())
            if size <= budget:
                for line in lines[:keep]:
                    print(line, file=file)
                print(marker, file=file)
                return
        print(truncated(len(lines)), file=file)

    @staticmethod
    def cleanup_split_container_lines(lines):
        container = [line for line in lines if ' kind=container ' in line]
        other = [line for line in lines if ' kind=container ' not in line]
        return other, container

    def cleanup_root_str(self):
        return os.environ['NAIA_GW_TEST_ROOT'] if self.test else '/'

    def cleanup_inventory_lines(self, stage, disk, keep_ids, used_ids, infos, containers):
        lines = []
        if disk is None:
            lines.append(cleanup_sanitize(f'CLEANUP_INVENTORY stage={stage} kind=disk total_gib=unavailable '
                                          'used_gib=unavailable free_gib=unavailable free_mib=unavailable '
                                          'used_pct=unavailable'))
        else:
            total, free, used = disk['total'], disk['free'], disk['used']
            pct = (used * 100 // total) if total > 0 else 0
            lines.append(cleanup_sanitize(f'CLEANUP_INVENTORY stage={stage} kind=disk total_gib={total // 1024**3} '
                                          f'used_gib={used // 1024**3} free_gib={free // 1024**3} '
                                          f'free_mib={free // 1024**2} used_pct={pct}'))
        root_str = self.cleanup_root_str()
        ok, out = self.try_command(['df', '-P', '-k', root_str], limit=15)
        df_line = 'unavailable'
        if ok:
            rows = out.splitlines()
            if len(rows) >= 2:
                df_line = ' '.join(rows[1].split())
                if not df_line:
                    df_line = 'unavailable'
        lines.append(cleanup_sanitize(f'CLEANUP_INVENTORY stage={stage} kind=df line={df_line}'))
        ok, out = self.try_command(['docker', 'system', 'df', '--format',
                                    '{{.Type}} total={{.TotalCount}} active={{.Active}} '
                                    'size={{.Size}} reclaimable={{.Reclaimable}}'], limit=15)
        if not ok:
            lines.append(cleanup_sanitize(f'CLEANUP_INVENTORY stage={stage} kind=docker_df unavailable'))
        else:
            for row in out.splitlines():
                row = row.strip()
                if row:
                    lines.append(cleanup_sanitize(f'CLEANUP_INVENTORY stage={stage} kind=docker_df {row}'))
        decorated = []
        for info in infos:
            cls = self.cleanup_classify(info, keep_ids, used_ids)
            iid = info.get('Id')
            size = info.get('Size')
            size = size if isinstance(size, int) and size >= 0 else 0
            decorated.append((-size, iid if isinstance(iid, str) else '', cls, info))
        decorated.sort(key=lambda e: (e[0], e[1]))
        for neg_size, iid, cls, info in decorated[:40]:
            names = self.cleanup_display_names(info)
            name_out = '+'.join(names) if names else 'none'
            short = iid[:19] if iid else 'unavailable'
            lines.append(cleanup_sanitize(f'CLEANUP_INVENTORY stage={stage} kind=image class={cls} '
                                          f'name={name_out} id={short} size_mib={(-neg_size) // 1024**2}'))
        if len(decorated) > 40:
            lines.append(cleanup_sanitize(f'CLEANUP_INVENTORY stage={stage} kind=image truncated={len(decorated) - 40}'))
        if containers is None:
            lines.append(cleanup_sanitize(f'CLEANUP_INVENTORY stage={stage} kind=container total=unavailable'))
        else:
            infos_by_id = self.cleanup_infos_by_id(infos)
            counts = {'naia_gateway': 0, 'active': 0, 'gateway_active': 0, 'keep_image': 0,
                      'gateway_stopped': 0, 'other': 0}
            by_class = {'naia_gateway': [], 'active': [], 'keep_image': [],
                        'other': [], 'gateway_active': [], 'gateway_stopped': []}
            for entry in containers:
                cls = self.cleanup_classify_container(entry, keep_ids, infos_by_id)
                counts[cls] = counts.get(cls, 0) + 1
                by_class.setdefault(cls, []).append(entry)
            lines.append(cleanup_sanitize(f'CLEANUP_INVENTORY stage={stage} kind=container '
                                          f'total={sum(counts.values())} naia_gateway={counts["naia_gateway"]} '
                                          f'active={counts["active"]} gateway_active={counts["gateway_active"]} '
                                          f'keep_image={counts["keep_image"]} '
                                          f'gateway_stopped={counts["gateway_stopped"]} other={counts["other"]}'))
            ordered = []
            for cls in ('naia_gateway', 'active', 'keep_image', 'other'):
                group = sorted(by_class.get(cls, []),
                               key=lambda e: ((e.get('Name') or ''), (e.get('Id') or '')))
                ordered.extend([(cls, e) for e in group])
            for cls in ('gateway_active', 'gateway_stopped'):
                group = sorted(by_class.get(cls, []),
                               key=lambda e: (self.cleanup_created_key(e.get('Created') or ''),
                                              (e.get('Name') or ''), (e.get('Id') or '')))
                ordered.extend([(cls, e) for e in group])
            for cls, entry in ordered:
                name = entry.get('Name') if isinstance(entry.get('Name'), str) else ''
                cid = entry.get('Id') if isinstance(entry.get('Id'), str) else ''
                image = entry.get('Image') if isinstance(entry.get('Image'), str) else ''
                status = entry.get('Status') if isinstance(entry.get('Status'), str) else ''
                short_id = cid[:12] if cid else 'unavailable'
                short_image = image[:19] if image else 'unavailable'
                created = self.cleanup_created_display(entry.get('Created'))
                priority = self.cleanup_container_priority(cls)
                lines.append(cleanup_sanitize(f'CLEANUP_INVENTORY stage={stage} kind=container name={name} '
                                              f'id={short_id} image={short_image} state={status} '
                                              f'created={created} class={cls} priority={priority}'))
        base = root_str.rstrip('/') or '/'
        ok, out = self.try_command(['du', '-x', '-k', '-d', '2',
                                    '--exclude=' + (base.rstrip('/') + '/var/lib/docker' if base != '/'
                                                   else '/var/lib/docker'),
                                    base], limit=90, ok_codes=(0, 1))
        if not ok:
            lines.append(cleanup_sanitize(f'CLEANUP_INVENTORY stage={stage} kind=dir path={base} kib=unavailable'))
        else:
            entries = []
            for row in out.splitlines():
                parts = row.split(None, 1)
                if len(parts) != 2:
                    continue
                try:
                    entries.append((int(parts[0]), parts[1]))
                except ValueError:
                    continue
            entries.sort(key=lambda e: (-e[0], e[1]))
            for kib, path in entries[:12]:
                lines.append(cleanup_sanitize(f'CLEANUP_INVENTORY stage={stage} kind=dir path={path} kib={kib}'))
        for sub in ('var/log/journal', 'var/cache/apt', 'var/lib/naia-gw-deploy'):
            full = (base.rstrip('/') + '/' + sub) if base != '/' else ('/' + sub)
            if not Path(full).exists():
                lines.append(cleanup_sanitize(f'CLEANUP_INVENTORY stage={stage} kind=dir path={full} kib=unavailable'))
                continue
            ok, out = self.try_command(['du', '-s', '-k', full], limit=30)
            kib = 'unavailable'
            if ok:
                parts = out.split()
                if parts:
                    try:
                        kib = str(int(parts[0]))
                    except ValueError:
                        kib = 'unavailable'
            lines.append(cleanup_sanitize(f'CLEANUP_INVENTORY stage={stage} kind=dir path={full} kib={kib}'))
        return lines

    def cleanup(self, image, current, revision):
        require(image.startswith(REPO + '@') and DIGEST.fullmatch(image.split('@', 1)[1])
                and DIGEST.fullmatch(current), 'invalid_image')
        require(bool(re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', revision)), 'invalid_image')
        root = Path(os.environ['NAIA_GW_TEST_ROOT']) if self.test else Path('/')
        base = root / 'var/lib/naia-gw-deploy'
        cleanup_dir = base / 'cleanup' / self.run_id
        require(not cleanup_dir.exists(), 'cleanup_run_id_already_exists')
        disk_before = self.cleanup_disk()
        keep_ids, current_tags, candidate_id, db_names, _db_ids = self.cleanup_keep(image, current)
        used_ids, infos, containers_before = self.cleanup_image_table()
        try:
            cleanup_dir.mkdir(parents=True, mode=0o700, exist_ok=False)
        except FileExistsError:
            raise Refused('cleanup_run_id_already_exists') from None
        try:
            os.chmod(cleanup_dir, 0o700)
        except OSError:
            pass
        before_lines = self.cleanup_inventory_lines('before', disk_before, keep_ids, used_ids, infos,
                                                    containers_before)
        atomic(cleanup_dir / 'inventory-before.txt', ('\n'.join(before_lines) + '\n').encode() if before_lines else b'')
        print(self.cleanup_keep_line('before', current, current_tags, candidate_id, db_names))
        before_other, before_container = self.cleanup_split_container_lines(before_lines)
        self.cleanup_emit_block(before_container, CLEANUP_STDOUT_CONTAINER_BEFORE_BYTES,
                                lambda n: cleanup_sanitize('CLEANUP_INVENTORY stage=before kind=container '
                                                           f'truncated={n} file=inventory-before.txt'),
                                keep_first=True)
        self.cleanup_emit_block(before_other, CLEANUP_STDOUT_OTHER_BEFORE_BYTES,
                                lambda n: cleanup_sanitize(f'CLEANUP_INVENTORY stage=before truncated={n} '
                                                           'file=inventory-before.txt'))
        infos_by_id = self.cleanup_infos_by_id(infos)
        container_targets = sorted(
            (entry for entry in containers_before
             if self.cleanup_classify_container(entry, keep_ids, infos_by_id) == 'gateway_stopped'),
            key=lambda e: (self.cleanup_created_key(e.get('Created') or ''),
                           (e.get('Name') or ''), (e.get('Id') or '')))
        kept_active_entries = sorted(
            (entry for entry in containers_before
             if self.cleanup_classify_container(entry, keep_ids, infos_by_id) == 'gateway_active'),
            key=lambda e: (self.cleanup_created_key(e.get('Created') or ''),
                           (e.get('Name') or ''), (e.get('Id') or '')))
        kept_active_records = [self.cleanup_gateway_active_kept_record(e) for e in kept_active_entries]
        kept_active_count = len(kept_active_entries)
        removed_containers = 0
        failed_containers = 0
        container_failed = False
        container_stdout = []
        container_stdout_failed = []
        container_records = []
        for entry in container_targets:
            cid = entry.get('Id') if isinstance(entry.get('Id'), str) else ''
            if not self.cleanup_deadline_ok():
                result = 'skipped_deadline'
            else:
                ok, out = self.try_command(['docker', 'container', 'inspect', '--format',
                                            CLEANUP_CONTAINER_FORMAT, cid], limit=15)
                rows = self.cleanup_parse_container_rows(out) if ok else None
                if (rows is None or len(rows) != 1 or rows[0] != entry
                        or self.cleanup_classify_container(rows[0], keep_ids,
                                                           infos_by_id) != 'gateway_stopped'):
                    result = 'failed'
                else:
                    ok, _ = self.try_command(['docker', 'container', 'rm', cid], limit=60)
                    if not ok:
                        result = 'failed'
                    else:
                        ok, _ = self.try_command(['docker', 'container', 'inspect', '--format',
                                                  CLEANUP_CONTAINER_ID_FORMAT, cid], limit=15)
                        result = 'failed' if ok else 'removed'
            container_records.append(self.cleanup_container_removed_record(entry, result))
            line = self.cleanup_container_removed_line(entry, result)
            if result == 'removed':
                removed_containers += 1
                container_stdout.append(line)
            elif result == 'failed':
                failed_containers += 1
                container_stdout_failed.append(line)
                container_failed = True
                break
            else:
                container_stdout.append(line)
        self.cleanup_emit_block(container_stdout, CLEANUP_STDOUT_CONTAINER_REMOVED_BYTES,
                                lambda n: cleanup_sanitize('CLEANUP_REMOVED class=container '
                                                           f'truncated={n} file=inventory-after.txt'))
        for line in container_stdout_failed:
            print(line)
        print(self.cleanup_priority2_stdout_line(kept_active_count))
        if container_failed:
            for action in ('builder_prune', 'journal_vacuum', 'apt_clean'):
                print(cleanup_sanitize(f'CLEANUP_OBSERVED action={action} result=skipped_stop'))
            image_targets = []
            removed_stdout = []
            removed_records = []
            removed_count = 0
            removed_bytes = 0
            failed_count = 0
            mid_used, mid_infos, mid_containers = used_ids, infos, None
        else:
            try:
                used_ids, infos, mid_containers = self.cleanup_image_table()
            except Refused:
                after_lines = self.cleanup_inventory_lines('after', disk_before, keep_ids,
                                                           used_ids, infos, None)
                atomic(cleanup_dir / 'inventory-after.txt',
                       ('\n'.join(after_lines + container_records + kept_active_records) + '\n').encode()
                       if (after_lines or container_records or kept_active_records) else b'')
                raise Refused('cleanup_inventory_failed') from None
            mid_used, mid_infos = used_ids, infos
            infos_by_id = self.cleanup_infos_by_id(infos)
            classified = [(self.cleanup_classify(info, keep_ids, used_ids), info) for info in infos]
            targets = [(info.get('Size') if isinstance(info.get('Size'), int) else 0,
                        info.get('Id'), cls, info)
                       for cls, info in classified if cls in ('gateway_old', 'dangling')]
            targets.sort(key=lambda e: (-e[0], e[1] if isinstance(e[1], str) else ''))
            image_targets = targets
        removed_count = 0
        removed_bytes = 0
        failed_count = 0
        removed_stdout = []
        removed_records = []
        for size, iid, cls, info in image_targets:
            names = self.cleanup_display_names(info)
            size_mib = (size // 1024**2) if isinstance(size, int) and size >= 0 else 0
            short = iid[:19] if isinstance(iid, str) else 'unavailable'
            name_out = '+'.join(names) if names else 'none'
            if not self.cleanup_deadline_ok():
                result = 'skipped_deadline'
            elif not isinstance(iid, str) or not iid or iid in keep_ids or iid in used_ids:
                result = 'failed'
            else:
                tags = [t for t in (info.get('RepoTags') or [])
                        if isinstance(t, str) and t and t != '<none>:<none>']
                ok_all = True
                if tags:
                    tag_ok = True
                    for tag in tags:
                        ok, _ = self.try_command(['docker', 'image', 'rm', tag], limit=60)
                        if not ok:
                            tag_ok = False
                    if not tag_ok:
                        ok_all = False
                    else:
                        ok_insp, _ = self.try_command(['docker', 'image', 'inspect', iid], limit=15)
                        if ok_insp:
                            ok, _ = self.try_command(['docker', 'image', 'rm', iid], limit=60)
                            if not ok:
                                ok_all = False
                else:
                    ok, _ = self.try_command(['docker', 'image', 'rm', iid], limit=60)
                    if not ok:
                        ok_all = False
                if ok_all:
                    ok_insp, _ = self.try_command(['docker', 'image', 'inspect', iid], limit=15)
                    if ok_insp:
                        ok_all = False
                result = 'removed' if ok_all else 'failed'
            if result == 'removed':
                removed_count += 1
                removed_bytes += size if isinstance(size, int) and size > 0 else 0
            elif result == 'failed':
                failed_count += 1
            removed_stdout.append(cleanup_sanitize(f'CLEANUP_REMOVED class={cls} name={name_out} id={short} '
                                                   f'size_mib={size_mib} result={result}'))
            removed_records.append(self.cleanup_removed_record('after', cls, names, iid, size_mib, result))
        self.cleanup_emit_block(removed_stdout, CLEANUP_STDOUT_IMAGE_REMOVED_BYTES,
                                lambda n: cleanup_sanitize('CLEANUP_REMOVED class=image '
                                                           f'truncated={n} file=inventory-after.txt'))
        if not container_failed:
            for action, argv, limit in (('builder_prune', ['docker', 'builder', 'prune', '--all', '--force'], 180),
                                        ('journal_vacuum', ['journalctl', '--vacuum-size=200M'], 60),
                                        ('apt_clean', ['apt-get', 'clean'], 60)):
                if not self.cleanup_deadline_ok():
                    result = 'skipped_deadline'
                else:
                    ok, _ = self.try_command(argv, limit=limit)
                    result = 'ok' if ok else 'failed'
                print(cleanup_sanitize(f'CLEANUP_OBSERVED action={action} result={result}'))
        try:
            keep2 = self.cleanup_keep(image, current)
            keep_after_ok = (keep2[2] == candidate_id and set(keep2[0]) == set(keep_ids))
        except Refused:
            keep_after_ok = False
            keep2 = None
        try:
            disk_after = self.cleanup_disk()
        except Refused:
            disk_after = None
        try:
            used_after, infos_after, containers_after = self.cleanup_image_table()
        except Refused:
            used_after, infos_after, containers_after = mid_used, mid_infos, mid_containers
        after_lines = self.cleanup_inventory_lines('after', disk_after if disk_after is not None else disk_before,
                                                   keep_ids, used_after, infos_after, containers_after)
        atomic(cleanup_dir / 'inventory-after.txt',
               ('\n'.join(after_lines + removed_records + container_records + kept_active_records) + '\n').encode()
               if (after_lines or removed_records or container_records or kept_active_records) else b'')
        if keep_after_ok:
            _, current_tags_after, candidate_after, db_names_after, _ = keep2
            print(self.cleanup_keep_line('after', current, current_tags_after, candidate_after, db_names_after))
        after_other, after_container = self.cleanup_split_container_lines(after_lines)
        failed_tail = container_failed or not keep_after_ok or (disk_after or disk_before)['free'] < CLEANUP_THRESHOLD_BYTES
        if not failed_tail:
            self.cleanup_emit_block(after_container, CLEANUP_STDOUT_CONTAINER_AFTER_BYTES,
                                    lambda n: cleanup_sanitize('CLEANUP_INVENTORY stage=after kind=container '
                                                               f'truncated={n} file=inventory-after.txt'),
                                    keep_first=True)
        total = (disk_after or disk_before)['total']
        used_a = (disk_after or disk_before)['used']
        summary = self.cleanup_summary_line(total, used_a, disk_before['free'],
                                            (disk_after or disk_before)['free'],
                                            keep_after_ok, removed_count, removed_bytes // 1024**2, failed_count,
                                            removed_containers, failed_containers,
                                            kept_active_count)
        print(summary)
        if not keep_after_ok:
            self.cleanup_emit_block(after_container, CLEANUP_STDOUT_CONTAINER_AFTER_BYTES,
                                    lambda n: cleanup_sanitize('CLEANUP_INVENTORY stage=after kind=container '
                                                               f'truncated={n} file=inventory-after.txt'),
                                    file=sys.stderr, keep_first=True)
            self.cleanup_emit_block(after_other, CLEANUP_STDERR_AFTER_OTHER_BYTES,
                                    lambda n: cleanup_sanitize(f'CLEANUP_INVENTORY stage=after truncated={n} '
                                                               'file=inventory-after.txt'), file=sys.stderr)
            raise Refused('cleanup_keep_image_missing_after')
        if container_failed:
            self.cleanup_emit_block(after_container, CLEANUP_STDOUT_CONTAINER_AFTER_BYTES,
                                    lambda n: cleanup_sanitize('CLEANUP_INVENTORY stage=after kind=container '
                                                               f'truncated={n} file=inventory-after.txt'),
                                    file=sys.stderr, keep_first=True)
            self.cleanup_emit_block(after_other, CLEANUP_STDERR_AFTER_OTHER_BYTES,
                                    lambda n: cleanup_sanitize(f'CLEANUP_INVENTORY stage=after truncated={n} '
                                                               'file=inventory-after.txt'), file=sys.stderr)
            raise Refused('cleanup_container_remove_failed')
        if (disk_after or disk_before)['free'] < CLEANUP_THRESHOLD_BYTES:
            self.cleanup_emit_block(after_container, CLEANUP_STDOUT_CONTAINER_AFTER_BYTES,
                                    lambda n: cleanup_sanitize('CLEANUP_INVENTORY stage=after kind=container '
                                                               f'truncated={n} file=inventory-after.txt'),
                                    file=sys.stderr, keep_first=True)
            self.cleanup_emit_block(after_other, CLEANUP_STDERR_AFTER_OTHER_BYTES,
                                    lambda n: cleanup_sanitize(f'CLEANUP_INVENTORY stage=after truncated={n} '
                                                               'file=inventory-after.txt'), file=sys.stderr)
            raise Refused('disk_space_low')
        print(cleanup_sanitize(f'CLEANUP_OK run_id={self.run_id}'))


def main(argv):
    os.umask(0o077)
    # Always removed from the environment first, whatever the phase, so no docker/psql child sees them.
    secrets = take_candidate_secrets()
    require(len(argv) >= 3, 'usage_phase_environment_run_id')
    phase, environment, run_id, *rest = argv
    require(phase in ('backup', 'deploy', 'verify', 'rollback', 'status', 'cleanup'), 'invalid_phase')
    require(len(rest) == (3 if phase in ('backup', 'cleanup') else 0), 'invalid_argument_count')
    op = Operation(environment, run_id)
    op.lock.parent.mkdir(parents=True, exist_ok=True)
    with open(op.lock, 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused('operation_locked')
        if phase == 'backup':
            op.backup(*rest, secrets=secrets)
        elif phase == 'cleanup':
            op.cleanup(*rest)
        elif phase == 'deploy':
            op.deploy()
        elif phase == 'verify':
            rec, _ = op.load_backup()
            op.verify(rec)
        elif phase == 'rollback':
            op.rollback()
        else:
            op.status()


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main(sys.argv[1:])
    except (Refused, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        reason = str(error) if isinstance(error, Refused) else type(error).__name__
        print('OPERATION_FAILED reason=' + reason, file=sys.stderr)
        sys.exit(1)
