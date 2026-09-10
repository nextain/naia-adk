"use strict";
/**
 * Remote identity gate — core logic shared by the Claude, Codex and pi hooks.
 *
 * Why this exists (2026-09-09 incident): the workspace index catalogued
 * `projects/naia-comm` as the PRIVATE repository `nextain/naia-comm`. A Codex
 * session, after a context compaction erased the fact it had already verified,
 * reconstructed the PUBLIC repository `nextain/naia-comm-public` at that exact
 * path, added it as `origin`, and later pushed seven hours of work to the public
 * `main`. Nothing deterministic compared the checkout's remote with the index,
 * and nothing compared the remote's visibility with the catalogued visibility.
 * The public-release policy existed only as prose.
 *
 * What it checks (default allow; only hard-to-reverse boundaries are gated):
 *
 *  1. Identity: when the command's repository is catalogued in the workspace
 *     index (project-index.yaml `submodules.<name>.path` / `repo`, or
 *     agents-rules.json `local_projects`/`submodules` `entry_point` / `repo`),
 *     the remote it pushes to / adds / sets must name the catalogued
 *     `owner/repo`. A mismatch is blocked outright: the right fix is to change
 *     the index or the remote deliberately, not to approve the push.
 *  2. Visibility escalation: a checkout catalogued `visibility: private` may
 *     not push to a remote that GitHub reports as PUBLIC.
 *  3. Public creation / exposure: `gh repo create --public`, `gh repo edit
 *     --visibility public`, and `git clone`/`git remote` that would place a
 *     *different* repository at a catalogued path need a recorded, single-use,
 *     expiring approval (same shape as the force-push approval).
 *
 * Uncatalogued checkouts (worktrees, tmp clones) are left alone except for
 * rule 3, which is about the public action itself, not the path.
 *
 * This gate is NOT switched off by the `no-harness` marker: that marker relaxes
 * session-contract friction, and this gate belongs to the same class as the
 * force-push and destructive-git guards, which stay on in recovery mode.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const APPROVAL_RELATIVE = path.join(".agents", "work", "public-repository-approval.json");
const AUDIT_RELATIVE = path.join(".agents", "work", "public-repository-audit.jsonl");
const CACHE_RELATIVE = path.join(".agents", "harness", "remote-visibility-cache.json");
const MAX_APPROVAL_MINUTES = 30;
const VISIBILITY_TTL_MS = 30 * 60 * 1000;
const GH_TIMEOUT_MS = 8000;

/* ----------------------------------------------------------------------- */
/* Shell parsing (kept local so the core has no dependency on a host dir).   */

function shellClauses(command) {
	const clauses = [];
	let tokens = [], token = "", quote = null, escaped = false;
	const flushToken = () => { if (token) tokens.push(token); token = ""; };
	const flushClause = () => { flushToken(); if (tokens.length) clauses.push(tokens); tokens = []; };
	for (const char of String(command || "")) {
		if (escaped) { token += char; escaped = false; continue; }
		if (char === "\\" && quote !== "'") { escaped = true; continue; }
		if (quote) { if (char === quote) quote = null; else token += char; continue; }
		if (char === "'" || char === '"') { quote = char; continue; }
		if (/\s/.test(char)) { flushToken(); continue; }
		if (/[;&|()]/.test(char)) { flushClause(); continue; }
		token += char;
	}
	if (escaped) token += "\\";
	flushClause();
	return clauses;
}

const GIT_VALUE_OPTIONS = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]);

/** Every `git <sub> ...` invocation in the command, with its `-C dir` if any. */
function gitInvocations(command) {
	const found = [];
	for (const tokens of shellClauses(command)) {
		for (let i = 0; i < tokens.length; i++) {
			if (!/(?:^|[\\/])git(?:\.exe)?$/i.test(tokens[i])) continue;
			let index = i + 1;
			let chdir = null;
			while (index < tokens.length) {
				const current = tokens[index];
				if (current === "-C") { chdir = tokens[index + 1] || null; index += 2; continue; }
				if (GIT_VALUE_OPTIONS.has(current)) { index += 2; continue; }
				if (/^-c.+/.test(current) || /^--(?:git-dir|work-tree|namespace|config-env)=/.test(current)) { index++; continue; }
				if (current.startsWith("-")) { index++; continue; }
				found.push({ subcommand: current, args: tokens.slice(index + 1), chdir });
				break;
			}
		}
	}
	return found;
}

