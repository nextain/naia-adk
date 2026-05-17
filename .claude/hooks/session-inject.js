#!/usr/bin/env node
/**
 * Session State Inject Hook (UserPromptSubmit) — Claude Code adapter.
 *
 * THIN ADAPTER. All logic lives in the tool-agnostic core:
 *   .agents/hooks/core/harness-core.js → buildSessionInject()
 * This file only: read Claude UserPromptSubmit stdin → call core →
 * wrap result in Claude's hookSpecificOutput envelope.
 * (G-OC01 part1, scope A — pure refactor, behavior byte-identical.)
 *
 * Resolution order, opt-out, progress schema: see harness-core.js.
 */

const path = require("path");
// Fail-safe: a missing/broken core must not error the session (preserve
// original silent exit-0 contract — this is an inject hook, never blocking).
let core;
try {
	core = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "harness-core.js"));
} catch {
	process.exit(0);
}

async function main() {
	let input = "";
	try {
		process.stdin.setEncoding("utf8");
		for await (const chunk of process.stdin) {
			input += chunk;
		}
	} catch {
		// stdin not available — continue with process.cwd()
	}

	let cwd = process.cwd();
	let sessionId = null;
	if (input) {
		try {
			const data = JSON.parse(input);
			if (data.cwd) cwd = data.cwd;
			if (data.session_id) sessionId = data.session_id;
		} catch {
			// ignore parse errors
		}
	}

	const result = core.buildSessionInject({ cwd, sessionId, hooksDir: __dirname });
	if (!result) process.exit(0);

	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: result.text,
			},
		}),
	);

	process.exit(0);
}

main().catch(() => process.exit(0));
