#!/usr/bin/env node
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkChangeSync,
  classifyChangedFile,
  extractMarkdownLinks,
  scan
} from './check-guide-freshness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SCRIPT_PATH = path.join(HERE, 'check-guide-freshness.mjs');

function withTempWorkspace(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-freshness-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

function git(dir, args) {
  return cp.execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function runCli(args) {
  return cp.spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
}

test('classifyChangedFile distinguishes test, doc, code, and other paths', () => {
  assert.equal(classifyChangedFile('scripts/foo.test.mjs'), 'test');
  assert.equal(classifyChangedFile('scripts/run-native-harness-tests.cjs'), 'test');
  assert.equal(classifyChangedFile('packages/core/src/a.spec.ts'), 'test');
  assert.equal(classifyChangedFile('scripts/conform/selftest_conform.py'), 'test');
  assert.equal(classifyChangedFile('.claude/hooks/test/run-sync-entry-points-test.cjs'), 'test');
  assert.equal(classifyChangedFile('docs/guides/development-method.md'), 'doc');
  assert.equal(classifyChangedFile('.agents/context/contributing.yaml'), 'doc');
  assert.equal(classifyChangedFile('packages/core/README.md'), 'doc');
  assert.equal(classifyChangedFile('scripts/foo.mjs'), 'code');
  assert.equal(classifyChangedFile('packages/core/src/router.ts'), 'code');
  assert.equal(classifyChangedFile('package.json'), 'other');
  assert.equal(classifyChangedFile('.github/workflows/ci.yml'), 'other');
});

test('passes when feature code has matching doc and matching test', () => {
  withTempWorkspace({
    'scripts/feature-alpha.mjs': 'export const alpha = () => 1;\n',
    'scripts/feature-alpha.test.mjs': "import './feature-alpha.mjs';\n",
    'docs/feature-alpha.md': '# Alpha\nUses [impl](../scripts/feature-alpha.mjs).\n'
  }, (dir) => {
    const res = checkChangeSync({
      root: dir,
      files: ['scripts/feature-alpha.mjs', 'scripts/feature-alpha.test.mjs', 'docs/feature-alpha.md']
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.brokenLinks, []);
  });
});

test('passes when helper library is transitively imported by covered entrypoint', () => {
  withTempWorkspace({
    'scripts/lib/shared-util.mjs': 'export const helper = () => 42;\n',
    'scripts/feature-beta.mjs': "import { helper } from './lib/shared-util.mjs';\nexport { helper };\n",
    'scripts/feature-beta.test.mjs': "import './feature-beta.mjs';\n",
    'docs/guides/beta.md': '# Beta\nEntrypoint: `scripts/feature-beta.mjs`.\n'
  }, (dir) => {
    const res = checkChangeSync({
      root: dir,
      files: [
        'scripts/lib/shared-util.mjs',
        'scripts/feature-beta.mjs',
        'scripts/feature-beta.test.mjs',
        'docs/guides/beta.md'
      ]
    });
    assert.equal(res.ok, true);
  });
});

test('fails with missing_docs when code change omits documentation', () => {
  withTempWorkspace({
    'scripts/feature-gamma.mjs': 'export const gamma = 1;\n',
    'scripts/feature-gamma.test.mjs': "import './feature-gamma.mjs';\n"
  }, (dir) => {
    const res = checkChangeSync({
      root: dir,
      files: ['scripts/feature-gamma.mjs', 'scripts/feature-gamma.test.mjs']
    });
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors.map((e) => e.code), ['missing_docs']);
    assert.deepEqual(res.missingDocsFor, ['scripts/feature-gamma.mjs']);
  });
});

test('fails with missing_tests when code change omits test files', () => {
  withTempWorkspace({
    'scripts/feature-delta.mjs': 'export const delta = 1;\n',
    'docs/feature-delta.md': '# Delta\nSee `scripts/feature-delta.mjs`.\n'
  }, (dir) => {
    const res = checkChangeSync({
      root: dir,
      files: ['scripts/feature-delta.mjs', 'docs/feature-delta.md']
    });
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors.map((e) => e.code), ['missing_tests']);
    assert.deepEqual(res.missingTestsFor, ['scripts/feature-delta.mjs']);
  });
});

test('fails with unmatched_doc and unmatched_test for unrelated doc/test changes', () => {
  withTempWorkspace({
    'packages/billing/src/invoice.ts': 'export function bill() { return true; }\n',
    'packages/billing/src/logout.test.ts': "import { logout } from './logout';\n",
    'docs/unrelated.md': '# Unrelated\nCovers auth logout only.\n'
  }, (dir) => {
    const res = checkChangeSync({
      root: dir,
      files: [
        'packages/billing/src/invoice.ts',
        'packages/billing/src/logout.test.ts',
        'docs/unrelated.md'
      ]
    });
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors.map((e) => e.code).sort(), ['unmatched_doc', 'unmatched_test']);
    assert.deepEqual(res.missingDocsFor, ['packages/billing/src/invoice.ts']);
    assert.deepEqual(res.missingTestsFor, ['packages/billing/src/invoice.ts']);
  });
});

