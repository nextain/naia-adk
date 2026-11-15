import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { readWorkLedger } from './ledger.mjs';
import { safeName } from '../work-ledger/ledger.mjs';

const execFileAsync = promisify(execFile);

const OPEN_STATUSES = new Set(['open', '진행 중']);
const HUMAN_WAIT_STATUSES = new Set([
  'waiting_human',
  'blocked-human',
  'blocked_human',
  'human-approval-wait',
  'waiting-approval',
  'waiting',
  '대기',
  '막힘',
]);
const CLOSED_STATUSES = new Set(['done', 'dropped', '끝']);

const nonEmpty = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const isHttpUrl = value => /^https?:\/\//i.test(value);
const singleLine = value => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
const time = value => {
  if (typeof value !== 'string') return NaN;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
};

async function optionalStat(filePath) {
  try { return (await stat(filePath)).mtimeMs; }
  catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return null; throw e; }
}

async function gitOutput(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: 5000, maxBuffer: 65536 });
  return stdout.trim();
}

function inside(base, target) {
  const rel = relative(base, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Resolve linked result path latest commit timestamp at or before `now`.
 */
async function resultCommitAt(resultPath, workspace, now) {
  const probeDir = await optionalStat(resultPath).then(ms => (ms !== null ? resultPath : null))
    .catch(() => null);
  let startDir = dirname(resultPath);
  if (probeDir !== null) {
    try { if ((await stat(resultPath)).isDirectory()) startDir = resultPath; } catch { /* ignore */ }
  }
  const candidates = [...new Set([startDir, workspace].filter(Boolean))];
  for (const dir of candidates) {
    let repoRoot;
    try { repoRoot = await gitOutput(dir, ['rev-parse', '--show-toplevel']); }
    catch { continue; }
    if (!inside(repoRoot, resultPath)) continue;
    const rel = relative(repoRoot, resultPath) || '.';
    try {
      const isoBefore = new Date(now).toISOString();
      const raw = await gitOutput(repoRoot, ['log', '-1', `--before=${isoBefore}`, '--format=%cI', '--', rel]);
      const at = time(raw);
      if (Number.isFinite(at) && at <= now) return at;
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolve staleMinutes, repeatMinutes, and escalateAfterCount thresholds from config.
 */
export function resolveCardThresholds(config) {
  const staleMinutes = config.staleMinutes ?? (config.staleHours !== undefined ? config.staleHours * 60 : 90);
  const repeatMinutes = config.repeatMinutes ?? 30;
  const escalateAfterCount = config.escalateAfterCount ?? 3;
  return {
    staleMinutes,
    staleMs: staleMinutes * 60000,
    repeatMinutes,
    repeatMs: repeatMinutes * 60000,
    escalateAfterCount,
  };
}

/**
 * Read optional work-ledger.json metadata to find ledger dir, wake_dir, and report channel per role.
 */
export async function readWorkLedgerMeta(config) {
  if (!config.workLedgerConfig && !config.workLedgerDir) return null;
  let ledgerConfig = null;
  let root = config.workLedgerRoot ?? null;
  if (config.workLedgerConfig) {
    ledgerConfig = JSON.parse(await readFile(config.workLedgerConfig, 'utf8'));
    if (!ledgerConfig || typeof ledgerConfig !== 'object' || Array.isArray(ledgerConfig)) {
      throw Error('invalid workLedgerConfig');
    }
    if (!root) {
      const parent = dirname(config.workLedgerConfig);
      root = parent.endsWith(`${sep}config`) || parent.endsWith('/config') ? dirname(parent) : parent;
    }
  }
  const dir = config.workLedgerDir ?? join(root, '.agents/work/ledger');
  if (!root) root = dirname(dirname(dirname(dir)));
  return { root, dir, config: ledgerConfig };
}

function resolveWakeDir(role, wlRole, meta) {
  if (role.wakeDir) return role.wakeDir;
  const raw = nonEmpty(wlRole?.wake_dir);
  if (!raw || !meta?.root) return null;
  return isAbsolute(raw) ? raw : resolve(meta.root, raw);
}

function validateJsonItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('invalid json ledger item');
  safeName(item.id);
  if (typeof (item.title ?? item.task) !== 'string') throw Error('invalid json ledger title');
  if (typeof item.status !== 'string') throw Error('invalid json ledger status');
  for (const key of ['created_at', 'checked_at', 'updated_at', 'progress_at', 'status_changed_at']) {
    if (item[key] != null && !Number.isFinite(time(item[key]))) throw Error(`invalid json ledger ${key}`);
  }
}

async function readRoleJsonLedger(filePath, roleId) {
  let raw;
  try { raw = await readFile(filePath, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const doc = JSON.parse(raw);
  if (!doc || typeof doc !== 'object' || doc.version !== 1 || doc.role !== roleId || !Array.isArray(doc.items)) {
    throw Error('invalid json ledger schema');
  }
  const seen = new Set();
  for (const item of doc.items) {
    validateJsonItem(item);
    if (seen.has(item.id)) throw Error('duplicate json ledger item');
    seen.add(item.id);
  }
  return doc;
}

function collectLedgerTimestamps(entries, now) {
  return entries
    .map(([source, iso]) => ({ source, at: time(iso) }))
    .filter(e => Number.isFinite(e.at) && e.at <= now);
}

function uniqueResultPaths(values, baseDirs) {
  const roots = [...new Set(baseDirs.filter(Boolean))];
  const out = [];
  for (const raw of values) {
    const clean = nonEmpty(raw);
    if (!clean || isHttpUrl(clean)) continue;
    if (isAbsolute(clean)) {
      if (!out.includes(clean)) out.push(clean);
      continue;
    }
    for (const base of roots) {
      const abs = resolve(base, clean);
      if (!out.includes(abs)) out.push(abs);
    }
  }
  return out;
}

/**
 * Collect normalized open & non-open cards for `role` from YAML and/or JSON work ledgers.
 */
export async function collectRoleCards({ config, role, meta, now }) {
  const cards = [];
  const errors = [];
  let yamlKnown = !config.workLedger;
  let jsonKnown = !(config.workLedgerDir || config.workLedgerConfig || role.ledgerFile);
  const wlRole = meta?.config?.roles?.find(r => r?.role === role.id) ?? null;
  const wakeDir = resolveWakeDir(role, wlRole, meta);

  if (config.workLedger) {
    try {
      const rows = (await readWorkLedger(config.workLedger, now)).filter(r => r.role === role.id);
      yamlKnown = true;
      for (const row of rows) {
        const isOpen = OPEN_STATUSES.has(row.status);
        const progressDisabled = row.progress === false;
        const ledgerEvidence = collectLedgerTimestamps([
          ['장부 진행 표시', row.progress_at],
          ['장부 상태 전이', row.status_changed_at],
          ...(!progressDisabled ? [['장부 행 갱신', row.updated_at]] : []),
          ['장부 요청', row.requested_at],
        ], now);
        cards.push({
          cardKey: `yaml:${row.id}`,
          id: row.id,
          title: row.task,
          status: row.status,
          isOpen,
          isHumanWait: HUMAN_WAIT_STATUSES.has(row.status),
          isClosed: CLOSED_STATUSES.has(row.status),
          due: row.due_at ?? null,
          resultPaths: uniqueResultPaths([row.result, row.result_path], [role.workspace, meta?.root]),
          humanChannel: nonEmpty(row.report_channel ?? row.channel ?? row.from_channel)
            ?? nonEmpty(role.reportChannel)
            ?? nonEmpty(wlRole?.report?.channel)
            ?? nonEmpty(config.notifications?.escalation?.channelId),
          wakeDir,
          ledgerEvidence,
        });
      }
    } catch {
      errors.push('work ledger unavailable');
    }
  }

  const jsonPath = role.ledgerFile ?? (meta ? join(meta.dir, `${safeName(role.id)}.json`) : null);
  if (jsonPath) {
    try {
      const doc = await readRoleJsonLedger(jsonPath, role.id);
      jsonKnown = true;
      for (const item of doc?.items ?? []) {
        const isOpen = OPEN_STATUSES.has(item.status);
        const progressDisabled = item.progress === false;
        const rawProgress = [
          ['장부 진행 표시', item.progress_at],
          ['장부 상태 전이', item.status_changed_at],
          ['장부 확인(touch)', item.checked_at],
          ['일꾼 실행 시작', item.drive?.run?.started_at],
          ['일꾼 실행 종료', item.drive?.run?.ended_at],
          ['일꾼 등록', item.drive?.registered_at],
          ...(!progressDisabled ? [['장부 행 갱신', item.updated_at]] : []),
          ['카드 생성', item.created_at],
        ];
        cards.push({
          cardKey: `json:${item.id}`,
          id: item.id,
          title: item.title ?? item.task,
          status: item.status,
          isOpen,
          isHumanWait: HUMAN_WAIT_STATUSES.has(item.status),
          isClosed: CLOSED_STATUSES.has(item.status),
          due: item.due ?? null,
          resultPaths: uniqueResultPaths(
            [item.result, item.result_path, item.worker?.result, item.worker?.done_file, item.drive?.result_file],
            [meta?.root, role.workspace],
          ),
          humanChannel: nonEmpty(item.report_channel ?? item.channel)
            ?? nonEmpty(doc?.report?.channel)
            ?? nonEmpty(wlRole?.report?.channel)
            ?? nonEmpty(item.from?.channel)
            ?? nonEmpty(role.reportChannel)
            ?? nonEmpty(config.notifications?.escalation?.channelId),
          wakeDir,
          ledgerEvidence: collectLedgerTimestamps(rawProgress, now),
        });
      }
    } catch {
      if (!errors.includes('work ledger unavailable')) errors.push('work ledger unavailable');
    }
  }

  return { cards, wakeDir, ledgerKnown: yamlKnown && jsonKnown, errors };
}

/**
 * Evaluate per-card progress evidence (excluding plain Discord replies) and stall state.
 */
export async function evaluateCardStall({ card, role, record, now, staleMs }) {
  const prevStatuses = record.cardStatuses ?? {};
  const prior = prevStatuses[card.cardKey];
  const nextEvidence = [...card.ledgerEvidence];

  if (card.isOpen) {
    if (prior && prior.status !== card.status && Number.isFinite(now)) {
      // Transitioning from human-wait or another state into open counts as transition evidence.
      record.cardTransitions ??= {};
      record.cardTransitions[card.cardKey] = now;
    }
    const recordedTransition = record.cardTransitions?.[card.cardKey];
    if (Number.isFinite(recordedTransition) && recordedTransition <= now) {
      nextEvidence.push({ source: '장부 상태 전이', at: recordedTransition });
    }
    for (const resPath of card.resultPaths) {
      const mtimeAt = await optionalStat(resPath);
      if (Number.isFinite(mtimeAt) && mtimeAt <= now) {
        nextEvidence.push({ source: '결과 경로 mtime', at: mtimeAt });
      }
      const commitAt = await resultCommitAt(resPath, role.workspace, now);
      if (Number.isFinite(commitAt) && commitAt <= now) {
        nextEvidence.push({ source: '결과 경로 커밋', at: commitAt });
      }
    }
  }

  const latest = nextEvidence.length
    ? nextEvidence.reduce((best, cur) => (cur.at > best.at ? cur : best))
    : null;
  const fallbackFirst = record.cardFirstSeen?.[card.cardKey] ?? now;
  const effectiveAt = latest ? latest.at : fallbackFirst;
  const stalledMs = Math.max(0, now - effectiveAt);
  const stalled = card.isOpen && stalledMs >= staleMs;

  return {
    ...card,
    evidenceSources: nextEvidence,
    lastEvidenceAt: latest ? latest.at : null,
    lastEvidenceSource: latest ? latest.source : '관찰 시작(증거 없음)',
    effectiveAt,
    stalledMs,
    stalled,
  };
}

function buildWakeFilename({ stamp, cardId, roleId, cardKey, disambiguate = false }) {
  const safeId = cardId.replace(/[^a-zA-Z0-9._-]/g, '_') || 'card';
  const safeRole = roleId.replace(/[^a-zA-Z0-9._-]/g, '_') || 'role';
  const route = `-route-${safeRole}.md`;
  const keyTag = disambiguate || safeId !== cardId
    ? `-${createHash('sha256').update(cardKey).digest('hex').slice(0, 8)}`
    : '';
  const candidate = `${stamp}-stalled-${safeId}${keyTag}${route}`;
  if (Buffer.byteLength(candidate) <= 255) return candidate;
  const hash = createHash('sha256').update(JSON.stringify([cardKey, roleId, stamp])).digest('hex');
  const maxBody = Math.max(16, 255 - Buffer.byteLength(route));
  return `${stamp}-stalled-${hash}`.slice(0, maxBody) + route;
}

function formatStallDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return hours > 0 ? `${totalMin}분 (${hours}시간 ${mins}분)` : `${totalMin}분`;
}

export function formatStalledCardWake({ roleId, card, wakeCount, escalateAfterCount }) {
  const evidenceText = card.lastEvidenceAt !== null
    ? `${card.lastEvidenceSource} (${new Date(card.lastEvidenceAt).toISOString()})`
    : '없음';
  const lines = [
    `[장부] 멈춘 카드: ${singleLine(card.title)}`,
    `역할: ${singleLine(roleId)}`,
    `카드 id: ${singleLine(card.id)}`,
    `멈춘 시간: ${formatStallDuration(card.stalledMs)}`,
    `마지막 증거: ${evidenceText}`,
    `기한: ${card.due ? singleLine(card.due) : '없음'}`,
    `결과 경로: ${card.resultPaths.length ? card.resultPaths.join(', ') : '없음'}`,
    `반복 횟수: ${wakeCount}회`,
  ];
  if (wakeCount >= escalateAfterCount) {
    const channel = card.humanChannel ? singleLine(card.humanChannel) : '미설정(장부 사람 채널 확인 필요)';
    lines.push(`보고 대상(사람 채널): ${channel}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Reconcile per-card episode state and emit deduplicated repeat/escalated wake files into role.wakeDir.
 */
export async function syncCardWakes({ role, cardResults, ledgerKnown, now, dry, thresholds }) {
  const { record } = role;
  record.cardStalls ??= {};
  record.cardStatuses ??= {};
  record.cardTransitions ??= {};
  record.cardFirstSeen ??= {};

  const wakes = [];
  let previews = 0;

  if (!ledgerKnown) {
    return { wakes, previews };
  }

  const seenKeys = new Set();
  const usedFiles = new Set();
  for (const card of cardResults) {
    seenKeys.add(card.cardKey);
    record.cardStatuses[card.cardKey] = { status: card.status, at: now };

    if (!card.isOpen) {
      delete record.cardStalls[card.cardKey];
      delete record.cardTransitions[card.cardKey];
      delete record.cardFirstSeen[card.cardKey];
      continue;
    }

    if (card.lastEvidenceAt === null) {
      record.cardFirstSeen[card.cardKey] ??= now;
    } else {
      delete record.cardFirstSeen[card.cardKey];
    }

    const existing = record.cardStalls[card.cardKey];
    // New progress resets or closes the prior episode cleanly.
    if (!card.stalled || (existing && card.effectiveAt > existing.evidenceAt)) {
      delete record.cardStalls[card.cardKey];
      if (!card.stalled) continue;
    }

    if (!card.wakeDir) continue;

    const episode = record.cardStalls[card.cardKey] ??= {
      cardId: card.id,
      episodeAt: now,
      evidenceAt: card.effectiveAt,
      wakeCount: 0,
      lastWakeAt: null,
    };

    if (episode.lastWakeAt !== null && now - episode.lastWakeAt < thresholds.repeatMs) {
      continue;
    }

    const nextCount = episode.wakeCount + 1;
    const escalated = nextCount >= thresholds.escalateAfterCount;

    previews++;
    if (dry) continue;

    await mkdir(card.wakeDir, { recursive: true, mode: 0o700 });
    const stamp = new Date(now).toISOString().replace(/\D/g, '');
    let file = join(card.wakeDir, buildWakeFilename({ stamp, cardId: card.id, roleId: role.role, cardKey: card.cardKey }));
    if (usedFiles.has(file)) {
      file = join(card.wakeDir, buildWakeFilename({ stamp, cardId: card.id, roleId: role.role, cardKey: card.cardKey, disambiguate: true }));
    }
    usedFiles.add(file);
    const body = formatStalledCardWake({
      roleId: role.role,
      card,
      wakeCount: nextCount,
      escalateAfterCount: thresholds.escalateAfterCount,
    });

    let created = true;
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(body); } finally { await handle.close(); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      created = false;
    }

    episode.wakeCount = nextCount;
    episode.lastWakeAt = now;
    if (created) {
      wakes.push({
        role: role.role,
        cardId: card.id,
        title: card.title,
        wakeCount: nextCount,
        escalated,
        humanChannel: card.humanChannel,
        file,
      });
    }
  }

  for (const key of Object.keys(record.cardStalls)) {
    if (!seenKeys.has(key)) delete record.cardStalls[key];
  }
  for (const key of Object.keys(record.cardStatuses)) {
    if (!seenKeys.has(key)) {
      delete record.cardStatuses[key];
      delete record.cardTransitions[key];
      delete record.cardFirstSeen[key];
    }
  }

  return { wakes, previews };
}
