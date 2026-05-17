/**
 * Claude Code PreToolUse(Bash) envelope — shared adapter helper.
 *
 * Factors the I/O machinery common to every .claude Bash guard so each
 * guard file carries ONLY its policy. Behavior is a byte-identical port
 * of the original per-guard envelope (stdin read → JSON.parse[fail=exit0]
 * → tool_name!=="Bash"[exit0] → policy → {decision:"block",reason} on
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

async function runBashGuard(policy) {
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
	}

	let data;
	try {
		data = JSON.parse(input);
	} catch {
		process.exit(0);
	}

	const toolName = data.tool_name || "";
	if (toolName !== "Bash") {
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
	runBashGuard(policy).catch(() => {
		if (opts.failClosed) {
			process.stdout.write(
				JSON.stringify({ decision: "block", reason: opts.failClosedReason }),
			);
		}
		process.exit(0);
	});
}

module.exports = { start };
