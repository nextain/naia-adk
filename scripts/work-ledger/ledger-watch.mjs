#!/usr/bin/env node
import { assertLedgerOwner } from "../lib/work-ledger-owner.mjs";
import { readFile, mkdir, writeFile, stat, readdir, unlink, link } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { cardWakePublisher, escalationReason, ledgerWakeBody, ledgerWakeName, validCardEvent, overdueReason, reportReason } from "./card-wake.mjs";
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
import {WAKE_COOLDOWN_MS,roleOption,resolveMaxHumanWakesByRole,emptyWatchState,sanitizeWatchState} from "./ledger-watch-state.mjs";
import {createMessengerChecks} from "./ledger-watch-messenger.mjs";
import { cleanReceipts, dueWake, receiptPath, reconcileCurrent } from "./due-timer.mjs";
import { reconcileWorkerRuns } from "./worker-run.mjs";
import { deliverIntake } from "./work-intake.mjs";

const REPORT_CADENCE_FIELDS = ["day_every_min", "night_every_min", "night_hours", "timezone"];

function validateReportCadence(report) {
  for (const field of ["day_every_min", "night_every_min"])
    if (report[field] !== undefined && (!Number.isFinite(report[field]) || report[field] <= 0)) throw new Error(`Invalid ${field}`);
  if (report.night_hours !== undefined && (!Array.isArray(report.night_hours) || report.night_hours.length !== 2 || !report.night_hours.every(Number.isInteger) || report.night_hours.some(hour => hour < 0 || hour > 23) || report.night_hours[0] === report.night_hours[1])) throw new Error("Invalid night_hours");
  const timezone = report.timezone ?? "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }); } catch { throw new Error(`Invalid timezone: ${timezone}`); }
}

export function effectiveReportEveryMin(report, now) {
  validateReportCadence(report);
  const day = report.day_every_min ?? report.every_min;
  const night = report.night_every_min ?? report.every_min;
  if (report.night_hours === undefined) return day;
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: report.timezone ?? "UTC", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now)).find(part => part.type === "hour").value);
  const [start, end] = report.night_hours;
  return (start < end ? hour >= start && hour < end : hour >= start || hour < end) ? night : day;
}

function mergeReport(ledgerReport, configuredReport) {
  if (!configuredReport) return ledgerReport;
  const report = { ...ledgerReport };
  if (report.every_min === 0 && configuredReport.every_min !== undefined) report.every_min = configuredReport.every_min;
  if (!report.channel && configuredReport.channel) report.channel = configuredReport.channel;
  for (const field of REPORT_CADENCE_FIELDS) if (report[field] === undefined && configuredReport[field] !== undefined) report[field] = configuredReport[field];
  return report;
}

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
    const networkChecks = [];
    const intakeRoles = [];
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
    const messengerCheck = createMessengerChecks({root,config,configPath,now,sleep,adapter,state,warnings,errors,wake,oldWakeFiles,receipts,receiptDir,readCache,successfulThisRound,failedThisRound,safeIdPart,roleMaxHumanWakes});
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
              ...Object.fromEntries(REPORT_CADENCE_FIELDS.filter(field => initialReport?.[field] !== undefined).map(field => [field, initialReport[field]])),
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
        if (["open", "waiting_human"].includes(item.status) && Date.parse(item.due) < now && !handled.has(`${role}/${item.id}`)) {
          const key = JSON.stringify([role, item.id, overdueReason, item.due]);
          const observe = async (latest, receipt) => {
            const latestDetails = `출처: ${latest.from.channel}/${latest.from.msg_id}\n기한: ${latest.due}\n결과: ${latest.worker?.result || "(없음)"}`;
            await cardWakes.observe({ role, item: latest, reason: overdueReason, legacyDetails: latestDetails,
              details: latest.result ? `${latestDetails}\n카드 결과: ${latest.result}` : latestDetails,
              revision: [latest.status, latest.title, latest.due, latest.from.channel, latest.from.msg_id, latest.worker?.result ?? null, latest.result ?? null],
              evidenceAt: Math.max(Date.parse(latest.checked_at) || 0, Date.parse(latest.updated_at) || 0),
              legacyKey: JSON.stringify([role, latest.id, overdueReason, latest.due]),
              publishedAt: receipt?.status === "sent" && receipt.role === role && receipt.id === latest.id && receipt.due === latest.due ? receipt.at : undefined });
          };
          let recoverReceipt = false;
          try { recoverReceipt = ["failed", "claimed"].includes(JSON.parse(await readFile(receiptPath(root, role, item.id, item.due), "utf8")).status); }
          catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
          if (item.status === "open" && (config.due_timer?.enabled === true || recoverReceipt)) {
            await dueWake({ root, role, id: item.id, due: item.due, now, source: "watch", lastSent: state.sent[key], observe,
              emit: async () => {} });
          } else {
            let receipt;
            try { receipt = JSON.parse(await readFile(receiptPath(root, role, item.id, item.due), "utf8")); }
            catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
            await observe(item, receipt);
          }
        } else if (item.status === "escalated_human") {
          const legacyDetails = `${details}\n메모: ${item.note || "(없음)"}`;
          const escalation = item.result ? `${legacyDetails}\n카드 결과: ${item.result}` : legacyDetails;
          await cardWakes.observe({ role, item, reason: escalationReason, legacyDetails, details: escalation,
            revision: [item.title, escalation, item.drop_count ?? 0, item.defer_count ?? 0],
            evidenceAt: Math.max(Date.parse(item.checked_at) || 0, Date.parse(item.updated_at) || 0) });
        }
        // A closed card must not publish another unread-result notice. Waiting
        // cards still need results, and already-published events stay intact.
        if (item.worker && !["done", "dropped"].includes(item.status)) {
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
      let report;
      try { report = mergeReport(ledger.report, configuredReport); } catch (error) { errors.push(`report:${role}: ${error.message}`); continue; }
      let effectiveEveryMin;
      try { effectiveEveryMin = effectiveReportEveryMin(report, now); } catch (error) { errors.push(`report:${role}: ${error.message}`); await wake(role, "report-error", "감시 실패", "보고 주기 설정 오류", error.message); continue; }
      if (
        effectiveEveryMin > 0 &&
        (report.last_at === null ||
          now - Date.parse(report.last_at) >= effectiveEveryMin * 60000)
      )
        await cardWakes.observe({ role, item: { id: "report", title: `${effectiveEveryMin}분 정기 보고` }, reason: reportReason,
          details: `출처: ${report.channel}\n기한: ${report.last_at ? new Date(Date.parse(report.last_at) + effectiveEveryMin * 60000).toISOString() : "첫 보고 대기"}\n결과: (없음)`,
          revision: [report.channel, effectiveEveryMin, report.last_msg_id, report.last_at],
          evidenceAt: Date.parse(report.last_at) || 0,
          legacyKey: JSON.stringify([role, "report", reportReason]) });
      const intake = intakeSettings(config, roleConfig);
      if (intake.enabled === true) intakeRoles.push(role);
      networkChecks.push(messengerCheck({role,roleConfig,ledger,intake}));
    }
    // Deadline notices must be visible before any network request can stall.
    // Commit the same semantic heads before flushing their existing outbox.
    await atomicJson(stateFile, state);
    await cardWakes.flush(true);
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
