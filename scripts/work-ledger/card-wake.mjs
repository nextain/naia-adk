import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const escalationReason = "사람에게 올림";
export const workerResultReason = "일꾼 끝, 결과 안 읽음";
export const overdueReason = "기한 넘음";
export const reportReason = "정기 보고 시각";
const eventReasons = [escalationReason, workerResultReason, overdueReason, reportReason];

export function ledgerWakeName({ stamp, role, id, reason }, nonce = "") {
  const route = `-route-${role}.md`;
  const normal = `${stamp}-ledger-${id}${nonce}${route}`;
  if (Buffer.byteLength(normal) <= 255) return normal;
  const available = 255 - Buffer.byteLength(route);
  if (available < 5) throw new Error("Role too long for wake filename");
  return digest([role, id, reason, stamp, nonce]).slice(0, available) + route;
}

export function ledgerWakeBody({ reason, title, details }) {
  return `[장부] ${reason}: ${String(title).replace(/[\r\n]/g, " ")}\n${details}\n`;
}

// Even the longest supported role gets a unique inbox and delivery-receipt
// key. A compact ordinal is allocated under the watch lock when the complete
// event hash cannot fit beside the route. Saved heads retain its largest value.
function eventWakeName(role, id, event, ordinal) {
  const route = `-route-${role}.md`;
  const prefix = `event-${event}`;
  const normal = `${prefix}-ledger-${id}${route}`;
  if (Buffer.byteLength(normal) <= 255) return normal;
  if (Buffer.byteLength(prefix + route) <= 255) return prefix + route;
  if (ordinal === undefined) return null;
  const short = `~${ordinal.toString(36)}${route}`;
  if (Buffer.byteLength(short) > 255) throw new Error(`Card event sequence exceeds wake filename capacity for ${role}`);
  return short;
}

export function isCardEventWakeName(name) {
  if (/^event-[0-9a-f]{64}(?:-ledger-[A-Za-z0-9][A-Za-z0-9_-]*)?-route-[A-Za-z0-9][A-Za-z0-9_-]*\.md$/.test(name)) return true;
  const compact = /^~[1-9a-z][0-9a-z]*(-route-[A-Za-z0-9][A-Za-z0-9_-]*\.md)$/.exec(name);
  return Boolean(compact && Buffer.byteLength(compact[1]) + "event-".length + 64 > 255);
}

export function isCardEventWakeBody(body) {
  const [first, card] = body.split("\n", 2);
  return eventReasons.some(reason => first.startsWith(`[장부] ${reason}: `)) &&
    /^작업카드: [A-Za-z0-9][A-Za-z0-9_-]*$/.test(card);
}

export function validCardEvent(key, value) {
  try {
    const [role, id, reason] = JSON.parse(key);
    return typeof role === "string" && typeof id === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(role) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) &&
      eventReasons.includes(reason) && key === JSON.stringify([role, id, reason]) &&
      isDigest(value?.event) && (value.signature === null || isDigest(value.signature)) &&
      (value.ordinal === undefined || (Number.isSafeInteger(value.ordinal) && value.ordinal > 0)) &&
      eventWakeName(role, id, value.event, value.ordinal) !== null &&
      (value.artifact === undefined || (isDigest(value.artifact?.stamp) && isDigest(value.artifact?.sha) && isDigest(value.artifact?.origin)));
  } catch { return false; }
}

function resultFileStamp(file, info) {
  return digest([file, ...[info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String)]);
}

