import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, chmodSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { moveWakes, wakeDirFor, spoolIo, messengerRoleIds } from './wake-move.mjs';
// Fixture roles; a real install names its own in NAIA_MESSENGER_ROLES (default: naia).
process.env.NAIA_MESSENGER_ROLES = 'coder,planner,reviewer,writer,naia,designer'
process.env.NAIA_MESSENGER_ROOT_WAKE_ROLE = 'coder'

const setup = () => {
 const base = mkdtempSync(join(tmpdir(), 'messenger-wake-move-'));
 const root = join(base, 'adk'), spool = join(base, 'spool'), state = join(base, 'state', 'moved.json');
 mkdirSync(root); mkdirSync(spool);
 const spoolWake = (id, role, body = `@${role} 확인`) => {
  const name = `20261108000000000-${id}-route-${role}.json`;
  writeFileSync(join(spool, name), JSON.stringify({ v: 1, role, file: name.replace(/\.json$/, '.md'), body }));
  return name;
 };
 const wakeFiles = (role) => { try { return readdirSync(wakeDirFor(root, role)).filter(n => n.endsWith('.md')); } catch { return []; } };
 return { base, root, spool, state, spoolWake, wakeFiles, spoolFiles: () => readdirSync(spool) };
};

test('moves coder to wake/, other roles to wake/<role>/, roles.json wakeDir first, then deletes the spool file', () => {
 const s = setup();
 mkdirSync(join(s.root, '.agents/work/l4'), { recursive: true });
 writeFileSync(join(s.root, '.agents/work/l4/roles.json'), JSON.stringify({ roles: [{ id: 'reviewer', names: ['리뷰어'], wakeDir: '.agents/work/l4/wake/reviewer-custom' }, { id: 'writer', wakeDir: '../outside' }] }));
 s.spoolWake('m1', 'coder', '[메신저] 첫 깨움'); s.spoolWake('m1', 'planner'); s.spoolWake('m1', 'reviewer'); s.spoolWake('m1', 'writer');
 const result = moveWakes({ spool: s.spool, root: s.root, state: s.state });
 assert.equal(result.moved.length, 4);
 assert.deepEqual(readdirSync(join(s.root, '.agents/work/l4/wake')).filter(n => n.endsWith('.md')), ['20261108000000000-m1-route-coder.md']);
 assert.equal(readFileSync(join(s.root, '.agents/work/l4/wake/20261108000000000-m1-route-coder.md'), 'utf8'), '[메신저] 첫 깨움');
 assert.deepEqual(s.wakeFiles('planner'), ['20261108000000000-m1-route-planner.md']);
 assert.deepEqual(readdirSync(join(s.root, '.agents/work/l4/wake/reviewer-custom')), ['20261108000000000-m1-route-reviewer.md']);
 // A roles.json wakeDir outside the root is ignored and the default rule applies.
 assert.deepEqual(s.wakeFiles('writer'), ['20261108000000000-m1-route-writer.md']);
 assert.equal(readdirSync(join(s.root, '.agents/work/l4/wake/writer')).length, 1);
 assert.deepEqual(s.spoolFiles(), []);
 rmSync(s.base, { recursive: true, force: true });
});

test('never moves the same wake twice, even when the spool file could not be deleted', () => {
 const s = setup();
 const name = s.spoolWake('m2', 'planner');
 const keep = { remove: () => { throw new Error('EACCES'); } };
 const first = moveWakes({ spool: s.spool, root: s.root, state: s.state, io: keep });
 assert.equal(first.moved.length, 1);
 assert.deepEqual(s.spoolFiles(), [name]);
 // The consumer may clear its wake folder; the ledger still stops a second delivery.
 rmSync(join(wakeDirFor(s.root, 'planner'), name.replace(/\.json$/, '.md')));
 const second = moveWakes({ spool: s.spool, root: s.root, state: s.state });
 assert.equal(second.moved.length, 0);
 assert.deepEqual(s.wakeFiles('planner'), []);
 assert.deepEqual(s.spoolFiles(), []);
 rmSync(s.base, { recursive: true, force: true });
});

