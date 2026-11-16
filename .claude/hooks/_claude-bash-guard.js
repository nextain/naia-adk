/**
 * Claude Code PreToolUse(Bash) envelope — shared adapter helper.
 *
 * Factors the I/O machinery common to every .claude Bash guard so each
 * guard file carries ONLY its policy. Behavior is a byte-identical port
 * of the original per-guard envelope (stdin read → JSON.parse[fail=exit0]
 * → shell tool check → policy → {decision:"block",reason} on
 * stdout → exit0). G-OC01 part1 Slice 2, scope A (pure refactor).
 *
 * Guard-specific policy + path constants stay in each guard file so
 * __dirname / cwd-relative resolution is unchanged.
 *
 * policy(command, data) → falsy = pass; { reason } = block.
 *   The policy may perform its own fs/exec side-effects (audit, marker
 *   consume, etc.) exactly as the original guard did, then return.
 * opts.failClosed   — on a thrown error emit a block (pr-guard parity).
 * opts.failClosedReason — the block reason used when failClosed.
 */

const { isShellTool } = require("./tool-names.js");

async function runBashGuard(policy, opts) {
	const failClosed = opts.failClosed !== false;
	const failReason = opts.failClosedReason || "[Harness] Command policy could not be verified (fail-closed).";

	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
	}

	let data;
	try {
		data = JSON.parse(input);
	} catch {
		if (failClosed) {
			process.stdout.write(JSON.stringify({ decision: "block", reason: failReason }));
		}
		process.exit(0);
	}

	const toolName = data.tool_name || "";
	if (!isShellTool(toolName)) {
		process.exit(0);
	}

	const command = data.tool_input?.command || "";

	const decision = await policy(command, data);
	if (decision && decision.reason) {
		process.stdout.write(
			JSON.stringify({ decision: "block", reason: decision.reason }),
		);
	}
	process.exit(0);
}

function start(policy, opts) {
	opts = opts || {};
	const failClosed = opts.failClosed !== false;
	const failReason = opts.failClosedReason || "[Harness] Command policy could not be verified (fail-closed).";
	runBashGuard(policy, opts).catch(() => {
		if (failClosed) {
			process.stdout.write(
				JSON.stringify({ decision: "block", reason: failReason }),
			);
		}
		process.exit(0);
	});
}

module.exports = { start };
