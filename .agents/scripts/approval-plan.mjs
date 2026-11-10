#!/usr/bin/env node
/**
 * 운영 배포 승인 보고 양식(계획서) 도구. 절차: docs/guides/approval-plan-gate.md
 *
 *   template                         빈 양식(JSON) 출력
 *   check <plan>                     양식 칸·적대 리뷰 기록 점검, 명령별 sha 출력
 *   report <plan>                    승인자에게 올릴 보고문 출력(리뷰 통과 시)
 *   review <plan> --author <argon|codex|muse> [--out <file>] 차례(작성자 다음 모델) 1명 적대 리뷰(읽기 전용) → 결과 파일 + gates/deploy-plan-review.json. 고정 planReview 가 유효하면 그 리뷰어를 먼저 쓰고, 한도 실패 때만 차례대로 넘어간다(넘긴 리뷰어는 skipped 로 남긴다)
 *       리뷰마다 gates/review-rounds/round-<NNN>.json 을 쌓고, 직전 회차 판정·차단 지적을 요청문에 붙인다. 연속 3회 FAIL 이면 리뷰 대신 사람 판정 요청을 내고 코드 4로 끝낸다
 *   review-prompt <plan>             리뷰 요청문만 출력(직전 회차 포함)
 *   preapprove <plan> --session <id>      사전승인 코드 발급(승인 아님: PLAN+전단계 코드, approval_mode 사전 계획만)
 *   step-ok <plan> <step> --evidence <file>   단계 성공 확인 증거 기록(gates/deploy-steps/<step>.json)
 *   judge <plan> --evidence <file>... --executor-session <id>   장애/개발 독립 판정(다른 세션: muse 헤드리스)
 *
 * 이름에 deploy 를 넣지 않는다: 배포 가드 분류기가 이름에 deploy 가 든 스크립트를 운영 배포로 본다.
 * 이 도구는 운영 서버에 아무 명령도 보내지 않는다.
 */
