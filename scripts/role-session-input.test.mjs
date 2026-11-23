import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeSnapshot, hostDependencies, main } from './role-session-input.mjs';
import { payloadHash } from './lib/role-session-input.mjs';
const row = (type, payload) => JSON.stringify({ type, payload }) + '\n';
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-native-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const cwd = await fs.readlink(`/proc/${process.pid}/cwd`), stat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
  const session = { kind: 'codex-jsonl', pid: process.pid, process_start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], thread_id: 'own-thread', native_path: file, cwd };
  await fs.writeFile(file, row('session_meta', { id: 'own-thread', cwd }) + row('event_msg', { type: 'task_complete' }));
  return { dir, file, session };
}

test('native new user ACK has byte offset and session/process binding', async t => {
  const f = await fixture(t), first = await nativeSnapshot(f.session, payloadHash('message'));
  await fs.appendFile(f.file, row('response_item', { role: 'user', content: [{ type: 'input_text', text: 'message' }] }));
  const after = await nativeSnapshot(f.session, payloadHash('message'), { cursor: { offset: first.byte_size }, file_id: first.file_id });
  assert.equal(after.ack.offset, first.byte_size); assert.equal(after.ack.thread_id, 'own-thread'); assert.equal(after.process_start, f.session.process_start);
});

test('split append preserves incomplete user line and later finds ACK', async t => {
  const f = await fixture(t), first = await nativeSnapshot(f.session, payloadHash('message'));
  const text = row('response_item', { role: 'user', content: [{ type: 'input_text', text: 'message' }] });
  await fs.appendFile(f.file, text.slice(0, 30));
  const partial = await nativeSnapshot(f.session, payloadHash('message'), { cursor: { offset: first.byte_size } });
  assert.equal(partial.next_cursor.offset, first.byte_size); assert.equal(partial.ack, null);
  await fs.appendFile(f.file, text.slice(30));
  const complete = await nativeSnapshot(f.session, payloadHash('message'), { cursor: partial.next_cursor });
  assert.equal(complete.ack.offset, first.byte_size);
});

test('large log uses bounded tail, unknown state recovers on new complete', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.file, row('event_msg', { type: 'task_started' }));
  const filler = row('response_item', { role: 'assistant', content: 'x'.repeat(2048) });
  await fs.appendFile(f.file, filler.repeat(1500));
  const before = await nativeSnapshot(f.session, 'not-matching');
  assert.equal(before.state, 'unknown'); assert.ok(before.bytes_read <= 576 * 1024);
  await fs.appendFile(f.file, row('event_msg', { type: 'task_complete' }));
  const after = await nativeSnapshot(f.session, 'not-matching');
  assert.equal(after.state, 'idle'); assert.ok(after.bytes_read <= 576 * 1024);
});

test('symlink, rotated and truncated native files are rejected', async t => {
  const f = await fixture(t), before = await nativeSnapshot(f.session, 'none');
  const link = path.join(f.dir, 'link'); await fs.symlink(f.file, link);
  assert.equal((await nativeSnapshot({ ...f.session, native_path: link }, 'none')).error, 'native_symlink');
  await fs.rename(f.file, f.file + '.old'); await fs.copyFile(f.file + '.old', f.file);
  assert.equal((await nativeSnapshot(f.session, 'none', { file_id: before.file_id })).error, 'native_rotated');
  assert.equal((await nativeSnapshot(f.session, 'none', { cursor: { offset: before.byte_size + 100 } })).error, 'native_truncated');
});

test('overlarge unfinished native record is explicit and never skipped', async t => {
  const f = await fixture(t), before = await nativeSnapshot(f.session, 'none');
  await fs.appendFile(f.file, 'x'.repeat(600 * 1024));
  const after = await nativeSnapshot(f.session, 'none', { cursor: { offset: before.byte_size } });
  assert.equal(after.error, 'native_record_too_large'); assert.equal(after.next_cursor.offset, before.byte_size);
});

test('host submits supported atomic prompt without model/restart/key commands', async () => {
  const calls = [], deps = hostDependencies({ paneBin: '/generic/herdr', run: (bin, args) => { calls.push([bin, args]); return ''; } });
  await deps.submit({ pane_id: 'w2:p6' }, 'exact\npayload');
  assert.deepEqual(calls, [['/generic/herdr', ['agent', 'prompt', 'w2:p6', 'exact\npayload', '--wait', '--until', 'working', '--timeout', '5000']]]);
});