test('passes for docs-only or tests-only changes', () => {
  withTempWorkspace({
    'docs/guides/overview.md': '# Overview\n',
    '.agents/context/project-index.yaml': 'projects: {}\n',
    'scripts/only.test.mjs': 'import assert from "node:assert/strict";\n'
  }, (dir) => {
    assert.equal(checkChangeSync({
      root: dir,
      files: ['docs/guides/overview.md', '.agents/context/project-index.yaml']
    }).ok, true);
    assert.equal(checkChangeSync({
      root: dir,
      files: ['scripts/only.test.mjs']
    }).ok, true);
  });
});

test('extractMarkdownLinks and checkChangeSync catch broken relative links while skipping fences and external URLs', () => {
  const sample = [
    '# Title',
    '[ok](./ok.md#sec)',
    'syntax `[inline](../ignored.md)` example',
    '[web](https://example.com)',
    '[anchor](#local)',
    'deprecated [retired](./removed.md)',
    '```md',
    '[fenced](./not-checked.md)',
    '```',
    '[broken](../missing-target.md "title")'
  ].join('\n');

  const extracted = extractMarkdownLinks(sample);
  assert.deepEqual(extracted, [
    { target: './ok.md', line: 2 },
    { target: '../missing-target.md', line: 10 }
  ]);

  withTempWorkspace({
    'docs/guides/ok.md': '# OK\n',
    'docs/guides/sample.md': sample
  }, (dir) => {
    const res = checkChangeSync({ root: dir, files: ['docs/guides/sample.md'] });
    assert.equal(res.ok, false);
    assert.equal(res.brokenLinks.length, 1);
    assert.deepEqual(res.brokenLinks[0], {
      file: 'docs/guides/sample.md',
      target: '../missing-target.md',
      line: 10
    });
  });
});

test('CLI --sync-check validates --commit, --range, --staged, and --json against a git repository', () => {
  withTempWorkspace({
    'scripts/svc.mjs': 'export const v = 1;\n',
    'scripts/svc.test.mjs': "import { v } from './svc.mjs';\nconsole.log(v);\n",
    'docs/svc.md': '# Svc\nScript: `scripts/svc.mjs`.\n'
  }, (dir) => {
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'init valid']);

    const c1 = runCli(['--sync-check', '--root', dir, '--commit', 'HEAD', '--json']);
    assert.equal(c1.status, 0, c1.stderr || c1.stdout);
    const j1 = JSON.parse(c1.stdout);
    assert.equal(j1.ok, true);
    assert.equal(j1.source, 'commit:HEAD');

    writeFiles(dir, { 'scripts/svc.mjs': 'export const v = 2;\n' });
    git(dir, ['add', 'scripts/svc.mjs']);
    git(dir, ['commit', '-m', 'code only']);

    const c2 = runCli(['--sync-check', '--root', dir, '--commit', 'HEAD', '--json']);
    assert.equal(c2.status, 1);
    assert.equal(JSON.parse(c2.stdout).ok, false);

    const rangeRes = runCli(['--sync-check', '--root', dir, '--range', 'HEAD~1..HEAD']);
    assert.equal(rangeRes.status, 1);

    writeFiles(dir, {
      'scripts/svc.mjs': 'export const v = 3;\n',
      'scripts/svc.test.mjs': "import { v } from './svc.mjs';\nif (v !== 3) process.exit(1);\n"
    });
    git(dir, ['add', 'scripts/svc.mjs', 'scripts/svc.test.mjs']);
    const stagedMissingDoc = runCli(['--sync-check', '--root', dir, '--staged']);
    assert.equal(stagedMissingDoc.status, 1);

    writeFiles(dir, { 'docs/svc.md': '# Svc\nScript: `scripts/svc.mjs` v3.\n' });
    git(dir, ['add', 'docs/svc.md']);
    const stagedOk = runCli(['--sync-check', '--root', dir, '--staged']);
    assert.equal(stagedOk.status, 0, stagedOk.stdout);
  });
});

test('repo development-method changes and scan() compatibility pass', () => {
  const res = checkChangeSync({
    root: REPO_ROOT,
    files: [
      'docs/guides/development-method.md',
      '.agents/context/agents-rules.json',
      'scripts/check-guide-freshness.mjs',
      'scripts/check-guide-freshness.test.mjs',
      'scripts/run-native-harness-tests.cjs'
    ]
  });
  assert.equal(res.ok, true, JSON.stringify(res, null, 2));
  assert.deepEqual(res.brokenLinks, []);

  const guides = scan({ lagDays: 14 });
  assert.ok(Array.isArray(guides) && guides.length > 0);
  assert.ok('rel' in guides[0] && 'missing' in guides[0] && 'newer' in guides[0]);
});
