#!/usr/bin/env node
import { assertLedgerOwner } from "../lib/work-ledger-owner.mjs";
import { readFile, mkdir, writeFile, stat, readdir, unlink, link } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { cardWakePublisher, escalationReason, ledgerWakeBody, ledgerWakeName, validCardEvent } from "./card-wake.mjs";
import {
  readLedger,
  changeLedger,
  safeName,
  withLock,
  atomicJson,
  parseArgs,
  driven,
  closedProperly,
  normalizeMsgId,
  hasHumanMsgId,
  validDate,
  matchesSource,
  taskForSource,
  intakeSettings,
  isWorkerItem,
  loadLedgerConfig,
} from "./ledger.mjs";
import { configuredHumans, createAdapter } from "./messenger.mjs";
import { cleanReceipts, dueWake, receiptPath, reconcileCurrent } from "./due-timer.mjs";
import { reconcileWorkerRuns } from "./worker-run.mjs";
import { deliverIntake, orderForIntake, receiveWork, relatedSources, relatedTask } from "./work-intake.mjs";

const DEFAULT_MAX_HUMAN_WAKES = 3;
const MENTION_ONLY_MAX_WAKES = 1;
const WAKE_COOLDOWN_MS = 30 * 60000;
const DAY_MS = 24 * 60 * 60000;
const ELSEWHERE_MAX_AGE_MS = 7 * DAY_MS;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

