#!/usr/bin/env node
/**
 * Remote Identity Gate for Codex hosts (PreToolUse on shell tools).
 * Same core as .claude/hooks/remote-identity-gate.js. Not disabled by
 * .codex/no-harness: it guards a hard-to-reverse boundary (public exposure,
 * pushing to a repository other than the catalogued one), like the force-push
 * and destructive-git guards.
 */
"use strict";

const core = require("../../.agents/hooks/core/remote-identity.js");

const SHELL_TOOL_NAMES = new Set(["shell", "shell_command", "bash", "exec", "exec_command", "local_shell", "container.exec"]);

function commandFrom(toolInput) {
	if (!toolInput || typeof toolInput !== "object") return "";
	if (typeof toolInput.command === "string") return toolInput.command;
	if (Array.isArray(toolInput.command)) return toolInput.command.join(" ");
	if (typeof toolInput.cmd === "string") return toolInput.cmd;
	if (typeof toolInput.input === "string") return toolInput.input;
	return "";
}

async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try { data = JSON.parse(input); } catch { process.exit(0); }
	const name = String(data.tool_name || "").trim().toLowerCase();
	if (!SHELL_TOOL_NAMES.has(name) && !/shell|exec|bash/.test(name)) process.exit(0);
	const command = commandFrom(data.tool_input);
	let result = null;
	try { result = core.evaluate({ command, cwd: data.cwd }); } catch { result = null; }
	if (result) process.stdout.write(JSON.stringify(result));
	process.exit(0);
}

main().catch(() => process.exit(0));