// The caller holds the watch-state lock. Stage the body first, commit its identity
// with watch-state, then move it into the inbox once. A retry can still complete
// that move if the watcher stopped, even when the consumer removes notices.
export function cardWakePublisher({ root, wakeDir, state, oldWakeFiles, wakes }) {
  const outbox = path.join(wakeDir, ".ledger-card-outbox");
  const active = new Set();
  const observedRoles = new Set();
  const ordinals = new Map();
  for (const [key, row] of Object.entries(state.card_events)) {
    if (row.ordinal) {
      const [role] = JSON.parse(key);
      ordinals.set(role, Math.max(ordinals.get(role) ?? 0, row.ordinal));
    }
  }
  const legacy = new Map();
  for (const name of oldWakeFiles) {
    const old = /^(\d{17})(?:-[a-f0-9]{8})?-ledger-(.+)$/.exec(name);
    if (!old) continue;
    if (!legacy.has(old[2])) legacy.set(old[2], []);
    legacy.get(old[2]).push(name);
  }

  async function alreadyPublished(notice, key, legacyBody, evidenceAt, legacyKey, publishedAt) {
    const tail = `${notice.id}-route-${notice.role}.md`;
    const candidates = legacy.get(tail) ?? [];
    for (const name of [...candidates].sort().reverse()) {
      let body;
      try { body = await readFile(path.join(wakeDir, name), "utf8"); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (notice.reason === overdueReason) body = body.replace(/^\[장부\] 정한 시각:/, `[장부] ${overdueReason}:`).replace(/\n늦음 [^\n]*\n?$/, "\n");
      if (!body.startsWith(`[장부] ${notice.reason}: `)) continue;
      const stamp = name.slice(0, 17);
      return body === legacyBody && (!evidenceAt || stamp >= new Date(evidenceAt).toISOString().replace(/\D/g, ""));
    }
    // The original consumer may already have archived the file. Its producer
    // recorded this exact card/reason when writing it. Newer source evidence
    // starts a new version even within the old cooldown.
    const sent = state.sent[legacyKey ?? key];
    return (Number.isFinite(sent) && evidenceAt <= sent) || (Number.isFinite(publishedAt) && evidenceAt <= publishedAt);
  }

  async function observe({ role, item, reason, details, legacyDetails = details, revision, evidenceAt = 0, artifact, legacyKey, publishedAt }) {
    const id = item.id;
    const key = JSON.stringify([role, id, reason]);
    active.add(key);
    const notice = { role, id, reason, title: item.title, details };
    const body = ledgerWakeBody({ ...notice, details: `작업카드: ${id}\n${details}` });
    const signature = digest([item.created_at ?? null, revision]);
    const previous = state.card_events[key];
    if (previous?.signature === signature) {
      if (artifact) previous.artifact = artifact;
      return;
    }
    const event = digest([key, previous?.event ?? null, signature]);
    let ordinal;
    if (eventWakeName(role, id, event) === null) {
      ordinal = (ordinals.get(role) ?? 0) + 1;
      eventWakeName(role, id, event, ordinal);
      ordinals.set(role, ordinal);
    }
    if (previous || !await alreadyPublished(notice, key, ledgerWakeBody({ ...notice, details: legacyDetails }), evidenceAt, legacyKey, publishedAt)) {
      await mkdir(outbox, { recursive: true, mode: 0o700 });
      await writeFile(path.join(outbox, event), body, { mode: 0o600 });
    }
    state.card_events[key] = { signature, event, ...(ordinal ? { ordinal } : {}), ...(artifact ? { artifact } : {}) };
  }

  async function workerResult(role, item, details, marker) {
    const key = JSON.stringify([role, item.id, workerResultReason]);
    const markerAt = Number(marker.mtimeNs / 1000000n);
    let at = markerAt, artifact;
    const result = item.worker.result;
    const markerVersion = marker.mtimeNs.toString();
    const origin = digest([item.worker.done_file, markerVersion, result]);
    const cached = state.card_events[key]?.artifact;
    if (result && !/^\w+:\/\//.test(result)) {
      const file = path.resolve(root, result);
      let info;
      try { info = await stat(file, { bigint: true }); }
      catch (error) { if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error; }
      if (info?.isFile()) {
        at = Math.max(at, Number(info.mtimeNs / 1000000n));
        const stamp = resultFileStamp(file, info);
        // A coarse filesystem timestamp can cover several same-size writes.
        if (cached?.stamp === stamp && info.ctimeNs % 1000000n !== 0n) artifact = { ...cached, origin };
        else {
          let handle;
          try {
            handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
            const before = await handle.stat({ bigint: true });
            if (before.isFile()) {
              const readStamp = resultFileStamp(file, before);
              const hash = createHash("sha256");
              for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
              if (readStamp !== resultFileStamp(file, await handle.stat({ bigint: true }))) {
                active.add(key); // Retry a changing result without announcing a partial read.
                return;
              }
              at = Math.max(markerAt, Number(before.mtimeNs / 1000000n));
              artifact = { stamp: readStamp, sha: hash.digest("hex"), origin };
            }
          } catch (error) {
            if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error;
          } finally { await handle?.close(); }
        }
      }
    }
    // While the same completion's result is unavailable, the last confirmed
    // bytes remain its evidence. A later readable revision is compared again.
    if (!artifact && cached?.origin === origin) artifact = cached;
    await observe({ role, item, reason: workerResultReason, legacyDetails: details, artifact, evidenceAt: at,
      details: `${details}\n완료 표시: ${new Date(markerAt).toISOString()}${artifact ? `\n결과 SHA-256: ${artifact.sha}` : ""}`,
      revision: [item.worker.name, item.worker.done_file, markerVersion, result, artifact?.sha ?? null] });
  }

  async function flush(committed = false) {
    let staged;
    try { staged = (await readdir(outbox)).filter(isDigest); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!staged.length) return;
    const byEvent = new Map(Object.entries(state.card_events).map(([key, row]) => [row.event, key]));
    for (const event of staged) {
      const file = path.join(outbox, event);
      const key = byEvent.get(event);
      if (!key) {
        // An interrupted preparation predates the committed watch state.
        if (committed) await unlink(file);
        continue;
      }
      const [role, id, reason] = JSON.parse(key);
      const name = eventWakeName(role, id, event, state.card_events[key].ordinal);
      const target = path.join(wakeDir, name);
      let present;
      try { present = await readFile(target); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (present !== undefined) {
        if (!present.equals(await readFile(file))) throw new Error(`Conflicting card wake: ${name}`);
        await unlink(file);
      } else {
        await rename(file, target);
        wakes.push({ role, id, reason });
      }
    }
  }

  function endInactive() {
    for (const [key, row] of Object.entries(state.card_events)) {
      if (observedRoles.has(JSON.parse(key)[0]) && !active.has(key)) row.signature = null;
    }
  }
  return { observe, workerResult, flush, endInactive,
    observedRole: role => observedRoles.add(role),
    keepWorker: (role, id) => active.add(JSON.stringify([role, id, workerResultReason])),
  };
}
