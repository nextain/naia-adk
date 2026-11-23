"use strict";
// Plan gate responsibility: review-lock.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { PLAN_FILE, DISCORD_FILE, REVIEW_FILE } = require("./deploy-plan-common.js");

// ── 계획 리뷰 중 저장소 쓰기 잠금 (.agents/state/plan-review.lock) ──────────────────
const PLAN_REVIEW_LOCK_REL = ".agents/state/plan-review.lock";

const PLAN_REVIEW_LOCK_SCHEMA = "plan-review-lock/v1";

const PLAN_REVIEW_LOCK_DEFAULT_TTL_MS = 60 * 60 * 1000;

function sanitizeLockLine(v) {
	return String(v ?? "").replace(/[\r\n]+/g, " ").trim();
}

function realPathLooseForLock(targetPath) {
	const resolved = path.resolve(String(targetPath || ""));
	let cur = resolved;
	const tail = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync(cur), ...tail);
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return resolved;
			tail.unshift(path.basename(cur));
			cur = parent;
		}
	}
}

function readProcStat(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const closeParen = raw.lastIndexOf(")");
		if (closeParen < 0) return null;
		const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
		if (fields.length < 20) return null;
		return {
			state: fields[0],
			ppid: Number(fields[1]),
			startTicks: fields[19] || null,
		};
	} catch {
		return null;
	}
}

function isPidAlive(pid, expectedStartTicks = null) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (!error || error.code !== "EPERM") return false;
	}
	const stat = readProcStat(pid);
	if (stat) {
		if (stat.state === "Z" || stat.state === "X") return false;
		if (expectedStartTicks !== null && expectedStartTicks !== undefined && expectedStartTicks !== "" && stat.startTicks && String(stat.startTicks) !== String(expectedStartTicks)) {
			return false;
		}
	}
	return true;
}

function isPidInLineage(currentPid, ownerPid, expectedStartTicks = null) {
	if (!Number.isInteger(ownerPid) || ownerPid <= 0) return false;
	if (!isPidAlive(ownerPid, expectedStartTicks)) return false;
	if (currentPid === ownerPid) return true;
	let cur = currentPid;
	const seen = new Set();
	for (let hop = 0; hop < 32; hop++) {
		if (!Number.isInteger(cur) || cur <= 1 || seen.has(cur)) break;
		seen.add(cur);
		const stat = readProcStat(cur);
		if (!stat) {
			if (cur === process.pid && process.ppid === ownerPid) return true;
			break;
		}
		if (stat.ppid === ownerPid) return true;
		cur = stat.ppid;
	}
	return false;
}

function checkLockPathSafe(repoRoot) {
	let root;
	try {
		root = fs.realpathSync(repoRoot);
	} catch (error) {
		return { ok: false, root: path.resolve(String(repoRoot || "")), lockPath: path.resolve(String(repoRoot || ""), PLAN_REVIEW_LOCK_REL), reason: `저장소 루트 확인 실패(${error.code || error.message})` };
	}
	const agentsDir = path.join(root, ".agents");
	const stateDir = path.join(agentsDir, "state");
	const lockPath = path.join(stateDir, "plan-review.lock");
	for (const [candidate, expectDir] of [[agentsDir, true], [stateDir, true], [lockPath, false]]) {
		let st;
		try {
			st = fs.lstatSync(candidate);
		} catch (error) {
			if (error && error.code === "ENOENT") continue;
			return { ok: false, root, stateDir, lockPath, reason: `잠금 경로 상태 확인 실패(${error.code || error.message})` };
		}
		if (st.isSymbolicLink()) {
			return { ok: false, root, stateDir, lockPath, reason: "잠금 경로에 심볼릭 링크가 있습니다" };
		}
		if (expectDir && !st.isDirectory()) {
			return { ok: false, root, stateDir, lockPath, reason: "잠금 상위 경로가 디렉터리가 아닙니다" };
		}
		if (!expectDir && !st.isFile()) {
			return { ok: false, root, stateDir, lockPath, reason: "잠금 파일이 일반 파일이 아닙니다" };
		}
	}
	return { ok: true, root, stateDir, lockPath };
}

function planReviewLockPath(repoRoot) {
	return path.join(path.resolve(String(repoRoot || "")), PLAN_REVIEW_LOCK_REL);
}

