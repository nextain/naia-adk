import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeSnapshot, hostDependencies, main } from './role-session-input.mjs';
import { attemptFile, payloadHash, verifyInput } from './lib/role-session-input.mjs';
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

test('upgrade reconciles a pre-pane receiver attempt only against its original dispatch and native user row', async t => {
  const f = await fixture(t);
  const role = 'writer', pane = 'w4:p5', key = '23232323-2323-4232-8232-232323232323';
  const payload = 'fixture instruction', hash = payloadHash(payload);
  const entry = row('response_item', { role: 'user', content: [{ type: 'input_text', text: payload }] });
  await fs.appendFile(f.file, entry);
  const baseline = await nativeSnapshot(f.session, hash);
  const file = attemptFile(f.dir, role, key);
  const dispatchFile = path.join(f.dir, 'submissions', role + '.json');
  await fs.mkdir(path.dirname(file), { mode: 0o700 });
  await fs.mkdir(path.dirname(dispatchFile), { mode: 0o700 });
  // Previous receivers stored the session and native read boundary here.
  // The pane lived in the dispatcher's separate pending-submission journal.
  const record = { role, source_key: key, thread_id: f.session.thread_id, source_message_id: null,
    source_sha256: null, transport_sha256: hash, payload_hash: hash, status: 'submitted_unconfirmed',
    native_file_id: baseline.file_id, native_after_offset: baseline.byte_size, native_cursor: { offset: baseline.byte_size } };
  const dispatch = { role, pane, attempt: key, sha256: hash, keys: ['original.md'], messageId: null };
  const save = (file, value) => fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  const options = { role, key, transportSha256: hash, stateDir: f.dir, profile: { pane_id: pane, session: f.session } };
  const deps = { inspect: async () => ({ foreground: [{ pid: process.pid, args: 'codex' }], processes: [] }),
    native: (session, digest, _agent, query) => nativeSnapshot(session, digest, query) };
  const verify = () => verifyInput(options, deps);
  await save(file, record);
  await save(dispatchFile, dispatch);
  assert.equal((await verify()).status, 'unknown', 'an older occurrence of the same text cannot settle this attempt');
  const cached = { ...record, status: 'accepted', native_evidence: {
    offset: baseline.byte_size, thread_id: f.session.thread_id, payload_sha256: hash } };
  await save(file, cached);
  assert.equal((await verify()).status, 'unknown', 'legacy cached metadata alone is insufficient');
  await fs.appendFile(f.file, entry);
  await save(file, { ...cached, native_cursor: { offset: (await fs.stat(f.file)).size } });
  assert.equal((await verify()).status, 'accepted', 're-read from the original native boundary even after the cursor advanced');
  await save(file, record);
  const accepted = await verify();
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.evidence.native_user_ack.offset, baseline.byte_size);
  assert.equal((await verify()).receipt, accepted.receipt);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), record);
  for (const changes of [{ pane: 'another-pane' }, { role: 'other' }, { attempt: 'other' }, { sha256: '0'.repeat(64) }]) {
    await save(dispatchFile, { ...dispatch, ...changes });
    assert.equal((await verify()).status, 'unknown');
  }
  await fs.unlink(dispatchFile);
  assert.equal((await verify()).status, 'unknown');
  const otherState = path.join(f.dir, 'dispatcher');
  const otherFile = path.join(otherState, 'submissions', role + '.json');
  await fs.mkdir(path.dirname(otherFile), { recursive: true, mode: 0o700 });
  await save(otherFile, dispatch);
  const split = { ...options, profile: { ...options.profile, active_mentions: { dispatcher_state_dir: otherState } } };
  assert.equal((await verifyInput(split, deps)).receipt, accepted.receipt);
  await save(dispatchFile, dispatch);
  await save(file, { ...record, native_after_offset: undefined });
  assert.equal((await verify()).status, 'unknown');
  await save(file, { ...record, pane_id: 'another-pane' });
  assert.equal((await verify()).status, 'unknown', 'an explicit pane disagreement cannot be migrated');
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

