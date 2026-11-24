import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const READMES = ['README.md', 'README.ko.md', 'README.ja.md', 'README.zh-CN.md'];
const SIBLINGS = [
  'https://github.com/nextain/naia-shell',
  'https://github.com/nextain/naia-agent',
  'https://github.com/nextain/naia-memory',
  'https://github.com/nextain/naia-kb-compiler',
];

for (const file of READMES) {
  test(`${file} has no legacy naia-os links`, () => {
    const body = readFileSync(join(root, file), 'utf8');
    assert.ok(
      !body.includes('github.com/nextain/naia-os'),
      `${file} still links to the legacy naia-os repository`,
    );
  });

  test(`${file} links all four sibling repos`, () => {
    const body = readFileSync(join(root, file), 'utf8');
    for (const url of SIBLINGS) {
      assert.ok(body.includes(url), `${file} is missing ${url}`);
    }
  });
}
