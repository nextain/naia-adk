import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { startWorkNowBoard } from './work-now-board.mjs';

const root = process.env.WORK_NOW_TEST_TMP ?? join(tmpdir(), 'work-now-board-test');
const row = (id, role, status, task) => ({ id, role, status, task, requested_at: '2020-01-01T00:00:00Z', due_at: null, evidence: 'private evidence', result: status === '끝' ? 'done' : null, updated_at: '2020-01-01T00:00:00Z' });
async function fixture() {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'board-'));
  const ledgerPath = join(dir, 'work.json');
  const data = { version: 1, work: [row('a', 'role-a', '진행 중', '<script>alert("x")</script>'), row('b', 'role-b', '진행 중', 'Second role'), row('c', 'role-a', '막힘', 'Blocked'), row('d', 'role-a', '끝', 'Completed'), row('e', 'role-c', '대기', 'Pending')] };
  await writeFile(ledgerPath, JSON.stringify(data));
  const instance = await startWorkNowBoard({ ledgerPath });
  return { ledgerPath, data, ...instance };
}
function get(port, path = '/', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', part => { body += part; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}
const authorization = password => `Basic ${Buffer.from(`board:${password}`).toString('base64')}`;

test('private authenticated board uses the current ledger, escapes HTML and groups open work', async t => {
  const f = await fixture(); t.after(() => new Promise(resolve => f.server.close(resolve)));
  const before = await readFile(f.ledgerPath, 'utf8');
  assert.equal((await get(f.port)).status, 401);
  assert.equal((await get(f.port, '/', { authorization: authorization('wrong') })).status, 401);
  const auth = { authorization: authorization(f.password) };
  assert.equal((await get(f.port, '/', { ...auth, host: `attacker.example:${f.port}` })).status, 403);
  assert.equal((await get(f.port, '/', { ...auth, 'x-forwarded-for': '127.0.0.1' })).status, 403);
  assert.equal((await get(f.port, '/', { ...auth, 'sec-fetch-site': 'cross-site' })).status, 403);
  const html = await get(f.port, '/', auth);
  assert.equal(html.status, 200); assert.match(html.headers['cache-control'], /no-store/); assert.match(html.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(html.body, /&lt;script&gt;/); assert.doesNotMatch(html.body, /<script>/); assert.match(html.body, /role-a/); assert.match(html.body, /role-b/); assert.doesNotMatch(html.body, /role-c|막힘|Pending/); assert.doesNotMatch(html.body, /Completed|private evidence/);
  const json = await get(f.port, '/api/work', auth); const data = JSON.parse(json.body);
  assert.deepEqual(data.work.map(r => r.id), ['a', 'b']); assert.equal(data.work[0].task, '<script>alert("x")</script>'); assert.equal('evidence' in data.work[0], false);
  assert.equal(await readFile(f.ledgerPath, 'utf8'), before);
  f.data.work[0].task = 'Updated'; await writeFile(f.ledgerPath, JSON.stringify(f.data));
  assert.match((await get(f.port, '/', auth)).body, /Updated/);
  await writeFile(f.ledgerPath, 'invalid');
  const failed = await get(f.port, '/', auth); assert.equal(failed.status, 503); assert.doesNotMatch(failed.body, /work\.json|Updated/);
});

test('startup requires a valid explicit ledger', async () => {
  await assert.rejects(startWorkNowBoard({}), /ledger path required/);
  await assert.rejects(startWorkNowBoard({ ledgerPath: join(root, 'missing') }));
});

// Exercise an OS-assigned low ephemeral port without binding any fixed port.
test('accepts a low OS-assigned ephemeral port', async t => {
  const f = await fixture(); t.after(() => new Promise(resolve => f.server.close(resolve)));
  let bind;
  const fake = {
    once() { return this; },
    listen(port, host, ready) { bind = { port, host }; queueMicrotask(ready); },
    address() { return { port: 24000 }; },
  };
  const mock = t.mock.method(http, 'createServer', () => fake);
  const board = await startWorkNowBoard({ ledgerPath: f.ledgerPath });
  assert.deepEqual(bind, { port: 0, host: '127.0.0.1' });
  assert.equal(board.port, 24000);
  mock.mock.restore();
});