test('an active steer requires a same-turn native user item and reconciles once after restart', async t => {
  const { deliverInput, verifyInput } = await import('./lib/role-session-input.mjs');
  const f = await fixture(t), turn = 'turn-a', profile = { pane_id: 'w2:p6', session: f.session };
  const text = 'Local cross-channel request', key = 'attempt-local';
  const options = { role: 'writer', key, transportSha256: payloadHash(text), profile, stateDir: f.dir };
  const { activeDispatch } = await import('./lib/active-mention.mjs');
  const author = '400000000000000001', message = '200000000000000001';
  profile.bot_id = '100000000000000001';
  profile.active_mentions = { origin_dir: path.join(f.dir, 'gateway'), home_channels: ['300000000000000001'] };
  const proof = { schema: 'discord-human-mention/v1', role: 'writer', bot: profile.bot_id, author, message,
    guild: '500000000000000001', channel: '300000000000000002', wake_sha256: payloadHash(text) };
  await fs.mkdir(path.join(profile.active_mentions.origin_dir, 'writer'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(profile.active_mentions.origin_dir, 'writer', message + '.json'), JSON.stringify(proof), { mode: 0o600 });
  await fs.mkdir(path.join(f.dir, 'submissions'), { mode: 0o700 });
  await fs.writeFile(path.join(f.dir, 'submissions', 'writer.json'), JSON.stringify({ attempt: key, role: 'writer', pane: profile.pane_id,
    messageId: message, sha256: options.transportSha256, gateway_only: true, gateway_wake_sha256: proof.wake_sha256 }));
  const mention = activeDispatch({ state_dir: f.dir, delivery: { priority_user_ids: [author] } }, 'writer', profile, key, text, options.transportSha256);
  assert.deepEqual(mention, proof);
  const item = turnId => row('event_msg', { type: 'item_completed', thread_id: f.session.thread_id, turn_id: turnId,
    item: { type: 'UserMessage', id: 'native-item', content: [{ type: 'text', text }] } });
  await fs.appendFile(f.file, row('event_msg', { type: 'task_started', turn_id: turn }));
  let steers = 0;
  const deps = { now: () => 1, sleep: async () => {},
    inspect: async () => ({ foreground: [{ pid: process.pid, args: 'codex' }], processes: [], screen: '› My own unsent draft' }),
    native: (session, hash, agent, query) => nativeSnapshot(session, hash, query),
    submit: () => assert.fail('active delivery must not touch the composer'),
    steer: async (_profile, expected, input) => {
      assert.equal(expected, turn); assert.equal(input, text); steers++;
      return { method: 'turn/steer', turn_id: turn };
    } };
  const call = (input = {}) => deliverInput({ ...options, text, canonicalAttempt: true, ackTimeoutMs: 0, ...input }, deps);
  assert.equal((await call({ key: 'priority-only', activeMention: proof })).reason, 'screen_busy');
  const pending = await call({ activeMention: mention });
  assert.equal(pending.code, 75); assert.equal(pending.status, 'uncertain');
  assert.equal(JSON.parse(await fs.readFile(pending.attempt_path)).active_transport.turn_id, turn);
  await fs.appendFile(f.file, item('a-different-turn'));
  assert.equal((await verifyInput(options, deps)).status, 'unknown');
  assert.equal((await call({ activeMention: mention })).code, 75);
  await fs.appendFile(f.file, item(turn));
  const accepted = await verifyInput(options, deps);
  assert.equal(accepted.status, 'accepted'); assert.equal(accepted.evidence.native_user_ack.item_id, 'native-item');
  assert.equal(accepted.evidence.native_user_ack.turn_id, turn); assert.equal(steers, 1);
});

test('the protected Unix adapter reads the owning thread and steers only its expected active turn', async t => {
  const { createServer } = await import('node:http');
  const { WebSocketServer } = await import('ws');
  const { steerActiveTurn } = await import('./lib/codex-active-turn.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-turn-'));
  const socket = path.join(dir, 'endpoint'), alias = path.join(dir, 'current');
  const server = createServer();
  const endpoint = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(socket, resolve));
  await fs.chmod(socket, 0o600);
  await fs.symlink(socket, alias);
  t.after(async () => { endpoint.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const thread = { id: 'thread-local', cwd: dir, path: path.join(dir, 'native.jsonl'), status: { type: 'active' } };
  const steers = [];
  endpoint.on('connection', client => client.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.method === 'initialized') return;
    const results = { initialize: {}, 'thread/read': { thread }, 'thread/turns/list': { data: [{ id: 'active-turn', status: 'inProgress' }] } };
    if (message.method === 'turn/steer') {
      steers.push(message.params);
      client.send(JSON.stringify({ id: message.id, result: { turnId: 'active-turn' } }));
    } else {
      assert.ok(Object.hasOwn(results, message.method));
      client.send(JSON.stringify({ id: message.id, result: results[message.method] }));
    }
  }));
  const profile = { active_mentions: { app_server: { socket_path: alias } }, session: { thread_id: thread.id, native_path: thread.path, cwd: dir } };
  assert.equal(await steerActiveTurn(profile, null), 'active-turn');
  await assert.rejects(steerActiveTurn(profile, 'previous-turn', 'keep pending'), { notSubmitted: true });
  const receipt = await steerActiveTurn(profile, 'active-turn', 'current request');
  assert.deepEqual(receipt, { method: 'turn/steer', turn_id: 'active-turn' });
  assert.deepEqual(steers, [{ threadId: thread.id, expectedTurnId: 'active-turn', input: [{ type: 'text', text: 'current request', text_elements: [] }] }]);
});
