"use strict";
// Plan gate responsibility: approval-state.
const path = require("path");
const { statePath } = require("./deploy-human-approval.js");
const fs = require("fs");
const { acquirePidLock } = require("../../../scripts/lib/pid-lock.cjs");
const crypto = require("crypto");
const { readJson, PREAPPROVE_STEP_TTL_MS, STEP_CODE_TTL_MS, isoMs, PLAN_APPROVAL_TTL_MS, sha256 } = require("./deploy-plan-common.js");
const { gateConfigView: gateConfigContext } = require("./deploy-plan-context.js");

// ── 상태(저장소 밖) ─────────────────────────────────────────────
function stateFile(env) {
	return path.join(path.dirname(statePath(env)), "deploy-plan-state.json");
}

function loadState(env) {
	const d = readJson(stateFile(env));
	return { challenges: Array.isArray(d?.challenges) ? d.challenges : [], incidents: Array.isArray(d?.incidents) ? d.incidents : [] };
}

function saveState(env, data) {
	const file = stateFile(env);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/**
 * 상태 파일 읽고-고치고-쓰기를 한 번에 하나만. 동시 훅 두 개가 같은 단계 코드를 각각 쓰는 일을 막는다.
 * 디스코드 확인이 길어져도 소유 프로세스가 살아 있는 동안 잠금을 유지한다.
 */
async function withStateLock(env, fn, waitMs = 10000) {
	const lock = `${stateFile(env)}.lock`;
	const until = Date.now() + waitMs;
	let handle;
	for (;;) {
		try {
			handle = await acquirePidLock(lock, { orphanGraceMs: 120000, unverifiedMaxAgeMs: 0 });
			break;
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
			if (Date.now() > until) return null;
			await new Promise((r) => setTimeout(r, 50));
		}
	}
	try {
		return await fn();
	} finally {
		await handle.release();
	}
}

/**
 * 단계 코드 유효 기간: 사전발급 표시가 있고 현재 계획서 원본이 approval_mode
 * "preapprove_steps" 로 같은 sha 일 때만 12시간. 그 외(일반 계획·모드 변경·
 * sha 불일치)는 state 표시만으로 연장되지 않고 2시간 그대로다.
 */
function stepCodeTtlMs(challenge, plan) {
	if (challenge?.preapprove === true && plan?.approval_mode === "preapprove_steps") return PREAPPROVE_STEP_TTL_MS;
	return STEP_CODE_TTL_MS;
}

function approvalExpiresAt(row, plan) {
	return isoMs(row.createdAt) + (row.kind === "plan" ? PLAN_APPROVAL_TTL_MS : stepCodeTtlMs(row, plan));
}

function knownApprovalSession(sessionId) {
	return typeof sessionId === "string" && sessionId.trim().length > 0 && sessionId.trim() !== "unknown" && !/[\x00-\x1f\x7f]/.test(sessionId);
}

// Compute this from the reviewed plan and the session that is actually running.
// Only SHA-256 commitments are stored alongside the ordinary searchable fields.
function approvalScope({ root, file, plan, sha, manifest, sessionId }, step = null) {
	const kind = step ? "step" : "plan";
	const rel = path.relative(root, file);
	const commands = step ? step.commands : [plan.scenario, plan.incident.actions].map(
		(entries) => entries.map((entry) => [entry.id, entry.commands])
	);
	const commitment = [
		"naia/deploy-approval-scope/v1", fs.realpathSync(root), rel, sha, manifest, sessionId, kind, step?.id ?? null, commands,
	];
	const domain = gateConfigContext.getStore()?.admissionDomain;
	if (domain) commitment.push("registered-admission/v1", domain);
	const scopeSha = sha256(JSON.stringify(commitment));
	return { kind, plan: rel, planSha: sha, sessionId, step: step?.id ?? null, scopeSha };
}

function issuedApprovalCode(scope, request) {
	const hash = sha256(JSON.stringify([
		"naia/deploy-approval-request/v1", scope.scopeSha, request.nonce, request.createdAt, request.preapprove === true,
	]));
	return `${scope.kind.toUpperCase()}-${hash.toUpperCase()}`;
}

function sameScope(row, scope) {
	return row && Object.keys(scope).every((key) => row[key] === scope[key]);
}

function matchesIssuedApproval(row, scope) {
	return sameScope(row, scope) && !row.readonly && !row.riskAccepted
		&& typeof row.nonce === "string" && /^[0-9a-f]{32}$/.test(row.nonce)
		&& Number.isFinite(isoMs(row.createdAt))
		&& (row.preapprove === undefined || row.preapprove === true)
		&& (scope.kind !== "step" || Array.isArray(row.executed))
		&& row.code === issuedApprovalCode(scope, row);
}

// Call under withStateLock. A missing, stale, spent or unverified request gets
// a fresh nonce. Only the complete resulting code in a human reply authorizes it.
function activeApproval(state, scope, plan, now, { preapproveCommands, commandSha } = {}) {
	const prior = state.challenges.findLast((row) => row?.scopeSha === scope.scopeSha && !row.closed && !row.readonly);
	const createdAt = new Date(now).toISOString();
	if (prior) {
		if (matchesIssuedApproval(prior, scope) && now >= isoMs(prior.createdAt) && now < approvalExpiresAt(prior, plan)
			&& !(commandSha && prior.executed.includes(commandSha))
			&& !(preapproveCommands && !prior.preapprove)
			&& !preapproveCommands?.every((command) => prior.executed.includes(sha256(command)))) return prior;
		prior.closed = createdAt;
	}
	const row = { ...scope, nonce: crypto.randomBytes(16).toString("hex"), createdAt };
	if (scope.kind === "step") row.executed = [];
	if (preapproveCommands) row.preapprove = true;
	row.code = issuedApprovalCode(scope, row);
	state.challenges.push(row);
	return row;
}

module.exports = {
	stateFile,
	loadState,
	saveState,
	withStateLock,
	stepCodeTtlMs,
	approvalExpiresAt,
	knownApprovalSession,
	approvalScope,
	issuedApprovalCode,
	sameScope,
	matchesIssuedApproval,
	activeApproval,
};
