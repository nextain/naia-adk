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

test('host submits atomic pane input without agent metadata/model/restart/key commands', async () => {
  const calls = [], deps = hostDependencies({ paneBin: '/generic/herdr', run: (bin, args) => { calls.push([bin, args]); return ''; } });
  await deps.submit({ pane_id: 'w2:p6' }, 'exact\npayload');
  assert.deepEqual(calls, [['/generic/herdr', ['pane', 'run', 'w2:p6', 'exact\npayload']]]);
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

for (const metadata of ['stale-muse', 'unregistered']) {
  test(`existing Codex pane accepts input with ${metadata} agent metadata`, async t => {
    const { spawnSync } = await import('node:child_process');
    const f = await fixture(t), fake = path.join(f.dir, 'fake-herdr.mjs');
    const audit = path.join(f.dir, 'transport-audit.jsonl'), input = path.join(f.dir, 'formatted.txt');
    const config = path.join(f.dir, 'input.json');
    const payload = "정확한 본문 $HOME $(touch should-not-run)\nsecond 'quoted' --wait\n";
    await fs.writeFile(input, payload);
    await fs.writeFile(fake, `#!/usr/bin/env node
      import fs from 'node:fs';
      const args = process.argv.slice(2);
      fs.appendFileSync(process.env.FAKE_AUDIT, JSON.stringify({ method: args.slice(0, 2), count: args.length }) + '\\n');
      if (args[0] === 'agent') {
        console.error(JSON.stringify({ error: { code: process.env.FAKE_METADATA === 'unregistered' ? 'agent_not_found' : 'agent_not_ready' } }));
        process.exit(1);
      }
      if (args[0] === 'pane' && args[1] === 'process-info') {
        console.log(JSON.stringify({ result: { process_info: { foreground_processes: [{ pid: Number(process.env.FAKE_PID), cmdline: '/generic/bin/codex' }] } } }));
      } else if (args[0] === 'pane' && args[1] === 'read') {
        console.log('› Ask Codex to do anything');
      } else if (args[0] === 'pane' && args[1] === 'run') {
        if (args.length !== 4) process.exit(2);
        fs.appendFileSync(process.env.FAKE_NATIVE, JSON.stringify({ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: args[3] }] } }) + '\\n');
        console.log(JSON.stringify({ result: { ok: true } }));
      } else process.exit(2);
    `, { mode: 0o755 });
    await fs.writeFile(config, JSON.stringify({ state_dir: f.dir, pane: { bin: fake }, roles: { writer: { pane_id: 'w2:p6', session: f.session } } }));
    const env = { ...process.env, FAKE_AUDIT: audit, FAKE_METADATA: metadata, FAKE_PID: String(process.pid), FAKE_NATIVE: f.file,
      ADK_WAKE_ATTEMPT: `attempt-${metadata}`, ADK_WAKE_ROLE: 'writer', ADK_WAKE_PANE: 'w2:p6', ADK_WAKE_PAYLOAD_SHA256: payloadHash(payload) };
    const result = spawnSync(process.execPath, ['scripts/role-session-input.mjs', '--config', config, '--role', 'writer', '--file', input], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const answer = JSON.parse(result.stdout);
    assert.equal(answer.reason, 'submitted_ack'); assert.equal(answer.native_user_ack.payload_sha256, payloadHash(payload));
    const calls = (await fs.readFile(audit, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(call => call.method[0] === 'agent').length, 0);
    assert.deepEqual(calls.filter(call => call.method[1] === 'run'), [{ method: ['pane', 'run'], count: 4 }]);
    const log = (await fs.readFile(f.file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(log.at(-1).payload.content[0].text, payload);
  });
}

test('only definite pane API prequeue errors carry a negative transport proof', async () => {
  for (const [code, beforeInput] of [['pane_not_found', true], ['invalid_key', true], ['pane_send_failed', false], ['agent_not_ready', false]]) {
    const error = Object.assign(new Error('private diagnostic body'), { status: 1,
      stderr: JSON.stringify({ error: { code, message: 'private diagnostic body' } }) });
    const deps = hostDependencies({ run: () => { throw error; } });
    await assert.rejects(deps.submit({ pane_id: 'w2:p6' }, 'exact payload'), thrown => {
      assert.equal(thrown.transportCode, code); assert.equal(thrown.beforeInput, beforeInput); return true;
    });
  }
});
