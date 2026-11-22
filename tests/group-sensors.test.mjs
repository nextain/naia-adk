import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadGroup, validateSensorConfig, pollGroup, diagnoseGroup, recoverGroup } from '../scripts/lib/group-sensors.mjs';
const now = Date.now();
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-sensors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'workspace'));
  const config = { enabled: true, authority: { instance_id: 'primary' }, state_directory: 'state',
    messenger: { unanswered_seconds: 1800, routes: [{ id: 'room-a', server_ref: 'server-a', role: 'developer' }, { id: 'room-b', server_ref: 'server-b', role: 'support' }] },
    mail: { metadata_only: true, agent_sender_refs: ['agent-sender'], sources: [{ id: 'mail-a', kind: 'mailbox', resource_ref: 'inbox-a', role: 'developer' }, { id: 'mail-b', kind: 'group', resource_ref: 'group-a', role: 'support' }] },
    sessions: [{ id: 'session', workspace: 'workspace', expected_account_ref: 'account', recovery_actions: ['enable_wait'] }] };
  const wakes = []; const effects = [];
  const adapter = { readMessages: async () => [], readMailHeaders: async () => [], wake: async r => wakes.push(r),
    readSessionStatus: async () => ({ workspace: path.join(root, 'workspace'), account_ref: 'account', sensor_at: now, input_pending: true, wait_enabled: false, alive: true }),
    recover: async r => effects.push(r) };
  return { root, config, adapter, wakes, effects };
}
test('opt-in manifest, configuration and local paths', async t => {
  const { root, config, adapter } = fixture(t);
  fs.writeFileSync(path.join(root, 'sensors.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(root, 'adk.json'), JSON.stringify({ kind: 'group', group_config: { agents: [{ role: 'developer' }, { role: 'support' }], operations: { sensors_file: 'sensors.json' } } }));
  assert.equal(loadGroup(root).enabled, true);
  assert.throws(() => validateSensorConfig({ ...config, mail: { ...config.mail, metadata_only: false } }), /metadata_only/);
  assert.throws(() => validateSensorConfig(config, ['unknown']), /route/);
  config.enabled = false;
  assert.deepEqual(await pollGroup(root, config, 'other', adapter), { disabled: true, delivered: 0 });
  assert.equal(fs.existsSync(path.join(root, 'state')), false);
  config.enabled = true;
  config.sessions[0].workspace = '../escape';
  fs.writeFileSync(path.join(root, 'sensors.json'), JSON.stringify(config));
  assert.throws(() => loadGroup(root), /Unsafe/);
});
test('multiple servers, 30 minute and two hour boundaries, team replies and restart dedup', async t => {
  const { root, config, adapter, wakes } = fixture(t);
  adapter.readMessages = async ({ route }) => [
    { id: 'shared', at: now - 1800000, human: true },
    { id: 'young', at: now - 1799999, human: true },
    { id: 'expired', at: now - 7200001, human: true },
    { id: 'mention', at: now - 7200000, bot_mentioned: true },
    { id: 'bot-chatter', at: now - 7200001, team_bot: true },
    ...(route.id === 'room-b' ? [{ id: 'answer', at: now - 1, team_bot: true }] : []),
  ];
  assert.equal((await pollGroup(root, config, 'primary', adapter, now)).delivered, 2);
  assert.deepEqual(wakes.map(w => w.message_id).sort(), ['mention', 'shared']);
  assert.ok(wakes.every(w => w.source_ref === 'server-a'));
  assert.equal((await pollGroup(root, config, 'primary', adapter, now)).delivered, 0);
  adapter.readMessages = async () => [{ id: 'same-id', at: now - 1800000, human: true }];
  assert.equal((await pollGroup(root, config, 'primary', adapter, now)).delivered, 2);
});
test('mail headers only, opaque provider IDs, sender filter, two resources and durable retry', async t => {
  const { root, config, adapter, wakes } = fixture(t);
  let fail = true;
  adapter.readMailHeaders = async request => {
    assert.deepEqual(request.fields, ['id', 'sender_ref', 'subject', 'received_at']);
    return [
      { id: 'opaque+/=', sender_ref: 'external-sender', subject: 'Task', received_at: now },
      { id: 'agent-mail', sender_ref: 'agent-sender', subject: 'Agent task', received_at: now },
      { id: 'old', sender_ref: 'external-sender', subject: 'Old', received_at: now - 7200001 },
    ];
  };
  adapter.wake = async r => { wakes.push(r); if (fail) throw new Error('retry'); };
  await assert.rejects(pollGroup(root, config, 'primary', adapter, now), /retry/);
  const first = wakes[0].requestId;
  fail = false;
  assert.equal((await pollGroup(root, config, 'primary', adapter, now)).delivered, 2);
  assert.equal(wakes[1].requestId, first);
  assert.equal(wakes[1].subject, 'Task');
  assert.equal(wakes[1].sender_ref, 'external-sender');
  assert.equal(wakes[1].message_id, 'opaque+/=');
  assert.equal(new Set(wakes.map(w => w.requestId)).size, 2);
  assert.equal((await pollGroup(root, config, 'primary', adapter, now)).delivered, 0);
});
test('failed messenger delivery resolves on later team response and expires after two hours', async t => {
  const { root, config, adapter, wakes } = fixture(t);
  config.messenger.routes = [config.messenger.routes[0]];
  adapter.readMessages = async () => [{ id: 'request', at: now - 1800000, human: true }];
  adapter.wake = async () => { throw new Error('offline'); };
  await assert.rejects(pollGroup(root, config, 'primary', adapter, now));
  adapter.readMessages = async () => [{ id: 'request', at: now - 1800000, human: true }, { id: 'reply', at: now, team_bot: true }];
  adapter.wake = async r => wakes.push(r);
  assert.equal((await pollGroup(root, config, 'primary', adapter, now)).delivered, 0);
  adapter.readMessages = async () => [{ id: 'request-2', at: now - 1800000, human: true }];
  adapter.wake = async () => { throw new Error('offline'); };
  await assert.rejects(pollGroup(root, config, 'primary', adapter, now));
  adapter.readMessages = async () => [];
  assert.equal((await pollGroup(root, config, 'primary', adapter, now + 7200001)).delivered, 0);
});
test('authority and concurrent lock fail closed; read-only diagnosis creates no files', async t => {
  const { root, config, adapter } = fixture(t);
  const before = fs.readdirSync(root);
  const result = await diagnoseGroup(root, config, adapter, now);
  assert.deepEqual(fs.readdirSync(root), before);
  assert.equal(result.sessions[0].checks.workspace_matches, true);
  assert.equal(result.sessions[0].checks.input_clear, false);
  await assert.rejects(pollGroup(root, config, 'standby', adapter, now), /authority/);
  fs.mkdirSync(path.join(root, 'state'));
  fs.writeFileSync(path.join(root, 'state/authority.lock'), 'owner');
  await assert.rejects(pollGroup(root, config, 'primary', adapter, now), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(root, 'state/authority.lock'), 'utf8'), 'owner');
});
test('recovery requires allowlist, matching identity, explicit apply and observes result', async t => {
  const { root, config, adapter, effects } = fixture(t);
  await assert.rejects(recoverGroup(root, config, 'primary', adapter, 'session', 'restart_sensor', true), /allowlist/);
  const preview = await recoverGroup(root, config, 'primary', adapter, 'session', 'enable_wait');
  assert.equal(preview.planned, 'enable_wait');
  assert.equal(effects.length, 0);
  assert.equal(fs.existsSync(path.join(root, 'state')), false);
  assert.equal((await recoverGroup(root, config, 'primary', adapter, 'session', 'enable_wait', true)).applied, 'enable_wait');
  assert.equal(effects.length, 1);
  adapter.readSessionStatus = async () => ({ workspace: path.join(root, 'workspace'), account_ref: 'other' });
  await assert.rejects(recoverGroup(root, config, 'primary', adapter, 'session', 'enable_wait', true), /mismatch/);
  assert.equal(effects.length, 1);
});
test('symlink escape and corrupt persistent state fail closed', async t => {
  const { root, config, adapter } = fixture(t);
  fs.symlinkSync(os.tmpdir(), path.join(root, 'state'));
  await assert.rejects(pollGroup(root, config, 'primary', adapter, now), /escapes/);
  fs.unlinkSync(path.join(root, 'state'));
  fs.mkdirSync(path.join(root, 'state'));
  fs.writeFileSync(path.join(root, 'state/state.json'), '{');
  await assert.rejects(pollGroup(root, config, 'primary', adapter, now), SyntaxError);
  assert.equal(fs.existsSync(path.join(root, 'state/authority.lock')), false);
});
test('CLI loads group manifest and trusted adapter for opt-in poll, diagnose and recovery', t => {
  const { root, config } = fixture(t);
  fs.writeFileSync(path.join(root, 'sensors.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(root, 'adk.json'), JSON.stringify({ kind: 'group', group_config: { agents: [{ role: 'developer' }, { role: 'support' }], operations: { sensors_file: 'sensors.json' } } }));
  const adapter = path.join(root, 'adapter.mjs');
  fs.writeFileSync(adapter, `import fs from 'node:fs'; export default { readMessages: async () => [], readMailHeaders: async () => [{id:'opaque=',sender_ref:'external',subject:'Task',received_at:Date.now()-1000}], wake: async r => fs.appendFileSync(new URL('./wakes.jsonl', import.meta.url), JSON.stringify(r)+'\\n'), readSessionStatus: async ({workspace}) => ({workspace, account_ref:'account',sensor_at:Date.now(),input_pending:false,wait_enabled:true,alive:true}), recover: async () => {} };`);
  const run = (...args) => spawnSync(process.execPath, ['scripts/group-sensors.mjs', ...args], { encoding: 'utf8' });
  const poll = run('poll', root, adapter, 'primary');
  assert.equal(poll.status, 0, poll.stderr);
  assert.equal(JSON.parse(poll.stdout).delivered, 2);
  assert.equal(run('poll', root, adapter, 'primary').status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'wakes.jsonl'), 'utf8').trim().split('\n').length, 2);
  assert.equal(run('diagnose', root, adapter).status, 0);
  assert.equal(run('recover', root, adapter, 'primary', 'session', 'enable_wait', '--apply').status, 0);
});
