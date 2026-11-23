"use strict";
// Approval CLI responsibility: snapshot.
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { statePath } = require("../../.claude/hooks/lib/deploy-human-approval.js");
const lib = require("../../.claude/hooks/lib/deploy-plan.js");
const { ROOT } = require("./approval-plan-files.cjs");

function gitSnapshot(cwd = ROOT, seen = new Set(), isolated = false, baseRoot = cwd) {
	const registered = require("../../.claude/hooks/lib/deploy-plan-context.js").gateConfigView.getStore()?.executionRegistrationSha256;
	const git = (args, allowFailure = false) => {
		const r = registered ? require("../../scripts/lib/registered-git-identity.cjs").registeredGitResult(cwd,args,{encoding:"buffer",maxBuffer:128*1024*1024}) : spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
		if (r.status !== 0 || r.error) {
			if (allowFailure) return null;
			const error = new Error("읽기 전용 확인용 git 상태를 읽지 못함");
			error.code = r.error?.code || (r.signal ? `GIT_SIGNAL_${r.signal}` : `GIT_EXIT_${r.status}`);
			error.syscall = r.error?.syscall || "spawnSync";
			error.path = cwd;
			error.snapshotStage = `git-${args[0]}${args.includes("--cached") ? "-cached" : ""}`;
			throw error;
		}
		return r.stdout;
	};
	const topBuf = git(["rev-parse", "--show-toplevel"], seen.size > 0);
	if (topBuf === null) {
		const h = crypto.createHash("sha256");
		h.update("broken\0");
		hashPath(h, cwd, true);
		return h.digest("hex");
	}
	const top = fs.realpathSync(topBuf.toString("utf8").trim());
	if (seen.has(top)) throw new Error("중첩 저장소 경로가 순환함");
	seen.add(top); cwd = top;
	const h = crypto.createHash("sha256");
	h.update(filterSnapshotStatus(git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]), cwd, baseRoot));
	const hasHead = git(["rev-parse", "--verify", "HEAD"], true) !== null;
	const auditPathspec = cwd === fs.realpathSync(baseRoot) ? ["--", ".", ":(exclude,literal).claude/deploy/audit.jsonl"] : [];
	const diffOptions = registered ? ["--no-ext-diff", "--no-textconv"] : [];
	h.update(git(["diff", ...diffOptions, "--binary", ...(hasHead ? ["HEAD"] : []), "--ignore-submodules=all", ...auditPathspec]));
	h.update(git(["diff", "--cached", ...diffOptions, "--binary", "--ignore-submodules=all", ...auditPathspec]));
	const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0").filter(Boolean).filter((f) => !isSnapshotExcluded(cwd, f, baseRoot));
	const ignored = git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]).toString("utf8").split("\0").filter(Boolean).filter((f) => !isSnapshotExcluded(cwd, f, baseRoot));
	for (const file of ignored.sort()) hashIgnoredPath(h, path.resolve(cwd, file), path.relative(baseRoot, path.resolve(cwd, file)) || ".");
	for (const name of ["hooks", "config", "info/exclude"]) {
		const file = git(["rev-parse", "--git-path", name]).toString("utf8").trim();
		hashPath(h, path.resolve(cwd, file));
	}
	const modules = git(["ls-files", "--stage", "-z"]).toString("utf8").split("\0").filter((s) => s.startsWith("160000 ")).map((s) => s.slice(s.indexOf("\t") + 1));
	const nested = new Set(modules);
	for (const file of untracked.sort()) {
		h.update(file);
		const abs = path.join(cwd, file), stat = fs.lstatSync(abs);
		if (stat.isDirectory()) {
			if (!fs.existsSync(path.join(abs, ".git"))) throw new Error("미추적 폴더의 읽기 전용 확인 불가");
			nested.add(file);
		} else hashPath(h, abs);
	}
	for (const file of [...nested].sort()) {
		const abs = path.join(cwd, file);
		if (isRecoveryMode(baseRoot) && isOutsideWorkspace(abs, baseRoot)) {
			h.update(file + "\0external-recovery-skip"); continue;
		}
		if (!fs.existsSync(path.join(abs, ".git"))) {
			if (fs.existsSync(abs) && fs.readdirSync(abs).length) throw new Error("submodule 내용 확인 불가");
			h.update(file + "\0uninitialized"); continue;
		}
		h.update(file); h.update(gitSnapshot(abs, seen, isolated, baseRoot));
	}
	seen.delete(top);
	return h.digest("hex");
}

function hashIgnoredPath(h, file, rel = path.relative(ROOT, file) || ".") {
	let st;
	try { st = fs.lstatSync(file, { bigint: true }); }
	catch (error) {
		if (error.code === "ENOENT") { h.update(JSON.stringify([rel, "missing"])); return; }
		throw error;
	}
	const kind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : st.isFile() ? "file" : "special";
	h.update(JSON.stringify([rel, kind, ...[st.mode, st.uid, st.gid, st.size, st.mtimeNs, st.ctimeNs].map(String)]));
	if (!st.isDirectory()) return;
	try {
		const prefix = file.endsWith(path.sep) ? file : file + path.sep;
		const relPrefix = rel === "." ? "" : rel + path.sep;
		for (const name of fs.readdirSync(file).sort()) hashIgnoredPath(h, prefix + name, relPrefix + name);
	} catch (error) {
		if (error.code !== "EACCES") throw error;
		h.update(JSON.stringify([rel, "unreadable"]));
	}
}