function inspectPlanReviewLock(repoRoot, now = Date.now()) {
	if (!repoRoot) return { state: "none" };
	let rootExists = false;
	try { rootExists = fs.existsSync(repoRoot); } catch { rootExists = false; }
	if (!rootExists) return { state: "none" };
	const safe = checkLockPathSafe(repoRoot);
	if (!safe.ok) return { state: "corrupt", lockPath: safe.lockPath, reason: safe.reason };
	let raw;
	try {
		const st = fs.lstatSync(safe.lockPath);
		if (st.isSymbolicLink() || !st.isFile()) return { state: "corrupt", lockPath: safe.lockPath, reason: "잠금 파일이 일반 파일이 아닙니다" };
		if (st.size > 64 * 1024) return { state: "corrupt", lockPath: safe.lockPath, reason: "잠금 파일 크기 초과" };
		raw = fs.readFileSync(safe.lockPath, "utf8");
	} catch (error) {
		if (error && error.code === "ENOENT") return { state: "none", lockPath: safe.lockPath };
		return { state: "corrupt", lockPath: safe.lockPath, reason: `잠금 파일 읽기 실패(${error.code || error.message})` };
	}
	let lock;
	try {
		lock = JSON.parse(raw);
	} catch {
		return { state: "corrupt", lockPath: safe.lockPath, reason: "잠금 파일 JSON 파싱 실패" };
	}
	if (!lock || typeof lock !== "object" || Array.isArray(lock)) {
		return { state: "corrupt", lockPath: safe.lockPath, reason: "잠금 파일 형식이 객체가 아닙니다" };
	}
	if (lock.schema !== undefined && lock.schema !== PLAN_REVIEW_LOCK_SCHEMA) {
		return { state: "corrupt", lockPath: safe.lockPath, reason: `지원하지 않는 잠금 스키마(${sanitizeLockLine(lock.schema)})` };
	}
	const pid = lock.pid;
	const plan = sanitizeLockLine(lock.plan);
	const startedAt = sanitizeLockLine(lock.startedAt);
	const expiresAt = sanitizeLockLine(lock.expiresAt);
	const startedMs = Date.parse(startedAt);
	const expiresMs = Date.parse(expiresAt);
	if (!Number.isInteger(pid) || pid <= 0 || !plan || !Number.isFinite(startedMs) || !Number.isFinite(expiresMs)) {
		return { state: "corrupt", lockPath: safe.lockPath, reason: "잠금 파일 필수 필드(pid/plan/startedAt/expiresAt) 누락 또는 형식 오류" };
	}
	const normalizedLock = { ...lock, pid, plan, startedAt, expiresAt };
	if (!isPidAlive(pid, lock.pidStartTicks)) {
		return {
			state: "dead",
			lock: normalizedLock,
			lockPath: safe.lockPath,
			notice: `[Harness] 죽은 계획 리뷰 잠금 무시(${plan}, pid=${pid}, 시작=${startedAt}) — 이전 리뷰 실행기가 종료되어 쓰기를 허용합니다.`,
		};
	}
	if (now >= expiresMs) {
		return {
			state: "expired",
			lock: normalizedLock,
			lockPath: safe.lockPath,
			notice: `[Harness] 시한 넘은 계획 리뷰 잠금 무시(${plan}, pid=${pid}, 시한=${expiresAt}) — 잠금 시한이 지나 쓰기를 허용합니다.`,
		};
	}
	return {
		state: "active",
		lock: normalizedLock,
		lockPath: safe.lockPath,
		blockReason: `[Harness] 계획 리뷰 중(${plan}, ${startedAt}) — 끝난 뒤 다시 시도하십시오. (pid=${pid}, 시한=${expiresAt})`,
	};
}

