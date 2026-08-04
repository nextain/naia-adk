"use strict";

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
	return value;
}

function canonicalJson(value) {
	return JSON.stringify(canonicalize(value));
}

function normalizeRel(value) {
	return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function safeRoot(value) {
	if (typeof value !== "string" || value.includes("\0")) return false;
	const normalized = normalizeRel(value);
	if (!normalized || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value)) return false;
	return normalized.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function withinRoots(relative, roots) {
	return roots.some((root) => relative === root || relative.startsWith(`${root}/`));
}

function git(cwd, args, options = {}) {
	return cp.execFileSync(options.executable || "/usr/bin/git", ["-C", cwd, ...args], { encoding: options.encoding === null ? null : "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

function gitIdentity(cwd, executable) {
	const common = git(cwd, ["rev-parse", "--git-common-dir"], { executable }).trim();
	const commonPath = path.resolve(cwd, common);
	const stat = fs.statSync(commonPath);
	return { common_path: commonPath, device: Number(stat.dev), inode: Number(stat.ino) };
}

function existsLexically(target) {
	try {
		fs.lstatSync(target);
		return true;
	} catch (error) {
		if (error && error.code === "ENOENT") return false;
		throw error;
	}
}

function currentFiles(cwd, roots, executable) {
	const output = git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: null, executable });
	return output.toString("utf8").split("\0").filter(Boolean).map(normalizeRel).filter((relative) => withinRoots(relative, roots) && existsLexically(path.resolve(cwd, relative))).sort();
}

function baselineFiles(cwd, ref, roots, executable) {
	const output = git(cwd, ["ls-tree", "-r", "-z", "--name-only", ref], { encoding: null, executable });
	return output.toString("utf8").split("\0").filter(Boolean).map(normalizeRel).filter((relative) => withinRoots(relative, roots)).sort();
}

function currentBytes(cwd, relative) {
	const absolute = path.resolve(cwd, relative);
	if (absolute !== cwd && !absolute.startsWith(cwd + path.sep)) throw Object.assign(new Error("snapshot path escapes repository"), { code: "preservation_snapshot_path_escape" });
	const before = fs.lstatSync(absolute, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink()) throw Object.assign(new Error("snapshot input is not a regular file"), { code: "preservation_snapshot_file_invalid" });
	const bytes = fs.readFileSync(absolute);
	const after = fs.lstatSync(absolute, { bigint: true });
	for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) if (before[field] !== after[field]) throw Object.assign(new Error("snapshot input changed while being read"), { code: "preservation_snapshot_input_drift" });
	return { bytes, mode: Number(before.mode) & 0o111 ? 0o755 : 0o644 };
}

function baselineBytes(cwd, ref, relative, executable) {
	const record = git(cwd, ["ls-tree", "-z", ref, "--", relative], { encoding: null, executable }).toString("utf8");
	const header = record.split("\t", 1)[0].trim().split(/\s+/);
	if (header.length < 3 || header[1] !== "blob" || !["100644", "100755"].includes(header[0])) {
		throw Object.assign(new Error("snapshot input is not a regular file"), { code: "preservation_snapshot_file_invalid" });
	}
	const bytes = git(cwd, ["show", `${ref}:${relative}`], { encoding: null, executable });
	return { bytes, mode: header[0] === "100755" ? 0o755 : 0o644 };
}

function materialize(options) {
	const requestedCwd = path.resolve(options.cwd);
	const gitExecutable = options.gitExecutable || "/usr/bin/git";
	const gitStat = fs.lstatSync(gitExecutable);
	if (!path.isAbsolute(gitExecutable) || !gitStat.isFile() || gitStat.isSymbolicLink()) throw Object.assign(new Error("snapshot git executable is invalid"), { code: "preservation_snapshot_git_invalid" });
	const gitDigest = options.sha256(fs.readFileSync(gitExecutable));
	if (Array.isArray(options.allowedGitDigests) && !options.allowedGitDigests.includes(gitDigest)) throw Object.assign(new Error("snapshot git executable is not pinned"), { code: "preservation_snapshot_git_not_allowed" });
	const cwd = path.resolve(git(requestedCwd, ["rev-parse", "--show-toplevel"], { executable: gitExecutable }).trim());
	const destination = path.resolve(options.destination);
	const roots = [...new Set((options.roots || []).map(normalizeRel))].sort();
	if (!roots.length || !roots.every(safeRoot)) throw Object.assign(new Error("snapshot roots are invalid"), { code: "preservation_snapshot_roots_invalid" });
	const phase = options.phase;
	if (!["baseline", "current"].includes(phase)) throw Object.assign(new Error("snapshot phase is invalid"), { code: "preservation_snapshot_phase_invalid" });
	if (phase === "baseline" && !/^[a-f0-9]{40,64}$/.test(options.ref || "")) throw Object.assign(new Error("baseline ref is invalid"), { code: "preservation_snapshot_ref_invalid" });
	if (fs.existsSync(destination)) throw Object.assign(new Error("snapshot destination must not exist"), { code: "preservation_snapshot_destination_exists" });
	fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
	const ref = phase === "baseline" ? git(cwd, ["rev-parse", `${options.ref}^{commit}`], { executable: gitExecutable }).trim() : git(cwd, ["rev-parse", "HEAD"], { executable: gitExecutable }).trim();
	const files = phase === "baseline" ? baselineFiles(cwd, ref, roots, gitExecutable) : currentFiles(cwd, roots, gitExecutable);
	const manifest = {};
	for (const relative of files) {
		const source = phase === "baseline" ? baselineBytes(cwd, ref, relative, gitExecutable) : currentBytes(cwd, relative);
		const target = path.join(destination, ...relative.split("/"));
		fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
		fs.writeFileSync(target, source.bytes, { mode: source.mode, flag: "wx" });
		manifest[relative] = { digest: options.sha256(source.bytes), size: source.bytes.length, mode: source.mode };
	}
	return {
		phase,
		ref,
		roots,
		files: manifest,
		digest: options.sha256(canonicalJson({ phase, ref, roots, files: manifest })),
		repository: gitIdentity(cwd, gitExecutable),
		git_digest: gitDigest,
		destination,
	};
}

function verifyCurrentStable(cwd, roots, expected, sha256, gitOptions = {}) {
	const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "preservation-verify-"));
	const scratch = path.join(scratchRoot, "snapshot");
	try {
		const observed = materialize({ cwd, destination: scratch, roots, phase: "current", sha256, ...gitOptions });
		return observed.digest === expected.digest && canonicalJson(observed.repository) === canonicalJson(expected.repository);
	} finally {
		fs.rmSync(scratchRoot, { recursive: true, force: true });
	}
}

module.exports = { baselineFiles, canonicalJson, currentFiles, gitIdentity, materialize, normalizeRel, safeRoot, verifyCurrentStable, withinRoots };
