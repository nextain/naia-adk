import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {safeName,changeLedger,normalizeMsgId,matchesSource,taskForSource} from './ledger.mjs';
import {validCardEvent} from './card-wake.mjs';

const DEFAULT_MAX_HUMAN_WAKES = 3;
const MENTION_ONLY_MAX_WAKES = 1;
const WAKE_COOLDOWN_MS = 30 * 60000;
const DAY_MS = 24 * 60 * 60000;
const ELSEWHERE_MAX_AGE_MS = 7 * DAY_MS;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

function roleOption(roleConfig, config, key, fallback) {
  if (roleConfig?.[key] !== undefined) return roleConfig[key];
  if (config?.defaults?.[key] !== undefined) return config.defaults[key];
  if (config?.[key] !== undefined) return config[key];
  return fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveMaxHumanWakesByRole(config, warnings, emitStderr) {
  const byRole = new Map();
  const warnedSources = new Set();
  if (!Array.isArray(config?.roles)) return byRole;
  for (const rc of config.roles) {
    let roleName;
    try {
      roleName = safeName(rc?.role);
    } catch {
      continue;
    }
    const raw = roleOption(rc, config, "max_human_wakes", undefined);
    let resolved = DEFAULT_MAX_HUMAN_WAKES;
    if (raw !== undefined) {
      if (Number.isInteger(raw) && raw >= 1) {
        resolved = raw;
      } else {
        const source =
          rc?.max_human_wakes !== undefined
            ? roleName
            : config?.defaults?.max_human_wakes !== undefined
              ? "defaults"
              : "config";
        if (!warnedSources.has(source)) {
          warnedSources.add(source);
          const msg = `config:${source}: max_human_wakes(${JSON.stringify(raw)})는 1 이상의 정수가 아니므로 기본값 ${DEFAULT_MAX_HUMAN_WAKES} 사용`;
          warnings.push(msg);
          if (emitStderr) console.warn(`work-ledger-watch warning: ${msg}`);
        }
      }
    }
    byRole.set(roleName, resolved);
  }
  return byRole;
}

function isMentionOnlyBody(m) {
  if (Array.isArray(m?.attachments) && m.attachments.length > 0) return false;
  if (Array.isArray(m?.embeds) && m.embeds.length > 0) return false;
  const stripped = String(m?.body ?? m?.content ?? "")
    .replace(/<@!?\w[\w-]*>/g, "")
    .replace(/<@&\w[\w-]*>/g, "")
    .replace(/<#\w[\w-]*>/g, "")
    .replace(/(?<![\p{L}\p{N}_@])@(?:everyone|here)\b/gu, "")
    .trim();
  return stripped.length === 0;
}

/**
 * answered-elsewhere 파일 줄(`<글 ID> <기록 시각 ISO> <이유>`)을 파싱한다.
 * 7일 지난 항목과 시각 형식이 잘못된 항목은 건너뛴다.
 */
function parseAnsweredElsewhere(text, now, warnings, label) {
  const entries = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+)\s+(\S+)(?:\s+(.+))?$/.exec(line);
    if (!match) {
      warnings?.push(`elsewhere:${label}: 형식 오류 줄 무시`);
      continue;
    }
    const [, msgId, iso] = match;
    const recordedMs = ISO_TIMESTAMP_RE.test(iso) ? Date.parse(iso) : NaN;
    if (!Number.isFinite(recordedMs)) {
      warnings?.push(`elsewhere:${label}: 잘못된 시각 줄 무시 (${msgId})`);
      continue;
    }
    if (now - recordedMs > ELSEWHERE_MAX_AGE_MS) continue;
    const prev = entries.get(msgId);
    if (prev === undefined || recordedMs > prev) entries.set(msgId, recordedMs);
  }
  return entries;
}

/**
 * 설정에 명시한 `answered_elsewhere_file`만 읽는다(자동 경로 탐색 없음).
 */
async function loadAnsweredElsewhere({
  root,
  configPath,
  configured,
  warnings,
  role,
  now,
}) {
  const entries = new Map();
  if (configured === undefined || configured === false || configured === null)
    return entries;
  const configuredPaths = (Array.isArray(configured) ? configured : [configured])
    .filter((item) => typeof item === "string" && item.trim() !== "");
  for (const entry of configuredPaths) {
    const candidates = path.isAbsolute(entry)
      ? [entry]
      : [
          path.resolve(root, entry),
          ...(configPath ? [path.resolve(path.dirname(configPath), entry)] : []),
        ];
    for (const file of [...new Set(candidates)]) {
      try {
        const parsed = parseAnsweredElsewhere(
          await readFile(file, "utf8"),
          now,
          warnings,
          `${role}:${file}`,
        );
        for (const [id, ts] of parsed) {
          const prev = entries.get(id);
          if (prev === undefined || ts > prev) entries.set(id, ts);
        }
        break;
      } catch (error) {
        if (error.code !== "ENOENT") {
          warnings.push(`elsewhere:${role}:${file}: ${error.message || String(error)}`);
          break;
        }
      }
    }
  }
  return entries;
}

function emptyWatchState() {
  return {
    version: 1,
    sent: {},
    thread_cursors: {},
    mentions: {},
    wake_counts: {},
    wake_mention_only: {},
    wake_reset_at: {},
    wake_meta: {},
    card_events: {},
    human_wait_sent: {},
    channel_failures: {},
  };
}

/**
 * watch-state.json에서 손상된 개별 항목만 버리고 나머지 유효 상태는 유지한다.
 * wake_counts 정수는 `[0, 상한]` 범위로 자른다.
 */
