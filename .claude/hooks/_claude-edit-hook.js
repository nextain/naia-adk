/**
 * Claude Code Edit|Write-matcher hook envelope — shared adapter helper.
 *
 * Factors the I/O machinery common to the Edit|Write hooks
 * (design-doc-guard, prod-gateway-guard = PreToolUse; cascade-check =
 * PostToolUse) so each carries ONLY its policy. Byte-identical port of
 * the original per-hook envelope (G-OC01 part1 Slice 3, scope A).
 *
 * Sibling of _claude-bash-guard.js; the Bash helper is left untouched
 * (S2 frozen). agents-context-mirror.js is intentionally NOT adapted —
 * it uses a distinct synchronous fd-0 stdin + console.log envelope with
 * no machinery shared with the others; forcing it in would risk
 * byte-identity for zero reuse value (documented scope-A decision).
 *
 * policy(data) → falsy = pass (exit0, no output)
 *   { allow: true }      → {"decision":"allow"}            (design-doc unlock)
 *   { block: <reason> }  → {"decision":"block","reason":…} (PreToolUse block)
 *   { postContext: <s> } → {reason:"",hookSpecificOutput:{hookEventName:
 *                            "PostToolUse",additionalContext:s}} (cascade)
 * Fail-open: a thrown error → exit0 (all three originals were
 * main().catch(()=>process.exit(0))).
 */

async function runEditHook(policy) {
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
	if (toolName !== "Edit" && toolName !== "Write") {
		process.exit(0);
	}

	const decision = await policy(data);
	if (decision) {
		if (decision.allow) {
			process.stdout.write(JSON.stringify({ decision: "allow" }));
		} else if (decision.block !== undefined) {
			process.stdout.write(
				JSON.stringify({ decision: "block", reason: decision.block }),
			);
		} else if (decision.postContext !== undefined) {
			process.stdout.write(
				JSON.stringify({
					reason: "",
					hookSpecificOutput: {
						hookEventName: "PostToolUse",
						additionalContext: decision.postContext,
					},
				}),
			);
		}
	}
	process.exit(0);
}

function start(policy) {
	runEditHook(policy).catch(() => process.exit(0));
}

module.exports = { start };
