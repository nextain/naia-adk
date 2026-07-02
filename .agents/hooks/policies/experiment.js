// RDD experiment guard policy (tool-agnostic). fail-CLOSED.
// Copyright 2026 Nextain Inc. All rights reserved.
//
// Blocks running a research experiment script (exp*.py) UNLESS the project's
// Research-Driven-Development state proves the experiment was pre-registered and
// its alignment/recall audit passed. This is the ONE deterministic tooth that
// makes RDD real (see .agents/workflows/research-driven-development.yaml).
//
// Enforced deterministically (physical traces, not meaning):
//   1. An OPEN hypothesis-ledger entry exists with filled method_contract + gate
//      + decision_map(pass&fail) + tags.  (forces pre-registration)
//   2. A fresh align-audit stamp exists, bound to the CURRENT ledger hash.
//      The stamp is written ONLY by the out-of-loop runner (scripts/rdd-audit.cjs),
//      and binding to ledger_hash means the gate cannot be lowered after auditing.
//
// fail-OPEN only when the project is NOT using RDD (no .agents/research/ dir) —
// so this never breaks non-research projects. Inside an RDD project it is fail-CLOSED.

const fs = require("fs");
const path = require("path");
let core;
try {
	core = require("../core/harness-core.js");
} catch {
	core = { stripQuotesBlank: (s) => s };
}

const STAMP_TTL_MS = 24 * 3600 * 1000;

function sha(s) {
	return require("crypto").createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// Is this command actually running a research experiment script?
function matchExperiment(stripped) {
	if (/^\s*(echo|printf|cat|ls|head|tail|grep|sed|awk)\b/.test(stripped)) return null;
	const m = stripped.match(
		/(?:^|[;&|()$`])\s*(?:python3?|uv\s+run\s+python3?|uv\s+run|pytest)\b[^\n;&|]*?\b(exp[\w-]*\.py)\b/,
	);
	return m ? m[1] : null;
}

function readJson(p) {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return null;
	}
}

function entryValid(e) {
	return (
		e &&
		e.status === "open" &&
		typeof e.method_contract === "string" && e.method_contract.trim().length > 0 &&
		typeof e.gate === "string" && e.gate.trim().length > 0 &&
		e.decision_map && e.decision_map.pass && e.decision_map.fail &&
		Array.isArray(e.tags) && e.tags.length > 0
	);
}

function experiment(command, data) {
	const stripped = core.stripQuotesBlank ? core.stripQuotesBlank(command) : command;
	const script = matchExperiment(stripped);
	if (!script) return null; // not an experiment run → not our concern

	const cwd = (data && data.cwd) || process.cwd();
	const researchDir = path.join(cwd, ".agents", "research");
	if (!fs.existsSync(researchDir)) return null; // project not using RDD → fail-open

	// Scan program dirs for a valid open pre-registration + fresh, ledger-bound stamp.
	let programs = [];
	try {
		programs = fs.readdirSync(researchDir, { withFileTypes: true })
			.filter((d) => d.isDirectory() && d.name !== "TEMPLATE")
			.map((d) => path.join(researchDir, d.name));
	} catch {
		return null;
	}

	let sawLedger = false;
	for (const dir of programs) {
		const ledgerPath = path.join(dir, "hypothesis-ledger.json");
		if (!fs.existsSync(ledgerPath)) continue;
		sawLedger = true;
		const ledgerRaw = fs.readFileSync(ledgerPath, "utf8");
		const ledger = readJson(ledgerPath);
		const open = (ledger && Array.isArray(ledger.entries) ? ledger.entries : []).filter(entryValid);
		if (open.length === 0) continue;

		const stamp = readJson(path.join(dir, ".align-audit-stamp.json"));
		if (!stamp) continue;
		const ledgerHash = sha(ledgerRaw);
		const fresh = Date.now() - (stamp.ts || 0) <= STAMP_TTL_MS;
		if (stamp.ledger_hash === ledgerHash && fresh) return null; // ALLOW
	}

	// fail-CLOSED
	const reason = sawLedger
		? `[RDD] 실험 실행 차단 (${script}): 유효한 align-audit 스탬프 없음/만료/ledger 불일치.\n` +
		  `사전등록(method_contract·gate·decision_map·tags 채운 open 엔트리) 후 ` +
		  `\`node scripts/rdd-audit.cjs <program>\`(루프 밖 러너)로 감사 통과시켜야 실행됩니다.\n` +
		  `ledger 변경 시 스탬프 무효(gate 사후 낮춤 방지). 24h 만료.`
		: `[RDD] 실험 실행 차단 (${script}): .agents/research/<program>/hypothesis-ledger.json 에 ` +
		  `사전등록 엔트리가 없습니다. 가설·방법계약·게이트·결정맵·태그를 먼저 등록하세요.\n` +
		  `(탐색만 할 거면 EXPLORE 모드 — 산출물 격리, 증거·목표종료·피벗에 쓸 수 없음.)`;
	return { reason };
}

module.exports = { experiment, matchExperiment, entryValid };
