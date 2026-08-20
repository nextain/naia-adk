"use strict";
/**
 * Single place that answers "is the harness switched off for this working
 * directory?".
 *
 * Before this module every hook inlined `fs.existsSync(path.join(cwd, dir,
 * "no-harness"))`. That is an exact-directory test, so a marker placed at the
 * repository root had no effect on a session whose working directory was a
 * sub-project — the operator switched the harness off and it stayed on. The
 * lookup now walks upward from the working directory, which is what "put a
 * no-harness marker in the repo" was always understood to mean.
 */
const fs = require("fs");
const path = require("path");

const HARNESS_OFF_VALUES = new Set(["off", "0", "false", "no"]);
const HARNESS_ENV_VARS = ["AI_HARNESS", "CLAUDE_HARNESS", "CODEX_HARNESS"];
const HARNESS_CONFIG_DIRS = [".claude", ".codex", ".pi"];
const MARKER_NAME = "no-harness";

/** Every directory from `start` up to the filesystem root, nearest first. */
function ancestorDirectories(start) {
	if (typeof start !== "string" || start.length === 0) return [];
	let current;
	try { current = path.resolve(start); }
	catch { return []; }
	const chain = [];
	// The loop terminates because path.dirname("/") === "/".
	for (;;) {
		chain.push(current);
		const parent = path.dirname(current);
		if (parent === current) return chain;
		current = parent;
	}
}

function envSwitchedOff(env, envVars) {
	if (!env) return false;
	return (envVars || HARNESS_ENV_VARS).some((name) =>
		HARNESS_OFF_VALUES.has(String(env[name] || "").trim().toLowerCase()),
	);
}

/**
 * Path of the marker that switches the harness off, or null when none applies.
 * Returning the path (not just a boolean) lets callers report *which* marker
 * disabled enforcement, so "why did nothing run?" is answerable.
 */
function findHarnessMarker({ cwd = null, roots = [], configDirs = null } = {}) {
	const dirs = configDirs && configDirs.length ? configDirs : HARNESS_CONFIG_DIRS;
	const starts = [cwd, ...roots].filter((value) => typeof value === "string" && value.length > 0);
	const seen = new Set();
	for (const start of starts) {
		for (const directory of ancestorDirectories(start)) {
			if (seen.has(directory)) continue;
			seen.add(directory);
			for (const dir of dirs) {
				const marker = path.join(directory, dir, MARKER_NAME);
				try { if (fs.statSync(marker).isFile()) return marker; }
				catch { /* absent or unreadable: keep walking */ }
			}
		}
	}
	return null;
}

function harnessDisabled({ cwd = null, roots = [], configDirs = null, env = null, envVars = null } = {}) {
	if (envSwitchedOff(env, envVars)) return true;
	return findHarnessMarker({ cwd, roots, configDirs }) !== null;
}

module.exports = {
	HARNESS_OFF_VALUES,
	HARNESS_ENV_VARS,
	HARNESS_CONFIG_DIRS,
	MARKER_NAME,
	ancestorDirectories,
	envSwitchedOff,
	findHarnessMarker,
	harnessDisabled,
};
