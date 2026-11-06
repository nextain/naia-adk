#!/usr/bin/env node
/**
 * Deploy Guard Hook (PreToolUse on Bash) — Claude adapter.
 * Envelope: ./_claude-bash-guard.js. Policy: shared tool-agnostic
 * .agents/hooks/policies/bash.js → deploy (also used by pi adapter).
 * Enforces the approval-plan gate (계획서 → 적대 리뷰 → 관문 발급 승인 코드 →
 * 실행 때 바이트·고정 파일 sha 대조) via lib/deploy-plan.js, lib/deploy-readiness.js,
 * and lib/deploy-command-classifier.js.
 * DEPLOY_DIR is __dirname-dependent → this adapter resolves it and
 * passes via opts (byte-identical to original). (G-OC01 part2.)
 */
const path = require("path");
const fs = require("fs");
const roleMode = fs.existsSync(path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), ".naia-role.json"));
let H, P;
try {
	H = require("./_claude-bash-guard.js");
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "bash.js"));
} catch {
	if (roleMode) {
		process.stdout.write(JSON.stringify({ decision: "block", reason: "[Harness] Deployment policy module is unavailable (fail-closed)." }));
	}
	process.exit(0); // original main().catch fail-open
}

// __dirname = .claude/hooks → .claude/deploy (identical to original DEPLOY_DIR).
// Only role sessions follow NAIA_ADK_ROOT; others keep the repo hook decision.
const deployDir = roleMode && process.env.NAIA_ADK_ROOT
	? path.resolve(process.env.NAIA_ADK_ROOT, ".claude", "deploy")
	: path.resolve(__dirname, "..", "deploy");

H.start((command, data) => P.deploy(command, data, { deployDir }), {
	failClosed: roleMode,
	failClosedReason: "[Harness] Deployment policy could not be verified (fail-closed).",
});
