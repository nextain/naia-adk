#!/usr/bin/env node
/**
 * Watcher systemd unit failure monitor (`naia-*` / `minho-*`).
 *
 * - Inspects `systemd --user` watcher units matching configured patterns
 *   (default `['naia-*', 'minho-*']`, excluding transient worker units `*-worker-*`).
 * - Tracks consecutive failure count (`streak`) in state file (protected by `withPidLock`).
 * - When a unit is `failed` (`activeState === 'failed'`) OR reaches `N` consecutive
 *   failures (`streak >= failureThreshold`, default `N = 2`): writes a wake file into
 *   the responsible role's `wakeDir`.
 * - When failures continue `> 2` consecutive checks (`streak > escalationAfterStreak`,
 *   default `2`, i.e. 3rd consecutive failure onward): records a candidate in
 *   `candidatesFile` (`ceo-escalation-candidates.json`) AND sends via the existing
 *   Discord escalation transport (`createDiscordApi` / `postDiscord` from
 *   `./response-watch.mjs`) or configured `notifyCommand` (`{text}` placeholder,
 *   same shape as `role-wake.mjs`).
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { withPidLock } from './lib/pid-lock.mjs';
import { createDiscordApi, postDiscord, fill } from './response-watch.mjs';

const execFileAsync = promisify(execFile);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const digest = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 24);

export const DEFAULT_PATTERNS = ['naia-*', 'minho-*'];
export const DEFAULT_EXCLUDE_PATTERNS = ['*-worker-*', 'worker-*'];

function globToRegExp(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function matchesAny(name, patterns) {
  return (patterns ?? []).some((p) => globToRegExp(p).test(name));
}

async function atomicWrite(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, filePath);
}

export function validateWatcherUnitConfig(config) {
  if (!isObject(config)) throw new Error('watcherUnits config must be an object');
  if (typeof config.role !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(config.role)) {
    throw new Error('watcherUnits.role is required');
  }
  if (typeof config.wakeDir !== 'string' || !isAbsolute(config.wakeDir)) {
    throw new Error('watcherUnits.wakeDir must be an absolute path');
  }
  if (config.stateFile !== undefined && (typeof config.stateFile !== 'string' || !isAbsolute(config.stateFile))) {
    throw new Error('watcherUnits.stateFile must be an absolute path');
  }
  if (config.candidatesFile !== undefined && (typeof config.candidatesFile !== 'string' || !isAbsolute(config.candidatesFile))) {
    throw new Error('watcherUnits.candidatesFile must be an absolute path');
  }
  const threshold = config.failureThreshold ?? 2;
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error('watcherUnits.failureThreshold must be a positive integer');
  }
  const escalateAfter = config.escalationAfterStreak ?? 2;
  if (!Number.isInteger(escalateAfter) || escalateAfter < 1) {
    throw new Error('watcherUnits.escalationAfterStreak must be a positive integer');
  }
  if (config.notifyCommand !== undefined) {
    if (
      !Array.isArray(config.notifyCommand) ||
      !config.notifyCommand.length ||
      config.notifyCommand.some((p) => typeof p !== 'string') ||
      !config.notifyCommand.some((p) => p.includes('{text}'))
    ) {
      throw new Error('watcherUnits.notifyCommand must be a string argv with a {text} placeholder');
    }
  }
  if (config.escalation !== undefined) {
    if (
      !isObject(config.escalation) ||
      !/^\d+$/.test(config.escalation.channelId ?? '') ||
      !/^\d+$/.test(config.escalation.userId ?? '')
    ) {
      throw new Error('watcherUnits.escalation requires numeric channelId and userId');
    }
  }
  return config;
}

export function parseSystemctlShowOutput(raw) {
  const blocks = String(raw || '')
    .split(/\r?\n\r?\n+/)
    .map((b) => b.trim())
    .filter(Boolean);
  const units = [];
  for (const block of blocks) {
    const props = {};
    for (const line of block.split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      props[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (!props.Id) continue;
    const statusNum = props.ExecMainStatus !== undefined && props.ExecMainStatus !== ''
      ? Number(props.ExecMainStatus)
      : null;
    units.push({
      unit: props.Id,
      loadState: props.LoadState || 'loaded',
      activeState: props.ActiveState || 'unknown',
      subState: props.SubState || 'unknown',
      result: props.Result || '',
      execMainStatus: Number.isInteger(statusNum) ? statusNum : null,
      nRestarts: Number.isInteger(Number(props.NRestarts)) ? Number(props.NRestarts) : 0,
    });
  }
  return units;
}

export async function defaultUnitProbe({
  patterns = DEFAULT_PATTERNS,
  excludePatterns = DEFAULT_EXCLUDE_PATTERNS,
  units: explicitUnits,
  execImpl = execFileAsync,
} = {}) {
  let names = Array.isArray(explicitUnits) && explicitUnits.length ? [...explicitUnits] : [];
  if (!names.length) {
    const { stdout } = await execImpl(
      'systemctl',
      ['--user', 'list-units', '--all', '--plain', '--no-legend', '--no-pager', ...patterns],
      { timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
    );
    for (const line of String(stdout || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const unitName = trimmed.split(/\s+/)[0];
      if (!unitName) continue;
      if (!matchesAny(unitName, patterns)) continue;
      if (matchesAny(unitName, excludePatterns)) continue;
      names.push(unitName);
    }
  }
  names = [...new Set(names)].sort();
  if (!names.length) return [];

  const { stdout: showOut } = await execImpl(
    'systemctl',
    [
      '--user',
      'show',
      '--property=Id,LoadState,ActiveState,SubState,Result,ExecMainStatus,NRestarts',
      '--',
      ...names,
    ],
    { timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
  );
  return parseSystemctlShowOutput(showOut);
}

export function isUnitFailing(u) {
  if (!u || u.loadState === 'not-found') return false;
  if (u.activeState === 'failed' || u.subState === 'failed') return true;
  if (u.result && !['success', 'done', ''].includes(u.result)) return true;
  // Oneshot services exit 0 (normal) or non-zero; exit code 1+ when not active indicates failed run
  // (except exit code 2 on response-watch/session-health if systemd SuccessExitStatus=2 marked Result=success).
  if (
    Number.isInteger(u.execMainStatus) &&
    u.execMainStatus !== 0 &&
    u.activeState !== 'active' &&
    u.result !== 'success'
  ) {
    return true;
  }
  return false;
}

async function writeRoleWakeFile({ wakeDir, role, unit, streak, detail, now }) {
  await mkdir(wakeDir, { recursive: true, mode: 0o700 });
  const safeUnit = unit.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const key = digest(`${unit}/${role}/${streak}/${now}`);
  const fileName = `${now}-watcher-unit-${safeUnit}-route-${role}.md`;
  const filePath = join(wakeDir, fileName);
  const wakeId = (1000000000000000000n + (BigInt(`0x${key}`) % 9000000000000000000n)).toString();
  const body = [
    '# Discord wake',
    '',
    `Role: ${role}`,
    'Author: watcher-unit-health',
    `Message ID: ${wakeId}`,
    `Unit: ${unit}`,
    `Consecutive Failures: ${streak}`,
    '',
    `[감시 유닛 실패] \`${unit}\` 감시 유닛이 실패 상태입니다 (연속 ${streak}회, ${detail}).`,
    `원인 확인: \`journalctl --user -u ${unit} -n 50 --no-pager\``,
    '',
  ].join('\n');
  await atomicWrite(filePath, body);
  return filePath;
}

/**
 * Evaluate watcher unit states against persisted state object (mutates `unitState` in place).
 * Can be called inside `session-health.mjs`'s existing state lock OR via standalone `runWatcherUnitHealth`.
 */
