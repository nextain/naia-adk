#!/usr/bin/env node
/**
 * Task card hourly reminder hook (PostToolUse and UserPromptSubmit).
 *
 * An agent that focuses on one task tends to stop looking at the others. This
 * hook is not a gate: once per `tick` interval (default 60 minutes) it adds the
 * role's cards and check summary to the session context, and stays quiet
 * otherwise. `scripts/task-cards.mjs tick` keeps the last time in
 * `.agents/work/task-cards/tick-<session>.json`.
 *
 * The role comes from ADK_AGENT_ROLE, else from
 * `.agents/work/task-cards/session-roles.json` ({ "<session id>": "<role>" }).
 * Without a role it does nothing. It finishes within a second and exits 0 on
 * any failure. Registration in `.claude/settings.json` is left to the
 * workspace owner (see docs/guides/task-cards.md).
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const TIMEOUT_MS = 900;

function findRoot(start) {
	let current = path.resolve(start || process.cwd());
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function resolveRole(root, sessionId, env = process.env) {
	const fromEnv = (env.ADK_AGENT_ROLE || "").trim();
	if (fromEnv) return fromEnv;
	try {
		const mapping = JSON.parse(fs.readFileSync(path.join(root, ".agents", "work", "task-cards", "session-roles.json"), "utf8"));
		const role = mapping && mapping[sessionId];
		return typeof role === "string" ? role.trim() : "";
	} catch {
		return "";
	}
}

function parseInput(text) {
	if (!text || !text.trim()) return {};
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" ? value : {};
	} catch {
		return {};
	}
}

// Returns the hook stdout (empty string when there is nothing to add).
function run(input, { env = process.env, argvEvent } = {}) {
	const sessionId = typeof input.session_id === "string" ? input.session_id : "";
	if (!sessionId) return "";
	const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
	const root = findRoot(cwd);
	if (!root) return "";
	const role = resolveRole(root, sessionId, env);
	if (!role) return "";
	const script = path.join(root, "scripts", "task-cards.mjs");
	if (!fs.existsSync(script)) return "";
	const child = spawnSync(process.execPath, [script, "--root", root, "tick", "--role", role, "--session", sessionId], {
		encoding: "utf8",
		timeout: TIMEOUT_MS,
		env,
	});
	if (child.error) return "";
	const output = (child.stdout || "").trim();
	if (!output) return "";
	const eventName = input.hook_event_name || argvEvent || "PostToolUse";
	return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: output } });
}

module.exports = { findRoot, resolveRole, parseInput, run };

if (require.main === module) {
	try {
		let text = "";
		try { text = fs.readFileSync(0, "utf8"); } catch { /* no stdin */ }
		const out = run(parseInput(text), { argvEvent: process.argv[2] });
		if (out) process.stdout.write(out);
	} catch { /* never block the session */ }
	process.exit(0);
}
