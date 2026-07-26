#!/usr/bin/env node
'use strict';

/**
 * test-development-model-router.cjs
 *
 * Self-contained test suite for scripts/development-model-router.cjs.
 * Uses only Node built-ins (assert, fs, os, path). Creates temporary
 * config/prompt/repo fixtures, exercises all three runner argv shapes,
 * invalid-role rejection, and dry-run no-spawn behavior.
 *
 * Run: node scripts/test-development-model-router.cjs
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const router = require('./development-model-router.cjs');

const {
  RouterError,
  parseArgs,
  validateConfig,
  resolveRole,
  buildInvocation,
  loadConfig,
  loadPrompt,
  validateRepo,
  run,
} = router;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`ok   - ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`FAIL - ${name}\n`);
    process.stdout.write(`       ${err && err.stack ? err.stack.split('\n').join('\n       ') : String(err)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-model-router-test-'));

const repoDir = path.join(tmpRoot, 'repo');
fs.mkdirSync(repoDir);

const promptFile = path.join(tmpRoot, 'prompt.txt');
const PROMPT_TEXT = 'Refactor the widget module.\nKeep tests green.\n';
fs.writeFileSync(promptFile, PROMPT_TEXT, 'utf8');

const emptyPromptFile = path.join(tmpRoot, 'empty-prompt.txt');
fs.writeFileSync(emptyPromptFile, '   \n', 'utf8');

const configFile = path.join(tmpRoot, 'config.json');
const CONFIG = {
  version: 1,
  roles: {
    architect: { runner: 'opencode', model: 'anthropic/claude-opus-4' },
    implementer: { runner: 'codex', model: 'gpt-5-codex' },
    reviewer: { runner: 'claude', model: 'claude-sonnet-4-5' },
  },
};
fs.writeFileSync(configFile, JSON.stringify(CONFIG, null, 2), 'utf8');

const badJsonFile = path.join(tmpRoot, 'bad.json');
fs.writeFileSync(badJsonFile, '{ not valid json', 'utf8');

function cleanup() {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (_err) {
    /* best effort */
  }
}

function baseArgv(overrides = {}) {
  const opts = {
    config: configFile,
    role: 'architect',
    promptFile,
    repo: repoDir,
    ...overrides,
  };
  const argv = [
    '--config', opts.config,
    '--role', opts.role,
    '--prompt-file', opts.promptFile,
    '--repo', opts.repo,
  ];
  if (opts.execute) argv.push('--execute');
  return argv;
}

function nullStdout() {
  return { write() {} };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: parses all required flags and --execute', () => {
  const opts = parseArgs(baseArgv({ execute: true }));
  assert.strictEqual(opts.config, configFile);
  assert.strictEqual(opts.role, 'architect');
  assert.strictEqual(opts.promptFile, promptFile);
  assert.strictEqual(opts.repo, repoDir);
  assert.strictEqual(opts.execute, true);
});

test('parseArgs: defaults execute to false', () => {
  const opts = parseArgs(baseArgv());
  assert.strictEqual(opts.execute, false);
});

test('parseArgs: rejects missing required flag', () => {
  assert.throws(
    () => parseArgs(['--config', configFile, '--role', 'architect', '--prompt-file', promptFile]),
    RouterError
  );
});

test('parseArgs: rejects unknown argument', () => {
  assert.throws(() => parseArgs(baseArgv().concat(['--bogus'])), RouterError);
});

test('parseArgs: rejects flag with missing value', () => {
  assert.throws(() => parseArgs(['--config']), RouterError);
});

// ---------------------------------------------------------------------------
// validateConfig / loadConfig
// ---------------------------------------------------------------------------

test('validateConfig: accepts well-formed config', () => {
  assert.deepStrictEqual(validateConfig(CONFIG), CONFIG);
});

test('validateConfig: rejects wrong version', () => {
  assert.throws(() => validateConfig({ version: 2, roles: {} }), RouterError);
});