export async function checkWatcherUnits(config, {
  unitState = {},
  now = Date.now(),
  dry = false,
  unitProbe = defaultUnitProbe,
  fetchImpl = fetch,
  token,
  notifications,
  execImpl = execFileAsync,
  saveState = async () => {},
  log = () => {},
} = {}) {
  validateWatcherUnitConfig(config);
  const patterns = config.patterns ?? DEFAULT_PATTERNS;
  const excludePatterns = config.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS;
  const failureThreshold = config.failureThreshold ?? 2;
  const escalationAfterStreak = config.escalationAfterStreak ?? 2; // > 2 means 3+ consecutive checks
  const repeatMs = (config.repeatMinutes ?? 30) * 60_000;
  const candidatesFile = config.candidatesFile
    ? resolve(config.candidatesFile)
    : config.stateFile
      ? join(dirname(resolve(config.stateFile)), 'ceo-escalation-candidates.json')
      : join(resolve(config.wakeDir), '.ceo-escalation-candidates.json');

  const escalationTarget = config.escalation ?? notifications?.escalation ?? null;

  let observedUnits;
  try {
    observedUnits = await unitProbe({
      patterns,
      excludePatterns,
      units: config.units,
      execImpl,
    });
  } catch (error) {
    log({ stage: 'watcher_units', result: 'probe_failed', reason: error.message });
    return {
      degraded: true,
      probeError: error.message,
      units: [],
      wakes: [],
      escalations: [],
      candidatesFile,
    };
  }

  let candidatesDoc = { version: 1, candidates: {} };
  try {
    const parsed = JSON.parse(await readFile(candidatesFile, 'utf8'));
    if (isObject(parsed) && isObject(parsed.candidates)) {
      candidatesDoc = parsed;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let candidatesDirty = false;

  const wakes = [];
  const escalations = [];
  const rows = [];
  let degraded = false;

  for (const u of observedUnits) {
    if (!matchesAny(u.unit, patterns) || matchesAny(u.unit, excludePatterns)) continue;
    const prev = isObject(unitState[u.unit]) ? unitState[u.unit] : { streak: 0, sequence: 0 };
    const failing = isUnitFailing(u);
    const detail = `active=${u.activeState}/${u.subState}, result=${u.result || 'none'}, exit=${u.execMainStatus ?? 'n/a'}`;

    if (!failing) {
      if (prev.streak > 0 || prev.episode) {
        unitState[u.unit] = {
          streak: 0,
          sequence: prev.sequence ?? 0,
          lastHealthyAt: now,
        };
        if (candidatesDoc.candidates[u.unit] && !candidatesDoc.candidates[u.unit].resolvedAt) {
          candidatesDoc.candidates[u.unit].resolvedAt = new Date(now).toISOString();
          candidatesDoc.candidates[u.unit].status = 'resolved';
          candidatesDirty = true;
        }
        await saveState();
      } else {
        unitState[u.unit] = {
          streak: 0,
          sequence: prev.sequence ?? 0,
          lastHealthyAt: now,
        };
      }
      rows.push({ ...u, failing: false, streak: 0 });
      continue;
    }

    degraded = true;
    const streak = (prev.streak ?? 0) + 1;
    const sequence = prev.episode ? prev.sequence : (prev.sequence ?? 0) + 1;
    const episode = prev.episode ?? {
      firstFailedAt: now,
      lastWakeAt: null,
      escalation: null,
    };

    const shouldWakeRole = u.activeState === 'failed' || streak >= failureThreshold;
    if (shouldWakeRole) {
      const dueWake = episode.lastWakeAt == null || now - episode.lastWakeAt >= repeatMs;
      if (dueWake) {
        if (!dry) {
          const wakeFile = await writeRoleWakeFile({
            wakeDir: resolve(config.wakeDir),
            role: config.role,
            unit: u.unit,
            streak,
            detail,
            now,
          });
          episode.lastWakeAt = now;
          wakes.push({ unit: u.unit, role: config.role, streak, wakeFile });
        } else {
          wakes.push({ unit: u.unit, role: config.role, streak, dry: true });
        }
      }
    }

    if (streak > escalationAfterStreak) {
      const existingCandidate = candidatesDoc.candidates[u.unit];
      const candidateRecord = {
        unit: u.unit,
        role: config.role,
        streak,
        firstFailedAt: new Date(episode.firstFailedAt).toISOString(),
        updatedAt: new Date(now).toISOString(),
        activeState: u.activeState,
        subState: u.subState,
        result: u.result || null,
        execMainStatus: u.execMainStatus,
        status: existingCandidate?.status && existingCandidate.status !== 'resolved'
          ? existingCandidate.status
          : 'pending',
        ...(existingCandidate?.messageId ? { messageId: existingCandidate.messageId } : {}),
      };
      candidatesDoc.candidates[u.unit] = candidateRecord;
      candidatesDirty = true;

      const escReceipt = episode.escalation;
      const alreadySent = escReceipt && escReceipt.status !== 'rejected';
      if (!alreadySent) {
        const text = fill(
          config.escalationTemplate ??
            '<@{user}> [감시 유닛 연속 실패 올림] `{unit}` 유닛이 연속 {streak}회 실패 중입니다 ({detail}). 담당 역할: {role}',
          {
            user: escalationTarget?.userId ?? 'owner',
            unit: u.unit,
            streak,
            detail,
            role: config.role,
          },
        );

        if (dry) {
          escalations.push({ unit: u.unit, streak, status: 'would_send' });
        } else if (escalationTarget && token) {
          episode.escalation = { status: 'intent', at: now };
          unitState[u.unit] = { streak, sequence, lastFailedAt: now, detail, episode };
          await saveState();
          try {
            const api = createDiscordApi(fetchImpl, token);
            const sent = await postDiscord(api, {
              channelId: escalationTarget.channelId,
              content: text,
              mentions: [escalationTarget.userId],
              nonce: digest(`watcher-unit/${u.unit}/${sequence}/${episode.firstFailedAt}`),
            });
            if (!sent?.id) {
              const err = new Error('missing send receipt');
              err.uncertain = true;
              throw err;
            }
            episode.escalation = { status: 'confirmed', at: now, id: sent.id };
            candidateRecord.status = 'sent';
            candidateRecord.messageId = sent.id;
            escalations.push({ unit: u.unit, streak, status: 'confirmed', id: sent.id });
          } catch (error) {
            episode.escalation = {
              status: error.uncertain ? 'uncertain' : 'rejected',
              at: now,
              reason: error.message,
            };
            candidateRecord.status = episode.escalation.status;
            escalations.push({ unit: u.unit, streak, status: episode.escalation.status });
          }
        } else if (Array.isArray(config.notifyCommand)) {
          episode.escalation = { status: 'intent', at: now };
          unitState[u.unit] = { streak, sequence, lastFailedAt: now, detail, episode };
          await saveState();
          try {
            const argv = config.notifyCommand.map((part) => part.replaceAll('{text}', text));
            await execImpl(argv[0], argv.slice(1), { timeout: 15000 });
            episode.escalation = { status: 'confirmed', at: now };
            candidateRecord.status = 'sent';
            escalations.push({ unit: u.unit, streak, status: 'confirmed' });
          } catch (error) {
            episode.escalation = { status: 'rejected', at: now, reason: error.message };
            candidateRecord.status = 'rejected';
            escalations.push({ unit: u.unit, streak, status: 'rejected' });
          }
        } else {
          // Recorded in candidatesFile as pending escalation candidate when no live transport token is supplied.
          escalations.push({ unit: u.unit, streak, status: 'candidate_recorded' });
        }
      }
    }

    unitState[u.unit] = { streak, sequence, lastFailedAt: now, detail, episode };
    await saveState();
    rows.push({ ...u, failing: true, streak });
  }

  if (candidatesDirty && !dry) {
    await atomicWrite(candidatesFile, `${JSON.stringify(candidatesDoc, null, 2)}\n`);
  }

  return {
    degraded,
    probeError: null,
    units: rows,
    wakes,
    escalations,
    candidatesFile,
  };
}

export async function runWatcherUnitHealth(config, options = {}) {
  validateWatcherUnitConfig(config);
  if (!config.stateFile) throw new Error('stateFile is required for standalone runWatcherUnitHealth');
  const stateFile = resolve(config.stateFile);
  const dry = Boolean(options.dry);
  const now = options.now ?? Date.now();

  const execute = async () => {
    let state = { version: 1, units: {} };
    try {
      const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
      if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.units)) {
        throw new Error('invalid watcher unit health state');
      }
      state = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const saveState = async () => {
      if (dry) return;
      await atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    };

    const result = await checkWatcherUnits(config, {
      ...options,
      now,
      dry,
      unitState: state.units,
      saveState,
    });
    state.lastRun = { at: now, result: result.degraded ? 'degraded' : 'complete' };
    await saveState();
    return result;
  };

  if (dry) return execute();
  return withPidLock(`${stateFile}.lock`, () => execute());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--config');
  if (at < 0 || !args[at + 1] || args.some((x, i) => !['--config', '--dry'].includes(x) && i !== at + 1)) {
    console.error('Usage: node scripts/watcher-unit-health.mjs --config <file> [--dry]');
    process.exitCode = 1;
  } else {
    try {
      const config = JSON.parse(await readFile(args[at + 1], 'utf8'));
      const dry = args.includes('--dry') || process.env.DRY_RUN === '1';
      const token = process.env[config.tokenEnv ?? 'DISCORD_BOT_TOKEN'];
      const result = await runWatcherUnitHealth(config, { dry, token });
      process.exitCode = result.degraded ? 2 : 0;
    } catch (error) {
      console.error(JSON.stringify({ stage: 'startup', result: 'failed', reason: error.message }));
      process.exitCode = 1;
    }
  }
}
