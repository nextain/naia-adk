import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cardsToLedger, runCheck, validateWaitCardFields, WAIT_REASONS } from '../.agents/scripts/task-cards.mjs';
import { runHealth } from './session-health.mjs';

const now = Date.parse('2030-01-01T12:00:00Z');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wait-card-regression-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function card(root, role, id, extra = {}, base = join(root, 'docs/common/team/cards')) {
  const dir = join(base, role); mkdirSync(dir, { recursive: true });
  const fields = { id, title: id, owner: role, status: 'waiting', source: 'evt-fixture', received: '2029-12-20T00:00:00Z', moved: '2029-12-20T00:00:00Z', due: '2029-12-21', next: 'review', ...extra };
  writeFileSync(join(dir, `${id}.md`), `---\n${Object.entries(fields).map(([k,v]) => `${k}: ${v}`).join('\n')}\n---\n`);
}
function wakes(root) { try { return readdirSync(join(root, '.agents/work/l4/wake'), { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }

test('external cardsToLedger scans supplied store, writes consumer wake folder and canonical due_at', t => {
  const root = fixture(t), external = join(root, 'external-cards');
  card(root, 'external', 'elapsed', { wait_reason: WAIT_REASONS[3], recheck_at: '2030-01-01T11:00:00Z' }, external);
  const rows = cardsToLedger(root, external, join(root, 'ledger.json'), { now });
  assert.equal(rows[0].due_at, '2030-01-01T11:00:00Z');
  assert.equal('recheck_at' in rows[0], false);
  assert.equal(wakes(root).length, 1); assert.ok(wakes(root).every(f => f.isFile()));
  assert.match(readFileSync(join(root, '.agents/work/l4/wake', wakes(root)[0].name), 'utf8'), /external/);
});

test('central runHealth card store discovers role absent from configured health roles', async t => {
  const root = fixture(t), central = join(root, 'central'), workspace = join(root, 'workspace');
  mkdirSync(workspace); card(central, 'unlisted', 'legacy');
  const snapshot = join(root, 'snapshot.json'); writeFileSync(snapshot, JSON.stringify({ windows: [{ name: 'agent', aiRunning: true, output: 'running' }] }));
  const config = { stateFile: join(root, 'health.json'), reportFile: join(root, 'report.md'), baselineRepo: workspace, baselineSha: 'a'.repeat(40), taskCardsRoot: central, roles: [{ id: 'listed', workspace, window: 'agent', adapter: { kind: 'snapshot', path: snapshot } }] };
  await runHealth(config, { now, dry: true, log: () => {} }); assert.equal(wakes(central).length, 0);
  await runHealth(config, { now, log: () => {} }); assert.equal(wakes(central).length, 1);
  await runHealth(config, { now: now + 1000, log: () => {} }); assert.equal(wakes(central).length, 1);
});

test('37 legacy cards batch once per role, preserve overdue and stale warnings, and deduplicate', t => {
  const root = fixture(t), counts = { rolea: 2, roleb: 9, rolec: 10, roled: 16 };
  for (const [role,count] of Object.entries(counts)) for (let i=0;i<count;i++) card(root, role, `legacy-${i}`);
  card(root, 'rolea', 'stalled-work', { status: 'doing' });
  const problems = runCheck(root, Object.keys(counts), { now });
  assert.equal(problems.filter(p => p.kind === 'legacy-waiting').length, 37);
  assert.ok(problems.some(p => p.kind === 'overdue')); assert.ok(problems.some(p => p.kind === 'stale'));
  assert.equal(wakes(root).length, 4);
  for (const file of wakes(root)) { assert.ok(file.isFile()); const text=readFileSync(join(root, '.agents/work/l4/wake', file.name), 'utf8'); assert.match(text, /done <id>/); assert.match(text, /defer <id>.*--revisit/); }
  runCheck(root, Object.keys(counts), { now: now+1000 }); assert.equal(wakes(root).length, 4);
});

test('direct doing edit reconciles receipt and legacy reentry wakes again', t => {
  const root=fixture(t); card(root, 'rolea', 'legacy'); runCheck(root, ['rolea'], { now }); assert.equal(wakes(root).length, 1);
  card(root, 'rolea', 'legacy', { status: 'doing' }); runCheck(root, ['rolea'], { now: now+1000 });
  const state=JSON.parse(readFileSync(join(root, '.agents/work/task-cards/wait-wake-state.json'), 'utf8')); assert.deepEqual(state.sent, {});
  card(root, 'rolea', 'legacy'); runCheck(root, ['rolea'], { now: now+2000 }); assert.equal(wakes(root).length, 2);
});

test('dated deferred revisit wakes once and deduplicates', t => {
  const root=fixture(t); card(root, 'rolea', 'deferred', { status: 'deferred', defer_reason: 'scheduled review', revisit: '2029-12-31' });
  const problems=runCheck(root, ['rolea'], { now }); assert.ok(problems.some(p => p.kind === 'revisit')); assert.equal(wakes(root).length, 1);
  runCheck(root, ['rolea'], { now: now+1000 }); assert.equal(wakes(root).length, 1);
});

test('waiting rejects timezone-less recheck and valueless request-ref sentinel', () => {
  assert.throws(() => validateWaitCardFields({ waitReason: WAIT_REASONS[3], recheckAt: '2030-01-01T13:00:00', now }), /시간대/);
  assert.throws(() => validateWaitCardFields({ waitReason: WAIT_REASONS[0], recheckAt: '2030-01-01T13:00:00Z', requestRef: 'yes', now }), /request-ref/);
});


test('CLI rejects bare request-ref without changing the card and normalizes explicit offsets', t => {
  const root = fixture(t); card(root, 'rolea', 'request', { status: 'doing' });
  const file = join(root, 'docs/common/team/cards/rolea/request.md');
  const before = readFileSync(file, 'utf8');
  const script = fileURLToPath(new URL('../.agents/scripts/task-cards.mjs', import.meta.url));
  const args = [script, '--root', root, '--now', '2030-01-01T12:00:00Z', 'wait', 'request', '--wait-reason', WAIT_REASONS[0], '--recheck-at', '2030-01-01T22:00:00+09:00', '--request-ref'];
  const denied = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(denied.status, 2); assert.match(denied.stderr, /request-ref/); assert.equal(readFileSync(file, 'utf8'), before);
  for (const ref of ['yes', 'none', '-', '없음']) {
    const rejected = spawnSync(process.execPath, [...args, ref], { encoding: 'utf8' }); assert.equal(rejected.status, 2);
  }
  const accepted = spawnSync(process.execPath, [...args, 'https://example.invalid/request/1'], { encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(readFileSync(file, 'utf8'), /recheck_at: 2030-01-01T13:00:00.000Z/);
});

test('check and ledger interpret legacy timezone-less deadlines with the same UTC policy', t => {
  const root = fixture(t); card(root, 'rolea', 'deadline', { status: 'doing', due: '2030-01-01T13:00' });
  const problems = runCheck(root, ['rolea'], { now, wake: false }); assert.equal(problems.some(p => p.kind === 'overdue'), false);
  const rows = cardsToLedger(root, join(root, 'docs/common/team/cards'), join(root, 'ledger.json'), { now, wake: false });
  assert.equal(Date.parse(rows[0].due_at), Date.parse('2030-01-01T13:00:00Z'));
});

test('all checkouts use configured central wakeRoot and stateFile, never role subdirectories', t => {
  const root = fixture(t), central = join(root, 'consumer'), shared = join(root, 'shared-state.json');
  card(root, 'rolea', 'legacy'); mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'config/task-cards.json'), JSON.stringify({ wakeRoot: central, stateFile: shared, timeZone: 'UTC' }));
  runCheck(root, ['rolea'], { now });
  const files = readdirSync(central, { withFileTypes: true }); assert.equal(files.length, 1); assert.ok(files[0].isFile());
  assert.match(files[0].name, /route-rolea/); assert.equal(Object.keys(JSON.parse(readFileSync(shared)).sent).length, 1);
  runCheck(root, ['rolea'], { now: now + 1000 }); assert.equal(readdirSync(central).length, 1);
});
