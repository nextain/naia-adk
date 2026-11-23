import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attemptFile, deliverInput, payloadHash, resolveAgentProcess, screenState, verifyInput } from './role-session-input.mjs';

const idle = 'Finished working on the report.\n› Ask Codex to do anything\n  GPT-6\n';
const profile = { pane_id: 'w9:p7', session: { kind: 'codex-jsonl', pid: 42, process_start: '111', thread_id: 'thread-a', native_path: '/instance-a/session.jsonl', cwd: '/instance-a' } };
const snapshot = () => ({ process_start: '111', process_cwd: '/instance-a', thread_id: 'thread-a', cwd: '/instance-a', state: 'idle', file_id: '1:2', byte_size: 100, next_cursor: { offset: 100 } });
async function harness(t) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-input-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  let clock = 0, submitted = 0;
  const h = { stateDir, screen: idle, state: snapshot(), ackOnSubmit: true,
    deps: { now: () => clock, sleep: async ms => { clock += ms; },
      inspect: async () => ({ foreground: [{ pid: 42, args: 'codex' }], processes: [], screen: h.screen }),
      native: async (_session, hash) => ({ ...h.state, ...(submitted && h.ackOnSubmit ? { ack: { offset: 110, at: 'now', thread_id: 'thread-a', payload_sha256: hash } } : {}) }),
      submit: async () => { submitted++; } },
    call: (options = {}) => deliverInput({ role: 'author', key: 'source-a', text: 'hello', sourceSha256: 'sourcehash', transportSha256: 'transporthash', profile, stateDir, ackTimeoutMs: 0, ...options }, h.deps),
    count: () => submitted,
  };
  return h;
}

test('wrapped placeholder and long footer; ordinary working prose stays idle', () => {
  assert.equal(screenState('Finished working.\n› Ask Codex to do\n  anything\n────────────────\n' + 'footer\n'.repeat(20)), 'idle');
  assert.equal(screenState('◈ Double checking (16s ·\n❯ /usage shows this\n──────'), 'busy');
  assert.equal(screenState('• Compacting context (50s • esc\n› Ask Codex to do anything'), 'busy');
  assert.equal(screenState('› human draft\n  continued\n──────'), 'draft');
  assert.equal(screenState('no prompt'), 'unknown');
});

test('nearest executable through transparent wrappers, never argument text', () => {
  assert.equal(resolveAgentProcess([{ pid: 1, args: 'sudo -u another bash' }], [{ pid: 2, ppid: 1, args: 'bash -lc agent' }, { pid: 3, ppid: 2, args: '/opt/bin/codex' }]).pid, 3);
  assert.equal(resolveAgentProcess([{ pid: 1, args: 'python task.py codex' }], []), null);
});

test('idle input yields matching new native ACK; receipt contains no body', async t => {
  const h = await harness(t), result = await h.call();
  assert.equal(result.code, 0); assert.equal(result.native_user_ack.offset, 110); assert.equal(h.count(), 1);
  assert.equal((await fs.readFile(result.attempt_path, 'utf8')).includes('hello'), false);
});

test('busy pre-submit payload may change and then submit exactly once', async t => {
  const h = await harness(t); h.screen = '• Working (2m • esc\n› Ask Codex to do anything';
  assert.equal((await h.call()).reason, 'screen_busy'); assert.equal(h.count(), 0);
  h.screen = idle;
  const result = await h.call({ text: 'updated work header' });
  assert.equal(result.code, 0); assert.equal(result.payload_sha256, payloadHash('updated work header')); assert.equal(h.count(), 1);
});

test('human draft is deferred without any submission', async t => {
  const h = await harness(t); h.screen = '› please keep my draft\n──────';
  assert.equal((await h.call()).reason, 'draft'); assert.equal(h.count(), 0);
});

test('old identical native ACK cannot acknowledge a new attempt', async t => {
  const h = await harness(t); h.ackOnSubmit = false;
  h.state.ack = { offset: 30, thread_id: 'thread-a', payload_sha256: payloadHash('hello') };
  assert.equal((await h.call()).code, 75); assert.equal(h.count(), 1);
});

test('uncertain attempt reconciles old payload despite newly formatted header', async t => {
  const h = await harness(t); h.ackOnSubmit = false;
  assert.equal((await h.call()).status, 'uncertain');
  h.state.ack = { offset: 110, at: 'later', thread_id: 'thread-a', payload_sha256: payloadHash('hello') };
  const result = await h.call({ text: 'new header and context' });
  assert.equal(result.code, 0); assert.equal(h.count(), 1); assert.equal(result.payload_sha256, payloadHash('hello'));
});

test('uncertain retry never repeats paste and records native pending', async t => {
  const h = await harness(t); h.ackOnSubmit = false;
  await h.call(); assert.equal((await h.call()).reason, 'native_ack_pending'); assert.equal(h.count(), 1);
});

for (const [field, value, reason] of [['thread_id', 'another', 'thread_mismatch'], ['cwd', '/other', 'cwd_mismatch'], ['process_start', '222', 'process_mismatch']]) {
  test(`reject ${field} mismatch without submit`, async t => {
    const h = await harness(t); h.state[field] = value;
    assert.equal((await h.call()).reason, reason); assert.equal(h.count(), 0);
  });
}