export async function writeLedgerWake(wakeDir, { stamp, role, id, reason, title, details, once = false }) {
  const filename = (nonce = "") => ledgerWakeName({ stamp, role, id, reason }, nonce);
  const content = ledgerWakeBody({ reason, title, details });
  const write = file => writeFile(file, content, { flag: "wx", mode: 0o600 });
  const target = path.join(wakeDir, filename());
  if (once) {
    const temporary = path.join(wakeDir, `.${randomUUID()}.tmp`);
    try {
      await write(temporary);
      try { await link(temporary, target); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (await readFile(target, "utf8") !== content) throw new Error("Existing intake wake has different content");
        return false;
      }
      return true;
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }
  // wx prevents overwriting an existing wake when a prior state write failed.
  try {
    await write(target);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    await write(path.join(wakeDir, filename(`-${randomUUID().slice(0, 8)}`)));
  }
}

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

export async function watch({
  root,
  config,
  adapter,
  runner,
  unitProbe,
  pidProbe,
  configPath,
  now,
  clock = now === undefined ? Date.now : () => now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  _emitWarnings = true,
}) {
  await assertLedgerOwner(root);
  now ??= clock();
  const wakeDir = path.join(root, ".agents/work/l4/wake");
  const stateFile = path.join(root, ".agents/work/ledger", "watch-state.json");
  await mkdir(wakeDir, { recursive: true });
  const timerWarnings = [];
  if (config.due_timer?.enabled === true && Array.isArray(config.roles)) {
    try {
      timerWarnings.push(...await reconcileCurrent({ root, config, roles: config.roles.map(entry => entry.role), now, runner, configPath, overdueViaWatch: true, pruneUnknownRoles: true, reconcileWorkers: false }));
    } catch (error) { timerWarnings.push(`timer: 못 걺 (${error.message})`); }
  }
  // Instructed items are driven on the watcher's own schedule. An item the pass
  // handled gets the pass's notice in its role's box; any other overdue item
  // keeps the wake below, so a failed pass is never a silent one.
  let drive;
  let driveFailure;
  if (config.drive?.enabled === true) {
    try { drive = await (await import("./drive.mjs")).tick({ root, config, configPath, now }); }
    catch (error) { driveFailure = error.message || String(error); }
  }
  const handled = new Set(drive?.handled ?? []);
  let workerReconcile = { checked: 0, closed: [], errors: [] };
  if (Array.isArray(config.roles) && config.roles.length) {
    try {
      workerReconcile = await reconcileWorkerRuns({
        root,
        config,
        configPath,
        now,
        runner,
        unitProbe,
        pidProbe,
      });
    } catch (error) {
      workerReconcile = { checked: 0, closed: [], errors: [error.message || String(error)] };
    }
  }
  return withLock(stateFile, async () => {
    const warnings = [...timerWarnings];
    const roleMaxHumanWakes = resolveMaxHumanWakesByRole(config, warnings, _emitWarnings !== false);
    let state = emptyWatchState();
    let stateError;
    try {
      const parsedState = JSON.parse(await readFile(stateFile, "utf8"));
      ({ state, stateError } = sanitizeWatchState(parsedState, roleMaxHumanWakes, warnings));
    } catch (error) {
      if (error.code !== "ENOENT") {
        stateError = "감시 상태 파일 읽기 실패";
        state = emptyWatchState();
      }
    }
    // Receipts outlive consumed wake files and are independent of watch-state.
    const receiptDir = path.join(root, ".agents/work/ledger/human-wait-receipts");
    await mkdir(receiptDir, { recursive: true });
    const receipts = new Set();
    const oldWakeFiles = await readdir(wakeDir);
    for (const [key, at] of Object.entries(state.human_wait_sent)) {
      if (now - at >= 48 * 60 * 60000) continue;
      const name = Buffer.from(key).toString("base64url") + ".json";
      try { await writeFile(path.join(receiptDir, name), JSON.stringify({ key, at }), { flag: "wx", mode: 0o600 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    for (const name of await readdir(receiptDir)) {
      const file = path.join(receiptDir, name);
      let at;
      try { at = JSON.parse(await readFile(file, "utf8")).at; } catch { at = (await stat(file)).mtimeMs; }
      if (Number.isFinite(at) && now - at > 48 * 60 * 60000) await unlink(file);
      else receipts.add(name);
    }
    const wakes = [];
    const cardWakes = cardWakePublisher({ root, wakeDir, state, oldWakeFiles, wakes });
    await cardWakes.flush();
    const readCache = new Map();
    const failedThisRound = new Set();
    const successfulThisRound = new Set();
    let readStarted = false;
    let retryWaitMs = 0;
    let sharedMessenger = adapter;
    let messengerRoundStarted = false;
    const networkChecks = [];
    const intakeRoles = [];
    async function readMessages(messenger, channel, since) {
      const key = `messages:${channel}`;
      if (!readCache.has(key))
        readCache.set(key, readWithRetry(() => messenger.messages(channel, since)));
      return readCache.get(key);
    }
    async function readReply(messenger, channel, id) {
      if (!messenger.replyReference) return null;
      const key = `reply:${JSON.stringify([channel, id])}`;
      if (!readCache.has(key)) {
        readCache.set(key, readWithRetry(() => messenger.replyReference(channel, id)).catch(error => {
          if (error.status === 403 || error.status === 404) return null;
          throw error;
        }));
      }
      return readCache.get(key);
    }
    async function readWithRetry(read) {
      const interval = config.channel_read_interval_ms ?? 300;
      if (readStarted && interval > 0) await sleep(interval);
      readStarted = true;
      try {
        return await read();
      } catch (error) {
        const limited = error.status === 429 || /HTTP 429/.test(error.message || "");
        if (!limited || error.retry_exhausted) throw error;
        const seconds = Number(error.retry_after ?? 1);
        const delay = (Number.isFinite(seconds) && seconds >= 0 ? seconds : 1) * 1000;
        if (delay > 5000 || retryWaitMs + delay > 30000) throw error;
        retryWaitMs += delay;
        await sleep(delay);
        return read();
      }
    }
    async function channelFailure(role, channel, error, suffix = "") {
      if (!(error.status === 429 || /HTTP 429/.test(error.message || ""))) {
        if (!failedThisRound.has(channel)) delete state.channel_failures[channel];
        errors.push(`messenger:${role}:${channel}${suffix}`);
        await wake(
          role, `messenger-error-${safeIdPart(channel)}${suffix ? "-threads" : ""}`,
          "감시 실패", "메신저 읽기 실패",
          `채널: ${channel}\n오류: ${error.message || String(error)}`,
        );
        return;
      }
      if (!failedThisRound.has(channel)) {
        state.channel_failures[channel] = (state.channel_failures[channel] || 0) + 1;
        failedThisRound.add(channel);
      }
      warnings.push(`messenger:${role}:${channel}: ${error.message || String(error)}`);
      if (state.channel_failures[channel] >= 3)
        await wake(
          role, `messenger-error-${safeIdPart(channel)}`,
          "감시 실패", "메신저 읽기 연속 실패",
          `채널: ${channel}\n연속 실패: ${state.channel_failures[channel]}회\n오류: ${error.message || String(error)}`,
        );
    }
    const errors = [];
    if (driveFailure !== undefined) errors.push("drive");
    if (config.due_timer?.enabled === true) await cleanReceipts(root, now);
    let sequence = 0;
    function safeIdPart(raw) {
      try {
        return safeName(raw);
      } catch {
        const cleaned = String(raw ?? "")
          .replace(/[^a-zA-Z0-9_-]+/g, "_")
          .replace(/^[^a-zA-Z0-9]+/, "")
          .slice(0, 40);
        const hex =
          Buffer.from(String(raw ?? "")).toString("hex").slice(0, 16) || "0";
        return cleaned ? `${cleaned}-${hex}` : `id-${hex}`;
      }
    }
    async function wake(role, id, reason, title, details = "", dedupKey, force = false) {
      safeName(role);
      safeName(id);
      const key = dedupKey || JSON.stringify([role, id, reason]);
      if (!force && state.sent[key] !== undefined && now - state.sent[key] < WAKE_COOLDOWN_MS)
        return;
      const stamp = new Date(now + sequence++).toISOString().replace(/\D/g, "");
      await writeLedgerWake(wakeDir, { stamp, role, id, reason, title, details });
      state.sent[key] = now;
      wakes.push({ role, id, reason });
      return true;
    }
    if (!Array.isArray(config.roles) || !config.roles.length)
      throw new Error("Configuration requires roles");
    for (const roleConfig of config.roles) {
      let role;
      try { role = safeName(roleConfig.role); if (role.length > 240) throw new Error("Role too long"); }
      catch (error) { warnings.push(`ledger:${roleConfig?.role}: ${error.message}`); continue; }
      if (stateError) {
        errors.push(stateError);
        await wake(role, "watch-error", "감시 실패", stateError);
        stateError = undefined;
      }
      let ledger;
      try {
        try {
          ledger = await readLedger(root, role);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          const initialReport = roleOption(roleConfig, config, "report", undefined);
          await changeLedger(root, role, (l) => {
            l.report = {
              every_min: initialReport?.every_min ?? 0,
              channel: initialReport?.channel || "",
              last_msg_id: null,
              last_at: null,
            };
          });
          ledger = await readLedger(root, role);
        }
      } catch (error) {
        errors.push(`ledger:${role}`);
        await wake(
          role,
          "ledger-error",
          "감시 실패",
          "장부 읽기 실패",
          `장부: .agents/work/ledger/${role}.json\n오류: ${error.message || String(error)}`,
        );
        continue;
      }
      cardWakes.observedRole(role);
      const driveErrors = driveFailure !== undefined
        ? (ledger.items.some((item) => driven(item) && !closedProperly(item)) ? [driveFailure] : [])
        : (drive?.errors ?? []).filter((text) => text.startsWith(`${role}: `));
      if (driveErrors.length) {
        if (driveFailure === undefined) errors.push(`drive:${role}`);
        await wake(
          role,
          "drive-error",
          "감시 실패",
          "굴리기 실패",
          `장부: .agents/work/ledger/${role}.json\n오류: ${driveErrors.join("\n")}`,
        );
      }
      const workerProbeErrors = workerReconcile.errors.filter((text) => text.startsWith(`${role}/`));
      if (workerProbeErrors.length) {
        errors.push(`worker-reconcile:${role}`);
        await wake(
          role,
          "worker-reconcile-error",
          "감시 실패",
          "일꾼 상태 확인 실패",
          `장부: .agents/work/ledger/${role}.json\n오류: ${workerProbeErrors.join("\n")}`,
        );
      }
      for (const closedWorker of workerReconcile.closed.filter((entry) => entry.role === role && entry.status === "failed")) {
        const wakeReason =
          closedWorker.reason === "unit-missing" || closedWorker.reason === "process-missing" || closedWorker.reason === "no-unit-or-pid"
            ? "일꾼 유닛 사라짐"
            : "일꾼 비정상 종료";
        await wake(
          role,
          safeIdPart(`worker-dead-${closedWorker.id}`),
          wakeReason,
          closedWorker.title || closedWorker.id,
          `일꾼 ID: ${closedWorker.id}\n부모 줄: ${closedWorker.parent ?? "(없음)"}\n도구: ${closedWorker.tool}\n유닛: ${closedWorker.unit ?? "(없음)"}\n사유: ${closedWorker.reason ?? "(없음)"}\n결과: ${closedWorker.result ?? "(없음)"}\n로그: ${closedWorker.log ?? "(없음)"}`,
        );
      }
      for (const item of ledger.items) {
        if (isWorkerItem(item)) continue;
        const details = `출처: ${item.from.channel}/${item.from.msg_id}\n기한: ${item.due}\n결과: ${item.worker?.result || "(없음)"}`;
        if (item.status === "open" && Date.parse(item.due) < now && !handled.has(`${role}/${item.id}`)) {
          const key = JSON.stringify([role, item.id, "기한 넘음", item.due]);
          let failedReceipt = false;
          try { failedReceipt = JSON.parse(await readFile(receiptPath(root, role, item.id, item.due), "utf8")).status === "failed"; }
          catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
          if (config.due_timer?.enabled === true || failedReceipt) {
            const emitted = await dueWake({ root, role, id: item.id, due: item.due, now, source: "watch", lastSent: state.sent[key],
              emit: (latest, status) => wake(role, latest.id, status === "failed" ? "정한 시각" : "기한 넘음", latest.title,
                `출처: ${latest.from.channel}/${latest.from.msg_id}\n기한: ${latest.due}\n결과: ${latest.worker?.result || "(없음)"}\n늦음 ${Math.floor((now - Date.parse(latest.due)) / 60000)}분`, key, status === "failed") });
            if (emitted) state.sent[JSON.stringify([role, item.id, "기한 넘음"])] = now;
          } else {
            // A timer may have fired just before the feature was disabled.
            // Honor that receipt without starting any systemd operation.
            try {
              const receipt = JSON.parse(await readFile(receiptPath(root, role, item.id, item.due), "utf8"));
              if (receipt && typeof receipt === "object" && receipt.status === "sent" && receipt.role === role && receipt.id === item.id &&
                  receipt.due === item.due && Number.isFinite(receipt.at) && receipt.at <= now) {
                const legacyKey = JSON.stringify([role, item.id, "기한 넘음"]);
                state.sent[legacyKey] = Math.max(state.sent[legacyKey] ?? 0, receipt.at);
                state.sent[key] = Math.max(state.sent[key] ?? 0, receipt.at);
              }
            } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
            if (await wake(role, item.id, "기한 넘음", item.title, details)) state.sent[key] = now;
          }
        } else if (item.status === "waiting_human" && Date.parse(item.due) < now) {
          if (await wake(role, item.id, "기한 넘음", item.title, details)) {
            const nextDue = new Date(now + DAY_MS).toISOString();
            ledger = await changeLedger(root, role, (l) => {
              const target = l.items.find(
                (i) => i.id === item.id && i.status === "waiting_human",
              );
              if (!target || target.due !== item.due) return;
              target.due = nextDue;
            });
          }
        } else if (item.status === "escalated_human") {
          const legacyDetails = `${details}\n메모: ${item.note || "(없음)"}`;
          const escalation = item.result ? `${legacyDetails}\n카드 결과: ${item.result}` : legacyDetails;
          await cardWakes.observe({ role, item, reason: escalationReason, legacyDetails, details: escalation,
            revision: [item.title, escalation, item.drop_count ?? 0, item.defer_count ?? 0],
            evidenceAt: Math.max(Date.parse(item.checked_at) || 0, Date.parse(item.updated_at) || 0) });
        }
        if (item.worker) {
          try {
            const info = await stat(path.resolve(root, item.worker.done_file), { bigint: true });
            if (!item.checked_at || BigInt(Date.parse(item.checked_at)) * 1000000n < info.mtimeNs)
              await cardWakes.workerResult(role, item, details, info);
          } catch (error) {
            if (error.code !== "ENOENT") {
              cardWakes.keepWorker(role, item.id);
              errors.push(`worker:${role}:${item.id}`);
              await wake(
                role,
                item.id,
                "감시 실패",
                "일꾼 끝 파일 확인 실패",
                details,
              );
            }
          }
        }
      }
      const configuredReport = roleOption(roleConfig, config, "report", undefined);
      const report =
        ledger.report.every_min === 0 && configuredReport
          ? {
              ...ledger.report,
              every_min: configuredReport.every_min,
              channel: configuredReport.channel,
            }
          : ledger.report;
      if (
        report.every_min > 0 &&
        (report.last_at === null ||
          now - Date.parse(report.last_at) >= report.every_min * 60000)
      )
        await wake(
          role,
          "report",
          "정기 보고 시각",
          `${report.every_min}분 정기 보고`,
          `출처: ${report.channel}\n기한: ${report.last_at ? new Date(Date.parse(report.last_at) + report.every_min * 60000).toISOString() : "첫 보고 대기"}\n결과: (없음)`,
        );
      const intake = intakeSettings(config, roleConfig);
      if (intake.enabled === true) intakeRoles.push(role);
      networkChecks.push(async () => {
      try {
        if (intake.enabled === true && intake.since !== undefined && !validDate(intake.since))
          throw new Error("intake.since must be a UTC ISO date");
        const directChannels = roleOption(roleConfig, config, "direct_channels", []);
        const channels = [...new Set([
          ...roleOption(roleConfig, config, "channels", []),
          ...directChannels,
        ])];
        const humans = configuredHumans(config, roleConfig);
        const relays = [
          ...new Set([
            ...(roleConfig.relay_ids ?? []),
            ...(config.defaults?.relay_ids ?? []),
            ...(config.relay_ids ?? []),
            ...(roleConfig.relay_bot_ids ?? []),
            ...(config.defaults?.relay_bot_ids ?? []),
            ...(config.relay_bot_ids ?? []),
            ...(roleConfig.relay_user_ids ?? []),
            ...(config.defaults?.relay_user_ids ?? []),
            ...(config.relay_user_ids ?? []),
            ...(roleConfig.webhook_ids ?? []),
            ...(config.defaults?.webhook_ids ?? []),
            ...(config.webhook_ids ?? []),
          ]),
        ];
        // user_ids는 봇 정체성이므로 역할별로만 설정한다(defaults·최상위 상속 금지).
        const identities = roleConfig.user_ids ?? [];
        const roleIds = roleOption(roleConfig, config, "role_ids", []);
        const ownTargets = [...new Set([...identities, ...roleIds])];
        if (channels.length && (!humans.length || !ownTargets.length))
          throw new Error(
            "Messenger watch requires human_ids and role user_ids",
          );
        const maxHumanWakes =
          roleMaxHumanWakes.get(role) ?? DEFAULT_MAX_HUMAN_WAKES;
        const checkUnrecordedHuman =
          roleOption(roleConfig, config, "check_unrecorded_human", true) !== false;
        const elsewhereIds = await loadAnsweredElsewhere({
          root,
          configPath,
          configured: roleOption(roleConfig, config, "answered_elsewhere_file", undefined),
          warnings,
          role,
          now,
        });
        const messenger = sharedMessenger ??= (channels.length ? createAdapter(config.provider) : null);
        if (messenger && !messengerRoundStarted) {
          messenger.beginRound?.();
          messengerRoundStarted = true;
        }
        const maxThreads =
          roleConfig.max_threads ??
          config.defaults?.max_threads ??
          config.max_threads ??
          config.provider?.max_threads ??
          25;
        const visitedThreads = new Set(channels);
        for (const channel of channels) {
          const since = now - 24 * 60 * 60000;
          let channelMessages;
          try {
            safeName(channel);
            channelMessages = await readMessages(messenger, channel, since);
          } catch (error) {
            await channelFailure(role, channel, error);
            continue;
          }
          successfulThisRound.add(channel);
          const messages = channelMessages.map((m) => ({
            ...m,
            channel: m.channel || channel,
          }));
          const threadStarterAuthor = new Map();
          const discoveredThreads = new Set(channelMessages.threadIds || []);
          for (const m of channelMessages) {
            const tid = m?.thread_id || m?.thread?.id;
            // A question's own thread can contain the answer after archiving.
            if (tid) {
              discoveredThreads.add(tid);
              if (m.author_id) threadStarterAuthor.set(tid, m.author_id);
            }
          }
          const guildId =
            roleConfig.guild_id ??
            config.defaults?.guild_id ??
            config.guild_id ??
            config.provider?.guild_id ??
            null;
          if (typeof messenger.threads === "function") {
            try {
              const activeThreads = await readWithRetry(() =>
                messenger.threads(channel, channelMessages, { guildId, all: true, direct: directChannels.includes(channel) }),
              );
              for (const [tid, owner] of activeThreads?.threadOwners ?? [])
                if (owner && !threadStarterAuthor.has(tid)) threadStarterAuthor.set(tid, owner);
              for (const value of activeThreads || []) {
                const tid = typeof value === "string" ? value : value.id;
                if (tid) discoveredThreads.add(tid);
                const owner = typeof value === "string" ? activeThreads.threadOwners?.get(tid) : value.owner_id;
                if (owner && !threadStarterAuthor.has(tid)) threadStarterAuthor.set(tid, owner);
              }
            } catch (error) {
              // Thread discovery failing must not mark a successful channel read failed.
              if (error.status === 429 || /HTTP 429/.test(error.message || ""))
                warnings.push(`messenger:${role}:${channel}:threads: ${error.message || String(error)}`);
              else await channelFailure(role, channel, error, ":threads");
            }
          }
          const candidateThreads = [...discoveredThreads].filter(
            (tid) => tid && !visitedThreads.has(tid),
          );
          const threadLimit = Math.max(0, maxThreads);
          const cursorKey = `${role}:${channel}`;
          const previousThreadCursor = state.thread_cursors[cursorKey];
          let threadIds = [];
          if (threadLimit > 0 && candidateThreads.length > 0) {
            if (candidateThreads.length <= threadLimit) {
              threadIds = candidateThreads;
              state.thread_cursors[cursorKey] = 0;
            } else {
              const start =
                (state.thread_cursors[cursorKey] ?? 0) %
                candidateThreads.length;
              for (let i = 0; i < threadLimit; i++) {
                threadIds.push(
                  candidateThreads[(start + i) % candidateThreads.length],
                );
              }
              state.thread_cursors[cursorKey] =
                (start + threadLimit) % candidateThreads.length;
            }
          }
          const readChannelsInScan = new Set([channel]);
          for (const threadId of threadIds) {
            visitedThreads.add(threadId);
            let threadMessages;
            try {
              safeName(threadId);
              threadMessages = await readMessages(messenger, threadId, since);
            } catch (error) {
              await channelFailure(role, threadId, error);
              continue;
            }
            successfulThisRound.add(threadId);
            readChannelsInScan.add(threadId);
            for (const tm of threadMessages) {
              messages.push({ ...tm, channel: tm.channel || threadId });
            }
          }
          const byId = new Map(messages.map((m) => [m.id, m]));
          const otherRoleUserIds = config.roles
            .filter((r) => r.role !== role)
            .flatMap((r) => r.user_ids ?? [])
            .filter((id) => !identities.includes(id));
          const otherIdentities = config.roles
            .filter((r) => r.role !== role)
            .flatMap((r) => [...(r.user_ids ?? []), ...(r.role_ids ?? [])])
            .filter((id) => !ownTargets.includes(id));
          function isHumanOrRelay(m) {
            if (
              identities.includes(m.author_id) ||
              otherRoleUserIds.includes(m.author_id)
            )
              return false;
            if (humans.includes(m.author_id) || relays.includes(m.author_id))
              return true;
            if (m.webhook_id) return true;
            if (humans.some((h) => (m.body || "").includes(`[${h}]`)))
              return true;
            return false;
          }
          function extractMentions(m) {
            const mentions = new Set(
              (m.mentions ?? []).map((value) =>
                typeof value === "string" ? value : value.id,
              ),
            );
            for (const match of (m.body || "").matchAll(/<@!?(\w[\w-]*)>/g))
              mentions.add(match[1]);
            const roleMentions = new Set(
              (m.mention_roles ?? []).map((value) =>
                typeof value === "string" ? value : value.id,
              ),
            );
            for (const match of (m.body || "").matchAll(/<@&(\w[\w-]*)>/g))
              roleMentions.add(match[1]);
            const allMentions = new Set([...mentions, ...roleMentions]);
            const everyoneOrHere =
              m.mention_everyone === true ||
              /(?<![\p{L}\p{N}_@])@(?:everyone|here)\b/u.test(m.body || "");
            const tokens = [
              ...[...mentions].filter(Boolean).map((id) => `u:${id}`),
              ...[...roleMentions].filter(Boolean).map((id) => `r:${id}`),
              ...(everyoneOrHere ? ["all"] : []),
            ].sort();
            return {
              mentions,
              roleMentions,
              allMentions,
              everyoneOrHere,
              tokens,
            };
          }
          function extractItemMentions(i) {
            const quote = i?.from?.quote || "";
            const mentions = new Set(
              (i?.from?.mentions ?? []).map((value) =>
                typeof value === "string" ? value : value.id,
              ),
            );
            for (const match of quote.matchAll(/<@!?(\w[\w-]*)>/g))
              mentions.add(match[1]);
            const roleMentions = new Set(
              (i?.from?.mention_roles ?? []).map((value) =>
                typeof value === "string" ? value : value.id,
              ),
            );
            for (const match of quote.matchAll(/<@&(\w[\w-]*)>/g))
              roleMentions.add(match[1]);
            const everyoneOrHere =
              i?.from?.mention_everyone === true ||
              /(?<![\p{L}\p{N}_@])@(?:everyone|here)\b/u.test(quote);
            return new Set([
              ...[...mentions].filter(Boolean).map((id) => `u:${id}`),
              ...[...roleMentions].filter(Boolean).map((id) => `r:${id}`),
              ...(everyoneOrHere ? ["all"] : []),
            ]);
          }
          function addressed(m, followsRecordedTask = false) {
            const { allMentions, everyoneOrHere } = extractMentions(m);
            const ownMention = ownTargets.some((id) => allMentions.has(id));
            const parentAuthor =
              m.reply_to_author_id ||
              m.reply_to?.author_id ||
              m.reply_to?.author?.id ||
              byId.get(m.reply_to_id)?.author_id ||
              threadStarterAuthor.get(m.channel);
            const ownReply = ownTargets.includes(parentAuthor);
            const inDirectChannel =
              directChannels.includes(channel) ||
              directChannels.includes(m.channel);
            if (ownMention || ownReply || inDirectChannel) return true;
            const otherReply = Boolean(
              parentAuthor &&
                (otherIdentities.includes(parentAuthor) ||
                  (!ownTargets.includes(parentAuthor) &&
                    !humans.includes(parentAuthor) &&
                    !relays.includes(parentAuthor))),
            );
            if (otherReply) return false;
            return everyoneOrHere || followsRecordedTask;
          }
          function messageTimes(m) {
            const createdMs = Date.parse(m.created_at || m.timestamp);
            const rawEdit = m.edited_at || m.edited_timestamp;
            const editedMs = rawEdit ? Date.parse(rawEdit) : NaN;
            const isEdited = Number.isFinite(editedMs) && editedMs > createdMs;
            const effectiveMs = isEdited ? editedMs : createdMs;
            return { createdMs, editedMs, isEdited, effectiveMs };
          }
          const humanWait = {
            ...(config.defaults?.human_wait ?? {}),
            ...(config.human_wait ?? {}),
            ...(roleConfig.human_wait ?? {}),
          };
          const cleanBody = (body) => (body || "")
            .replace(/```[\s\S]*?(?:```|$)/g, "")
            .replace(/~~~[\s\S]*?(?:~~~|$)/g, "")
            .replace(/^\s*>.*$/gm, "").replace(/`[^`]*`/g, "");
          const questionMatchers = (humanWait.question_patterns ?? [
            "[?？](?:\\s|$)", "될까요", "(?:골라\\s*주시면|고르시면)",
            "(?:답변|응답|승인)을?\\s*기다리겠습니다",
            "(?:시각|시간|선택|승인|결정).*(?:알려|말씀)\\s*주시면",
          ]).map((pattern) => new RegExp(pattern, "u"));
          const groups = [];
          for (const post of [...messages].sort((a, b) => messageTimes(a).createdMs - messageTimes(b).createdMs)) {
            if (!identities.includes(post.author_id)) continue;
            const previous = groups.at(-1);
            if (previous && previous.author_id === post.author_id && previous.channel === post.channel &&
                (previous.parts.at(-1).body || "").length >= 1900 &&
                messageTimes(post).createdMs - messageTimes(previous.parts.at(-1)).createdMs <= 120000 &&
                // Split sends are contiguous: an intervening participant starts a new utterance.
                !messages.some((m) => m.channel === post.channel && m.author_id !== post.author_id &&
                  messageTimes(m).createdMs > messageTimes(previous.parts.at(-1)).createdMs &&
                  messageTimes(m).createdMs < messageTimes(post).createdMs)) previous.parts.push(post);
            else groups.push({ ...post, parts: [post] });
          }
          for (const question of groups) {
            const body = question.parts.map((part) => cleanBody(part.body)).join("\n");
            const parentAuthor = question.parts.map((part) => part.reply_to_author_id ||
              part.reply_to?.author_id || part.reply_to?.author?.id ||
              byId.get(part.reply_to_id)?.author_id).find(Boolean);
            const mentioned = extractMentions({ body }).mentions;
            const implicit = directChannels.includes(question.channel) ||
              humans.includes(threadStarterAuthor.get(question.channel));
            const targets = humans.filter((id) => mentioned.has(id) || id === parentAuthor ||
              (implicit && (!threadStarterAuthor.get(question.channel) || threadStarterAuthor.get(question.channel) === id)));
            if (!targets.length) continue;
            if (/[?？][ \t]*(?:네|아니요)[,，]?[ \t]+[^\r\n]*(?:시작했|진행했|완료했)/u.test(body)) continue;
            // Keep a standalone addressee attached to its following question.
            // A blank line starts a new scope, so a human report cannot lend its
            // recipient to a separate paragraph directed at another bot.
            const isQuestion = body.split(/\n\s*\n/).some((block) => {
              let scopedMentions = new Set();
              return block.split(/\n+|(?<=[.!?？])\s+/).some((sentence) => {
                const mentions = extractMentions({ body: sentence }).mentions;
                for (const id of mentions) scopedMentions.add(id);
                if (!questionMatchers.some((pattern) => pattern.test(sentence))) return false;
                if ([...scopedMentions].some((id) => otherRoleUserIds.includes(id)) &&
                    !targets.some((id) => scopedMentions.has(id))) return false;
                if (/(?:문제|이상|추가로? 필요).*(?:알려|말씀).*주시면.*(?:수정|반영)/u.test(sentence)) return false;
                return true;
              });
            });
            if (!isQuestion) continue;
            const questionAt = messageTimes(question).createdMs;
            if (!Number.isFinite(questionAt) || questionAt < since || questionAt > now ||
                now - questionAt < (humanWait.after_min ?? 15) * 60000) continue;
            const questionChannel = question.channel || channel;
            const ids = question.parts.map((part) => part.id);
            const continued = messages.some((post) => targets.includes(post.author_id) &&
              ((post.channel || channel) === questionChannel || ids.includes(post.reply_to_id) ||
                ids.includes(post.channel) || question.parts.some((part) =>
                  post.channel === part.thread_id || post.channel === part.thread?.id)) &&
              messageTimes(post).createdMs > questionAt && messageTimes(post).createdMs <= now);
            const key = JSON.stringify([role, questionChannel, question.id]);
            const receipt = Buffer.from(key).toString("base64url") + ".json";
            const wasSent = question.parts.some((part) => {
              const partKey = JSON.stringify([role, questionChannel, part.id]);
              const partReceipt = Buffer.from(partKey).toString("base64url") + ".json";
              return state.human_wait_sent[partKey] !== undefined || receipts.has(partReceipt) ||
                oldWakeFiles.some((name) => name.includes(`-ledger-human-wait-${safeIdPart(part.id)}-`) && name.endsWith(`-route-${role}.md`));
            });
            if (wasSent && !receipts.has(receipt)) {
              await writeFile(path.join(receiptDir, receipt), JSON.stringify({ key, at: now }), { mode: 0o600 });
              receipts.add(receipt);
            }
            if (continued || wasSent || receipts.has(receipt)) continue;
            const guild = question.guild_id || guildId || channelMessages.guildId || "@me";
            const url = question.url || messenger.messageUrl?.(questionChannel, question.id) ||
              `https://discord.com/channels/${guild}/${questionChannel}/${question.id}`;
            const firstLine = body.split(/\r?\n/).find((line) => line.trim()) || "(질문)";
            await wake(
              role, `human-wait-${safeIdPart(question.id)}`,
              "사람 답 기다림", firstLine,
              `채널: ${questionChannel}\n글: ${url}\n질문: ${firstLine}\n1) 이 일에 이미 받은 지시가 있는지 그 채널 앞 글을 다시 읽음\n2) 바깥 발송·운영 변경·돈이 아니고 되돌릴 수 있으면 지금 진행하고 그 채널에 알림\n3) 정말 사람 승인이 필요한 일이면 #업무-요청 에 [분류] 양식으로 옮김\n사람 답을 기다려야 하면 대기 카드를 waiting 으로 남기고 recheck_at 과 request_ref 를 채우세요.`,
            );
            for (const part of question.parts) {
              const partKey = JSON.stringify([role, questionChannel, part.id]);
              const partReceipt = Buffer.from(partKey).toString("base64url") + ".json";
              await writeFile(path.join(receiptDir, partReceipt), JSON.stringify({ key: partKey, at: now }), { mode: 0o600 });
              receipts.add(partReceipt);
              state.human_wait_sent[partKey] = now;
            }
          }
          if (!checkUnrecordedHuman && intake.enabled !== true) continue;
          const seenInScan = new Set();
          const intakePage = intake.enabled === true ? orderForIntake(messages, channel, discoveredThreads) : null;
          for (const m of intakePage?.ordered ?? messages) {
            seenInScan.add(m.id);
            try {
              if (!isHumanOrRelay(m)) continue;
              const { createdMs, editedMs, isEdited, effectiveMs } = messageTimes(m);
              if (!Number.isFinite(effectiveMs) || effectiveMs > now) continue;
              if (intake.enabled === true && intake.since && createdMs < Date.parse(intake.since)) continue;
              const msgChannel = m.channel || channel;
              if (intake.enabled === true && hasHumanMsgId(m.id) && effectiveMs >= since && !isMentionOnlyBody(m)) {
                // The legacy reminder also recognizes quoted identities. Creating
                // a work item requires an identity from the installation settings.
                if (!humans.includes(m.author_id) && !relays.includes(m.author_id) && !relays.includes(m.webhook_id)) continue;
                const answered = elsewhereIds.get(m.id);
                if (answered !== undefined && answered >= effectiveMs) continue;
                const mentions = extractMentions(m);
                const pointsElsewhere = otherIdentities.some(id => mentions.allMentions.has(id));
                if (pointsElsewhere && !mentions.everyoneOrHere && !ownTargets.some(id => mentions.allMentions.has(id))) continue;
                if (!addressed(m, true)) continue;
                const recorded = taskForSource(ledger.items, msgChannel, m.id);
                const related = recorded ? [] : await relatedSources(m, channel, intakePage, ledger.items,
                  (referenceChannel, id) => readReply(messenger, referenceChannel, id));
                if (!addressed(m, Boolean(recorded || relatedTask(ledger.items, related)))) continue;
                const body = String(m.body || "").trim();
                ledger = await receiveWork({
                  root, roleConfig, ledger, related, revision: effectiveMs, edited: isEdited, now, minutes: intake.defaultDueMinutes ?? 120,
                  title: body.replace(/\s+/g, " ").slice(0, 120) || "(본문 없음)",
                  source: { channel: msgChannel, msg_id: normalizeMsgId(m.id), quote: body.slice(0, 200),
                    mentions: [...mentions.mentions], mention_roles: [...mentions.roleMentions], mention_everyone: mentions.everyoneOrHere },
                });
                continue;
              }
              if (!checkUnrecordedHuman || !addressed(m)) continue;
              // 사람 글은 장부 기록(또는 명시된 answered_elsewhere_file) 없이 답글·후속 글만으로 닫히지 않는다.
              const mThreadId =
                msgChannel !== channel || discoveredThreads.has(msgChannel)
                  ? msgChannel
                  : m.thread_id || m.thread?.id || null;
              let latestThreadHumanMs = -Infinity;
              for (const post of messages) {
                if (post.id === m.id || !isHumanOrRelay(post)) continue;
                const postCh = post.channel || channel;
                const sameThread =
                  (mThreadId !== null && postCh === mThreadId) ||
                  (postCh !== channel && postCh === m.id);
                if (!sameThread) continue;
                const postEffMs = messageTimes(post).effectiveMs;
                if (
                  Number.isFinite(postEffMs) &&
                  postEffMs > effectiveMs &&
                  postEffMs <= now &&
                  postEffMs > latestThreadHumanMs
                ) {
                  latestThreadHumanMs = postEffMs;
                }
              }
              const reopenMs = Math.max(
                isEdited ? editedMs : -Infinity,
                latestThreadHumanMs,
              );
              const msgMentions = extractMentions(m);
              const { tokens: msgMentionTokens } = msgMentions;
              const mentionSignature = JSON.stringify(msgMentionTokens);
              const recordedItems = ledger.items.filter(
                (i) => !isWorkerItem(i) && matchesSource(i.from, msgChannel, m.id),
              );
              const isRecorded = recordedItems.some((i) => {
                if (i.status === "waiting_human") {
                  if (Number.isFinite(reopenMs)) {
                    const handledAt = i.checked_at || i.created_at;
                    if (!handledAt || Date.parse(handledAt) < reopenMs)
                      return false;
                  }
                  if (!isEdited) return true;
                } else if (!isEdited) {
                  return true;
                } else {
                  const handledAt = i.checked_at;
                  if (!handledAt || Date.parse(handledAt) < editedMs)
                    return false;
                }
                const itemMentions = extractItemMentions(i);
                const hasRecordedContext =
                  Boolean(i.from?.quote) ||
                  Array.isArray(i.from?.mentions) ||
                  Array.isArray(i.from?.mention_roles) ||
                  itemMentions.size > 0;
                if (hasRecordedContext) {
                  return msgMentionTokens.every((tok) =>
                    itemMentions.has(tok),
                  );
                }
                return true;
              });
              // 수정 시각이 answered-elsewhere 기록 시각보다 뒤면 수정 재감지가 우선한다.
              const elsewhereAt = elsewhereIds.get(m.id);
              const isRecordedElsewhere =
                elsewhereAt !== undefined && (!isEdited || elsewhereAt >= editedMs);
              const wakeId = `human-${safeName(m.id)}`;
              const wakeKey = JSON.stringify([
                role,
                wakeId,
                "장부에 없는 사람 글",
              ]);
              const clearHumanWakeState = () => {
                delete state.sent[wakeKey];
                delete state.mentions[wakeKey];
                delete state.wake_counts[wakeKey];
                delete state.wake_mention_only[wakeKey];
                delete state.wake_meta[wakeKey];
              };
              const bodyText = String(m.body || "").trim();
              const itemTitle =
                bodyText.replace(/\s+/g, " ").slice(0, 120) || "(본문 없음)";
              if (effectiveMs < since) {
                if (
                  !recordedItems.length &&
                  !isRecordedElsewhere
                ) {
                  ledger = await upsertWaitingHuman({
                    root,
                    role,
                    msgId: m.id,
                    msgChannel,
                    title: itemTitle,
                    quote: bodyText.slice(0, 200),
                    mentions: [...msgMentions.mentions],
                    roleMentions: [...msgMentions.roleMentions],
                    everyoneOrHere: msgMentions.everyoneOrHere,
                    reopenMs: effectiveMs,
                    note: "24시간 감시 창 밖 미등록 글 사람 대기 등록",
                    now,
                  });
                }
                clearHumanWakeState();
                delete state.wake_reset_at[wakeKey];
                continue;
              }
              if (
                isRecorded ||
                isRecordedElsewhere
              ) {
                clearHumanWakeState();
                delete state.wake_reset_at[wakeKey];
                continue;
              }
              const mentionOnly = isMentionOnlyBody(m);
              const wakeLimit = mentionOnly
                ? MENTION_ONLY_MAX_WAKES
                : maxHumanWakes;
              let priorCount = state.wake_counts[wakeKey] ?? 0;
              const mentionsChanged =
                isEdited &&
                state.mentions[wakeKey] !== undefined &&
                state.mentions[wakeKey] !== mentionSignature;
              const promotedToBody =
                isEdited && state.wake_mention_only[wakeKey] === true && !mentionOnly;
              const resetBaseline =
                state.wake_reset_at[wakeKey] ??
                Math.max(createdMs, state.sent[wakeKey] ?? -Infinity);
              const hasNewActivity =
                Number.isFinite(reopenMs) && reopenMs > resetBaseline;
              if (
                mentionsChanged ||
                promotedToBody ||
                (hasNewActivity && priorCount >= wakeLimit)
              ) {
                clearHumanWakeState();
                if (Number.isFinite(reopenMs)) state.wake_reset_at[wakeKey] = reopenMs;
                priorCount = 0;
              } else if (hasNewActivity) {
                state.wake_counts[wakeKey] = 0;
                state.wake_reset_at[wakeKey] = reopenMs;
                priorCount = 0;
              }
              if (priorCount >= wakeLimit) {
                const cooldownElapsed =
                  state.sent[wakeKey] === undefined ||
                  now - state.sent[wakeKey] >= WAKE_COOLDOWN_MS;
                if (cooldownElapsed) {
                  ledger = await upsertWaitingHuman({
                    root,
                    role,
                    msgId: m.id,
                    msgChannel,
                    title: itemTitle,
                    quote: bodyText.slice(0, 200),
                    mentions: [...msgMentions.mentions],
                    roleMentions: [...msgMentions.roleMentions],
                    everyoneOrHere: msgMentions.everyoneOrHere,
                    reopenMs: Number.isFinite(reopenMs) ? reopenMs : effectiveMs,
                    note: `재깨움 ${wakeLimit}회 상한 뒤 사람 대기 등록`,
                    now,
                  });
                  clearHumanWakeState();
                  delete state.wake_reset_at[wakeKey];
                }
                continue;
              }
              const woken = await wake(
                role,
                wakeId,
                "장부에 없는 사람 글",
                m.body || "(본문 없음)",
                `출처: ${msgChannel}/${m.id}\n기한: (미등록)\n결과: (없음)`,
              );
              if (woken) {
                state.mentions[wakeKey] = mentionSignature;
                state.wake_counts[wakeKey] = priorCount + 1;
                if (Number.isFinite(reopenMs)) state.wake_reset_at[wakeKey] = reopenMs;
                if (mentionOnly) state.wake_mention_only[wakeKey] = true;
                else delete state.wake_mention_only[wakeKey];
                state.wake_meta[wakeKey] = {
                  role,
                  channel: msgChannel,
                  scan_channel: channel,
                  msg_id: m.id,
                  title: itemTitle,
                  quote: bodyText.slice(0, 200),
                  mentions: [...msgMentions.mentions],
                  mention_roles: [...msgMentions.roleMentions],
                  mention_everyone: msgMentions.everyoneOrHere,
                  effective_ms: effectiveMs,
                };
              }
            } catch (error) {
              const sourceChannel = m?.channel || channel;
              if (intake.enabled === true && sourceChannel !== channel) {
                if (previousThreadCursor === undefined) delete state.thread_cursors[cursorKey];
                else state.thread_cursors[cursorKey] = previousThreadCursor;
              }
              errors.push(`messenger:${role}:${sourceChannel}:${m?.id}`);
              await wake(
                role,
                `messenger-error-${safeIdPart(`${sourceChannel}-${m?.id}`)}`,
                "감시 실패",
                "메신저 메시지 처리 실패",
                `공급자: ${config.provider?.type || "(미설정)"}\n채널: ${sourceChannel}\n메시지: ${m?.id}\n오류: ${error.message || String(error)}`,
              );
            }
          }
          if (!checkUnrecordedHuman) continue;
          // 24시간 감시 창을 벗어나 API 응답에서 빠진 미등록 사람 글을 버리기 전에 waiting_human으로 등록한다.
          for (const [wk, meta] of Object.entries(state.wake_meta)) {
            if (meta.role !== role || meta.scan_channel !== channel) continue;
            if (seenInScan.has(meta.msg_id)) continue;
            if (!readChannelsInScan.has(meta.channel) && meta.channel !== channel) continue;
            if (!(meta.effective_ms < since)) continue;
            const recorded = taskForSource(ledger.items, meta.channel, meta.msg_id);
            const metaElsewhereAt = elsewhereIds.get(meta.msg_id);
            const metaElsewhere =
              metaElsewhereAt !== undefined && metaElsewhereAt >= meta.effective_ms;
            const beforeIntake = intake.enabled === true && intake.since && meta.effective_ms < Date.parse(intake.since);
            if (!recorded && !metaElsewhere && !beforeIntake) {
              ledger = await upsertWaitingHuman({
                root,
                role,
                msgId: meta.msg_id,
                msgChannel: meta.channel,
                title: meta.title || "(본문 없음)",
                quote: meta.quote || "",
                mentions: Array.isArray(meta.mentions) ? meta.mentions : [],
                roleMentions: Array.isArray(meta.mention_roles)
                  ? meta.mention_roles
                  : [],
                everyoneOrHere: meta.mention_everyone === true,
                reopenMs: meta.effective_ms,
                note: "24시간 감시 창 밖 미등록 글 사람 대기 등록",
                now,
              });
            }
            delete state.sent[wk];
            delete state.mentions[wk];
            delete state.wake_counts[wk];
            delete state.wake_mention_only[wk];
            delete state.wake_reset_at[wk];
            delete state.wake_meta[wk];
          }
        }
      } catch (error) {
        errors.push(`messenger:${role}`);
        await wake(
          role,
          "messenger-error",
          "감시 실패",
          "메신저 읽기 실패",
          `공급자: ${config.provider?.type || "(미설정)"}\n오류: ${error.message || String(error)}`,
        );
      }
      });
    }
    for (const check of networkChecks) await check();
    for (const role of intakeRoles) {
      try {
        wakes.push(...await deliverIntake(root, role, notice => writeLedgerWake(wakeDir, notice)));
      } catch (error) {
        errors.push(`intake:${role}: ${error.message}`);
      }
    }
    // Keep only recent dedup entries; timers do not grow the state indefinitely.
    state.sent = Object.fromEntries(
      Object.entries(state.sent).filter(([, at]) => now - at < 24 * 60 * 60000),
    );
    state.human_wait_sent = Object.fromEntries(
      Object.entries(state.human_wait_sent).filter(([, at]) => now - at < 48 * 60 * 60000),
    );
    state.mentions = Object.fromEntries(
      Object.entries(state.mentions).filter(([k]) => k in state.sent),
    );
    state.wake_counts = Object.fromEntries(
      Object.entries(state.wake_counts).filter(([k]) => k in state.sent),
    );
    state.wake_mention_only = Object.fromEntries(
      Object.entries(state.wake_mention_only).filter(([k]) => k in state.sent),
    );
    state.wake_reset_at = Object.fromEntries(
      Object.entries(state.wake_reset_at).filter(([k]) => k in state.sent),
    );
    state.wake_meta = Object.fromEntries(
      Object.entries(state.wake_meta).filter(
        ([k, meta]) => k in state.sent || now - meta.effective_ms < 48 * 60 * 60000,
      ),
    );
    for (const channel of successfulThisRound) {
      if (!failedThisRound.has(channel)) delete state.channel_failures[channel];
    }
    cardWakes.endInactive();
    await atomicJson(stateFile, state);
    await cardWakes.flush(true);
    return {
      wakes,
      errors,
      warnings,
      ...(drive ? { drive: { launched: drive.launched, alerts: drive.alerts, skipped: drive.skipped } } : {}),
      ...(workerReconcile.closed.length ? { workerReconcile } : {}),
    };
  });
}
export async function main(args = process.argv.slice(2)) {
  const { opts } = parseArgs(args);
  const root = path.resolve(opts.root || process.cwd());
  const { config } = await loadLedgerConfig({
    root,
    configPath: opts.config,
    requireConfig: true,
    requireRole: false,
  });
  const result = await watch({
    root,
    config,
    configPath: opts.config ? path.resolve(root, opts.config) : undefined,
    _emitWarnings: false,
  });
  for (const warning of result.warnings)
    console.warn(`work-ledger-watch warning: ${warning}`);
  console.log(JSON.stringify({ event: "work-ledger-watch", ...result }));
  if (result.errors.length) process.exitCode = 1;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(`work-ledger-watch failed: ${error.message}`);
    process.exitCode = 1;
  });