test('does not overwrite a wake file that already exists and counts it as moved', () => {
 const s = setup();
 const name = s.spoolWake('m3', 'coder', 'new');
 mkdirSync(wakeDirFor(s.root, 'coder'), { recursive: true });
 writeFileSync(join(wakeDirFor(s.root, 'coder'), name.replace(/\.json$/, '.md')), 'old');
 moveWakes({ spool: s.spool, root: s.root, state: s.state });
 assert.equal(readFileSync(join(wakeDirFor(s.root, 'coder'), name.replace(/\.json$/, '.md')), 'utf8'), 'old');
 assert.deepEqual(s.spoolFiles(), []);
 rmSync(s.base, { recursive: true, force: true });
});

test('keeps the spool file when the wake folder cannot be written and moves it on the next run', () => {
 const s = setup();
 const name = s.spoolWake('m4', 'planner');
 mkdirSync(join(s.root, '.agents/work/l4/wake'), { recursive: true });
 writeFileSync(join(s.root, '.agents/work/l4/wake/planner'), 'not a folder');
 const failed = moveWakes({ spool: s.spool, root: s.root, state: s.state });
 assert.equal(failed.moved.length, 0); assert.equal(failed.kept.length, 1);
 assert.deepEqual(s.spoolFiles(), [name]);
 rmSync(join(s.root, '.agents/work/l4/wake/planner'));
 assert.equal(moveWakes({ spool: s.spool, root: s.root, state: s.state }).moved.length, 1);
 assert.deepEqual(s.wakeFiles('planner'), [name.replace(/\.json$/, '.md')]);
 assert.deepEqual(s.spoolFiles(), []);
 rmSync(s.base, { recursive: true, force: true });
});

test('leaves malformed or mismatched spool files alone', () => {
 const s = setup();
 writeFileSync(join(s.spool, '20261108000000000-m5-route-planner.json'), JSON.stringify({ v: 1, role: 'coder', file: '20261108000000000-m5-route-planner.md', body: 'x' }));
 writeFileSync(join(s.spool, '20261108000000000-m6-route-planner.json'), '{broken');
 writeFileSync(join(s.spool, 'notes.json'), JSON.stringify({ v: 1, role: 'planner', file: 'notes.md', body: 'x' }));
 const result = moveWakes({ spool: s.spool, root: s.root, state: s.state });
 assert.equal(result.moved.length, 0);
 assert.equal(s.spoolFiles().length, 3);
 assert.equal(existsSync(join(s.root, '.agents/work/l4/wake')), false);
 rmSync(s.base, { recursive: true, force: true });
});

test('command line reads, and deletes through sudo -n when asked', () => {
 const s = setup();
 const fake = join(s.base, 'fake-sudo');
 const calls = join(s.base, 'sudo-calls');
 writeFileSync(fake, `#!/bin/sh\necho "$*" >> '${calls}'\n[ "$1" = -n ] || exit 9\nshift\nexec "$@"\n`); chmodSync(fake, 0o755);
 const name = s.spoolWake('m7', 'naia');
 const script = fileURLToPath(new URL('./wake-move.mjs', import.meta.url));
 const run = spawnSync(process.execPath, [script, '--spool', s.spool, '--root', s.root, '--state', s.state, '--sudo'], { env: { ...process.env, MESSENGER_WAKE_MOVE_SUDO: fake }, encoding: 'utf8' });
 assert.equal(run.status, 0, run.stderr);
 assert.deepEqual(s.wakeFiles('naia'), [name.replace(/\.json$/, '.md')]);
 assert.deepEqual(s.spoolFiles(), []);
 const used = readFileSync(calls, 'utf8');
 assert.match(used, /^-n find /m); assert.match(used, /^-n find -P \S+ -maxdepth 0 -type f -size -\d+c -exec cat -- \{\} ;$/m); assert.match(used, /^-n rm -f -- /m);
 assert.doesNotMatch(used, /^-n cat /m);
 rmSync(s.base, { recursive: true, force: true });
});

const fakeSudo = (s) => {
 const fake = join(s.base, 'fake-sudo');
 writeFileSync(fake, `#!/bin/sh\n[ "$1" = -n ] || exit 9\nshift\nexec "$@"\n`); chmodSync(fake, 0o755);
 return fake;
};