import Module, { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

// 기동 시점 실행기 해시: 해시한 동일 바이트를 실행한다.
const PINNED_CJS_EXECUTORS = [
	".claude/hooks/lib/deploy-human-approval.js",
	".claude/hooks/lib/deploy-plan.js",
];
const preloadFlag = /(?:^|[\s"'])(?:--(?:require|import|(?:experimental-)?loader)(?=$|[\s="'])|-r)/;
if (preloadFlag.test(process.env.NODE_OPTIONS || "") || process.execArgv.some((arg) => preloadFlag.test(arg))) {
	die("기동 거부: NODE_OPTIONS/execArgv 선적재 옵션은 허용하지 않음", 1);
}
const pinnedExecutors = PINNED_CJS_EXECUTORS.map((rel) => {
	const requested = path.resolve(ROOT, rel);
	return { rel, requested, filename: fs.realpathSync(requested) };
});
for (const { requested, filename } of pinnedExecutors) {
	if (Object.hasOwn(require.cache, requested) || Object.hasOwn(require.cache, filename)) {
		die("기동 거부: 실행기 require.cache 선적재는 허용하지 않음", 1);
	}
}
const bootEntryAbs = (() => {
	const fromArgv = process.argv[1] ? path.resolve(process.argv[1]) : null;
	const fallback = fileURLToPath(import.meta.url);
	try { return fs.realpathSync(fromArgv || fallback); }
	catch { return path.resolve(fromArgv || fallback); }
})();
let BOOT_ENTRY_SHA = null;
try { BOOT_ENTRY_SHA = sha256(fs.readFileSync(bootEntryAbs)); }
catch { BOOT_ENTRY_SHA = null; }
const STARTUP_EXECUTOR_SHAS = new Map();
let lib, commandHash, statePath;
{
	for (const executor of pinnedExecutors) {
		const { rel, filename } = executor;
		const buf = fs.readFileSync(filename);
		executor.buffer = buf;
		STARTUP_EXECUTOR_SHAS.set(rel, sha256(buf));
	}
	const entryRel = path.relative(fs.realpathSync(ROOT), bootEntryAbs);
	STARTUP_EXECUTOR_SHAS.set(entryRel, BOOT_ENTRY_SHA);
	const compiled = [];
	try {
		for (const { filename, buffer } of pinnedExecutors) {
			const mod = new Module(filename);
			mod.filename = filename;
			mod.paths = Module._nodeModulePaths(path.dirname(filename));
			if (compiled.length) {
				const dependency = compiled[0];
				mod.require = function (request) {
					return request === "./deploy-human-approval.js" ? dependency.exports : Module.prototype.require.call(this, request);
				};
			}
			require.cache[filename] = mod;
			compiled.push(mod);
			mod._compile(buffer.toString(), filename);
			mod.loaded = true;
		}
		({ commandHash, statePath } = compiled[0].exports);
		lib = compiled[1].exports;
	} catch (error) {
		for (const mod of compiled) delete require.cache[mod.filename];
		throw error;
	}
}

const MUSE = process.env.APPROVAL_PLAN_MUSE_BIN || "muse";
const MODEL = "muse-spark-1.3";
const EFFORT = "xhigh";

function die(msg, code = 2) {
	console.error(msg);
	process.exit(code);
}
function opt(args, name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}
function optAll(args, name) {
	const out = [];
	for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1]) out.push(args[++i]);
	return out;
}
function loadPlan(p) {
	if (!p) die("계획서 경로가 필요합니다(.agents/progress/<작업>/gates/deploy-plan.json)");
	const abs = path.resolve(p);
	if (path.basename(abs) !== lib.PLAN_FILE || path.basename(path.dirname(abs)) !== "gates") die(`계획서는 .agents/progress/<작업>/gates/${lib.PLAN_FILE} 여야 합니다`);
	let plan;
	try {
		plan = JSON.parse(fs.readFileSync(abs, "utf8"));
	} catch (e) {
		die(`계획서를 읽지 못함: ${e.message}`);
	}
	return { abs, plan, gatesDir: path.dirname(abs), sha: sha256(fs.readFileSync(abs)) };
}

function runMuse(prompt) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-plan-"));
	const file = path.join(dir, "prompt.txt");
	fs.writeFileSync(file, prompt, { mode: 0o600 });
	let res;
	try {
		res = spawnSync(MUSE, ["exec", "--disable-approval", "--disable-sandbox", "--disable-write", "--disable-shell", "--no-session-log", "--model", MODEL, "--reasoning-effort", EFFORT, "--prompt-file", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 45 * 60 * 1000 });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	if (res.status !== 0 || !String(res.stdout || "").trim()) die(`muse 실행 실패(status ${res.status}): ${String(res.stderr || res.error || "").slice(0, 400)}`, 3);
	return String(res.stdout);
}

function execReviewer(bin, args, input = "", promptSha = "", model = "") {
	return new Promise((resolve) => {
		const startedAt = new Date().toISOString();
		let stdout = "", stderr = "", bytes = 0, finished = false, failed = "";
		const child = spawn(bin, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
		const finish = (status, error = "") => {
			if (finished) return;
			finished = true; clearTimeout(timer);
			resolve({ body: stdout, stderr, receipt: { model, started_at: startedAt, ended_at: new Date().toISOString(), exit_code: status, prompt_sha256: promptSha }, error: failed || error || (status !== 0 ? `status ${status}` : !stdout.trim() ? "빈 출력" : "") });
		};
		const timer = setTimeout(() => { failed = "45분 실행 제한 초과"; child.kill("SIGKILL"); }, 45 * 60 * 1000);
		child.on("error", () => finish(null, "실행 파일을 시작하지 못함"));
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (b) => {
			bytes += Buffer.byteLength(b, "utf8");
			if (bytes > 64 * 1024 * 1024) { failed = "출력 크기 제한 초과"; child.kill("SIGKILL"); }
			else stdout += b;
		});
		// stderr 는 한도 판별에만 쓰고 기록에는 남기지 않는다. 끝 16KB 만 둔다.
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (b) => { stderr = (stderr + b).slice(-16 * 1024); });
		child.on("close", (status) => finish(status));
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

function gitSnapshot(cwd = ROOT, seen = new Set(), isolated = false) {
	const git = (args, allowFailure = false) => {
		const r = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
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
	h.update(filterSnapshotStatus(git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]), cwd));
	const hasHead = git(["rev-parse", "--verify", "HEAD"], true) !== null;
	h.update(git(["diff", "--binary", ...(hasHead ? ["HEAD"] : []), "--ignore-submodules=all"]));
	h.update(git(["diff", "--cached", "--binary", "--ignore-submodules=all"]));
	const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0").filter(Boolean).filter((f) => !isSnapshotExcluded(cwd, f));
	const ignored = git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]).toString("utf8").split("\0").filter(Boolean).filter((f) => !isSnapshotExcluded(cwd, f));
	for (const file of ignored.sort()) hashIgnoredPath(h, path.resolve(cwd, file));
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
		if (isRecoveryMode() && isOutsideWorkspace(abs)) {
			h.update(file + "\0external-recovery-skip"); continue;
		}
		if (!fs.existsSync(path.join(abs, ".git"))) {
			if (fs.existsSync(abs) && fs.readdirSync(abs).length) throw new Error("submodule 내용 확인 불가");
			h.update(file + "\0uninitialized"); continue;
		}
		h.update(file); h.update(gitSnapshot(abs, seen, isolated));
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

const REVIEW_SNAPSHOT_EXCLUDED_PREFIXES = [".agents/progress/", ".agents/work/", ".agents/.dm-outbox/", "gates/", "tmp/"];
const REAL_ROOT = fs.realpathSync(ROOT);
function isRecoveryMode() {
	for (const marker of [".codex/no-harness", ".claude/no-harness", ".pi/no-harness"]) {
		try { if (fs.statSync(path.join(ROOT, marker)).isFile()) return true; } catch {}
	}
	return false;
}
function isOutsideWorkspace(abs) {
	let real;
	try { real = fs.realpathSync(abs); } catch { return false; }
	return real !== REAL_ROOT && !real.startsWith(REAL_ROOT + path.sep);
}
function isSnapshotExcluded(top, file) {
	if (path.resolve(top) !== REAL_ROOT) return false;
	let rel = String(file).replace(/\\/g, "/").replace(/\/+$/, "");
	if (rel.startsWith("./")) rel = rel.slice(2);
	if (path.isAbsolute(rel)) rel = path.relative(top, rel).replace(/\\/g, "/");
	if (!rel || rel === "." || rel.startsWith("..")) return false;
	return REVIEW_SNAPSHOT_EXCLUDED_PREFIXES.some((p) => rel === p.replace(/\/+$/, "") || rel.startsWith(p));
}
function filterSnapshotStatus(buf, top) {
	if (!buf || buf.length === 0) return buf;
	const kept = [];
	for (const chunk of buf.toString("utf8").split("\0")) {
		if (chunk === "") continue;
		const m = chunk.match(/^(.{2}) (.*)$/s);
		if (m && (m[1] === "??" || m[1] === "!!") && isSnapshotExcluded(top, m[2])) continue;
		kept.push(chunk);
	}
	if (!kept.length) return Buffer.alloc(0);
	return Buffer.from(kept.join("\0") + "\0", "utf8");
}

function reviewErrorDetails(error, stage, startedAt) {
	const token = (v) => typeof v === "string" && /^[A-Za-z0-9_ -]{1,64}$/.test(v) ? v : null;
	let rel = null;
	if (typeof error?.path === "string") {
		const candidate = path.relative(ROOT, path.resolve(ROOT, error.path));
		if (!path.isAbsolute(candidate) && candidate !== ".." && !candidate.startsWith(".." + path.sep)) rel = candidate || ".";
	}
	return JSON.stringify({
		stage: [stage, error?.snapshotStage].filter(Boolean).join("/"),
		elapsed_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
		code: token(error?.code), syscall: token(error?.syscall), path: rel,
	});
}

function readOnlySnapshot(isolated = false) {
	const h = crypto.createHash("sha256");
	h.update(gitSnapshot(ROOT, new Set(), isolated));
	if (fs.realpathSync(process.cwd()) !== fs.realpathSync(ROOT)) {
		if (isRecoveryMode() && isOutsideWorkspace(process.cwd())) h.update("cwd-external-recovery-skip");
		else h.update(gitSnapshot(process.cwd(), new Set(), isolated));
	}
	for (const file of new Set([statePath(process.env), lib.stateFile(process.env)])) hashPath(h, file);
	return h.digest("hex");
}

function stateSnapshot() {
	const h = crypto.createHash("sha256");
	for (const file of new Set([statePath(process.env), lib.stateFile(process.env)])) hashPath(h, file);
	return h.digest("hex");
}

function findBwrap() {
	for (const dir of (process.env.PATH || "").split(path.delimiter)) {
		const bin = path.resolve(dir, "bwrap");
		try { fs.accessSync(bin, fs.constants.X_OK); if (fs.statSync(bin).isFile()) return bin; } catch {}
	}
	return null;
}

function reviewerSandboxArgs(promptDir, id) {
	const root = fs.realpathSync(ROOT), cwd = fs.realpathSync(process.cwd());
	const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
	const home = fs.realpathSync(os.homedir());
	const runtime = id === "argon" ? fs.realpathSync(path.join(home, ".gemini")) : null;
	if (runtime && (!fs.statSync(runtime).isDirectory() || !runtime.startsWith(home + path.sep) || [root, cwd].some(p => overlaps(p, runtime)))) throw new Error("reviewer home overlaps protected workspace");
	const protectedDirs = new Set([root, cwd, fs.realpathSync(promptDir)]);
	for (const state of new Set([statePath(process.env), lib.stateFile(process.env)])) {
		let parent = path.dirname(path.resolve(state));
		while (!fs.existsSync(parent)) { const next = path.dirname(parent); if (next === parent) throw new Error("state parent unavailable"); parent = next; }
		protectedDirs.add(fs.realpathSync(parent));
		if (fs.existsSync(state)) protectedDirs.add(path.dirname(fs.realpathSync(state)));
	}
	const args = ["--die-with-parent", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
	if (runtime) args.push("--bind", runtime, runtime);
	if (id === "codex") {
		// Codex may write session and SQLite runtime state even in ephemeral mode, and opens installation_id read-write at start
		// (without it the reviewer exits 1 with "Read-only file system", found by the 2026-11-10 real QC).
		// Grant only existing runtime paths; the repository and gate directories stay read-only.
		const codexHome = path.join(home, ".codex");
		for (const name of ["sessions", "tmp", "log", "installation_id", "state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm"]) {
			const target = path.join(codexHome, name);
			if (!fs.existsSync(target)) continue;
			const real = fs.realpathSync(target);
			if (real !== target || [...protectedDirs].some(p => overlaps(p, real))) throw new Error("codex runtime overlaps protected workspace");
			args.push("--bind", target, target);
		}
	}
	for (const dir of protectedDirs) args.push("--ro-bind", dir, dir);
	return [...args, "--chdir", root];
}

async function runReviewers(ids, prompt, abs, preManifest = undefined) {
	let dir, failure;
	let stage = "prompt-create";
	const startedAt = Date.now();
	try {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-plan-dual-"));
		const file = path.join(dir, "prompt.txt");
		fs.writeFileSync(file, prompt, { mode: 0o600 });
		stage = "sandbox-prepare";
		const bwrap = findBwrap();
		if (ids.includes("codex") && !bwrap) throw new Error("codex 리뷰어: bwrap 읽기 전용 격리 없음");
		if (isRecoveryMode() && ids.some((id) => id === "argon" || id === "codex") && !bwrap) throw new Error("복구 모드: bwrap 읽기 전용 격리 없음");
		const sandboxArgs = ids.some((id) => id === "argon" || id === "codex") && bwrap ? reviewerSandboxArgs(dir, ids.includes("argon") ? "argon" : "codex") : null;
		const boundedRecovery = isRecoveryMode() && Boolean(sandboxArgs);
		stage = "snapshot-before";
		const before = boundedRecovery ? null : readOnlySnapshot(Boolean(sandboxArgs));
		const beforeState = boundedRecovery ? stateSnapshot() : null;
		const beforeManifest = preManifest === undefined ? (() => { try { return lib.reviewInputManifest(abs, ROOT); } catch { return null; } })() : preManifest;
		stage = "reviewers";
		const results = await Promise.all(ids.map(async (id) => {
			const config = lib.REVIEW_MODELS[id];
			let bin, args, input = "";
			if (id === "muse") {
				bin = MUSE;
				args = ["exec", "--disable-approval", "--disable-sandbox", "--disable-write", "--disable-shell", "--no-session-log", "--model", config.model, "--reasoning-effort", config.effort, "--prompt-file", file];
			} else if (id === "codex") {
				bin = process.env.APPROVAL_PLAN_CODEX_BIN || "codex";
				args = ["exec", "-m", config.model, "-c", `model_reasoning_effort=${config.effort}`, "-s", "read-only", "--skip-git-repo-check", "--ephemeral", prompt];
			} else {
				bin = process.env.APPROVAL_PLAN_ARGON_BIN || "agy";
				args = ["--model", config.model, "--effort", config.effort, "--mode", "plan", "--sandbox", "--disable-slash-commands", "--output-format", "text"];
				input = prompt;
			}
			let isolation = (id === "argon" || id === "codex") ? "snapshot-only" : "cli-read-only";
			if ((id === "argon" || id === "codex") && bwrap) {
				args = [...sandboxArgs, "--", bin, ...args];
				bin = bwrap; isolation = "bwrap-ro-bind";
			}
			return { id, ...config, isolation, ...await execReviewer(bin, args, input, sha256(prompt), config.model) };
		}));
		stage = "manifest-after";
		let afterManifest = null;
		try { afterManifest = lib.reviewInputManifest(abs, ROOT); } catch { afterManifest = null; }
		const manifestChanged = beforeManifest === null || beforeManifest === undefined || afterManifest === null || beforeManifest !== afterManifest;
		for (const r of results) {
			if (beforeManifest && r.receipt) r.receipt.input_manifest_sha256 = beforeManifest;
		}
		if (manifestChanged) {
			for (const r of results) r.error = "읽기 전용 검사 실패: 리뷰 대상 또는 실행기가 바뀜";
		} else if (boundedRecovery) {
			let changed = true;
			try { changed = beforeState !== stateSnapshot(); }
			catch (error) { console.error(reviewErrorDetails(error, "snapshot-after", startedAt)); }
			if (changed) for (const r of results) r.error = "읽기 전용 검사 실패: 승인 상태가 바뀜";
		} else {
			let changed = true;
			try { changed = before !== readOnlySnapshot(Boolean(sandboxArgs)); }
			catch (error) { console.error(reviewErrorDetails(error, "snapshot-after", startedAt)); }
			if (changed) for (const r of results) r.error = "읽기 전용 검사 실패: git status 또는 작업 트리 내용이 바뀜";
		}
		return results;
	} catch (error) {
		failure = error;
		error.reviewStage = stage;
		throw error;
	} finally {
		try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
		catch (error) {
			if (failure) console.error(reviewErrorDetails(error, "prompt-cleanup", startedAt));
			else { error.reviewStage = "prompt-cleanup"; throw error; }
		}
	}
}

function reviewStatus(gatesDir, sha, writeFindings = false, record = undefined) {
	const r = lib.reviewProblems(gatesDir, sha, ROOT, { record });
	for (const row of r.reviewers) {
		const fail = row.summary.filter((s) => s.verdict !== "PASS").map((s) => s.id);
		console.log(`리뷰어 ${row.id}: ${row.body ? (row.ok ? "PASS" : "FAIL") : "결과 없음"}; 불통과 기준 ${fail.join(", ") || (row.summary.length === lib.CRITERIA.length ? "없음" : "결과 없음")}; 남은 지적(차단) ${row.openFindings ?? "확인 불가"}; 참고 지적 ${row.advisoryFindings ?? 0}(차단 아님)`);
	}
	const merged = path.join(gatesDir, "deploy-plan-review-findings.md");
	if (writeFindings) {
		fs.writeFileSync(merged, lib.renderMergedFindings(r, sha));
		console.log(`통합 지적: ${path.relative(ROOT, merged)}`);
	}
	return r;
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
	case "template":
		console.log(JSON.stringify({ ...lib.TEMPLATE, createdAt: new Date().toISOString() }, null, 2));
		break;
	case "check": {
		const { abs, plan, gatesDir, sha } = loadPlan(args[0]);
		const form = lib.formProblems(plan);
		console.log(`계획서: ${path.relative(ROOT, abs)}  sha256 ${sha}`);
		for (const s of plan.scenario || []) for (const c of s.commands || []) console.log(`  ${s.id}  ${commandHash(c)}  ${String(c).slice(0, 120)}`);
		for (const a of plan.incident?.actions || []) for (const c of a.commands || []) console.log(`  장애 ${a.id}  ${commandHash(c)}  ${String(c).slice(0, 120)}`);
		console.log(form.length ? `양식: 빈 칸 ${form.length}\n${form.map((x) => `- ${x}`).join("\n")}` : "양식: 통과");
		const r = reviewStatus(gatesDir, sha);
		console.log(r.ok ? "적대 리뷰: 통과" : `적대 리뷰: 미통과\n${r.problems.map((x) => `- ${x}`).join("\n")}`);
		process.exit(form.length || !r.ok ? 1 : 0);
	}
	case "report": {
		const { plan, gatesDir, sha } = loadPlan(args[0]);
		const form = lib.formProblems(plan);
		if (form.length) die(`양식 빈 칸 ${form.length}건 — 보고문을 낼 수 없습니다\n${form.join("\n")}`, 1);
		const r = lib.reviewProblems(gatesDir, sha, ROOT);
		if (!r.ok) die(`적대 리뷰 미통과 — 보고문을 낼 수 없습니다\n${r.problems.join("\n")}`, 1);
		console.log(lib.renderReport(plan, sha, r));
		break;
	}
	case "review-prompt": {
		const { plan, sha, gatesDir } = loadPlan(args[0]);
		console.log(lib.reviewPrompt(plan, sha, ROOT, lib.priorRound(gatesDir)));
		break;
	}
	case "review": {
		let early = null;
		try { if (args[0]) early = lib.reviewInputEntries(path.resolve(args[0]), ROOT); } catch { early = null; }
		const { abs, plan, gatesDir, sha } = loadPlan(args[0]);
		const bindProblems = [];
		if (!early || early.digest === null) bindProblems.push(`읽기 전용 검사 실패: 리뷰 대상 또는 실행기가 바뀜(${early && early.problems.length ? early.problems[0] : "계획서·핀·실행기를 읽지 못함"})`);
		else {
			if (early.planSha256 !== sha) bindProblems.push("읽기 전용 검사 실패: 리뷰 대상 또는 실행기가 바뀜(계획서가 manifest 계산 뒤 바뀜)");
			const earlyByFile = new Map((early.entries || []).map((e) => [e.file, e.sha256]));
			if (STARTUP_EXECUTOR_SHAS.size !== lib.REVIEW_EXECUTOR_FILES.length) bindProblems.push("읽기 전용 검사 실패: 리뷰 대상 또는 실행기가 바뀜(실행기 목록이 기동 뒤 바뀜)");
			for (const [rel, want] of STARTUP_EXECUTOR_SHAS) {
				let now = null;
				try { now = sha256(fs.readFileSync(path.join(ROOT, rel))); } catch { now = null; }
				const earlySha = earlyByFile.get(rel) ?? null;
				if (want === null || now === null || earlySha === null || now !== want || earlySha !== want) {
					bindProblems.push(`읽기 전용 검사 실패: 리뷰 대상 또는 실행기가 바뀜(실행기 ${rel} 가 적재 경계 또는 기동 뒤 바뀜)`);
					break;
				}
			}
		}
		if (bindProblems.length) die(bindProblems.join("\n"), 1);
		const author = opt(args, "--author");
		if (!lib.ROTATION.includes(author)) die("--author argon|codex|muse 가 필요합니다(차례 셋 중 계획서 author_model 과 같은 것)");
		if (!Object.hasOwn(lib.REVIEW_MODELS, plan.author_model || "") || plan.author_model !== author) die("--author(argon|codex|muse) 와 계획서 author_model 이 다릅니다");
		const form = lib.formProblems(plan);
		if (form.length) die(`양식 빈 칸 ${form.length}건 — 먼저 채우십시오\n${form.join("\n")}`, 1);
		const pins = lib.pinnedFileProblems(plan, ROOT);
		if (pins.length) die(pins.join("\n"), 1);
		// 회차: 회차 파일이 아직 없고 앞 리뷰 기록이 있으면 그것을 첫 회차로 옮겨 둔다(회차 도입 전 기록도 직전 회차로 쓴다).
		if (!lib.roundFiles(gatesDir).length) {
			let old = null, oldSha = null;
			try { const buf = fs.readFileSync(path.join(gatesDir, lib.REVIEW_FILE)); oldSha = sha256(buf); old = JSON.parse(buf.toString("utf8")); } catch { old = null; }
			if (old && typeof old.plan_sha256 === "string" && Array.isArray(old.reviewers) && old.reviewers.some((r) => r && r.result)) {
				// 옛 기록도 관문을 통과해야 PASS 다. 무효 영수증의 본문 PASS 는 판정 "없음"과 실패 이유로 남는다(roundOutcome).
				let outcome = { verdict: "없음", criteria: [], blocking: [], reasons: ["옛 리뷰 기록을 관문으로 확인하지 못함"] };
				try { outcome = lib.roundOutcome(lib.reviewProblems(gatesDir, old.plan_sha256, ROOT)); } catch {}
				// 옮길 때 영수증은 그대로이므로 그 바이트 sha 로 확정 표지를 함께 쓴다.
				const moved = lib.writeRound(gatesDir, { plan_sha256: old.plan_sha256, plan: old.plan_sha256 === sha ? plan : null, record: old, outcome, legacy: true });
				lib.markRound(gatesDir, moved.rel, oldSha);
			}
		}
		// 같은 계획서가 연속 상한만큼 FAIL 이면 리뷰를 돌리지 않고 사람 판정을 요청한다.
		const streak = lib.failStreak(gatesDir);
		if (streak.count >= lib.ROUND_FAIL_LIMIT) die(lib.humanDecisionRequest(path.relative(ROOT, abs), streak), 4);
		const prior = lib.priorRound(gatesDir);
		const prompt = lib.reviewPrompt(plan, sha, ROOT, prior);
		const stamp = new Date().toISOString().replace(/[:.]/g, "-") + "-" + crypto.randomUUID();
		const base = path.resolve(opt(args, "--out") || path.join(gatesDir, `deploy-plan-review-${stamp}.md`));
		// 차례는 기록 reviewedAt 과 같은 시각으로 고른다. 관문이 같은 시각으로 차례를 다시 만들어 대조한다.
		const reviewedAt = new Date().toISOString();
		let ids;
		try { ids = lib.orderedReviewers(author, ROOT, reviewedAt); }
		catch (error) { die(`리뷰 차례를 정하지 못함: ${error.message}`); }
		const parsed = path.parse(base);
		const outputs = ids.map((id) => path.join(parsed.dir, `${parsed.name}-${id}${parsed.ext || ".md"}`));
		for (const out of outputs) if (out === abs || fs.existsSync(out)) die("리뷰 결과 경로가 이미 있습니다. 새 --out 경로를 쓰십시오");
		try { for (const out of outputs) lib.resultFile(gatesDir, path.relative(gatesDir, out), true); }
		catch { die("--out 은 해당 계획서 gatesDir 안 일반 파일 경로여야 합니다. 하위 폴더는 먼저 만드십시오"); }
		const rec = { plan_sha256: sha, plan: path.relative(ROOT, abs), author_model: author, prompt_sha256: sha256(prompt), rotation: true, skipped: [], reviewers: [], reviewedAt, ...(prior ? { prior_round: { round: prior.data.round, file: prior.rel, sha256: prior.sha256 } } : {}) };
		const recordFile = path.join(gatesDir, lib.REVIEW_FILE);
		fs.writeFileSync(recordFile, `${JSON.stringify(rec, null, 2)}\n`);
		const reviewStartedAt = Date.now();
		// 리뷰 본문은 계획서 낱말을 되풀이할 수 있으므로 한도 판별에서 뺀다.
		const limitTextOf = (r) => `${r.stderr || ""}\n${r.error || ""}`;
		let actual = null, actualOutput = null;
		try {
			const [first] = await runReviewers([ids[0]], prompt, abs, early.digest);
			if (lib.isLimitFailure(first.receipt?.exit_code, limitTextOf(first))) {
				rec.skipped.push({ id: ids[0], reason: "limit", exit_code: first.receipt.exit_code, ended_at: first.receipt.ended_at });
				console.log(`한도 실패로 다음 차례 리뷰어로 넘어감: ${ids[0]} → ${ids[1]}`);
				const [second] = await runReviewers([ids[1]], prompt, abs, early.digest);
				actual = second; actualOutput = outputs[1];
			} else {
				actual = first; actualOutput = outputs[0];
			}
		}
		catch (error) { die(`읽기 전용 실행 준비 실패. 이전 리뷰 기록은 무효입니다 ${reviewErrorDetails(error, error.reviewStage || "review-prepare", reviewStartedAt)}`, 3); }
		{
			const r = actual;
			const text = r.body.endsWith("\n") ? r.body : `${r.body}\n`;
			const final = `${text}review-run: target_sha256=${sha} prompt_sha256=${sha256(prompt)} stdout_sha256=${sha256(text)}\n`;
			let output;
			try { output = lib.resultFile(gatesDir, path.relative(gatesDir, actualOutput), true); }
			catch { die("리뷰 실행 중 결과 경로가 gatesDir 밖 또는 일반 파일이 아닌 경로로 바뀜", 3); }
			fs.writeFileSync(output, final, { flag: "wx" });
			rec.reviewers.push({ id: r.id, model: r.model, effort: r.effort, result: path.relative(gatesDir, actualOutput), result_sha256: sha256(final), target_sha256: sha, receipt: { ...r.receipt, stdout_sha256: sha256(text), isolation: r.isolation }, ...(r.error ? { execution_error: r.error } : {}) });
			console.log(`결과 ${r.id}: ${path.relative(ROOT, actualOutput)}`);
		}
		// 회차 파일 → 최신 영수증 → 확정 표지(round-NNN.ok, 영수증 바이트 sha) 순서로 쓴다. 어느 단계든 실패하면 표지가 없거나
		// 디스크 영수증과 맞지 않아 관문이 막고, 회차 판정도 "없음"으로 본다(실패 시 닫힘).
		const r = reviewStatus(gatesDir, sha, true, rec);
		const outcome = lib.roundOutcome(r);
		let saved, recordSha;
		try { saved = lib.writeRound(gatesDir, { plan_sha256: sha, plan, record: rec, outcome }); }
		catch (error) { die(`회차 기록 저장 실패(${error.code || error.message}). 최신 리뷰 영수증을 확정하지 않았으므로 이번 리뷰는 무효입니다. 다시 리뷰하십시오`, 3); }
		try { recordSha = lib.writeReviewRecord(gatesDir, rec); }
		catch (error) { die(`최신 리뷰 영수증 저장 실패(${error.code || error.message}). 회차를 확정하지 않았으므로 이번 리뷰는 무효입니다. 다시 리뷰하십시오`, 3); }
		try { lib.markRound(gatesDir, saved.rel, recordSha); }
		catch (error) {
			if (error.uncertain) die(`회차 확정 여부 불명(${error.code || error.message}). 판정은 디스크를 따릅니다: approval-plan check 로 관문 상태를 확인하고, 막히면 다시 리뷰하십시오`, 5);
			die(`회차 확정 표지 저장 실패(${error.code || error.message}). 이번 리뷰는 무효입니다. 다시 리뷰하십시오`, 3);
		}
		console.log(`회차 기록: gates/${saved.rel} (판정 ${outcome.verdict})`);
		console.log(r.ok ? "적대 리뷰: 통과 — 승인 요청 가능" : `적대 리뷰: 미통과\n${r.problems.map((x) => `- ${x}`).join("\n")}`);
		process.exit(r.ok ? 0 : 1);
	}
	case "preapprove": {
		const { abs, plan, sha } = loadPlan(args[0]);
		const session = opt(args, "--session");
		if (!session) die("--session <rootSessionId> 가 필요합니다");
		const r = await lib.preapproveStepCodes(abs, ROOT, session, process.env, Date.now());
		if (!r.ok) die(`사전발급 거부: ${r.why}`, 1);
		console.log(lib.renderReport(plan, sha, r.review));
		console.log(`사전발급 코드(사용자 본인이 한 메시지로 승인): PLAN ${r.plan_code} ` + r.steps.map((s) => `${s.step} ${s.code}`).join(" "));
		break;
	}
	case "step-ok": {
		const { plan, gatesDir, sha } = loadPlan(args[0]);
		const step = args[1];
		if (!(plan.scenario || []).some((s) => s.id === step)) die(`단계 ${step} 가 계획서에 없습니다`);
		const ev = opt(args, "--evidence");
		if (!ev || !fs.existsSync(ev)) die("--evidence <성공 확인 출력 파일> 이 필요합니다");
		const dir = path.join(gatesDir, "deploy-steps");
		fs.mkdirSync(dir, { recursive: true });
		const copy = path.join(dir, `${step}-evidence.txt`);
		fs.copyFileSync(ev, copy);
		const rec = { plan_sha256: sha, step, verdict: "pass", evidence: path.basename(copy), evidence_sha256: sha256(fs.readFileSync(copy)), checkedAt: new Date().toISOString() };
		fs.writeFileSync(path.join(dir, `${step}.json`), `${JSON.stringify(rec, null, 2)}\n`);
		console.log(`단계 ${step} 성공 확인 기록: ${path.relative(ROOT, path.join(dir, `${step}.json`))}`);
		break;
	}
	case "judge": {
		const { plan, gatesDir, sha } = loadPlan(args[0]);
		const evidence = optAll(args, "--evidence");
		const executor = opt(args, "--executor-session") || process.env.CLAUDE_SESSION_ID || "";
		if (!executor) die("--executor-session <실행 세션 id> 가 필요합니다");
		if (evidence.length === 0) die("--evidence <확인 결과·헬스·오류 로그 파일> 이 하나 이상 필요합니다");
		const ev = evidence.map((p) => { const abs = path.resolve(p); const buf = fs.readFileSync(abs); return { path: abs, sha256: sha256(buf), text: buf.toString("utf8").slice(0, 20000) }; });
		const prompt = [
			"당신은 운영 배포를 실행하는 세션과 다른, 독립 판정자입니다. 지금 상황이 '장애'인지 '개발'인지 판정하십시오.",
			"장애(incident): 운영 사용자에게 지금 영향이 있거나 곧 생기며, 계획서의 장애 판단 기준에 해당한다. 계획서에 미리 적은 선조치를 바로 해야 한다.",
			"개발(development): 배포 작업 중 생긴 실패·예상 밖 결과지만 운영 사용자 영향이 없거나 기준에 해당하지 않는다. 실행 세션은 멈추고 보고해야 한다.",
			"애매하면 개발로 판정하십시오(선조치는 승인 없이 도는 길이라 좁게 씁니다).",
			"",
			"장애 판단 기준:",
			...((plan.incident && plan.incident.criteria) || []).map((c) => `- ${c}`),
			"선조치 목록:",
			...((plan.incident && plan.incident.actions) || []).map((a) => `- ${a.id}: ${a.why_safe}`),
			"",
			...ev.flatMap((e) => [`증거 ${path.basename(e.path)}:`, "```", e.text, "```"]),
			"",
			"출력 마지막 줄을 정확히 'VERDICT: incident' 또는 'VERDICT: development' 로 쓰고, 그 위에 근거를 3줄 이내로 적으십시오.",
		].join("\n");
		const raw = runMuse(prompt);
		const lastLine = raw.trim().split(/\r?\n/).filter((l) => l.trim()).pop() || "";
		const m = lastLine.match(/^\s*VERDICT:\s*(incident|development)\s*$/i);
		const verdict = m ? m[1].toLowerCase() : "development";
		const judgeSession = `muse-judge-${crypto.randomUUID()}`;
		const dir = path.join(gatesDir, "deploy-incident");
		fs.mkdirSync(dir, { recursive: true });
		const rec = { plan_sha256: sha, verdict, judge: { model: MODEL, effort: EFFORT, session: judgeSession }, executor_session: executor, evidence: ev.map(({ path: p, sha256: s }) => ({ path: p, sha256: s })), decidedAt: new Date().toISOString(), raw_output: raw.slice(-4000), raw_sha256: sha256(raw) };
		const file = path.join(dir, `${rec.decidedAt.replace(/[:.]/g, "-")}.json`);
		fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
		console.log(`판정: ${verdict === "incident" ? "장애 — 계획서의 선조치만 실행하고 바로 보고" : "개발 — 선조치 불가, 멈추고 보고"}\n기록: ${path.relative(ROOT, file)}`);
		process.exit(verdict === "incident" ? 0 : 1);
	}
	default:
		die("사용: approval-plan.mjs template|check|report|review|review-prompt|preapprove|step-ok|judge (docs/guides/approval-plan-gate.md)");
}
