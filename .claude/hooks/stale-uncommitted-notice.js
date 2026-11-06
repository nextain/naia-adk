#!/usr/bin/env node
"use strict";
/**
 * Stale Uncommitted Changes Notice Hook (SessionStart) — Claude Code adapter.
 *
 * Emits a short one-line warning when the workspace or any projects/* git
 * repository has uncommitted changes older than N hours (default 4).
 * Output only — no wake triggers or Discord notifications.
 */
const fs = require("fs");
const path = require("path");

let harnessDisabled, checkStaleUncommitted;
try {
	({ harnessDisabled } = require(path.join(
		__dirname,
		"..",
		"..",
		".agents",
		"hooks",
		"core",
		"harness-switch.js",
	)));
	({ checkStaleUncommitted } = require(path.join(
		__dirname,
		"..",
		"..",
		"scripts",
		"check-stale-uncommitted.cjs",
	)));
} catch {
	process.exit(0);
}

function main() {
	let data = {};
	try {
		const raw = fs.readFileSync(0, "utf8");
		if (raw && raw.trim()) data = JSON.parse(raw);
	} catch {
		data = {};
	}

	const cwd = (data && data.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
	if (harnessDisabled({ cwd, env: process.env })) {
		return 0;
	}

	const res = checkStaleUncommitted({ root: cwd });
	if (res && res.hasStale && res.oneLineWarning) {
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					additionalContext: res.oneLineWarning,
				},
			}),
		);
	}
	return 0;
}

try {
	process.exitCode = main();
} catch {
	process.exitCode = 0;
}
