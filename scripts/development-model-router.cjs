#!/usr/bin/env node
'use strict';

/**
 * development-model-router.cjs
 *
 * Dependency-free CommonJS CLI that routes a prompt to a configured model
 * runner (opencode | codex | claude) based on a role defined in a JSON
 * config file shaped: { version: 1, roles: { <name>: { runner, model } } }.
 *
 * Usage:
 *   node scripts/development-model-router.cjs \
 *     --config <path/to/config.json> \
 *     --role <role-name> \
 *     --prompt-file <path/to/prompt.txt> \
 *     --repo <path/to/repo> \
 *     [--execute]
 *
 * Without --execute the router performs a dry run and prints a JSON
 * envelope { mode, role, runner, model, command, args, stdin } to stdout.
 * With --execute the resolved command is spawned via spawnSync and the
 * child exit status is forwarded.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const KNOWN_RUNNERS = ['opencode', 'codex', 'claude'];

class RouterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RouterError';
  }
}

/**
 * Parse raw CLI argv (excluding node + script) into an options object.
 * Pure: throws RouterError on malformed input, no I/O.
 */
function parseArgs(argv) {
  const options = {
    config: null,
    role: null,
    promptFile: null,
    repo: null,
    execute: false,
  };
  const flagMap = {
    '--config': 'config',
    '--role': 'role',
    '--prompt-file': 'promptFile',
    '--repo': 'repo',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') {
      options.execute = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(flagMap, arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new RouterError(`Missing value for ${arg}`);
      }
      options[flagMap[arg]] = value;
      i += 1;
      continue;
    }
    throw new RouterError(`Unknown argument: ${arg}`);
  }

  for (const [flag, key] of Object.entries(flagMap)) {
    if (!options[key]) {
      throw new RouterError(`Missing required argument: ${flag}`);
    }
  }

  return options;
}

/**
 * Validate a parsed config object. Pure: throws RouterError when invalid.
 */
function validateConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new RouterError('Config must be a JSON object');
  }
  if (config.version !== 1) {
    throw new RouterError(`Unsupported config version: ${String(config.version)}`);
  }
  if (
    config.roles === null ||
    typeof config.roles !== 'object' ||
    Array.isArray(config.roles)
  ) {
    throw new RouterError('Config must contain a "roles" object');
  }
  return config;
}

/**
 * Resolve a role entry from a validated config. Pure.
 * Returns { runner, model } or throws RouterError.
 */
function resolveRole(config, roleName) {
  if (!Object.prototype.hasOwnProperty.call(config.roles, roleName)) {
    const known = Object.keys(config.roles).sort().join(', ') || '(none)';
    throw new RouterError(`Unknown role "${roleName}". Known roles: ${known}`);
  }
  const role = config.roles[roleName];
  if (role === null || typeof role !== 'object' || Array.isArray(role)) {
    throw new RouterError(`Role "${roleName}" must be an object`);
  }
  if (typeof role.runner !== 'string' || role.runner.length === 0) {
    throw new RouterError(`Role "${roleName}" is missing a runner`);
  }
  if (!KNOWN_RUNNERS.includes(role.runner)) {
    throw new RouterError(
      `Role "${roleName}" has unknown runner "${role.runner}". Known runners: ${KNOWN_RUNNERS.join(', ')}`
    );
  }
  if (typeof role.model !== 'string' || role.model.length === 0) {
    throw new RouterError(`Role "${roleName}" is missing a model`);
  }
  return { runner: role.runner, model: role.model };
}

/**
 * Build the command invocation (argv array, never a shell string) for the
 * given runner. Pure.
 *
 * Returns { command, args, stdin } where stdin is null unless the runner
 * consumes the prompt via stdin (claude).
 */
function buildInvocation({ runner, model, prompt, repo }) {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new RouterError('Prompt content must be a non-empty string');
  }
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new RouterError('Repo path must be a non-empty string');
  }

  switch (runner) {
    case 'opencode':
      return {
        command: 'opencode',
        args: ['run', prompt, '--dir', repo, '-m', model],
        stdin: null,
      };
    case 'codex':
      return {
        command: 'codex',
        args: ['exec', '-m', model, prompt],
        stdin: null,
      };
    case 'claude':
      return {
        command: 'claude',
        args: ['-p', '--model', model],
        stdin: prompt,
      };
    default:
      throw new RouterError(`Unknown runner "${runner}"`);
  }
}

/**
 * Read and parse the JSON config from disk. Throws RouterError on failure.
 */
function loadConfig(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new RouterError(`Cannot read config file: ${configPath} (${err.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RouterError(`Config is not valid JSON: ${configPath} (${err.message})`);
  }
  return validateConfig(parsed);
}

/**
 * Read prompt content from disk. Throws RouterError on failure/empty.
 */
function loadPrompt(promptPath) {
  let raw;
  try {
    raw = fs.readFileSync(promptPath, 'utf8');
  } catch (err) {
    throw new RouterError(`Cannot read prompt file: ${promptPath} (${err.message})`);
  }
  if (raw.trim().length === 0) {
    throw new RouterError(`Prompt file is empty: ${promptPath}`);
  }
  return raw;
}

/**
 * Validate the repo path exists and is a directory.
 */
function validateRepo(repoPath) {
  let stat;
  try {
    stat = fs.statSync(repoPath);
  } catch (err) {
    throw new RouterError(`Repo path does not exist: ${repoPath}`);
  }
  if (!stat.isDirectory()) {
    throw new RouterError(`Repo path is not a directory: ${repoPath}`);
  }
  return path.resolve(repoPath);
}

/**
 * Orchestrate a full routing pass. Impure only through injected deps so it
 * remains testable; defaults use real fs/spawn.
 *
 * Returns { exitCode, envelope } where envelope is present for dry runs.
 */
function run(rawArgv, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  const stdout = deps.stdout || process.stdout;

  const options = parseArgs(rawArgv);
  const config = loadConfig(options.config);
  const { runner, model } = resolveRole(config, options.role);
  const prompt = loadPrompt(options.promptFile);
  const repo = validateRepo(options.repo);

  const invocation = buildInvocation({ runner, model, prompt, repo });

  if (!options.execute) {
    const envelope = {
      mode: 'dry-run',
      role: options.role,
      runner,
      model,
      command: invocation.command,
      args: invocation.args,
      stdin: invocation.stdin,
    };
    stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return { exitCode: 0, envelope };
  }

  const spawnOptions = {
    stdio: [
      invocation.stdin === null ? 'inherit' : 'pipe',
      'inherit',
      'inherit',
    ],
    shell: false,
  };
  if (invocation.stdin !== null) {
    spawnOptions.input = invocation.stdin;
    spawnOptions.stdio = ['pipe', 'inherit', 'inherit'];
  }

  const result = spawn(invocation.command, invocation.args, spawnOptions);
  if (result.error) {
    throw new RouterError(
      `Failed to execute ${invocation.command}: ${result.error.message}`
    );
  }
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  return { exitCode, envelope: null };
}

function main() {
  try {
    const { exitCode } = run(process.argv.slice(2));
    process.exitCode = exitCode;
  } catch (err) {
    if (err instanceof RouterError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 2;
    } else {
      throw err;
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  KNOWN_RUNNERS,
  RouterError,
  parseArgs,
  validateConfig,
  resolveRole,
  buildInvocation,
  loadConfig,
  loadPrompt,
  validateRepo,
  run,
};