test('another installation uses distinct configured pane/PID/thread/cwd', async t => {
  const h = await harness(t), other = { pane_id: 'w3:p8', session: { ...profile.session, pid: 84, process_start: '333', thread_id: 'thread-b', cwd: '/installation-b' } };
  h.deps.inspect = async () => ({ foreground: [{ pid: 84, args: 'codex' }], processes: [], screen: idle });
  h.state = { ...snapshot(), process_start: '333', process_cwd: '/installation-b', cwd: '/installation-b', thread_id: 'thread-b' };
  h.deps.native = async (_s, hash) => ({ ...h.state, ...(h.count() ? { ack: { offset: 110, thread_id: 'thread-b', payload_sha256: hash } } : {}) });
  assert.equal((await h.call({ profile: other })).code, 0);
});

for (const stale of ['', '{torn', JSON.stringify({ pid: 2147483647, start: 'x' }), JSON.stringify({ pid: process.pid, start: 'recycled' })]) {
  test(`stale lock recovers ${JSON.stringify(stale)}`, async t => {
    const h = await harness(t), dir = path.join(h.stateDir, 'role-input', 'author');
    await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'deliver.lock'), stale);
    assert.equal((await h.call()).code, 0); assert.equal(h.count(), 1);
  });
}

test('live lock defers another receiver', async t => {
  const h = await harness(t), { acquireLock } = await import('../role-wake.mjs');
  const release = acquireLock({ stateDir: path.join(h.stateDir, 'role-input', 'author') });
  try { assert.equal((await h.call()).reason, 'receiver_locked'); assert.equal(h.count(), 0); } finally { release(); }
});

test('readonly verify projects canonical dispatcher attempt and native receipt', async t => {
  const h = await harness(t); await h.call();
  const file = attemptFile(h.stateDir, 'author', 'source-a'), before = await fs.readFile(file, 'utf8');
  const result = await verifyInput({ role: 'author', key: 'source-a', transportSha256: 'transporthash', profile, stateDir: h.stateDir }, h.deps);
  assert.equal(result.status, 'accepted'); assert.equal(result.attempt, 'source-a'); assert.equal(result.sha256, 'transporthash');
  assert.equal(result.evidence.payload_sha256, payloadHash('hello')); assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal((await verifyInput({ role: 'author', key: 'source-a', transportSha256: 'wrong', profile, stateDir: h.stateDir }, h.deps)).code, 75);
});

test('foreign native ACK and wrong process id cannot acknowledge input', async t => {
  const h = await harness(t); h.ackOnSubmit = false;
  h.state.ack = { offset: 110, thread_id: 'foreign', payload_sha256: payloadHash('hello') };
  assert.equal((await h.call()).code, 75);
  h.deps.inspect = async () => ({ foreground: [{ pid: 43, args: 'codex' }], processes: [], screen: idle });
  assert.equal((await h.call()).reason, 'process_mismatch'); assert.equal(h.count(), 1);
});

test('payload hashing preserves actual bytes including CRLF', () => {
  assert.notEqual(payloadHash('a\r\nb'), payloadHash('a\nb'));
});

test('missing journal is unknown rather than negative submission proof', async t => {
  const h = await harness(t);
  const answer = await verifyInput({ role: 'author', key: 'missing', transportSha256: 'transporthash', profile, stateDir: h.stateDir }, h.deps);
  assert.equal(answer.status, 'unknown'); assert.equal(answer.code, 75); assert.equal(answer.reason, 'attempt_unrecorded');
});

test('canonical not-submitted is terminal; fresh attempt can resume safely', async t => {
  const h = await harness(t); h.screen = '• Working (2m • esc\n› Ask Codex to do anything';
  const options = { role: 'author', key: 'source-a', transportSha256: 'transporthash', profile, stateDir: h.stateDir };
  await h.call({ canonicalAttempt: true });
  assert.equal((await verifyInput(options, h.deps)).status, 'rejected');
  h.screen = idle;
  assert.equal((await h.call({ canonicalAttempt: true })).reason, 'attempt_terminal');
  assert.equal((await verifyInput(options, h.deps)).status, 'rejected'); assert.equal(h.count(), 0);
  assert.equal((await h.call({ canonicalAttempt: true, key: 'fresh-attempt' })).code, 0); assert.equal(h.count(), 1);
});

test('legacy fresh retry is allowed but cannot issue terminal negative proof', async t => {
  const h = await harness(t); h.screen = '› human draft';
  await h.call();
  const answer = await verifyInput({ role: 'author', key: 'source-a', transportSha256: 'transporthash', profile, stateDir: h.stateDir }, h.deps);
  assert.equal(answer.status, 'unknown'); assert.equal(answer.reason, 'legacy_nonterminal_attempt');
  h.screen = idle; assert.equal((await h.call()).code, 0); assert.equal(h.count(), 1);
});

test('concurrent verification during preflight never reports rejected on either installation', async t => {
  for (const suffix of ['one', 'two']) {
    const h = await harness(t), paneProfile = { ...profile, pane_id: `instance-${suffix}:pane` };
    let unblock, entered;
    const gate = new Promise(resolve => { unblock = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const original = h.deps.inspect;
    h.deps.inspect = async current => { entered(); await gate; return original(current); };
    const delivery = h.call({ profile: paneProfile, canonicalAttempt: true });
    await started;
    const options = { role: 'author', key: 'source-a', transportSha256: 'transporthash', profile: paneProfile, stateDir: h.stateDir };
    const during = await verifyInput(options, h.deps);
    assert.equal(during.status, 'unknown'); assert.equal(during.code, 75); assert.equal(during.reason, 'receiver_locked');
    unblock(); assert.equal((await delivery).code, 0);
    assert.equal((await verifyInput(options, h.deps)).status, 'accepted'); assert.equal(h.count(), 1);
  }
});
