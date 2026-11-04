import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const args of [[], ['ai-agent', 'roles.json'], ['ai-agent', 'roles.json', 'issuer.json']]) {
  test(`installer refuses before any privileged work: ${JSON.stringify(args)}`, () => {
    const result = spawnSync('/bin/bash', ['scripts/install-approved-runner.sh', ...args], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Installation refused: Discord issuer is not implemented/);
    assert.equal(result.stdout, '');
  });
}