/** Every `gh repo <sub> ...` invocation. */
function ghRepoInvocations(command) {
	const found = [];
	for (const tokens of shellClauses(command)) {
		for (let i = 0; i + 2 < tokens.length; i++) {
			if (!/(?:^|[\\/])gh(?:\.exe)?$/i.test(tokens[i])) continue;
			if (tokens[i + 1] !== "repo") continue;
			found.push({ subcommand: tokens[i + 2], args: tokens.slice(i + 3) });
		}
	}
	return found;
}

/** Apply every `cd` in order so nested commands resolve where they run. */
function commandDirectory(command, sessionCwd) {
	let current = path.resolve(sessionCwd || process.cwd());
	const pattern = /(?:^|[;&|]|\n)\s*cd\s+(?:--\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/g;
	for (const match of String(command || "").matchAll(pattern)) {
		const target = match[1].replace(/^["']|["']$/g, "");
		if (!target || target.startsWith("-")) continue;
		current = path.resolve(current, target.replace(/^~(?=$|\/)/, process.env.HOME || "~"));
	}
	return current;
}

function repositoryRoot(start) {
	let current = path.resolve(start || process.cwd());
	for (;;) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/** Nearest ancestor holding the workspace index (the ADK installation root). */
function workspaceRoot(start) {
	let current = path.resolve(start || process.cwd());
	for (;;) {
		if (fs.existsSync(path.join(current, ".agents", "context", "project-index.yaml"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function realpathSafe(target) {
	try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

/* ----------------------------------------------------------------------- */
/* Remote slugs and visibility.                                              */

/** `owner/repo` from any GitHub remote spelling, else null. */
function slugFromRemote(url) {
	const value = String(url || "").trim().replace(/\.git$/i, "").replace(/\/+$/, "");
	let match = value.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+)$/i);
	if (match) return `${match[1]}/${match[2]}`.toLowerCase();
	match = value.match(/^(?:gh:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
	if (match && !value.includes("://") && !value.startsWith(".") && !value.startsWith("/")) return `${match[1]}/${match[2]}`.toLowerCase();
	return null;
}

function remoteUrl(root, name) {
	try {
		return execFileSync("git", ["-C", root, "config", "--get", `remote.${name}.url`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch { return ""; }
}

function readCache(wsRoot) {
	if (!wsRoot) return {};
	try { return JSON.parse(fs.readFileSync(path.join(wsRoot, CACHE_RELATIVE), "utf8")); } catch { return {}; }
}

function writeCache(wsRoot, cache) {
	if (!wsRoot) return;
	try {
		fs.mkdirSync(path.dirname(path.join(wsRoot, CACHE_RELATIVE)), { recursive: true });
		fs.writeFileSync(path.join(wsRoot, CACHE_RELATIVE), `${JSON.stringify(cache, null, 2)}\n`);
	} catch { /* a missing cache only costs a network call */ }
}

/** "PUBLIC" | "PRIVATE" | "INTERNAL" | null (unknown). Cached for 30 minutes. */
function remoteVisibility(slug, wsRoot, deps = {}) {
	if (!slug) return null;
	const now = Date.now();
	const cache = readCache(wsRoot);
	const hit = cache[slug];
	if (hit && typeof hit.visibility === "string" && now - Number(hit.at || 0) < VISIBILITY_TTL_MS) return hit.visibility;
	let visibility = null;
	try {
		const query = deps.ghQuery || ((s) => execFileSync("gh", ["repo", "view", s, "--json", "visibility", "--jq", ".visibility"], {
			encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: GH_TIMEOUT_MS,
		}).trim());
		const value = String(query(slug) || "").trim().toUpperCase();
		if (/^(PUBLIC|PRIVATE|INTERNAL)$/.test(value)) visibility = value;
	} catch { visibility = null; }
	if (visibility) { cache[slug] = { visibility, at: now }; writeCache(wsRoot, cache); }
	return visibility;
}

/* ----------------------------------------------------------------------- */
/* Workspace index.                                                          */

/**
 * Minimal reader for project-index.yaml `submodules:` entries. The file is a
 * flat two-level map (`  name:` then `    key: value`), which is all this
 * needs; a YAML library is deliberately not required by a hook.
 */
function parseProjectIndex(text) {
	const entries = [];
	let inSubmodules = false, current = null;
	for (const rawLine of String(text || "").split(/\r?\n/)) {
		const line = rawLine.replace(/\s+#.*$/, "");
		if (/^\S/.test(line)) { inSubmodules = /^submodules:\s*$/.test(line); current = null; continue; }
		if (!inSubmodules) continue;
		let match = line.match(/^  ([A-Za-z0-9_.-]+):\s*$/);
		if (match) { current = { name: match[1] }; entries.push(current); continue; }
		match = line.match(/^    ([A-Za-z_]+):\s*(.+?)\s*$/);
		if (match && current) current[match[1]] = match[2].replace(/^["']|["']$/g, "");
	}
	return entries;
}

/** Catalogue: [{ name, absPath, repo (lowercase owner/repo|null), visibility|null, source }]. */
function loadCatalogue(wsRoot) {
	if (!wsRoot) return [];
	const items = [];
	try {
		for (const entry of parseProjectIndex(fs.readFileSync(path.join(wsRoot, ".agents", "context", "project-index.yaml"), "utf8"))) {
			if (!entry.path) continue;
			items.push({
				name: entry.name,
				absPath: realpathSafe(path.resolve(wsRoot, entry.path)),
				repo: entry.repo ? entry.repo.toLowerCase() : null,
				visibility: entry.visibility ? entry.visibility.toLowerCase() : null,
				source: "project-index.yaml",
			});
		}
	} catch { /* index absent: nothing catalogued */ }
	try {
		const rules = JSON.parse(fs.readFileSync(path.join(wsRoot, ".agents", "context", "agents-rules.json"), "utf8"));
		for (const section of ["local_projects", "submodules"]) {
			for (const [name, value] of Object.entries(rules[section] || {})) {
				if (!value || typeof value !== "object" || !value.entry_point) continue;
				const dir = path.dirname(String(value.entry_point));
				items.push({
					name,
					absPath: realpathSafe(path.resolve(wsRoot, dir)),
					repo: value.repo ? String(value.repo).toLowerCase() : null,
					visibility: value.visibility ? String(value.visibility).toLowerCase() : null,
					source: `agents-rules.json ${section}`,
				});
			}
		}
	} catch { /* rules absent */ }
	return items;
}

/** The catalogue entries whose path is exactly this repository root. */
function catalogueEntriesFor(catalogue, repoRoot) {
	if (!repoRoot) return [];
	const target = realpathSafe(repoRoot);
	return catalogue.filter((item) => item.absPath === target);
}

/* ----------------------------------------------------------------------- */
/* Approval record (single-use, expiring), same discipline as force push.    */

function readApproval(wsRoot) {
	try { return JSON.parse(fs.readFileSync(path.join(wsRoot, APPROVAL_RELATIVE), "utf8")); } catch { return null; }
}

function approvalProblem(approval, { operation, repo }) {
	if (!approval || typeof approval !== "object") return "no approval record";
	for (const field of ["operation", "repo", "reason", "approved_by", "expires_at"]) {
		if (typeof approval[field] !== "string" || !approval[field].trim()) return `approval is missing ${field}`;
	}
	if (approval.consumed_at) return "approval was already used; record a new one";
	if (approval.operation !== operation) return `approval covers ${approval.operation}, not ${operation}`;
	if (repo && approval.repo.toLowerCase() !== repo.toLowerCase()) return `approval covers ${approval.repo}, not ${repo}`;
	const expiry = Date.parse(approval.expires_at);
	if (!Number.isFinite(expiry)) return "approval expires_at is not a timestamp";
	if (expiry <= Date.now()) return "approval expired";
	if (expiry - Date.now() > MAX_APPROVAL_MINUTES * 60 * 1000) return `approval window exceeds ${MAX_APPROVAL_MINUTES} minutes`;
	return null;
}

function consumeApproval(wsRoot, approval, command) {
	const now = new Date().toISOString();
	try {
		fs.writeFileSync(path.join(wsRoot, APPROVAL_RELATIVE), `${JSON.stringify({ ...approval, consumed_at: now }, null, 2)}\n`);
		fs.appendFileSync(path.join(wsRoot, AUDIT_RELATIVE), `${JSON.stringify({ at: now, ...approval, command })}\n`);
		return true;
	} catch { return false; }
}

function howToApprove(operation, repo, problem) {
	const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
	const record = JSON.stringify({
		operation, repo: repo || "<owner/repo>",
		reason: "<why this repository may be created or exposed publicly>",
		approved_by: "<name>", expires_at: expires,
	}, null, 2);
	return [
		`⛔ [HARNESS: REMOTE IDENTITY] ${operation === "create_public" ? "Creating a public repository" : operation === "expose_public" ? "Making a repository public" : "Placing a different repository at a catalogued path"} needs a recorded approval.`,
		`Reason it is not covered: ${problem}.`,
		"",
		`Write ${APPROVAL_RELATIVE} at the workspace root, then run the command again:`,
		record,
		"",
		"It is single-use, scoped to this exact repository, and expires within 30 minutes.",
		"Before approving, run the public-safety review in .agents/context/agents-rules.json public_repository_release_gate.",
	].join("\n");
}

/* ----------------------------------------------------------------------- */
/* Decision.                                                                 */

function block(reason) { return { decision: "block", reason }; }

function identityMismatch(entry, actualSlug, what) {
	return block([
		"⛔ [HARNESS: REMOTE IDENTITY] The checkout and the workspace index disagree about which repository this is.",
		`Path: ${entry.absPath}`,
		`Index (${entry.source}, entry "${entry.name}") says: ${entry.repo}`,
		`${what}: ${actualSlug}`,
		"",
		"Do not push or rewire this checkout until the two agree. Either the index entry is wrong",
		"(fix .agents/context/project-index.yaml deliberately and say so), or this directory holds the",
		"wrong clone (move it aside and clone the catalogued repository). If the user named a repository,",
		"the user's name wins over anything discovered by search.",
	].join("\n"));
}

function visibilityEscalation(entry, actualSlug) {
	return block([
		"⛔ [HARNESS: REMOTE IDENTITY] This checkout is catalogued as PRIVATE but the remote is PUBLIC.",
		`Path: ${entry.absPath}`,
		`Index (${entry.source}, entry "${entry.name}"): ${entry.repo || "(no repo)"} visibility=${entry.visibility}`,
		`Remote: ${actualSlug} visibility=PUBLIC (per gh repo view)`,
		"",
		"Pushing private-workspace content to a public remote is a public release. Follow",
		"public_repository_release_gate in .agents/context/agents-rules.json and fix the index or the remote first.",
	].join("\n"));
}

/**
 * Evaluate one shell command. Returns null (allow) or { decision: "block", reason }.
 * `deps` lets tests inject `ghQuery`, `remoteUrl`, `now`.
 */
/**
 * Drop heredoc bodies (`<<EOF ... EOF`) so that a commit message or a file
 * being written through `cat <<EOF` cannot be mistaken for commands. Only the
 * command line that introduces the heredoc is kept.
 */
function stripHeredocs(command) {
	const lines = String(command || "").split("\n");
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		out.push(line);
		const match = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
		if (!match) continue;
		const terminator = match[2];
		for (i += 1; i < lines.length; i++) {
			if (lines[i].replace(/^\t+/, "") === terminator) break;
		}
	}
	return out.join("\n");
}

function evaluate({ command, cwd, deps = {} }) {
	const text = stripHeredocs(command);
	if (!/\b(git|gh)\b/.test(text)) return null;
	const stripped = text.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
	if (/^\s*(echo|printf)\s/.test(stripped) && !stripped.includes("|")) return null;

	const baseDir = commandDirectory(text, cwd);
	const wsRoot = workspaceRoot(baseDir) || workspaceRoot(cwd);
	const catalogue = deps.catalogue || loadCatalogue(wsRoot);
	const getRemoteUrl = deps.remoteUrl || remoteUrl;
	const visibilityOf = (slug) => remoteVisibility(slug, wsRoot, deps);

	/* --- gh repo create / edit -------------------------------------------- */
	for (const inv of ghRepoInvocations(text)) {
		if (inv.subcommand === "create" && inv.args.includes("--public")) {
			const name = inv.args.find((a) => !a.startsWith("-")) || "";
			const problem = approvalProblem(readApproval(wsRoot), { operation: "create_public", repo: name });
			if (problem) return block(howToApprove("create_public", name, problem));
			if (!consumeApproval(wsRoot, readApproval(wsRoot), text)) return block("⛔ [HARNESS: REMOTE IDENTITY] The approval could not be marked as used, so the operation is refused rather than left unrecorded.");
			continue;
		}
		if (inv.subcommand === "edit") {
			const idx = inv.args.findIndex((a) => a === "--visibility" || a.startsWith("--visibility="));
			if (idx === -1) continue;
			const value = inv.args[idx].includes("=") ? inv.args[idx].split("=")[1] : inv.args[idx + 1];
			if (String(value || "").toLowerCase() !== "public") continue;
			const name = inv.args.find((a) => !a.startsWith("-") && a !== value) || "";
			const problem = approvalProblem(readApproval(wsRoot), { operation: "expose_public", repo: name });
			if (problem) return block(howToApprove("expose_public", name, problem));
			if (!consumeApproval(wsRoot, readApproval(wsRoot), text)) return block("⛔ [HARNESS: REMOTE IDENTITY] The approval could not be marked as used, so the operation is refused rather than left unrecorded.");
		}
	}

	/* --- git push / remote / clone ---------------------------------------- */
	for (const inv of gitInvocations(text)) {
		const dir = inv.chdir ? path.resolve(baseDir, inv.chdir) : baseDir;

		if (inv.subcommand === "clone") {
			const operands = inv.args.filter((a) => !a.startsWith("-"));
			const url = operands[0] || "";
			const slug = slugFromRemote(url);
			if (!slug) continue;
			const dest = operands[1] ? path.resolve(dir, operands[1]) : path.resolve(dir, path.basename(url).replace(/\.git$/i, ""));
			const entries = catalogue.filter((item) => item.absPath === realpathSafe(dest) && item.repo);
			const mismatch = entries.find((item) => item.repo !== slug);
			if (mismatch) return identityMismatch(mismatch, slug, "Clone target");
			continue;
		}

		if (inv.subcommand === "remote") {
			const [verb, ...rest] = inv.args.filter((a) => !a.startsWith("-"));
			if (verb !== "add" && verb !== "set-url") continue;
			const url = verb === "add" ? rest[1] : rest[rest.length - 1];
			const slug = slugFromRemote(url);
			if (!slug) continue;
			const root = repositoryRoot(dir);
			const entries = catalogueEntriesFor(catalogue, root).filter((item) => item.repo);
			const mismatch = entries.find((item) => item.repo !== slug);
			if (mismatch) return identityMismatch(mismatch, slug, `git remote ${verb}`);
			continue;
		}

		if (inv.subcommand === "push") {
			const operands = inv.args.filter((a) => !a.startsWith("-"));
			const root = repositoryRoot(dir);
			if (!root) continue;
			const target = operands[0] || "origin";
			const slug = slugFromRemote(target) || slugFromRemote(getRemoteUrl(root, target));
			if (!slug) continue;
			const entries = catalogueEntriesFor(catalogue, root);
			if (entries.length === 0) continue; // uncatalogued checkout: default allow
			const mismatch = entries.find((item) => item.repo && item.repo !== slug);
			if (mismatch) return identityMismatch(mismatch, slug, "Push remote");
			const privateEntry = entries.find((item) => item.visibility === "private");
			if (privateEntry && visibilityOf(slug) === "PUBLIC") return visibilityEscalation(privateEntry, slug);
		}
	}
	return null;
}

module.exports = {
	stripHeredocs, APPROVAL_RELATIVE, AUDIT_RELATIVE, CACHE_RELATIVE,
	evaluate, parseProjectIndex, loadCatalogue, slugFromRemote, gitInvocations, ghRepoInvocations,
	commandDirectory, repositoryRoot, workspaceRoot, approvalProblem, remoteVisibility,
};
