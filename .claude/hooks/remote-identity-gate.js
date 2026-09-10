#!/usr/bin/env node
/**
 * Remote Identity Gate (PreToolUse on Bash).
 *
 * Blocks pushes, remote rewiring, clones and public repository creation that
 * contradict the workspace index (which repository lives at which path, and
 * whether it is private). Logic lives in .agents/hooks/core/remote-identity.js
 * so every host (Claude, Codex, pi) enforces the same rule.
 */
"use strict";

const core = require("../../.agents/hooks/core/remote-identity.js");

async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try { data = JSON.parse(input); } catch { process.exit(0); }
	if ((data.tool_name || "") !== "Bash") process.exit(0);
	const command = data.tool_input?.command || "";
	let result = null;
	try { result = core.evaluate({ command, cwd: data.cwd }); }
	catch { result = null; } // the gate must never fail closed on its own bug for routine commands
	if (result) process.stdout.write(JSON.stringify(result));
	process.exit(0);
}

main().catch(() => process.exit(0));