function hashPath(h, file, recurse = true) {
	h.update(JSON.stringify(file));
	let st;
	try { st = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") { h.update("missing"); return; } throw e; }
	h.update(String(st.mode));
	if (st.isSymbolicLink()) {
		h.update(fs.readlinkSync(file));
	} else if (st.isDirectory()) {
		if (recurse) for (const name of fs.readdirSync(file).sort()) hashPath(h, path.join(file, name));
	} else if (st.isFile()) {
		const fd = fs.openSync(file, "r"), buf = Buffer.alloc(1024 * 1024);
		try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null))) h.update(buf.subarray(0, n)); }
		finally { fs.closeSync(fd); }
	}
}

const REVIEW_SNAPSHOT_EXCLUDED_FILES = new Set([".claude/deploy/audit.jsonl"]);

const REVIEW_SNAPSHOT_EXCLUDED_PREFIXES = [".agents/progress/", ".agents/work/", ".agents/state/", ".agents/.dm-outbox/", "gates/", "tmp/"];

function isRecoveryMode(root = ROOT) {
	for (const marker of [".codex/no-harness", ".claude/no-harness", ".pi/no-harness"]) {
		try { if (fs.statSync(path.join(root, marker)).isFile()) return true; } catch {}
	}
	return false;
}

function isOutsideWorkspace(abs, root = ROOT) {
	let real, realRoot;
	try { real = fs.realpathSync(abs); realRoot = fs.realpathSync(root); } catch { return false; }
	return real !== realRoot && !real.startsWith(realRoot + path.sep);
}

function isSnapshotExcluded(top, file, root = ROOT) {
	let realRoot;
	try { realRoot = fs.realpathSync(root); } catch { realRoot = path.resolve(root); }
	if (path.resolve(top) !== realRoot) return false;
	let rel = String(file).replace(/\\/g, "/").replace(/\/+$/, "");
	if (rel.startsWith("./")) rel = rel.slice(2);
	if (path.isAbsolute(rel)) rel = path.relative(top, rel).replace(/\\/g, "/");
	if (!rel || rel === "." || rel.startsWith("..")) return false;
	return REVIEW_SNAPSHOT_EXCLUDED_FILES.has(rel) || REVIEW_SNAPSHOT_EXCLUDED_PREFIXES.some((p) => rel === p.replace(/\/+$/, "") || rel.startsWith(p));
}

function filterSnapshotStatus(buf, top, root = ROOT) {
	if (!buf || buf.length === 0) return buf;
	const kept = [];
	for (const chunk of buf.toString("utf8").split("\0")) {
		if (chunk === "") continue;
		const m = chunk.match(/^(.{2}) (.*)$/s);
		if (m && isSnapshotExcluded(top, m[2], root) &&
			((m[1] === "??" || m[1] === "!!") || (m[2] === ".claude/deploy/audit.jsonl" && !/[RC]/.test(m[1])))) continue;
		kept.push(chunk);
	}
	if (!kept.length) return Buffer.alloc(0);
	return Buffer.from(kept.join("\0") + "\0", "utf8");
}

function reviewErrorDetails(error, stage, startedAt, root = ROOT) {
	const token = (v) => typeof v === "string" && /^[A-Za-z0-9_ -]{1,64}$/.test(v) ? v : null;
	let rel = null;
	if (typeof error?.path === "string") {
		const candidate = path.relative(root, path.resolve(root, error.path));
		if (!path.isAbsolute(candidate) && candidate !== ".." && !candidate.startsWith(".." + path.sep)) rel = candidate || ".";
	}
	return JSON.stringify({
		stage: [stage, error?.snapshotStage].filter(Boolean).join("/"),
		elapsed_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
		code: token(error?.code), syscall: token(error?.syscall), path: rel,
	});
}

function readOnlySnapshot(isolated = false, root = ROOT) {
	const h = crypto.createHash("sha256");
	const realRoot = fs.realpathSync(root);
	h.update(gitSnapshot(root, new Set(), isolated, root));
	if (fs.realpathSync(process.cwd()) !== realRoot) {
		if (isRecoveryMode(root) && isOutsideWorkspace(process.cwd(), root)) h.update("cwd-external-recovery-skip");
		else h.update(gitSnapshot(process.cwd(), new Set(), isolated, root));
	}
	for (const file of new Set([statePath(process.env), lib.stateFile(process.env)])) hashPath(h, file);
	return h.digest("hex");
}

function stateSnapshot() {
	const h = crypto.createHash("sha256");
	for (const file of new Set([statePath(process.env), lib.stateFile(process.env)])) hashPath(h, file);
	return h.digest("hex");
}

module.exports = {
	gitSnapshot,
	hashIgnoredPath,
	hashPath,
	REVIEW_SNAPSHOT_EXCLUDED_FILES,
	REVIEW_SNAPSHOT_EXCLUDED_PREFIXES,
	isRecoveryMode,
	isOutsideWorkspace,
	isSnapshotExcluded,
	filterSnapshotStatus,
	reviewErrorDetails,
	readOnlySnapshot,
	stateSnapshot,
};
