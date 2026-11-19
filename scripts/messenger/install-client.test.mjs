import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { installClient } from './install-client.mjs';

test('installed wake reply command loads its guard and sends only allowed replies', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'messenger-install-'));
  const cli = installClient(join(dir, '.local/lib/naia-messenger'));
  const posted = [];
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify([{id:'free', name:'자유'}]));
    let body = ''; for await (const part of req) body += part;
    posted.push(JSON.parse(body)); res.end('{"id":"sent"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const bodyFile = join(dir, 'reply.md');
  const run = body => new Promise(resolve => {
    writeFileSync(bodyFile, body);
    const child = spawn(process.execPath, [cli, 'post', '자유', 'parent', bodyFile], {
      cwd: dir, env: {...process.env, NAIA_MESSENGER_URL:`http://127.0.0.1:${server.address().port}`, NAIA_MESSENGER_TOKEN:'test'}
    });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    child.on('close', code => resolve({code, stderr}));
  });
  const blocked = await run('철저히 하겠습니다.');
  assert.equal(blocked.code, 1, blocked.stderr);
  assert.equal(posted.length, 0);
  const allowed = await run('확인했습니다.');
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.deepEqual(posted, [{body:'확인했습니다.', reply_to_id:'parent'}]);
});