test('tracked development config: preserves the required role and escalation policy', () => {
  const config = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../naia-settings/development-models.json'), 'utf8')
  );
  const roles = config.roles;
  assert.deepStrictEqual(Object.keys(roles).sort(), [
    'adversarial_review',
    'adversarial_review_hy3',
    'approval_boundary',
    'expert',
    'integration',
    'main',
    'monitoring',
    'sub',
    'testing',
    'translation',
    'translation_review_hy3',
    'translation_verification',
  ]);
  assert.strictEqual(roles.expert.runner, 'codex');
  assert.strictEqual(roles.expert.model, 'gpt-5.6-sol');
  for (const roleName of [
    'main',
    'sub',
    'testing',
    'translation',
    'translation_review_hy3',
    'adversarial_review_hy3',
  ]) {
    assert.strictEqual(roles[roleName].runner, 'opencode');
    assert.strictEqual(roles[roleName].model, 'openrouter/tencent/hy3');
  }
  assert.strictEqual(roles.monitoring.model, 'gpt-5.6-terra');
  assert.strictEqual(roles.adversarial_review.model, 'gpt-5.6-terra');
  assert.strictEqual(roles.main.reasoningEffort, 'high');
  assert.strictEqual(roles.sub.reasoningEffort, 'medium');
  assert.strictEqual(roles.testing.reasoningEffort, 'medium');
  assert.strictEqual(roles.translation.reasoningEffort, 'low');
  assert.strictEqual(roles.translation_review_hy3.reasoningEffort, 'medium');
  assert.strictEqual(roles.adversarial_review_hy3.reasoningEffort, 'high');
  assert.strictEqual(roles.approval_boundary.runner, 'external');
  assert.strictEqual(roles.integration.runner, 'codex');
  assert.deepStrictEqual(config.routes.adversarial_review, ['adversarial_review', 'adversarial_review_hy3']);
  assert.strictEqual(config.routes.translation, 'translation');
  assert.deepStrictEqual(config.routes.translation_review, [
    'translation_verification',
    'translation_review_hy3',
  ]);
  assert.strictEqual(roles.translation_verification.runner, 'claude');
  assert.strictEqual(roles.translation_verification.model, 'haiku');
  assert.strictEqual(roles.translation_verification.modelFamily, 'claude-haiku');
  assert.strictEqual(config.expertEscalation.mode, 'automatic');
  assert.strictEqual(config.expertEscalation.triggers.length, 4);
});

test('tracked translation review panel: requires independent Claude Haiku and HY3 medium reviewers', () => {
  const config = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../naia-settings/development-models.json'), 'utf8')
  );
  const translation = { roleName: 'translation', ...config.roles.translation };
  const reviewers = config.routes.translation_review.map((roleName) => ({
    roleName,
    ...config.roles[roleName],
  }));

  assert.strictEqual(translation.modelFamily, 'hy3');
  assert.strictEqual(translation.reasoningEffort, 'low');
  assert.deepStrictEqual(reviewers.map(({ roleName }) => roleName), [
    'translation_verification',
    'translation_review_hy3',
  ]);
  assert.deepStrictEqual(reviewers.map(({ runner, model, reasoningEffort }) => ({
    runner,
    model,
    reasoningEffort,
  })), [
    { runner: 'claude', model: 'haiku', reasoningEffort: undefined },
    { runner: 'opencode', model: 'openrouter/tencent/hy3', reasoningEffort: 'medium' },
  ]);
  assert.notStrictEqual(reviewers[0].modelFamily, translation.modelFamily);
  assert.notStrictEqual(reviewers[0].runner, translation.runner);
  assert.notStrictEqual(reviewers[0].roleName, translation.roleName);
  assert.notStrictEqual(reviewers[1].roleName, translation.roleName);
  assert.notStrictEqual(reviewers[1].reasoningEffort, translation.reasoningEffort);
});

test('tracked substantive reviewers: roles are distinct from implementation and test roles', () => {
  const config = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../naia-settings/development-models.json'), 'utf8')
  );
  const substantiveReviewers = config.routes.adversarial_review;

  assert.deepStrictEqual(substantiveReviewers, ['adversarial_review', 'adversarial_review_hy3']);
  for (const reviewerRole of substantiveReviewers) {
    assert.notStrictEqual(reviewerRole, config.routes.implementation);
    assert.notStrictEqual(reviewerRole, config.routes.testing);
  }
  assert.notStrictEqual(config.routes.implementation, config.routes.testing);
});

test('tracked review panel: requires Terra and HY3 high for substantive adversarial review', () => {
  const panel = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../naia-settings/review.json'), 'utf8'));
  assert.deepStrictEqual(panel.reviewers.map((reviewer) => reviewer.id), ['terra', 'hy3-high']);
  assert.strictEqual(panel.reviewers[0].model, 'gpt-5.6-terra');
  assert.strictEqual(panel.reviewers[1].model, 'openrouter/tencent/hy3');
  assert.strictEqual(panel.reviewers[1].tier, 'high');
  for (const stage of Object.values(panel.stages)) {
    assert.deepStrictEqual(stage.reviewers, ['terra', 'hy3-high']);
  }
});

