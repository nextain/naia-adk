"use strict";
/**
 * Append-only record of what enforcement refused.
 *
 * Until this existed, a refusal left no trace anywhere: the message went to the
 * agent's transcript and nowhere else, so "the harness blocked my session"
 * could only be diagnosed by asking the operator to paste their screen. Every
 * blocked call now leaves one line on disk.
 *
 * Recording must never be able to break a hook, so every failure here is
 * swallowed: a lost log line is preferable to a refused tool call becoming a
 * crash.
 */
const fs = require("fs");
const path = require("path");

const { ancestorDirectories } = require("./harness-switch.js");

const LOG_RELATIVE = path.join(".agents", "harness-blocks.jsonl");
const KEEP_LINES = 300;
const MAX_FIELD = 400;

/**
 * Outermost enclosing repository, not the nearest one. Sub-projects are
 * submodules with their own .git, and a per-submodule log would scatter the
 * record across twenty files when the operator needs one place to look.
 */
function repositoryRoot(cwd) {
	let outermost = null;
	for (const directory of ancestorDirectories(cwd || process.cwd())) {
		try { if (fs.existsSync(path.join(directory, ".git"))) outermost = directory; }
		catch { /* keep walking */ }
	}
	return outermost;
}

function clip(value) {
	if (value === null || value === undefined) return null;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (typeof text !== "string") return null;
	return text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD)}…` : text;
}

/** The part of tool_input worth keeping: what the call was going to touch. */
function subject(toolInput) {
	if (!toolInput || typeof toolInput !== "object") return null;
	for (const key of ["command", "file_path", "path", "notebook_path", "prompt", "patch"]) {
		if (typeof toolInput[key] === "string" && toolInput[key].length > 0) return clip(toolInput[key]);
	}
	return clip(Object.keys(toolInput).slice(0, 6));
}

function trim(file) {
	try {
		const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
		if (lines.length <= KEEP_LINES) return;
		fs.writeFileSync(file, `${lines.slice(-KEEP_LINES).join("\n")}\n`);
	} catch { /* trimming is best effort */ }
}

function record({ hook, tool, cwd, sessionId = null, toolInput = null, reason = null, at = null } = {}) {
	try {
		const root = repositoryRoot(cwd);
		if (!root) return null;
		const file = path.join(root, LOG_RELATIVE);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const line = JSON.stringify({
			at: at || new Date().toISOString(),
			hook: hook || null,
			tool: tool || null,
			session: sessionId,
			cwd: cwd || null,
			subject: subject(toolInput),
			// First line only: the rest of a refusal is standing instructions.
			reason: clip(String(reason || "").split("\n")[0]),
		});
		fs.appendFileSync(file, `${line}\n`);
		trim(file);
		return file;
	} catch { return null; }
}

function recent(cwd, limit = 20) {
	try {
		const root = repositoryRoot(cwd);
		if (!root) return [];
		return fs.readFileSync(path.join(root, LOG_RELATIVE), "utf8")
			.split("\n").filter(Boolean).slice(-limit)
			.map((line) => { try { return JSON.parse(line); } catch { return null; } })
			.filter(Boolean);
	} catch { return []; }
}

module.exports = { LOG_RELATIVE, KEEP_LINES, record, recent, repositoryRoot, subject };

if (require.main === module) {
	const limit = Number(process.argv[process.argv.indexOf("--recent") + 1]) || 20;
	const rows = recent(process.cwd(), limit);
	if (rows.length === 0) { process.stdout.write("기록된 차단 없음\n"); }
	else for (const row of rows) {
		process.stdout.write(`${row.at}  ${row.hook || "?"}  ${row.tool || "?"}\n    대상: ${row.subject || "-"}\n    사유: ${row.reason || "-"}\n`);
	}
}
