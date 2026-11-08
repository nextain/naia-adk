#!/usr/bin/env node
/**
 * Design-Change Consumer / Upstream Artifact Intent Guard Hook (PreToolUse on Bash) & CLI Checker/Runner.
 * Envelope: ./_claude-bash-guard.js. Policy: .agents/hooks/policies/design-intent-guard.js
 * (re-exported via .agents/hooks/policies/bash.js → designIntentRecheck / intentGuard).
 */
const path = require("path");

const args = process.argv.slice(2);
if (
	args.includes("--check") ||
	args.includes("--staged") ||
	args.includes("--worktree") ||
	args.includes("--commit") ||
	args.includes("--run-tests")
) {
	const policy = require(path.join(
		__dirname,
		"..",
		"..",
		".agents",
		"hooks",
		"policies",
		"design-intent-guard.js",
	));
	let mode = "auto";
	let commitRev = "HEAD";
	let cwd = process.cwd();
	let reqId = null;
	let runTests = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--run-tests") runTests = true;
		else if (args[i] === "--req" && i + 1 < args.length) reqId = args[++i];
		else if (args[i] === "--staged") mode = "staged";
		else if (args[i] === "--worktree") mode = "worktree";
		else if (args[i] === "--commit") {
			mode = "commit";
			if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
				commitRev = args[++i];
			}
		} else if (args[i] === "--cwd" && i + 1 < args.length) {
			cwd = path.resolve(args[++i]);
		}
	}
	if (runTests) {
		const runRes = policy.runRequirementIntentTests(cwd, { reqId });
		if (!runRes.ok) {
			for (const f of runRes.failures || []) {
				process.stderr.write(`[intent-guard] FAIL ${f.reqId}/${f.artifactId} (${f.testPath}): ${f.reason}\n`);
			}
			process.exit(1);
		}
		process.stdout.write(`intent-guard: RECEIPTS_WRITTEN (${runRes.receiptsWritten.length})\n`);
		process.exit(0);
	}
	const result = policy.checkRepositoryDesignIntent(cwd, { mode, commitRev });
	if (!result.ok) {
		process.stderr.write(`${result.reason}\n`);
		process.exit(1);
	}
	process.stdout.write("intent-guard: PASS\n");
	process.exit(0);
}

let H, P;
try {
	H = require("./_claude-bash-guard.js");
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "bash.js"));
} catch {
	process.exit(0);
}

H.start((command, data) => P.designIntentRecheck(command, data));