test('validateConfig: rejects missing roles object', () => {
  assert.throws(() => validateConfig({ version: 1 }), RouterError);
  assert.throws(() => validateConfig({ version: 1, roles: [] }), RouterError);
});

test('loadConfig: reads config from disk', () => {
  const cfg = loadConfig(configFile);
  assert.strictEqual(cfg.version, 1);
  assert.ok(cfg.roles.architect);
});

test('loadConfig: rejects missing file', () => {
  assert.throws(() => loadConfig(path.join(tmpRoot, 'nope.json')), RouterError);
});

test('loadConfig: rejects invalid JSON', () => {
  assert.throws(() => loadConfig(badJsonFile), RouterError);
});

// ---------------------------------------------------------------------------
// resolveRole
// ---------------------------------------------------------------------------

test('resolveRole: returns runner and model for known role', () => {
  assert.deepStrictEqual(resolveRole(CONFIG, 'implementer'), {
    runner: 'codex',
    model: 'gpt-5-codex',
  });
});

test('resolveRole: rejects unknown role', () => {
  assert.throws(() => resolveRole(CONFIG, 'ghost'), /Unknown role "ghost"/);
});

test('resolveRole: rejects role with unknown runner', () => {
  const cfg = { version: 1, roles: { r: { runner: 'gemini', model: 'x' } } };
  assert.throws(() => resolveRole(cfg, 'r'), /unknown runner/);
});

test('resolveRole: rejects role missing model', () => {
  const cfg = { version: 1, roles: { r: { runner: 'codex' } } };
  assert.throws(() => resolveRole(cfg, 'r'), /missing a model/);
});

test('resolveRole: rejects role missing runner', () => {
  const cfg = { version: 1, roles: { r: { model: 'x' } } };
  assert.throws(() => resolveRole(cfg, 'r'), /missing a runner/);
});

// ---------------------------------------------------------------------------
// buildInvocation - the three runner argv shapes
// ---------------------------------------------------------------------------

test('buildInvocation: opencode shape -> opencode run <prompt> --dir <repo> -m <model>', () => {
  const inv = buildInvocation({
    runner: 'opencode',
    model: 'anthropic/claude-opus-4',
    prompt: PROMPT_TEXT,
    repo: repoDir,
  });
  assert.strictEqual(inv.command, 'opencode');
  assert.deepStrictEqual(inv.args, [
    'run',
    PROMPT_TEXT,
    '--dir',
    repoDir,
    '-m',
    'anthropic/claude-opus-4',
  ]);
  assert.strictEqual(inv.stdin, null);
});

test('buildInvocation: codex shape -> codex exec -m <model> <prompt>', () => {
  const inv = buildInvocation({
    runner: 'codex',
    model: 'gpt-5-codex',
    prompt: PROMPT_TEXT,
    repo: repoDir,
  });
  assert.strictEqual(inv.command, 'codex');
  assert.deepStrictEqual(inv.args, ['exec', '-m', 'gpt-5-codex', PROMPT_TEXT]);
  assert.strictEqual(inv.stdin, null);
});

test('buildInvocation: claude shape -> claude -p --model <model> with prompt on stdin', () => {
  const inv = buildInvocation({
    runner: 'claude',
    model: 'claude-sonnet-4-5',
    prompt: PROMPT_TEXT,
    repo: repoDir,
  });
  assert.strictEqual(inv.command, 'claude');
  assert.deepStrictEqual(inv.args, ['-p', '--model', 'claude-sonnet-4-5']);
  assert.strictEqual(inv.stdin, PROMPT_TEXT);
});

test('buildInvocation: rejects unknown runner', () => {
  assert.throws(
    () => buildInvocation({ runner: 'nope', model: 'm', prompt: 'p', repo: repoDir }),
    RouterError
  );
});

test('buildInvocation: rejects empty prompt and repo', () => {
  assert.throws(
    () => buildInvocation({ runner: 'codex', model: 'm', prompt: '', repo: repoDir }),
    RouterError
  );
  assert.throws(
    () => buildInvocation({ runner: 'codex', model: 'm', prompt: 'p', repo: '' }),
    RouterError
  );
});

// ---------------------------------------------------------------------------
// loadPrompt / validateRepo
// ---------------------------------------------------------------------------

test('loadPrompt: reads prompt content', () => {
  assert.strictEqual(loadPrompt(promptFile), PROMPT_TEXT);
});

test('loadPrompt: rejects missing prompt file', () => {
  assert.throws(() => loadPrompt(path.join(tmpRoot, 'nope.txt')), RouterError);
});

test('loadPrompt: rejects empty prompt file', () => {
  assert.throws(() => loadPrompt(emptyPromptFile), RouterError);
});