function sanitizeWatchState(raw, roleMaxHumanWakes, warnings) {
  if (!isPlainObject(raw)) {
    return { state: emptyWatchState(), stateError: "감시 상태 파일 읽기 실패" };
  }
  let partialCorrupt = false;
  const pickMap = (value, pred) => {
    if (value === undefined) return {};
    if (!isPlainObject(value)) {
      partialCorrupt = true;
      return {};
    }
    const clean = {};
    for (const [k, v] of Object.entries(value)) {
      if (pred(k, v)) clean[k] = v;
      else partialCorrupt = true;
    }
    return clean;
  };
  const topInvalid = raw.version !== 1 || !isPlainObject(raw.sent);
  const mentionOnlyMap = pickMap(raw.wake_mention_only, (k, v) => typeof k === "string" && typeof v === "boolean");
  const resolveCap = (wakeKey) => {
    let roleCap = DEFAULT_MAX_HUMAN_WAKES;
    try {
      const parsedKey = JSON.parse(wakeKey);
      if (Array.isArray(parsedKey) && typeof parsedKey[0] === "string" && roleMaxHumanWakes.has(parsedKey[0])) {
        roleCap = roleMaxHumanWakes.get(parsedKey[0]);
      }
    } catch { /* fallback to default cap */ }
    return mentionOnlyMap[wakeKey] === true ? Math.min(roleCap, MENTION_ONLY_MAX_WAKES) : roleCap;
  };
  const cleanCounts = {};
  if (raw.wake_counts !== undefined) {
    if (!isPlainObject(raw.wake_counts)) {
      partialCorrupt = true;
    } else {
      for (const [k, v] of Object.entries(raw.wake_counts)) {
        if (!Number.isInteger(v)) {
          partialCorrupt = true;
          continue;
        }
        const cap = resolveCap(k);
        const clamped = Math.max(0, Math.min(cap, v));
        if (clamped !== v) partialCorrupt = true;
        cleanCounts[k] = clamped;
      }
    }
  }
  const state = {
    version: 1,
    sent: isPlainObject(raw.sent) ? pickMap(raw.sent, (_, v) => Number.isFinite(v)) : {},
    human_wait_sent: pickMap(raw.human_wait_sent, (_, v) => Number.isFinite(v) && v >= 0),
    channel_failures: pickMap(raw.channel_failures, (_, v) => Number.isFinite(v) && v >= 0),
    thread_cursors: pickMap(raw.thread_cursors, (_, v) => Number.isInteger(v) && v >= 0),
    mentions: pickMap(raw.mentions, (_, v) => typeof v === "string"),
    wake_mention_only: mentionOnlyMap,
    wake_reset_at: pickMap(raw.wake_reset_at, (_, v) => Number.isFinite(v) && v >= 0),
    wake_meta: pickMap(
      raw.wake_meta,
      (_, v) =>
        isPlainObject(v) &&
        typeof v.role === "string" &&
        typeof v.channel === "string" &&
        typeof v.msg_id === "string" &&
        Number.isFinite(v.effective_ms),
    ),
    wake_counts: cleanCounts,
    card_events: pickMap(raw.card_events, validCardEvent),
  };
  if (topInvalid) {
    return { state, stateError: "감시 상태 파일 읽기 실패" };
  }
  if (partialCorrupt) {
    warnings.push("watch-state: 손상된 항목을 제외하거나 횟수 범위를 보정함");
  }
  return { state, stateError: undefined };
}

async function upsertWaitingHuman({
  root,
  role,
  msgId,
  msgChannel,
  title,
  quote,
  mentions,
  roleMentions,
  everyoneOrHere,
  reopenMs,
  note,
  now,
}) {
  return changeLedger(root, role, async (l) => {
    const fromObj = {
      channel: msgChannel,
      msg_id: msgId,
      quote,
      mentions,
      mention_roles: roleMentions,
      mention_everyone: everyoneOrHere,
    };
    const nextDue = new Date(now + 4 * 60 * 60000).toISOString();
    const nextCreated = new Date(now).toISOString();
    const trimmedMsgId = normalizeMsgId(msgId);
    const existing = l.items.find(
      (i) => matchesSource(i.from, msgChannel, trimmedMsgId) && i.status === "waiting_human",
    );
    if (existing) {
      const handledMs = Date.parse(existing.checked_at || existing.created_at);
      if (Number.isFinite(reopenMs) && (!Number.isFinite(handledMs) || reopenMs > handledMs)) {
        existing.title = title;
        existing.from = fromObj;
        existing.due = nextDue;
        existing.created_at = nextCreated;
        existing.checked_at = null;
        existing.note = note;
      }
      return;
    }
    if (taskForSource(l.items, msgChannel, trimmedMsgId)) return;
    const baseId = `human-${safeName(msgId)}`;
    let itemId = baseId;
    let suffix = 2;
    while (l.items.some((i) => i.id === itemId)) itemId = `${baseId}-${suffix++}`;
    l.items.push({
      id: itemId,
      title,
      from: fromObj,
      due: nextDue,
      created_at: nextCreated,
      status: "waiting_human",
      worker: null,
      checked_at: null,
      note,
    });
  });
}


export {DEFAULT_MAX_HUMAN_WAKES,MENTION_ONLY_MAX_WAKES,WAKE_COOLDOWN_MS,roleOption,resolveMaxHumanWakesByRole,isMentionOnlyBody,loadAnsweredElsewhere,emptyWatchState,sanitizeWatchState,upsertWaitingHuman};
