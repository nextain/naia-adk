#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([
	".c", ".cc", ".cjs", ".cpp", ".cs", ".cts", ".dart", ".ex", ".exs", ".go", ".h", ".hpp",
	".java", ".js", ".jsx", ".kt", ".kts", ".lua", ".mjs", ".mts", ".php", ".ps1", ".py",
	".r", ".rb", ".rs", ".scala", ".sh", ".svelte", ".swift", ".ts", ".tsx", ".vue",
]);
const DEFAULT_THRESHOLDS = Object.freeze({ warnLines: 500, refactorLines: 800, criticalLines: 1_200, growthLines: 250, warnBytes: 80_000, refactorBytes: 160_000, criticalBytes: 300_000, warnLineLength: 1_000, refactorLineLength: 5_000 });
const MAX_REPOSITORY_PATCH_BYTES = 64 * 1024 * 1024;
const WAIVER_KEYS = new Set(["path", "sha256", "maxLines", "maxBytes", "reason", "owner", "authorityRef", "expiresOn"]);

function lineCount(content) {
	if (!content) return 0;
	return content.endsWith("\n") ? content.slice(0, -1).split("\n").length : content.split("\n").length;
}

function digest(content) {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function readRegularFile(path, label) {
	const before = lstatSync(path, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
	let descriptor;
	try {
		descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
		const opened = fstatSync(descriptor, { bigint: true });
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`${label} changed before read`);
		const bytes = readFileSync(descriptor);
		const after = fstatSync(descriptor, { bigint: true });
		const current = lstatSync(path, { bigint: true });
		if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino
			|| after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || current.size !== after.size || current.mtimeNs !== after.mtimeNs) {
			throw new Error(`${label} changed during read`);
		}
		return bytes;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function decodeUtf8(bytes, label) {
	try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { throw new Error(`${label} must be valid UTF-8`); }
}

function gitPathList(root, args) {
	const bytes = execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"] });
	const records = [];
	let start = 0;
	for (let index = 0; index <= bytes.length; index += 1) {
		if (index !== bytes.length && bytes[index] !== 0) continue;
		if (index > start) {
			const raw = bytes.subarray(start, index);
			const path = raw.toString("utf8");
			if (!Buffer.from(path).equals(raw)) throw new Error("review path is not valid UTF-8");
			records.push(path);
		}
		start = index + 1;
	}
	return records;
}

function trackedGitlinks(root) {
	return gitPathList(root, ["ls-files", "--stage", "-z"]).flatMap((record) => {
		const separator = record.indexOf("\t");
		if (separator < 0) throw new Error("Git index record is malformed");
		const metadata = record.slice(0, separator).split(" ");
		if (metadata.length !== 3) throw new Error("Git index metadata is malformed");
		return metadata[0] === "160000" ? [record.slice(separator + 1)] : [];
	});
}

function assertRepositoryIsReviewable(root) {
	const unmerged = gitPathList(root, ["diff", "--name-only", "-z", "--diff-filter=U", "--"]);
	if (unmerged.length > 0) throw new Error(`review repository has unresolved merge paths: ${unmerged.join(", ")}`);
}

function safeRelativePath(value) {
	return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\")
		&& value.split("/").every((part) => part && part !== "." && part !== "..");
}

function governedSourcePath(path) {
	return SOURCE_EXTENSIONS.has(extname(path).toLowerCase())
		|| /^\.(?:agents|users)\/skills\/[^/]+\/(?:SKILL\.md|.+\.md)$/.test(path);
}

function validDate(value) {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function validateComplexityWaiver(waiver, { path, sha256, lines, bytes, today } = {}) {
	if (!waiver || typeof waiver !== "object" || Array.isArray(waiver)) return { valid: false, reason: "waiver_missing" };
	if (Object.keys(waiver).some((key) => !WAIVER_KEYS.has(key))) return { valid: false, reason: "waiver_unknown_key" };
	if (!safeRelativePath(waiver.path) || waiver.path !== path) return { valid: false, reason: "waiver_path_mismatch" };
	if (!/^sha256:[a-f0-9]{64}$/.test(waiver.sha256 ?? "") || waiver.sha256 !== sha256) return { valid: false, reason: "waiver_hash_mismatch" };
	if (!Number.isSafeInteger(waiver.maxLines) || waiver.maxLines < 1 || lines > waiver.maxLines) return { valid: false, reason: "waiver_line_limit_exceeded" };
	if (!Number.isSafeInteger(waiver.maxBytes) || waiver.maxBytes < 1 || bytes > waiver.maxBytes) return { valid: false, reason: "waiver_byte_limit_exceeded" };
	if (typeof waiver.reason !== "string" || waiver.reason.trim().length < 20 || waiver.reason.length > 500) return { valid: false, reason: "waiver_reason_invalid" };
	if (typeof waiver.owner !== "string" || !/^[A-Za-z0-9_.:@-]{3,80}$/.test(waiver.owner) || /^(self|me|unknown|todo)$/i.test(waiver.owner)) return { valid: false, reason: "waiver_owner_invalid" };
	if (typeof waiver.authorityRef !== "string" || !/^source:USR-\d+#sha256:[a-f0-9]{64}$/.test(waiver.authorityRef)) return { valid: false, reason: "waiver_authority_invalid" };
	if (!validDate(today) || !validDate(waiver.expiresOn) || waiver.expiresOn < today) return { valid: false, reason: "waiver_expired" };
	const maximumExpiry = new Date(`${today}T00:00:00Z`);
	maximumExpiry.setUTCDate(maximumExpiry.getUTCDate() + 90);
	if (waiver.expiresOn > maximumExpiry.toISOString().slice(0, 10)) return { valid: false, reason: "waiver_expiry_too_distant" };
	return { valid: true, reason: waiver.reason.trim() };
}

export function measureComplexity({ path, content, addedLines = 0, waiver = null, today = new Date().toISOString().slice(0, 10), thresholds = DEFAULT_THRESHOLDS } = {}) {
	if (!safeRelativePath(path) || typeof content !== "string" || !Number.isSafeInteger(addedLines) || addedLines < 0) throw new Error("complexity measurement input is invalid");
	for (const key of ["warnLines", "refactorLines", "criticalLines", "growthLines", "warnBytes", "refactorBytes", "criticalBytes", "warnLineLength", "refactorLineLength"]) if (!Number.isSafeInteger(thresholds[key]) || thresholds[key] < 1) throw new Error("complexity thresholds are invalid");
	if (!(thresholds.warnLines < thresholds.refactorLines && thresholds.refactorLines < thresholds.criticalLines)) throw new Error("complexity thresholds must be increasing");
	if (!(thresholds.warnBytes < thresholds.refactorBytes && thresholds.refactorBytes < thresholds.criticalBytes)) throw new Error("complexity byte thresholds must be increasing");
	if (!(thresholds.warnLineLength < thresholds.refactorLineLength)) throw new Error("complexity line-length thresholds must be increasing");
	const lines = lineCount(content);
	const bytes = Buffer.byteLength(content);
	const longestLine = content.split("\n").reduce((maximum, line) => Math.max(maximum, line.length), 0);
	const sha256 = digest(content);
	const triggers = [];
	if (lines >= thresholds.criticalLines) triggers.push("critical_file_size");
	else if (lines >= thresholds.refactorLines) triggers.push("file_size");
	else if (lines >= thresholds.warnLines) triggers.push("large_file_warning");
	if (lines >= thresholds.warnLines && addedLines >= thresholds.growthLines) triggers.push("large_file_growth");
	if (bytes >= thresholds.criticalBytes) triggers.push("critical_file_bytes");
	else if (bytes >= thresholds.refactorBytes) triggers.push("file_bytes");
	else if (bytes >= thresholds.warnBytes) triggers.push("large_file_bytes_warning");
	if (longestLine >= thresholds.refactorLineLength) triggers.push("generated_or_minified_line");
	else if (longestLine >= thresholds.warnLineLength) triggers.push("long_line_warning");
	let status = triggers.some((item) => !new Set(["large_file_warning", "large_file_bytes_warning", "long_line_warning"]).has(item)) ? "REFACTOR_REQUIRED" : triggers.length ? "WARN" : "OK";
	let waiverReason = null;
	let waiverProblem = null;
	if (waiver) {
		const checked = validateComplexityWaiver(waiver, { path, sha256, lines, bytes, today });
		if (checked.valid && status === "REFACTOR_REQUIRED") {
			status = "WAIVED_COMPLEXITY";
			waiverReason = checked.reason;
		} else if (!checked.valid) waiverProblem = checked.reason;
	}
	return {
		path, status, lines, bytes, longestLine, addedLines, sha256, triggers, waiverReason, waiverProblem,
		waiver: waiver ? { owner: waiver.owner ?? null, authorityRef: waiver.authorityRef ?? null, expiresOn: waiver.expiresOn ?? null, maxLines: waiver.maxLines ?? null, maxBytes: waiver.maxBytes ?? null } : null,
	};
}

function git(root, args) {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function assertRepositoryRoot(root, base) {
	const actual = realpathSync(root);
	const topLevel = realpathSync(git(actual, ["rev-parse", "--show-toplevel"]).trim());
	if (actual !== topLevel) throw new Error("complexity root must be the repository top-level");
	const baseRevision = git(actual, ["rev-parse", "--verify", `${base}^{commit}`]).trim();
	const headRevision = git(actual, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
	const ancestor = execFileSync("git", ["-C", actual, "merge-base", "--is-ancestor", baseRevision, headRevision], { encoding: "utf8" });
	void ancestor;
	return { root: actual, baseRevision, headRevision };
}

function changedPaths(root, base) {
	const staged = gitPathList(root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACDMRTUXB", base, "--"]);
	const worktree = gitPathList(root, ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", "--"]);
	const untracked = gitPathList(root, ["ls-files", "-o", "--exclude-standard", "-z"]);
	return [...new Set([...staged, ...worktree, ...untracked])].sort();
}

function optionalLstat(path) {
	try { return lstatSync(path); }
	catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function indexEntry(root, path) {
	const records = gitPathList(root, ["ls-files", "--stage", "-z", "--", path]);
	if (records.length === 0) return null;
	if (records.length !== 1) throw new Error(`review index entry is ambiguous: ${path}`);
	const separator = records[0].indexOf("\t");
	const metadata = records[0].slice(0, separator).split(" ");
	if (separator < 0 || metadata.length !== 3 || metadata[2] !== "0" || !/^(100644|100755|120000|160000)$/.test(metadata[0]) || !/^[a-f0-9]{40,64}$/.test(metadata[1])) throw new Error(`review index entry is invalid: ${path}`);
	return { mode: metadata[0], objectId: metadata[1] };
}

function assertStagedWorktreeParity(root, base) {
	const staged = gitPathList(root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACDMRTUXB", base, "--"]);
	for (const path of staged) {
		if (!safeRelativePath(path)) throw new Error(`staged review path is unsafe: ${path}`);
		const absolute = resolve(root, path);
		const stat = optionalLstat(absolute);
		const entry = indexEntry(root, path);
		if (entry === null) {
			if (stat !== null) throw new Error(`staged deletion differs from the worktree: ${path}`);
			continue;
		}
		if (entry.mode === "160000") {
			if (!stat?.isDirectory()) throw new Error(`staged submodule differs from the worktree: ${path}`);
			const current = git(absolute, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
			if (current !== entry.objectId) throw new Error(`staged submodule differs from the worktree: ${path}`);
			continue;
		}
		const indexBytes = execFileSync("git", ["-C", root, "cat-file", "blob", entry.objectId], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_REPOSITORY_PATCH_BYTES });
		if (entry.mode === "120000") {
			if (!stat?.isSymbolicLink() || !Buffer.from(readlinkSync(absolute)).equals(indexBytes)) throw new Error(`staged symlink differs from the worktree: ${path}`);
		} else if (!stat?.isFile() || stat.isSymbolicLink() || !readRegularFile(absolute, `staged review path ${path}`).equals(indexBytes)) {
			throw new Error(`staged file differs from the worktree: ${path}`);
		}
	}
}

function submoduleSnapshots(root, ancestors) {
	return trackedGitlinks(root).map((path) => {
		const absolute = resolve(root, path);
		if (!existsSync(absolute)) return { path, state: "uninitialized_absent" };
		if (!lstatSync(absolute).isDirectory()) throw new Error(`tracked submodule path is not a directory: ${path}`);
		if (!existsSync(resolve(absolute, ".git"))) {
			if (readdirSync(absolute).length === 0) return { path, state: "uninitialized_empty" };
			throw new Error(`tracked submodule is not an initialized repository: ${path}`);
		}
		let nestedRoot;
		try { nestedRoot = realpathSync(git(absolute, ["rev-parse", "--show-toplevel"]).trim()); }
		catch {
			if (readdirSync(absolute).length === 0) return { path, state: "uninitialized_empty" };
			throw new Error(`tracked submodule is not an initialized repository: ${path}`);
		}
		if (nestedRoot !== realpathSync(absolute)) throw new Error(`tracked submodule resolves outside its root: ${path}`);
		if (ancestors.has(nestedRoot)) throw new Error(`recursive submodule cycle detected: ${path}`);
		const headRevision = git(nestedRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
		const nested = repositoryChangeSnapshot(nestedRoot, headRevision, new Set([...ancestors, nestedRoot]));
		return { path, state: "initialized", headRevision, sha256: nested.sha256 };
	});
}

function repositoryChangeSnapshot(root, base, ancestors = new Set([realpathSync(root)])) {
	assertRepositoryIsReviewable(root);
	assertStagedWorktreeParity(root, base);
	const indexPatch = execFileSync("git", ["-C", root, "diff", "--cached", "--binary", "--full-index", base, "--"], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_REPOSITORY_PATCH_BYTES });
	const worktreePatch = execFileSync("git", ["-C", root, "diff", "--binary", "--full-index", "--"], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_REPOSITORY_PATCH_BYTES });
	const untrackedPaths = gitPathList(root, ["ls-files", "-o", "--exclude-standard", "-z"]).sort();
	const untracked = untrackedPaths.map((path) => {
		if (!safeRelativePath(path)) throw new Error(`untracked review path is unsafe: ${path}`);
		const absolute = resolve(root, path);
		const stat = lstatSync(absolute);
		if (stat.isFile()) return { path, state: "file", sha256: digest(readRegularFile(absolute, `untracked review path ${path}`)) };
		if (stat.isSymbolicLink()) return { path, state: "symlink", sha256: digest(readlinkSync(absolute)) };
		throw new Error(`untracked review path has an unsupported type: ${path}`);
	});
	const indexPatchSha256 = digest(indexPatch);
	const worktreePatchSha256 = digest(worktreePatch);
	const submodules = submoduleSnapshots(root, ancestors);
	return { indexPatchSha256, worktreePatchSha256, untracked, submodules, sha256: digest(JSON.stringify({ indexPatchSha256, worktreePatchSha256, untracked, submodules })) };
}

function resolveWaiverAuthority(root, authorityRef) {
	const match = authorityRef?.match(/^source:(USR-\d+)#(sha256:[a-f0-9]{64})$/);
	if (!match) return "waiver_authority_invalid";
	const directory = resolve(root, ".agents/requirements/sources");
	const candidates = readdirSync(directory).filter((name) => name.startsWith(`${match[1]}-`) && name.endsWith(".json"));
	if (candidates.length !== 1) return "waiver_authority_unresolved";
	const relativePath = `.agents/requirements/sources/${candidates[0]}`;
	const path = resolve(root, relativePath);
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) return "waiver_authority_unsafe";
	try { git(root, ["ls-files", "--error-unmatch", "--", relativePath]); }
	catch { return "waiver_authority_untracked"; }
	const bytes = readRegularFile(path, `waiver authority ${relativePath}`);
	if (digest(bytes) !== match[2]) return "waiver_authority_hash_mismatch";
	const source = JSON.parse(bytes.toString("utf8"));
	if (source.id !== match[1] || source.source_kind !== "human" || source.origin !== "native_user_message" || source.actor !== "user" || !Array.isArray(source.events) || source.events.length < 1) return "waiver_authority_not_human_source";
	return null;
}

function addedLines(root, base, path) {
	const row = git(root, ["diff", "--numstat", base, "--", path]).trim();
	if (!row) {
		try { git(root, ["ls-files", "--error-unmatch", "--", path]); return 0; }
		catch { return lineCount(decodeUtf8(readRegularFile(resolve(root, path), `complexity source ${path}`), `complexity source ${path}`)); }
	}
	const value = row.split("\t", 1)[0];
	return /^\d+$/.test(value) ? Number(value) : 0;
}

function loadWaivers(root) {
	const path = ".agents/context/complexity-waivers.json";
	const absolute = resolve(root, path);
	if (!existsSync(absolute)) return { entries: new Map(), sha256: null, path };
	const stat = lstatSync(absolute);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("complexity waiver document must be a tracked regular file");
	try { git(root, ["ls-files", "--error-unmatch", "--", path]); }
	catch { throw new Error("complexity waiver document must be tracked by git"); }
	const bytes = readRegularFile(absolute, "complexity waiver document");
	const document = JSON.parse(bytes.toString("utf8"));
	const documentKeys = document && typeof document === "object" && !Array.isArray(document)
		? Object.keys(document).sort()
		: [];
	if (JSON.stringify(documentKeys) !== JSON.stringify(["schemaVersion", "waivers"]) || document.schemaVersion !== 1 || !Array.isArray(document.waivers)) throw new Error("complexity waiver document is invalid");
	const entries = new Map();
	for (const waiver of document.waivers) {
		if (!safeRelativePath(waiver?.path) || entries.has(waiver.path)) throw new Error("complexity waiver paths must be unique and relative");
		entries.set(waiver.path, waiver);
	}
	return { entries, sha256: digest(bytes), path };
}

function parseArgs(argv) {
	const options = { root: process.cwd(), base: null, json: false };
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--json") options.json = true;
		else if (new Set(["--root", "--base"]).has(value)) {
			const next = argv[++index];
			if (!next) throw new Error(`${value} requires a value`);
			if (value === "--root") options.root = resolve(next);
			else if (value === "--base") options.base = next;
		} else throw new Error(`unknown complexity option: ${value}`);
	}
	if (!options.base) throw new Error("--base is required and must be the recorded review baseline");
	return options;
}

export function runComplexityMeasurement({ root, base, today } = {}) {
	if (!base) throw new Error("complexity baseline is required");
	const scope = assertRepositoryRoot(root, base);
	const waiverDocument = loadWaivers(scope.root);
	const waivers = waiverDocument.entries;
	const allChangedPaths = changedPaths(scope.root, scope.baseRevision);
	const repositoryChanges = repositoryChangeSnapshot(scope.root, scope.baseRevision);
	const changedSourcePaths = allChangedPaths.filter((path) => safeRelativePath(path) && governedSourcePath(path));
	const selected = [...new Set([...changedSourcePaths, ...waivers.keys()])].sort()
		.filter((path) => safeRelativePath(path) && governedSourcePath(path));
	const results = [];
	for (const path of selected) {
		const absolute = resolve(scope.root, path);
		if (!existsSync(absolute)) continue;
		if (lstatSync(absolute).isSymbolicLink()) throw new Error(`complexity source must not be a symbolic link: ${path}`);
		const content = decodeUtf8(readRegularFile(absolute, `complexity source ${path}`), `complexity source ${path}`);
		const waiver = waivers.get(path);
		const measured = measureComplexity({ path, content, addedLines: addedLines(scope.root, scope.baseRevision, path), waiver, today });
		const authorityProblem = waiver ? resolveWaiverAuthority(scope.root, waiver.authorityRef) : null;
		if (authorityProblem) {
			measured.status = "REFACTOR_REQUIRED";
			measured.waiverReason = null;
			measured.waiverProblem = authorityProblem;
		}
		results.push(measured);
	}
	const inspectedPaths = new Set(results.map((item) => item.path));
	const unusedWaivers = [...waivers.keys()].filter((path) => !inspectedPaths.has(path));
	const finalChangedPaths = changedPaths(scope.root, scope.baseRevision);
	if (JSON.stringify(finalChangedPaths) !== JSON.stringify(allChangedPaths)) throw new Error("repository changed during complexity measurement");
	if (repositoryChangeSnapshot(scope.root, scope.baseRevision).sha256 !== repositoryChanges.sha256) throw new Error("repository bytes changed during complexity measurement");
	if (git(scope.root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim() !== scope.headRevision) throw new Error("HEAD changed during complexity measurement");
	if (loadWaivers(scope.root).sha256 !== waiverDocument.sha256) throw new Error("complexity waiver document changed during measurement");
	for (const waiver of waivers.values()) if (resolveWaiverAuthority(scope.root, waiver.authorityRef)) throw new Error("complexity waiver authority changed during measurement");
	for (const item of results) {
		const absolute = resolve(scope.root, item.path);
		if (!existsSync(absolute) || digest(readRegularFile(absolute, `complexity source ${item.path}`)) !== item.sha256) throw new Error(`source changed during complexity measurement: ${item.path}`);
	}
	const measuredByPath = new Map(results.map((item) => [item.path, item]));
	const changedSourceStates = changedSourcePaths.map((path) => {
		const measured = measuredByPath.get(path);
		if (measured) return { path, state: "present", sha256: measured.sha256 };
		let baseContent;
		try { baseContent = git(scope.root, ["show", `${scope.baseRevision}:${path}`]); }
		catch { throw new Error(`deleted complexity source is unavailable at the review baseline: ${path}`); }
		return { path, state: "deleted", baseSha256: digest(baseContent) };
	});
	const deletedSourceFiles = changedSourceStates.filter((item) => item.state === "deleted").map((item) => item.path);
	const changedSetSha256 = digest(JSON.stringify(changedSourceStates));
	const hasInvalidWaiver = results.some((item) => item.waiverProblem) || unusedWaivers.length > 0;
	return {
		schemaVersion: 1,
		scope: { root: scope.root, baseRevision: scope.baseRevision, headRevision: scope.headRevision, changedFiles: allChangedPaths.length, repositoryChangedSetSha256: repositoryChanges.sha256, changedSourceFiles: changedSourcePaths.length, inspectedSourceFiles: results.length, changedSetSha256 },
		waiverDocument: { path: waiverDocument.path, sha256: waiverDocument.sha256 },
		thresholds: DEFAULT_THRESHOLDS,
		result: results.some((item) => item.status === "REFACTOR_REQUIRED") || hasInvalidWaiver ? "REFACTOR_REQUIRED" : results.some((item) => item.status !== "OK") ? "ATTENTION" : "CLEAN",
		files: results,
		deletedSourceFiles,
		unusedWaivers,
	};
}

function printHuman(report) {
	console.log(`complexity=${report.result} warn=${report.thresholds.warnLines} refactor=${report.thresholds.refactorLines} critical=${report.thresholds.criticalLines} growth=${report.thresholds.growthLines}`);
	for (const item of report.files.filter((entry) => entry.status !== "OK" || entry.waiverProblem)) {
		const reason = item.waiverReason ? ` reason=${JSON.stringify(item.waiverReason)}` : "";
		const invalid = item.waiverProblem ? ` invalidWaiver=${item.waiverProblem}` : "";
		console.log(`${item.status} ${item.path} lines=${item.lines} bytes=${item.bytes} longest=${item.longestLine} added=${item.addedLines} triggers=${item.triggers.join(",") || "none"}${reason}${invalid}`);
	}
	for (const path of report.unusedWaivers) console.log(`UNUSED_WAIVER ${path}`);
	for (const path of report.deletedSourceFiles) console.log(`DELETED_SOURCE ${path}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = parseArgs(process.argv.slice(2));
		const report = runComplexityMeasurement(options);
		if (options.json) console.log(JSON.stringify(report, null, 2));
		else printHuman(report);
		if (report.result === "REFACTOR_REQUIRED") process.exitCode = 2;
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