test('CLI uses dispatcher canonical attempt and verify projection', async t => {
  const f = await fixture(t), config = path.join(f.dir, 'config.json'), input = path.join(f.dir, 'input.txt');
  await fs.writeFile(config, JSON.stringify({ state_dir: f.dir, roles: { writer: { pane_id: 'w2:p6', session: f.session } } }));
  await fs.writeFile(input, 'exact payload');
  let submitted = 0;
  const deps = { now: () => 0, sleep: async () => {}, inspect: async () => ({ foreground: [{ pid: process.pid, args: 'codex' }], processes: [], screen: '› Ask Codex to do anything' }),
    native: async (_s, hash) => ({ ...await nativeSnapshot(f.session, hash), ...(submitted ? { ack: { offset: 999, thread_id: 'own-thread', payload_sha256: hash } } : {}) }), submit: async () => { submitted++; } };
  const env = { ADK_WAKE_ATTEMPT: 'canonical-attempt', ADK_WAKE_PAYLOAD_SHA256: 'raw-dispatch-hash', ADK_WAKE_ROLE: 'writer', ADK_WAKE_PANE: 'w2:p6' };
  assert.equal(await main(['--config', config, '--file', input], deps, env), 0);
  assert.equal(await main(['verify', '--config', config], deps, env), 0); assert.equal(submitted, 1);
  await assert.rejects(main(['verify', '--config', config], deps, { ...env, ADK_WAKE_PANE: 'other' }), /binding differs/);
});

test('probe never submits or creates attempt state for a busy native session', async t => {
  const f = await fixture(t), config = path.join(f.dir, 'config.json');
  await fs.writeFile(config, JSON.stringify({ state_dir: f.dir, roles: { writer: { pane_id: 'w2:p6', session: f.session } } }));
  const deps = { inspect: async () => ({ foreground: [{ pid: process.pid, args: 'codex' }], processes: [], screen: '• Working (2m • esc\n› Ask Codex to do anything' }),
    native: async () => ({ ...await nativeSnapshot(f.session, ''), state: 'active' }), submit: async () => assert.fail('must not submit') };
  assert.equal(await main(['probe', '--config', config, '--role', 'writer'], deps, {}), 75);
  assert.equal((await fs.readdir(f.dir)).includes('role-input'), false);
});

test('readonly verify traverses beyond its first bounded window to fixed EOF', async t => {
  const { deliverInput, verifyInput, attemptFile } = await import('./lib/role-session-input.mjs');
  const f = await fixture(t), profile = { pane_id: 'w2:p6', session: f.session };
  let submitted = 0;
  const deps = { now: () => 0, sleep: async () => {},
    inspect: async () => ({ foreground: [{ pid: process.pid, args: 'codex' }], processes: [], screen: '› Ask Codex to do anything' }),
    native: (session, hash, agent, query) => nativeSnapshot(session, hash, query), submit: async () => { submitted++; } };
  const options = { role: 'writer', key: 'fixed-attempt', transportSha256: 'raw-hash', profile, stateDir: f.dir };
  assert.equal((await deliverInput({ ...options, text: 'user payload', ackTimeoutMs: 0 }, deps)).code, 75);
  await fs.appendFile(f.file, row('response_item', { role: 'assistant', content: 'x'.repeat(700) }).repeat(1200));
  await fs.appendFile(f.file, row('response_item', { role: 'user', content: [{ type: 'input_text', text: 'user payload' }] }));
  const record = attemptFile(f.dir, 'writer', 'fixed-attempt'), before = await fs.readFile(record, 'utf8');
  const verified = await verifyInput(options, deps);
  assert.equal(verified.status, 'accepted'); assert.equal(submitted, 1);
  assert.match(verified.receipt, /^codex-jsonl:own-thread:/);
  assert.equal(await fs.readFile(record, 'utf8'), before);
});

test('native child reads inherited pipe fd without reopening /dev/stdin', async t => {
  const f = await fixture(t);
  const deps = hostDependencies();
  const answer = await deps.native({ ...f.session, read_prefix: ['/usr/bin/env'] }, 'none', null);
  assert.equal(answer.error, undefined); assert.equal(answer.thread_id, 'own-thread');
});
