#!/usr/bin/env node
/**
 * gcs-guard PreToolUse replay 검증 러너 (#246, codex 권고)
 * 실제 hook을 child process로 띄워 stdin payload를 replay → decision 확인.
 * 사용: node run-gcs-guard-test.js
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HOOK = path.join(__dirname, "..", "gcs-guard.js");
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "gcs-guard.fixtures.json"), "utf8"));

function runHook(stdin) {
	try {
		const out = execFileSync("node", [HOOK], { input: stdin, encoding: "utf8" });
		return out.trim();
	} catch (e) {
		return "__EXEC_ERROR__:" + (e.message || "");
	}
}
function decisionOf(out) {
	if (!out) return "allow";
	try {
		return JSON.parse(out).decision === "block" ? "block" : "allow";
	} catch {
		return "allow";
	}
}

let pass = 0, fail = 0;
const fails = [];

console.log("=== 명령 matrix (replay) ===");
for (const c of FX.cases) {
	const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: c.cmd } });
	const got = decisionOf(runHook(payload));
	const ok = got === c.expect;
	if (ok) pass++;
	else { fail++; fails.push(`${c.name}: expect ${c.expect}, got ${got} | ${c.cmd}`); }
	const gap = c.gap ? `  (known-gap: ${c.gap})` : "";
	console.log(`  ${ok ? "✓" : "✗"} [${c.expect}] ${c.name}${gap}`);
}

console.log("\n=== fail-open 점검 (비정상 입력에 crash/오작동 없어야) ===");
for (const f of FX.failopen) {
	const out = runHook(f.stdin);
	const errored = out.startsWith("__EXEC_ERROR__");
	const dec = decisionOf(out);
	// 비정상 입력은 allow(통과)가 정상이되, hook이 crash(non-zero)하면 안 됨
	const ok = !errored;
	if (ok) pass++; else { fail++; fails.push(`failopen ${f.name}: hook crashed → ${out}`); }
	console.log(`  ${ok ? "✓" : "✗"} ${f.name} → ${errored ? "CRASH" : dec}`);
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail) { console.log("\n실패:"); fails.forEach((x) => console.log("  - " + x)); process.exit(1); }
console.log("✅ 전부 통과 (known-gap은 IAM 방어 영역으로 문서화됨)");
