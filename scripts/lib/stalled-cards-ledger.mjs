import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readWorkLedger } from './ledger.mjs';
import { safeName } from '../work-ledger/ledger.mjs';
import { readWorkLedgerMeta } from '../../packages/core/work-ledger-meta.mjs';

export { readWorkLedgerMeta };

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
const KNOWN_STATUSES = new Set([...OPEN_STATUSES, ...HUMAN_WAIT_STATUSES, ...CLOSED_STATUSES]);

const nonEmpty = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const nonEmptyLine = value => {
  const clean = nonEmpty(value);
  return clean && !/[\r\n\0]/.test(clean) ? clean : null;
};
const isHttpUrl = value => /^https?:\/\//i.test(value);

/**
 * Parse an ISO-8601 timestamp with timezone, rejecting calendar rollover dates.
 */
export function parseIsoTime(value) {
  if (typeof value !== 'string') return NaN;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return NaN;
  const wall = new Date(Date.parse(value.slice(0, 19) + 'Z'));
  return wall.toISOString().slice(0, 19) === value.slice(0, 19) ? ms : NaN;
}

function resolveWakeDir(role, wlRole, meta) {
  const direct = nonEmptyLine(role.wakeDir);
  if (direct) return direct;
  const raw = nonEmptyLine(wlRole?.wake_dir);
  if (!raw || !meta?.root) return null;
  return isAbsolute(raw) ? raw : resolve(meta.root, raw);
}

/** Return true when a ledger row tracks a worker run rather than a task card. */
function isWorkerLedgerItem(item) {
  return Boolean(item && typeof item === 'object' && !Array.isArray(item) && item.kind === 'worker');
}

function validateJsonItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('invalid json ledger item');
  safeName(item.id);
  if (typeof (item.title ?? item.task) !== 'string') throw Error('invalid json ledger title');
  if (typeof item.status !== 'string' || !KNOWN_STATUSES.has(item.status)) throw Error('invalid json ledger status');
  for (const key of ['created_at', 'checked_at', 'updated_at', 'progress_at', 'status_changed_at']) {
    if (item[key] != null && !Number.isFinite(parseIsoTime(item[key]))) throw Error(`invalid json ledger ${key}`);
  }
}

async function readRoleJsonLedger(filePath, roleId) {
  const raw = await readFile(filePath, 'utf8');
  const doc = JSON.parse(raw);
  if (!doc || typeof doc !== 'object' || doc.version !== 1 || doc.role !== roleId || !Array.isArray(doc.items)) {
    throw Error('invalid json ledger schema');
  }
  const seen = new Set();
  for (const item of doc.items) {
    if (isWorkerLedgerItem(item)) safeName(item.id);
    else validateJsonItem(item);
    if (seen.has(item.id)) throw Error('duplicate json ledger item');
    seen.add(item.id);
  }
  return doc;
}

function collectLedgerTimestamps(entries, now) {
  return entries
    .map(([source, iso]) => ({ source, at: parseIsoTime(iso) }))
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
  if (!wakeDir) errors.push('wake dir unavailable');

  if (config.workLedger) {
    try {
      const rows = (await readWorkLedger(config.workLedger, now)).filter(r => r.role === role.id);
      yamlKnown = true;
      for (const row of rows) {
        if (isWorkerLedgerItem(row)) continue;
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
          isKnownStatus: KNOWN_STATUSES.has(row.status),
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

  if (role.ledgerFile || meta) {
    try {
      const jsonPath = role.ledgerFile ?? join(meta.dir, `${safeName(role.id)}.json`);
      const doc = await readRoleJsonLedger(jsonPath, role.id);
      jsonKnown = true;
      for (const item of doc.items) {
        if (isWorkerLedgerItem(item)) continue;
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
          isKnownStatus: KNOWN_STATUSES.has(item.status),
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