test('does not follow a symlink in the spool and never logs file contents, with or without sudo', () => {
 const s = setup();
 const secret = join(s.base, 'secret.txt');
 writeFileSync(secret, 'TOPSECRET-root:$6$abcdef');
 const name = '20261108000000000-m8-route-planner.json';
 symlinkSync(secret, join(s.spool, name));
 const direct = [];
 const first = moveWakes({ spool: s.spool, root: s.root, state: s.state, log: (line) => direct.push(line) });
 assert.equal(first.moved.length, 0);
 const script = fileURLToPath(new URL('./wake-move.mjs', import.meta.url));
 const viaSudo = spawnSync(process.execPath, [script, '--spool', s.spool, '--root', s.root, '--state', join(s.base, 'state2.json'), '--sudo'], { env: { ...process.env, MESSENGER_WAKE_MOVE_SUDO: fakeSudo(s) }, encoding: 'utf8' });
 assert.equal(viaSudo.status, 0, viaSudo.stderr);
 // sudo lists with find -type f, so the link never reaches a read; read itself refuses it too (swap race).
 assert.doesNotMatch(direct.join('\n') + viaSudo.stdout + viaSudo.stderr, /TOPSECRET|root:/);
 assert.match(direct.join('\n'), /형식 아님 .*m8-route-planner\.json: ENOTREG/);
 assert.throws(() => spoolIo(fakeSudo(s)).read(join(s.spool, name)), { code: 'ENOTREG' });
 assert.throws(() => spoolIo(null).read(join(s.spool, name)), { code: 'ENOTREG' });
 assert.equal(existsSync(join(s.root, '.agents/work/l4/wake')), false);
 assert.equal(readFileSync(secret, 'utf8'), 'TOPSECRET-root:$6$abcdef');
 rmSync(s.base, { recursive: true, force: true });
});

test('moves only roles the server writes, read from the same NAIA_MESSENGER_ROLES as messenger-watch.ts', () => {
 const s = setup();
 s.spoolWake('m9', 'zzz');
 const result = moveWakes({ spool: s.spool, root: s.root, state: s.state });
 assert.equal(result.moved.length, 0);
 assert.equal(existsSync(join(s.root, '.agents/work/l4/wake/zzz')), false);
 assert.equal(s.spoolFiles().length, 1);
 // Both sides read NAIA_MESSENGER_ROLES; packages/server/test/messenger-roles.test.ts checks they parse it the same way.
 assert.deepEqual(messengerRoleIds({}), ['naia']);
 assert.deepEqual(messengerRoleIds({ NAIA_MESSENGER_ROLES: 'coder:코더,Bad,coder' }), ['coder']);
 assert.match(readFileSync(fileURLToPath(new URL('../../packages/server/src/messenger-watch.ts', import.meta.url)), 'utf8'), /for \(const role of messengerRoleIds\(\)\)/);
 rmSync(s.base, { recursive: true, force: true });
});

test('logs a malformed spool file once, keeps it on an ignore list, and forgets it once it is gone', () => {
 const s = setup();
 const bad = '20261108000000000-m10-route-planner.json';
 writeFileSync(join(s.spool, bad), '{broken');
 const lines = [];
 const log = (line) => lines.push(line);
 moveWakes({ spool: s.spool, root: s.root, state: s.state, log });
 moveWakes({ spool: s.spool, root: s.root, state: s.state, log });
 moveWakes({ spool: s.spool, root: s.root, state: s.state, log });
 assert.equal(lines.filter((line) => line.includes(bad)).length, 1);
 assert.deepEqual(s.spoolFiles(), [bad]);
 assert.ok(JSON.parse(readFileSync(s.state, 'utf8')).ignored[bad]);
 unlinkSync(join(s.spool, bad));
 moveWakes({ spool: s.spool, root: s.root, state: s.state, log });
 assert.equal(JSON.parse(readFileSync(s.state, 'utf8')).ignored[bad], undefined);
 rmSync(s.base, { recursive: true, force: true });
});

test('still honours a state file in the earlier flat format', () => {
 const s = setup();
 const name = s.spoolWake('m11', 'planner');
 mkdirSync(join(s.base, 'state'), { recursive: true });
 writeFileSync(s.state, JSON.stringify({ [name]: Date.now() }));
 const result = moveWakes({ spool: s.spool, root: s.root, state: s.state });
 assert.equal(result.moved.length, 0);
 assert.deepEqual(s.wakeFiles('planner'), []);
 assert.deepEqual(s.spoolFiles(), []);
 rmSync(s.base, { recursive: true, force: true });
});
