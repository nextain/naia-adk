/**
 * Tool-agnostic protected-path policy (human-only files).
 *
 * Paths listed in `.agents/context/protected-paths.json` are reserved for a
 * human: an agent may not read, write, or run them. No list (missing file,
 * empty list, malformed file) blocks nothing.
 *
 *   editPath(data, opts?)      → { block } | null   (Edit|Write|NotebookEdit|MultiEdit)
 *   commandPath(command, opts?) → { reason } | null  (Bash)
 *
 * Pure apart from reading the policy file. opts.protectedPaths overrides the
 * file (tests, adapters that already hold the list); opts.cwd / opts.root
 * locate the policy and resolve relative entries.
 */
const fs = require("fs");
const path = require("path");

const POLICY_RELATIVE = path.join(".agents", "context", "protected-paths.json");
const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..", "..");

function normalizeList(list) {
	if (!Array.isArray(list)) return [];
	return list
		.filter((item) => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim().replace(/\\/g, "/").replace(/\/+$/, ""))
		.filter(Boolean);
}

function readList(dir) {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(dir, POLICY_RELATIVE), "utf8"));
		return parsed && typeof parsed === "object" ? normalizeList(parsed.protected_paths) : null;
	} catch {
		return null;
	}
}

/** Nearest policy file from cwd upward, then this workspace. → { root, list } (empty list when none). */
function loadProtectedPaths(cwd, opts) {
	if (opts && Array.isArray(opts.protectedPaths)) {
		return { root: path.resolve((opts.root || cwd || process.cwd())), list: normalizeList(opts.protectedPaths) };
	}
	let cur = path.resolve(cwd || process.cwd());
	for (;;) {
		const list = readList(cur);
		if (list) return { root: cur, list };
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	const list = readList(WORKSPACE_ROOT);
	return list ? { root: WORKSPACE_ROOT, list } : { root: WORKSPACE_ROOT, list: [] };
}

function reserved(p) {
	return `[Harness] 보호 경로 차단: ${p}\n\n이 경로는 사람 전용입니다. 에이전트는 읽기·쓰기·실행을 할 수 없습니다.\n필요하면 사용자에게 직접 처리해 달라고 요청하세요.`;
}

function candidatePaths(data) {
	const input = (data && (data.tool_input || data.parameters)) || {};
	return [input.file_path, input.filePath, input.path, input.notebook_path]
		.filter((value) => typeof value === "string" && value.length > 0);
}

/** An entry matches a file when it is that file, a directory containing it, or a trailing path segment of it. */
function editPath(data, opts) {
	const cwd = (data && data.cwd) || (opts && opts.cwd) || process.cwd();
	const { root, list } = loadProtectedPaths(cwd, opts);
	if (!list.length) return null;
	for (const file of candidatePaths(data)) {
		const abs = path.resolve(cwd, file);
		const slashed = abs.replace(/\\/g, "/");
		for (const entry of list) {
			const target = path.resolve(root, entry).replace(/\\/g, "/");
			if (slashed === target || slashed.startsWith(`${target}/`) || slashed.endsWith(`/${entry}`)) {
				return { block: reserved(entry) };
			}
		}
	}
	return null;
}

/** Split into shell segments of tokens (quotes removed; `;|&()` and newlines separate). */
function shellTokens(command) {
	const segments = [];
	let current = [];
	let token = "";
	let hasToken = false;
	let quote = null;
	const pushToken = () => { if (hasToken) current.push(token); token = ""; hasToken = false; };
	const pushSegment = () => { pushToken(); if (current.length) segments.push(current); current = []; };
	const text = String(command ?? "");
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"' && i + 1 < text.length) token += text[++i];
			else token += ch;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; hasToken = true; continue; }
		if (ch === "\\" && i + 1 < text.length) { token += text[++i]; hasToken = true; continue; }
		if (ch === " " || ch === "\t") { pushToken(); continue; }
		if (ch === "\n" || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")" || ch === "`") { pushSegment(); continue; }
		if (ch === "$" && text[i + 1] === "(") { pushSegment(); i++; continue; }
		token += ch;
		hasToken = true;
	}
	pushSegment();
	return segments;
}

/**
 * Command structure: quoted free text (a commit message that mentions a path)
 * is replaced by a placeholder, except the program text after `-c`, which is
 * itself a command and stays visible.
 */
function structureText(command) {
	return shellTokens(command)
		.map((tokens) => tokens.map((tok, i) => (/\s/.test(tok) && tokens[i - 1] !== "-c" ? '"…"' : tok)).join(" "))
		.join(" ; ");
}

function commandPath(command, opts) {
	const cwd = (opts && opts.cwd) || process.cwd();
	const { list } = loadProtectedPaths(cwd, opts);
	if (!list.length) return null;
	const structure = structureText(command);
	for (const entry of list) {
		if (structure.includes(entry)) return { reason: reserved(entry) };
	}
	return null;
}

module.exports = { editPath, commandPath, loadProtectedPaths, structureText, POLICY_RELATIVE };
