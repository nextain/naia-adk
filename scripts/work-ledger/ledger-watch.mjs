#!/usr/bin/env node
import { readFile, mkdir, writeFile, stat, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import {
  readLedger,
  changeLedger,
  safeName,
  withLock,
  atomicJson,
  parseArgs,
  driven,
  closedProperly,
} from "./ledger.mjs";
import { createAdapter } from "./messenger.mjs";
import { cleanReceipts, dueWake, receiptPath, reconcileCurrent } from "./due-timer.mjs";

const DEFAULT_REPORT_PREFIXES = ["[서버 민호 정기 보고", "[서버 민호 "];
const DEFAULT_MAX_HUMAN_WAKES = 3;
const MENTION_ONLY_MAX_WAKES = 1;
const BURST_GAP_MS = 3 * 60000;
const BURST_SPAN_MS = 5 * 60000;
const WAKE_COOLDOWN_MS = 30 * 60000;

function roleOption(roleConfig, config, key, fallback) {
  if (roleConfig?.[key] !== undefined) return roleConfig[key];
  if (config?.defaults?.[key] !== undefined) return config.defaults[key];
  if (config?.[key] !== undefined) return config[key];
  return fallback;
}

function positiveIntOption(value, fallback) {
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

function normalizePrefixes(raw) {
  if (!Array.isArray(raw)) return DEFAULT_REPORT_PREFIXES;
  return raw.filter((prefix) => typeof prefix === "string" && prefix.length > 0);
}

function isReportPost(post, prefixes) {
  if (!prefixes.length) return false;
  const body = String(post?.body ?? post?.content ?? "").trimStart();
  return prefixes.some((prefix) => body.startsWith(prefix));
}

function isMentionOnlyBody(m) {
  if (Array.isArray(m?.attachments) && m.attachments.length > 0) return false;
  const stripped = String(m?.body ?? m?.content ?? "")
    .replace(/<@!?\w[\w-]*>/g, "")
    .replace(/<@&\w[\w-]*>/g, "")
    .replace(/<#\w[\w-]*>/g, "")
    .replace(/(?<![\p{L}\p{N}_@])@(?:everyone|here)\b/gu, "")
    .trim();
  return stripped.length === 0;
}

function parseAnsweredElsewhere(text) {
  const ids = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [msgId] = line.split(/\s+/, 1);
    if (msgId) ids.add(msgId);
  }
  return ids;
}

async function loadAnsweredElsewhere({ root, configPath, configured, warnings, role }) {
  if (configured === false || configured === null) return new Set();
  const ids = new Set();
  const addFromText = (text) => {
    for (const id of parseAnsweredElsewhere(text)) ids.add(id);
  };
  if (configured !== undefined) {
    const entries = (Array.isArray(configured) ? configured : [configured])
      .filter((item) => typeof item === "string" && item.trim() !== "");
    for (const entry of entries) {
      const candidates = path.isAbsolute(entry)
        ? [entry]
        : [
            path.resolve(root, entry),
            ...(configPath ? [path.resolve(path.dirname(configPath), entry)] : []),
          ];
      for (const file of [...new Set(candidates)]) {
        try {
          addFromText(await readFile(file, "utf8"));
          break;
        } catch (error) {
          if (error.code !== "ENOENT") {
            warnings.push(`elsewhere:${role}:${file}: ${error.message || String(error)}`);
            break;
          }
        }
      }
    }
    return ids;
  }
  const autoFiles = [
    ...(configPath ? [path.join(path.dirname(configPath), "answered-elsewhere.txt")] : []),
    path.join(root, ".agents/work/ledger/answered-elsewhere.txt"),
  ];
  for (const file of [...new Set(autoFiles.map((p) => path.resolve(p)))]) {
    try {
      addFromText(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT")
        warnings.push(`elsewhere:${role}:${file}: ${error.message || String(error)}`);
    }
  }
  return ids;
}

function collectAuthorBurstIds(chList, targetIdx, authorId, targetCreatedMs, stopAuthors, getCreatedMs) {
  const ids = new Set([chList[targetIdx].id]);
  if (!Number.isFinite(targetCreatedMs)) return ids;
  for (const step of [-1, 1]) {
    let prevMs = targetCreatedMs;
    for (let j = targetIdx + step; j >= 0 && j < chList.length; j += step) {
      const om = chList[j];
      const oc = getCreatedMs(om);
      if (!Number.isFinite(oc)) break;
      if (Math.abs(oc - targetCreatedMs) > BURST_SPAN_MS) break;
      if (om.author_id === authorId) {
        if (Math.abs(oc - prevMs) > BURST_GAP_MS) break;
        ids.add(om.id);
        prevMs = oc;
      } else if (stopAuthors.has(om.author_id) || Boolean(om.webhook_id)) {
        break;
      }
    }
  }
  return ids;
}

export async function watch({
  root,
  config,
  adapter,
  runner,
  configPath,
  now,
  clock = now === undefined ? Date.now : () => now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  now ??= clock();
  const wakeDir = path.join(root, ".agents/work/l4/wake");
  const stateFile = path.join(root, ".agents/work/ledger", "watch-state.json");
  await mkdir(wakeDir, { recursive: true });
  const timerWarnings = [];
  if (config.due_timer?.enabled === true && Array.isArray(config.roles)) {
    try {
      timerWarnings.push(...await reconcileCurrent({ root, config, roles: config.roles.map(entry => entry.role), now, runner, configPath, overdueViaWatch: true, pruneUnknownRoles: true }));
    } catch (error) { timerWarnings.push(`timer: 못 걺 (${error.message})`); }
  }
  // Instructed items are driven on the watcher's own schedule. An item the pass
  // handled gets the pass's notice in its role's box; any other overdue item
  // keeps the wake below, so a failed pass is never a silent one.
  let drive;
  let driveFailure;
  if (config.drive?.enabled === true) {
    try { drive = await (await import("./drive.mjs")).tick({ root, config, now }); }
    catch (error) { driveFailure = error.message || String(error); }
  }
  const handled = new Set(drive?.handled ?? []);
  return withLock(stateFile, async () => {
    let state = { version: 1, sent: {}, thread_cursors: {}, mentions: {}, wake_counts: {}, wake_mention_only: {} };
    let stateError;
    let recoveredHumanWait = {};
    try {
      state = JSON.parse(await readFile(stateFile, "utf8"));
      if (state?.human_wait_sent && typeof state.human_wait_sent === "object" && !Array.isArray(state.human_wait_sent))
        recoveredHumanWait = Object.fromEntries(Object.entries(state.human_wait_sent).filter(([, at]) => Number.isFinite(at) && at >= 0));
      if (
        !state ||
        typeof state !== "object" ||
        Array.isArray(state) ||
        state.version !== 1 ||
        [state.human_wait_sent, state.channel_failures].some(
          (map) => map !== undefined && (
            !map || typeof map !== "object" || Array.isArray(map) ||
            Object.values(map).some((value) => !Number.isFinite(value) || value < 0)
          ),
        ) ||
        !state.sent ||
        typeof state.sent !== "object" ||
        Array.isArray(state.sent) ||
        Object.values(state.sent).some((v) => !Number.isFinite(v)) ||
        (state.thread_cursors !== undefined &&
          (!state.thread_cursors ||
            typeof state.thread_cursors !== "object" ||
            Array.isArray(state.thread_cursors) ||
            Object.values(state.thread_cursors).some(
              (v) => !Number.isInteger(v) || v < 0,
            ))) ||
        (state.mentions !== undefined &&
          (!state.mentions ||
            typeof state.mentions !== "object" ||
            Array.isArray(state.mentions))) ||
        (state.wake_counts !== undefined &&
          (!state.wake_counts ||
            typeof state.wake_counts !== "object" ||
            Array.isArray(state.wake_counts) ||
            Object.values(state.wake_counts).some(
              (v) => !Number.isInteger(v) || v < 0,
            ))) ||
        (state.wake_mention_only !== undefined &&
          (!state.wake_mention_only ||
            typeof state.wake_mention_only !== "object" ||
            Array.isArray(state.wake_mention_only) ||
            Object.values(state.wake_mention_only).some(
              (v) => typeof v !== "boolean",
            )))
      )
        throw new Error("Invalid watch state");
      state.thread_cursors ??= {};
      state.mentions ??= {};
      state.wake_counts ??= {};
      state.wake_mention_only ??= {};
    } catch (error) {
      if (error.code !== "ENOENT") {
        stateError = "감시 상태 파일 읽기 실패";
        state = { version: 1, sent: {}, thread_cursors: {}, mentions: {}, wake_counts: {}, wake_mention_only: {} };
      }
    }
    state.human_wait_sent ??= recoveredHumanWait;
    state.channel_failures ??= {};
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
    const warnings = [...timerWarnings];
    const readCache = new Map();
    const failedThisRound = new Set();
    const successfulThisRound = new Set();
    let readStarted = false;
    let retryWaitMs = 0;
    let sharedMessenger = adapter;
    let messengerRoundStarted = false;
    const networkChecks = [];
    async function readMessages(messenger, channel, since) {
      const key = `messages:${channel}`;
      if (!readCache.has(key))
        readCache.set(key, readWithRetry(() => messenger.messages(channel, since)));
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
      const route = `-route-${role}.md`;
      const filename = (nonce = "") => {
        const normal = `${stamp}-ledger-${id}${nonce}${route}`;
        if (Buffer.byteLength(normal) <= 255) return normal;
        const available = 255 - Buffer.byteLength(route);
        if (available < 5) throw new Error("Role too long for wake filename");
        return `${createHash("sha256").update(JSON.stringify([role, id, reason, stamp, nonce])).digest("hex").slice(0, available)}${route}`;
      };
      const file = path.join(wakeDir, filename());
      // wx prevents overwriting an existing wake when a prior state write failed.
      try {
        await writeFile(
          file,
          `[장부] ${reason}: ${String(title).replace(/[\r\n]/g, " ")}\n${details}\n`,
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const alternate = path.join(wakeDir, filename(`-${randomUUID().slice(0, 8)}`));
        await writeFile(alternate, `[장부] ${reason}: ${title}\n${details}\n`, {
          flag: "wx",
          mode: 0o600,
        });
      }
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
      for (const item of ledger.items) {
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
        }
        if (item.worker) {
          try {
            const info = await stat(path.resolve(root, item.worker.done_file));
            if (!item.checked_at || Date.parse(item.checked_at) < info.mtimeMs)
              await wake(
                role,
                item.id,
                "일꾼 끝, 결과 안 읽음",
                item.title,
                details,
              );
          } catch (error) {
            if (error.code !== "ENOENT") {
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
      networkChecks.push(async () => {
      try {
        const directChannels = roleOption(roleConfig, config, "direct_channels", []);
        const channels = [...new Set([
          ...roleOption(roleConfig, config, "channels", []),
          ...directChannels,
        ])];
        const humans = roleConfig.human_ids ?? roleConfig.humans ??
          config.defaults?.human_ids ?? config.defaults?.humans ??
          config.human_ids ?? config.humans ?? [];
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
        const identities = roleOption(roleConfig, config, "user_ids", []);
        const roleIds = roleOption(roleConfig, config, "role_ids", []);
        const ownTargets = [...new Set([...identities, ...roleIds])];
        if (channels.length && (!humans.length || !ownTargets.length))
          throw new Error(
            "Messenger watch requires human_ids and role user_ids",
          );
        const answeredByAnyRolePostAfter =
          roleOption(roleConfig, config, "answered_by_any_role_post_after", false) === true;
        const answeredByOwnPostAfter =
          roleOption(roleConfig, config, "answered_by_own_post_after", false) === true;
        const reportPrefixes = normalizePrefixes(
          roleOption(roleConfig, config, "report_prefixes", DEFAULT_REPORT_PREFIXES),
        );
        const maxHumanWakes = positiveIntOption(
          roleOption(roleConfig, config, "max_human_wakes", DEFAULT_MAX_HUMAN_WAKES),
          DEFAULT_MAX_HUMAN_WAKES,
        );
        const checkUnrecordedHuman =
          roleOption(roleConfig, config, "check_unrecorded_human", true) !== false;
        const elsewhereIds = await loadAnsweredElsewhere({
          root,
          configPath,
          configured: roleOption(roleConfig, config, "answered_elsewhere_file", undefined),
          warnings,
          role,
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
          function addressed(m) {
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
            if (everyoneOrHere) return true;
            return false;
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
          if (!checkUnrecordedHuman) continue;
          const orderedByChannel = new Map();
          for (const msg of messages) {
            const ch = msg.channel || channel;
            if (!orderedByChannel.has(ch)) orderedByChannel.set(ch, []);
            orderedByChannel.get(ch).push(msg);
          }
          for (const list of orderedByChannel.values()) {
            list.sort((a, b) => {
              const ta = messageTimes(a).createdMs;
              const tb = messageTimes(b).createdMs;
              if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
              return ta - tb;
            });
          }
          const stopBurstAuthors = new Set([...identities, ...humans, ...relays]);
          const replyTimeOk = (r, sinceMs) => {
            const reEffMs = messageTimes(r).effectiveMs;
            return Number.isFinite(reEffMs) && reEffMs > sinceMs && reEffMs <= now;
          };
          for (const m of messages) {
            try {
              if (!isHumanOrRelay(m) || !addressed(m)) continue;
              const { createdMs, editedMs, isEdited, effectiveMs } = messageTimes(m);
              if (
                !Number.isFinite(effectiveMs) ||
                effectiveMs < since ||
                effectiveMs > now
              )
                continue;
              const msgChannel = m.channel || channel;
              const replies = messages.filter(
                (r) =>
                  identities.includes(r.author_id) &&
                  (r.channel || channel) === msgChannel &&
                  r.reply_to_id === m.id,
              );
              const isReplied = isEdited
                ? replies.some((r) => messageTimes(r).effectiveMs >= editedMs)
                : replies.length > 0;
              const isParentReplied =
                Boolean(m.reply_to_id) &&
                messages.some(
                  (r) =>
                    identities.includes(r.author_id) &&
                    (r.channel || channel) === msgChannel &&
                    r.reply_to_id === m.reply_to_id &&
                    replyTimeOk(r, effectiveMs),
                );
              let isBurstReplied = false;
              const chList = orderedByChannel.get(msgChannel) || [];
              const targetIdx = chList.indexOf(m);
              if (targetIdx !== -1) {
                const burstIds = collectAuthorBurstIds(
                  chList,
                  targetIdx,
                  m.author_id,
                  createdMs,
                  stopBurstAuthors,
                  (post) => messageTimes(post).createdMs,
                );
                isBurstReplied = messages.some(
                  (r) =>
                    identities.includes(r.author_id) &&
                    (r.channel || channel) === msgChannel &&
                    burstIds.has(r.reply_to_id) &&
                    replyTimeOk(r, effectiveMs),
                );
              }
              const isAnsweredAfter =
                (answeredByAnyRolePostAfter || answeredByOwnPostAfter) &&
                messages.some((post) => {
                  if (!identities.includes(post.author_id)) return false;
                  if ((post.channel || channel) !== msgChannel) return false;
                  if (!replyTimeOk(post, effectiveMs)) return false;
                  if (answeredByAnyRolePostAfter) return true;
                  return !isReportPost(post, reportPrefixes);
                });
              const msgMentions = extractMentions(m);
              const { tokens: msgMentionTokens } = msgMentions;
              const mentionSignature = JSON.stringify(msgMentionTokens);
              const recordedItems = ledger.items.filter(
                (i) => i.from.msg_id === m.id,
              );
              const isRecorded = isEdited
                ? recordedItems.some((i) => {
                    const handledAt = i.checked_at || (i.status === "waiting_human" ? i.created_at : null);
                    if (!handledAt || Date.parse(handledAt) < editedMs)
                      return false;
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
                  })
                : recordedItems.length > 0;
              const isRecordedElsewhere = elsewhereIds.has(m.id);
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
              };
              if (
                isReplied ||
                isParentReplied ||
                isBurstReplied ||
                isAnsweredAfter ||
                isRecorded ||
                isRecordedElsewhere
              ) {
                clearHumanWakeState();
                continue;
              }
              const mentionOnly = isMentionOnlyBody(m);
              if (
                isEdited &&
                state.sent[wakeKey] !== undefined &&
                ((state.mentions[wakeKey] !== undefined &&
                  state.mentions[wakeKey] !== mentionSignature) ||
                  (state.wake_mention_only[wakeKey] === true && !mentionOnly))
              ) {
                clearHumanWakeState();
              }
              const wakeLimit = mentionOnly ? MENTION_ONLY_MAX_WAKES : maxHumanWakes;
              const priorCount = state.wake_counts[wakeKey] ?? 0;
              if (priorCount >= wakeLimit) {
                const cooldownElapsed =
                  state.sent[wakeKey] === undefined ||
                  now - state.sent[wakeKey] >= WAKE_COOLDOWN_MS;
                if (!mentionOnly && cooldownElapsed) {
                  ledger = await changeLedger(root, role, async (l) => {
                    if (l.items.some((i) => i.from?.msg_id === m.id && i.status === "waiting_human")) return;
                    const baseId = `human-${safeName(m.id)}`;
                    let itemId = baseId;
                    let suffix = 2;
                    while (l.items.some((i) => i.id === itemId)) itemId = `${baseId}-${suffix++}`;
                    const bodyText = String(m.body || "").trim();
                    l.items.push({
                      id: itemId,
                      title: bodyText.replace(/\s+/g, " ").slice(0, 120) || "(본문 없음)",
                      from: {
                        channel: msgChannel,
                        msg_id: m.id,
                        quote: bodyText.slice(0, 200),
                        mentions: [...msgMentions.mentions],
                        mention_roles: [...msgMentions.roleMentions],
                        mention_everyone: msgMentions.everyoneOrHere,
                      },
                      due: new Date(now + 4 * 60 * 60000).toISOString(),
                      created_at: new Date(now).toISOString(),
                      status: "waiting_human",
                      worker: null,
                      checked_at: null,
                      note: `재깨움 ${maxHumanWakes}회 상한 뒤 사람 대기 등록`,
                    });
                  });
                  clearHumanWakeState();
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
                if (mentionOnly) state.wake_mention_only[wakeKey] = true;
                else delete state.wake_mention_only[wakeKey];
              }
            } catch (error) {
              const sourceChannel = m?.channel || channel;
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
    for (const channel of successfulThisRound) {
      if (!failedThisRound.has(channel)) delete state.channel_failures[channel];
    }
    await atomicJson(stateFile, state);
    return {
      wakes,
      errors,
      warnings,
      ...(drive ? { drive: { launched: drive.launched, alerts: drive.alerts, skipped: drive.skipped } } : {}),
    };
  });
}
export async function main(args = process.argv.slice(2)) {
  const { opts } = parseArgs(args);
  const root = path.resolve(opts.root || process.cwd());
  const config = JSON.parse(
    await readFile(
      path.resolve(root, opts.config || "config/work-ledger.json"),
      "utf8",
    ),
  );
  const result = await watch({ root, config, configPath: opts.config ? path.resolve(root, opts.config) : undefined });
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
