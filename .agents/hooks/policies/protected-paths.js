/**
 * Tool-agnostic protected-path policy (human-only files).
 *
 * Paths listed in `.agents/context/protected-paths.json` are reserved for a
 * human: an agent may not read, write, or run them. No list (missing file,
 * empty list, malformed file) blocks nothing.
 *
 *   editPath(data, opts?)      → { block } | null   (Edit|Write|NotebookEdit|MultiEdit)
 *   readPath(data, opts?)      → { block } | null   (Read|Grep|Glob|NotebookRead)
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

/** Options whose value is human prose (commit/PR text), never a file operand. */
const PROSE_OPTION = /^(?:-m|--message|--body|--title|--subject|--notes|--description|--comment)(?:=|$)/;
const PROSE_COMMANDS = new Set(["echo", "printf"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const CD_BLOCKED = /[$`~]/;

/**
 * Command structure: quoted free text (a commit message that mentions a path)
 * is replaced by a placeholder, except program text handed to a shell, which
 * is itself a command and stays visible.
 */
function structureText(command) {
	return shellTokens(command)
		.map((tokens) => tokens.map((tok, i) => (/\s/.test(tok) && !isShellProgram(tokens, i) ? '"…"' : tok)).join(" "))
		.join(" ; ");
}

/** Token i is the program text of `sh -c` / `bash -lc` / `eval`. */
function isShellProgram(tokens, i) {
	if (tokens[0] === "eval" && i >= 1) return true;
	const flag = tokens[i - 1] || "";
	if (!/^-[A-Za-z]*c$/.test(flag)) return false;
	return tokens.slice(0, i - 1).some((tok) => SHELLS.has(path.basename(tok)));
}

function underTarget(abs, target) {
	return abs === target || abs.startsWith(`${target}/`);
}

function matchesEntry(token, cwd, root, entry) {
	const slashed = token.replace(/\\/g, "/");
	if (slashed.includes(entry)) return true;
	const target = path.resolve(root, entry).replace(/\\/g, "/");
	// `--opt=value` and redirections keep the operand after the last `=`, `<` or `>`.
	const operands = new Set([slashed, slashed.slice(slashed.search(/[=<>][^=<>]*$/) + 1)]);
	for (const operand of operands) {
		if (!operand || operand.startsWith("-") || /[$`]/.test(operand)) continue;
		const abs = path.resolve(cwd, operand).replace(/\\/g, "/");
		if (underTarget(abs, target) || abs.endsWith(`/${entry}`)) return true;
	}
	return false;
}

/** → first protected entry the command touches, or null. cwd follows `cd` across segments. */
function scanCommand(command, cwd, root, list, depth) {
	if (depth > 4) return null;
	let here = cwd;
	for (const tokens of shellTokens(command)) {
		if (tokens[0] === "cd" && tokens[1] && !CD_BLOCKED.test(tokens[1])) {
			const next = path.resolve(here, tokens[1]);
			for (const entry of list) if (matchesEntry(tokens[1], here, root, entry)) return entry;
			here = next;
			continue;
		}
		const prose = PROSE_COMMANDS.has(path.basename(tokens[0] || ""));
		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];
			const spaced = /\s/.test(tok);
			if (spaced && isShellProgram(tokens, i)) {
				const hit = scanCommand(tok, here, root, list, depth + 1);
				if (hit) return hit;
				continue;
			}
			if (spaced && (prose || PROSE_OPTION.test(tokens[i - 1] || "") || /^--[a-z-]+=/.test(tok) && PROSE_OPTION.test(tok))) continue;
			for (const entry of list) if (matchesEntry(tok, here, root, entry)) return entry;
		}
	}
	return null;
}

function commandPath(command, opts) {
	const cwd = path.resolve((opts && opts.cwd) || process.cwd());
	const { root, list } = loadProtectedPaths(cwd, opts);
	if (!list.length) return null;
	const entry = scanCommand(command, cwd, root, list, 0);
	return entry ? { reason: reserved(entry) } : null;
}

const READ_TOOLS = new Set(["Read", "NotebookRead", "Grep", "Glob"]);

/**
 * Native read tools. Read/NotebookRead: the file. Grep/Glob: the search root,
 * and the pattern/glob when it names a protected file. A content-mode Grep
 * rooted above a protected entry would print its lines, so it is blocked too;
 * name-only modes and Glob over an ancestor reveal no content and stay open.
 */
function readPath(data, opts) {
	const tool = (data && data.tool_name) || "";
	if (!READ_TOOLS.has(tool)) return null;
	const cwd = path.resolve((data && data.cwd) || (opts && opts.cwd) || process.cwd());
	const { root, list } = loadProtectedPaths(cwd, opts);
	if (!list.length) return null;
	const input = (data && (data.tool_input || data.parameters)) || {};
	const targets = list.map((entry) => ({ entry, target: path.resolve(root, entry).replace(/\\/g, "/") }));
	const hit = (abs) => targets.find(({ entry, target }) => underTarget(abs, target) || abs.endsWith(`/${entry}`));
	if (tool === "Read" || tool === "NotebookRead") {
		for (const file of candidatePaths(data)) {
			const found = hit(path.resolve(cwd, file).replace(/\\/g, "/"));
			if (found) return { block: reserved(found.entry) };
		}
		return null;
	}
	const base = path.resolve(cwd, typeof input.path === "string" && input.path ? input.path : ".").replace(/\\/g, "/");
	const inside = hit(base);
	if (inside) return { block: reserved(inside.entry) };
	// Glob's `pattern` and Grep's `glob` are file patterns; Grep's `pattern` is a regex over contents.
	const filePattern = tool === "Glob" ? input.pattern : input.glob;
	if (typeof filePattern === "string" && filePattern) {
		const text = filePattern.replace(/\\/g, "/");
		const named = targets.find(({ entry }) => text.includes(entry));
		if (named) return { block: reserved(named.entry) };
		const abs = path.resolve(base, text).replace(/\\/g, "/");
		const globbed = hit(abs.replace(/[*?[{].*$/, "").replace(/\/$/, ""));
		if (globbed) return { block: reserved(globbed.entry) };
	}
	if (tool === "Grep" && (input.output_mode || "files_with_matches") === "content") {
		const above = targets.find(({ target }) => underTarget(target, base));
		if (above) return { block: reserved(above.entry) };
	}
	return null;
}

module.exports = { editPath, readPath, commandPath, loadProtectedPaths, structureText, POLICY_RELATIVE };