function acquirePlanReviewLock({ repoRoot, plan, pid = process.pid, ttlMs, env = process.env, now = Date.now() }) {
	const safe = checkLockPathSafe(repoRoot);
	if (!safe.ok) return { ok: false, state: "corrupt", why: safe.reason };
	const envTtl = Number(env && env.APPROVAL_PLAN_REVIEW_LOCK_TTL_MS);
	const effectiveTtlMs = Number.isFinite(ttlMs) && ttlMs > 0
		? ttlMs
		: (Number.isFinite(envTtl) && envTtl > 0 ? envTtl : PLAN_REVIEW_LOCK_DEFAULT_TTL_MS);
	const planClean = sanitizeLockLine(plan);
	if (!planClean) return { ok: false, state: "invalid", why: "계획서 경로가 비어 있습니다" };

	for (let attempt = 0; attempt < 2; attempt++) {
		const cur = inspectPlanReviewLock(safe.root, now);
		if (cur.state === "corrupt") {
			return { ok: false, state: "corrupt", why: `계획 리뷰 잠금 파일이 손상되어 시작할 수 없습니다: ${cur.reason}` };
		}
		if (cur.state === "active" && cur.lock.pid !== pid) {
			return {
				ok: false,
				state: "active",
				lock: cur.lock,
				why: `이미 진행 중인 계획 리뷰 잠금이 있습니다(${cur.lock.plan}, pid=${cur.lock.pid}, 시작=${cur.lock.startedAt}, 시한=${cur.lock.expiresAt})`,
			};
		}
		if (cur.state === "dead" || cur.state === "expired" || (cur.state === "active" && cur.lock.pid === pid)) {
			try { fs.unlinkSync(safe.lockPath); } catch {}
		}
		try {
			fs.mkdirSync(safe.stateDir, { recursive: true });
		} catch (error) {
			return { ok: false, state: "io-error", why: `잠금 디렉터리 생성 실패: ${error.message}` };
		}
		const recheck = checkLockPathSafe(safe.root);
		if (!recheck.ok) return { ok: false, state: "corrupt", why: recheck.reason };
		const stat = readProcStat(pid);
		const lock = {
			schema: PLAN_REVIEW_LOCK_SCHEMA,
			pid,
			...(stat && stat.startTicks ? { pidStartTicks: String(stat.startTicks) } : {}),
			instanceId: crypto.randomUUID(),
			plan: planClean,
			repoRoot: safe.root,
			startedAt: new Date(now).toISOString(),
			expiresAt: new Date(now + effectiveTtlMs).toISOString(),
		};
		try {
			fs.writeFileSync(safe.lockPath, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx", mode: 0o644 });
			return { ok: true, lockPath: safe.lockPath, stateDir: safe.stateDir, lock, released: false };
		} catch (error) {
			if (error && error.code === "EEXIST" && attempt === 0) continue;
			return { ok: false, state: "io-error", why: `계획 리뷰 잠금 파일 생성 실패(${error.code || error.message})` };
		}
	}
	return { ok: false, state: "busy", why: "계획 리뷰 잠금 경합으로 잠금을 잡지 못했습니다" };
}

function releasePlanReviewLock(handle) {
	if (!handle || handle.released) return false;
	const repoRoot = handle.lock && handle.lock.repoRoot ? handle.lock.repoRoot : path.resolve(handle.lockPath, "../../..");
	const safe = checkLockPathSafe(repoRoot);
	if (!safe.ok) return false;
	try {
		const raw = fs.readFileSync(safe.lockPath, "utf8");
		const existing = JSON.parse(raw);
		const sameInstance = handle.lock && handle.lock.instanceId
			? existing && existing.instanceId === handle.lock.instanceId
			: existing && existing.pid === (handle.lock && handle.lock.pid);
		if (sameInstance) {
			fs.unlinkSync(safe.lockPath);
		}
	} catch (error) {
		if (!error || error.code !== "ENOENT") {
			// 읽지 못하더라도 본인 PID 소유가 확실할 때만 제거하지 않고 안전하게 둔다.
		}
	}
	try {
		fs.rmdirSync(safe.stateDir);
	} catch {}
	handle.released = true;
	return true;
}

function isPlanReviewRecordPath(targetPath, repoRoot) {
	if (!targetPath || !repoRoot) return false;
	let realRepo;
	try { realRepo = fs.realpathSync(repoRoot); } catch { return false; }
	const realTarget = realPathLooseForLock(targetPath);
	const rel = path.relative(realRepo, realTarget).replace(/\\/g, "/");
	if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) return false;
	const m = rel.match(/^(?:\.agents\/progress\/[^/]+\/gates|gates)\/(?:reviews\/[a-z][a-z0-9_-]{0,63}\/)?([^/]+)$/);
	if (!m) return false;
	const base = m[1];
	if (base === PLAN_FILE || base === "deploy.json" || base === DISCORD_FILE) return false;
	return (
		base === REVIEW_FILE
		|| base === "deploy-plan-review-findings.md"
		|| /^deploy-plan-review-[^/]+\.md$/i.test(base)
		|| /^(?:plan-)?review(?:-[^/]*)?\.(?:md|json|txt|log)$/i.test(base)
	);
}

module.exports = {
	PLAN_REVIEW_LOCK_REL,
	PLAN_REVIEW_LOCK_SCHEMA,
	PLAN_REVIEW_LOCK_DEFAULT_TTL_MS,
	sanitizeLockLine,
	realPathLooseForLock,
	readProcStat,
	isPidAlive,
	isPidInLineage,
	checkLockPathSafe,
	planReviewLockPath,
	inspectPlanReviewLock,
	acquirePlanReviewLock,
	releasePlanReviewLock,
	isPlanReviewRecordPath,
};
