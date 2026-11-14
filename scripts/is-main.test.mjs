import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { isMain } from './lib/is-main.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cliRoot = process.env.IS_MAIN_TEST_ROOT || root;
function temporary(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'main-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function node(args, cwd) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 10000 });
}

test('isMain resolves both paths and fails closed for absent or invalid paths', t => {
  const dir = temporary(t);
  const target = path.join(dir, 'entry.mjs');
  const link = path.join(dir, 'link.mjs');
  writeFileSync(target, '');
  symlinkSync(target, link);
  const original = process.argv[1];
  t.after(() => { process.argv[1] = original; });
  process.argv[1] = link;
  assert.equal(isMain(pathToFileURL(target).href), true);
  process.argv[1] = target;
  assert.equal(isMain(pathToFileURL(link).href), true);
  assert.equal(isMain(import.meta.url), false);
  assert.equal(isMain('invalid URL'), false);
  assert.equal(isMain(pathToFileURL(path.join(dir, 'missing')).href), false);
  process.argv[1] = path.join(dir, 'missing');
  assert.equal(isMain(pathToFileURL(target).href), false);
  process.argv[1] = undefined;
  assert.equal(isMain(pathToFileURL(target).href), false);
});

// These files travel with independently installed packages, skills and templates.
// Keep one implementation while including it inside each deployment boundary.
test('distributed copies match the canonical shared guard', () => {
  const canonical = readFileSync(new URL('./lib/is-main.mjs', import.meta.url), 'utf8');
  for (const file of [
    '.agents/skills/manage-discord-sessions/helper/is-main.mjs',
    '.agents/skills/natural-writing/scripts/is-main.mjs',
    '.agents/skills/review-pass/scripts/is-main.mjs',
    'skills/review-pass/scripts/is-main.mjs',
    'packages/benchmark-contract/src/is-main.mjs',
    'templates/project-skeleton/scripts/lib/is-main.mjs',
  ]) assert.equal(readFileSync(path.join(root, file), 'utf8'), canonical, file);
});

test('shared guard runs through relative file and directory symlinks but stays quiet on import', t => {
  const dir = temporary(t);
  const entry = path.join(dir, 'entry.mjs');
  const helper = new URL('./lib/is-main.mjs', import.meta.url).href;
  writeFileSync(entry, `import { isMain } from ${JSON.stringify(helper)};\nif (isMain(import.meta.url)) console.log('main-ran');\n`);
  symlinkSync('entry.mjs', path.join(dir, 'link.mjs'));
  symlinkSync(dir, path.join(dir, 'linked-dir'), 'dir');
  for (const name of ['entry.mjs', 'link.mjs', 'linked-dir/entry.mjs']) {
    const result = node([name], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'main-ran\n');
  }
  const imported = node(['--input-type=module', '-e', `import ${JSON.stringify(pathToFileURL(entry).href)}`], dir);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
});

// Missing arguments are deliberate: these paths stop before config, credentials,
// network connections, service management, or ledger writes can occur.
for (const [script, message] of [
  ['scripts/bot-mention-wake.mjs', 'bot_mention_wake_failed'],
  ['scripts/schedule-record.mjs', 'failed'],
  ['.agents/skills/review-pass/scripts/review-preflight.mjs', '--root and --base are required'],
]) {
  test(`symlink CLI invokes main: ${script}`, t => {
    const dir = temporary(t);
    symlinkSync(path.join(cliRoot, script), path.join(dir, 'entry.mjs'));
    const result = node(['entry.mjs'], dir);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(message), result.stderr);
    assert.ok(!result.stderr.includes('ERR_MODULE_NOT_FOUND'), result.stderr);
  });
}

test('independent skill and template deployments retain working symlink entrypoints', t => {
  const dir = temporary(t);
  for (const [source, entry, args, message] of [
    ['.agents/skills/review-pass', 'scripts/review-preflight.mjs', [], '--root and --base are required'],
    ['templates/project-skeleton/scripts', 'validate-spec-chain.mjs', [path.join(dir, 'missing-project')], 'validation FAILED'],
  ]) {
    const deployed = path.join(dir, path.basename(source));
    cpSync(path.join(root, source), deployed, { recursive: true });
    const link = path.join(dir, `${path.basename(entry)}-link.mjs`);
    symlinkSync(path.join(deployed, entry), link);
    const result = node([link, ...args], dir);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(message), result.stderr);
  }
});

function unsafeGuard(source) {
  const argv = String.raw`(?:path\.)?resolve\(\s*process\.argv\[1\]\s*\)`;
  const meta = String.raw`(?:fileURLToPath\(\s*import\.meta\.url\s*\)|__filename)`;
  const resolvedMeta = String.raw`(?:(?:path\.)?resolve\(\s*${meta}\s*\)|${meta})`;
  const argvUrl = String.raw`pathToFileURL\(\s*(?:(?:path\.)?resolve\(\s*process\.argv\[1\]\s*\)|process\.argv\[1\])\s*\)\.href`;
  const metaUrl = String.raw`import\.meta\.url`;
  return new RegExp(`${argv}\\s*===?\\s*${resolvedMeta}|${resolvedMeta}\\s*===?\\s*${argv}`).test(source)
    || new RegExp(`${metaUrl}\\s*===?\\s*${argvUrl}|${argvUrl}\\s*===?\\s*${metaUrl}`).test(source)
    || /import\.meta\.url\s*===?\s*`file:\/\/\$\{process\.argv\[1\]\}`/.test(source);
}

test('guard lint rejects legacy comparisons in both orders', () => {
  const argv = ['process', 'argv[1]'].join('.');
  const meta = ['import', 'meta', 'url'].join('.');
  const filename = `fileURLToPath(${meta})`;
  for (const source of [
    `path.resolve(${argv}) === ${filename}`,
    `${filename} === resolve(${argv})`,
    `path.resolve(${argv}) === path.resolve(${filename})`,
    `${meta} === pathToFileURL(path.resolve(${argv})).href`,
    `${meta} === pathToFileURL(${argv}).href`,
    `${meta} === \`file://\$\{${argv}\}\``,
  ]) assert.equal(unsafeGuard(source), true, source);
  assert.equal(unsafeGuard('if (isMain(import.meta.url)) main();'), false);
  assert.equal(unsafeGuard(`const url = pathToFileURL(${argv}).href;`), false);
  assert.equal(unsafeGuard(`realpathSync(${argv}) === realpathSync(${filename})`), false);
});

test('all tracked and new mjs files avoid unresolved direct execution comparisons', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.mjs'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const violations = files.filter(file => unsafeGuard(readFileSync(path.join(root, file), 'utf8')));
  assert.deepEqual(violations, [], `Use isMain(import.meta.url): ${violations.join(', ')}`);
});