test('validateRepo: accepts existing directory', () => {
  assert.strictEqual(validateRepo(repoDir), path.resolve(repoDir));
});

test('validateRepo: rejects missing path and non-directory', () => {
  assert.throws(() => validateRepo(path.join(tmpRoot, 'nope-dir')), RouterError);
  assert.throws(() => validateRepo(promptFile), RouterError);
});

// ---------------------------------------------------------------------------
// run: dry-run envelope + no-spawn, invalid role, execute forwarding
// ---------------------------------------------------------------------------

test('run: dry run emits JSON envelope and never spawns', () => {
  let spawnCalls = 0;
  let written = '';
  const result = run(baseArgv(), {
    spawnSync: () => {
      spawnCalls += 1;
      return { status: 0 };
    },
    stdout: { write(chunk) { written += chunk; } },
  });

  assert.strictEqual(spawnCalls, 0, 'spawnSync must not be called in dry run');
  assert.strictEqual(result.exitCode, 0);

  const envelope = JSON.parse(written);
  assert.strictEqual(envelope.mode, 'dry-run');
  assert.strictEqual(envelope.role, 'architect');
  assert.strictEqual(envelope.runner, 'opencode');
  assert.strictEqual(envelope.model, 'anthropic/claude-opus-4');
  assert.strictEqual(envelope.command, 'opencode');
  assert.deepStrictEqual(envelope.args, [
    'run',
    PROMPT_TEXT,
    '--dir',
    path.resolve(repoDir),
    '-m',
    'anthropic/claude-opus-4',
  ]);
  assert.strictEqual(envelope.stdin, null);
  assert.deepStrictEqual(result.envelope, envelope);
});

test('run: dry run for claude includes prompt as stdin in envelope', () => {
  const result = run(baseArgv({ role: 'reviewer' }), { stdout: nullStdout() });
  assert.strictEqual(result.envelope.command, 'claude');
  assert.deepStrictEqual(result.envelope.args, ['-p', '--model', 'claude-sonnet-4-5']);
  assert.strictEqual(result.envelope.stdin, PROMPT_TEXT);
});

test('run: rejects unknown role', () => {
  assert.throws(
    () => run(baseArgv({ role: 'nonexistent' }), { stdout: nullStdout() }),
    /Unknown role "nonexistent"/
  );
});

test('run: execute calls spawnSync with argv array (no shell) and forwards status', () => {
  let captured = null;
  const result = run(baseArgv({ role: 'implementer', execute: true }), {
    spawnSync: (command, args, options) => {
      captured = { command, args, options };
      return { status: 7 };
    },
    stdout: nullStdout(),
  });

  assert.ok(captured, 'spawnSync should be called with --execute');
  assert.strictEqual(captured.command, 'codex');
  assert.deepStrictEqual(captured.args, ['exec', '-m', 'gpt-5-codex', PROMPT_TEXT]);
  assert.strictEqual(captured.options.shell, false);
  assert.strictEqual(result.exitCode, 7, 'child status must be forwarded');
});

test('run: execute pipes stdin for claude runner', () => {
  let captured = null;
  run(baseArgv({ role: 'reviewer', execute: true }), {
    spawnSync: (command, args, options) => {
      captured = { command, args, options };
      return { status: 0 };
    },
    stdout: nullStdout(),
  });

  assert.strictEqual(captured.command, 'claude');
  assert.strictEqual(captured.options.input, PROMPT_TEXT);
  assert.deepStrictEqual(captured.options.stdio, ['pipe', 'inherit', 'inherit']);
});

test('run: execute surfaces spawn errors as RouterError', () => {
  assert.throws(
    () =>
      run(baseArgv({ execute: true }), {
        spawnSync: () => ({ error: new Error('ENOENT'), status: null }),
        stdout: nullStdout(),
      }),
    /Failed to execute opencode/
  );
});

test('run: rejects missing config file', () => {
  assert.throws(
    () => run(baseArgv({ config: path.join(tmpRoot, 'missing.json') }), { stdout: nullStdout() }),
    /Cannot read config file/
  );
});

test('run: rejects missing prompt file', () => {
  assert.throws(
    () => run(baseArgv({ promptFile: path.join(tmpRoot, 'missing.txt') }), { stdout: nullStdout() }),
    /Cannot read prompt file/
  );
});

test('run: rejects missing repo directory', () => {
  assert.throws(
    () => run(baseArgv({ repo: path.join(tmpRoot, 'missing-repo') }), { stdout: nullStdout() }),
    /Repo path does not exist/
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

cleanup();

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exitCode = 1;
}
