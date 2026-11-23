"use strict";
// Approval CLI responsibility: reviewer.
const lib = require("../../.claude/hooks/lib/deploy-plan.js");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { spawn } = require("node:child_process");
const { statePath } = require("../../.claude/hooks/lib/deploy-human-approval.js");
const { MUSE, die, ROOT, sha256 } = require("./approval-plan-files.cjs");
const { isRecoveryMode, readOnlySnapshot, stateSnapshot, reviewErrorDetails } = require("./approval-plan-snapshot.cjs");

function runMuse(prompt, museCfg = lib.REVIEW_MODELS.muse, registeredProvider = null) {
	const validated = lib.validateReviewModelEntry("muse", museCfg);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-plan-"));
	const file = path.join(dir, "prompt.txt");
	fs.writeFileSync(file, prompt, { mode: 0o600 });
	let res, providerSnapshot;
	try {
        providerSnapshot=registeredProvider?snapshotRegisteredProvider(registeredProvider):null;
		res = spawnSync(providerSnapshot?.file || MUSE, ["exec", "--disable-approval", "--disable-sandbox", "--disable-write", "--disable-shell", "--no-session-log", "--model", validated.model, "--reasoning-effort", validated.effort, "--prompt-file", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 45 * 60 * 1000, ...(registeredProvider?{env:require("./registered-gate-environment.cjs").childEnvironment()}:{}) });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
        if(providerSnapshot)fs.rmSync(providerSnapshot.dir,{recursive:true,force:true});
	}
	if (res.status !== 0 || !String(res.stdout || "").trim()) die(`muse 실행 실패(status ${res.status}): ${String(res.stderr || res.error || "").slice(0, 400)}`, 3);
	return String(res.stdout);
}

function execReviewer(bin, args, input, promptSha, model, effort, cwd, env, signal) {
	signal.throwIfAborted();
	return new Promise((resolve) => {
		const startedAt = new Date().toISOString();
		let stdout = "", stderr = "", bytes = 0, finished = false, failed = "";
		const processGroup = process.platform !== "win32";
		const child = spawn(bin, args, { cwd, env, detached: processGroup, stdio: ["pipe", "pipe", "pipe"] });
		let stopped = false;
		const stop = () => {
			if (!child.pid || stopped) return;
			stopped = true;
			if (processGroup) {
				try { process.kill(-child.pid, "SIGKILL"); }
				catch (error) {
					if (error.code === "ESRCH") return;
					failed = `검수 프로세스 그룹 종료 실패 (${error.code})`;
					child.kill("SIGKILL");
				}
			} else {
				const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
				const result = spawnSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
				if (result.status !== 0) child.kill("SIGKILL");
			}
		};
		signal.addEventListener("abort", stop, { once: true });
		// A wrapper may exit while a helper still owns its pipes or the shared test slot.
		if (processGroup) child.once("exit", stop);
		const finish = (status, error = "") => {
			if (finished) return;
			finished = true; clearTimeout(timer);
			signal.removeEventListener("abort", stop);
			resolve({ body: stdout, stderr, receipt: { model, effort, started_at: startedAt, ended_at: new Date().toISOString(), exit_code: status, prompt_sha256: promptSha }, error: failed || error || (status !== 0 ? `status ${status}` : !stdout.trim() ? "빈 출력" : "") });
		};
		const timer = setTimeout(() => { failed = "45분 실행 제한 초과"; stop(); }, 45 * 60 * 1000);
		child.on("error", () => finish(null, "실행 파일을 시작하지 못함"));
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (b) => {
			bytes += Buffer.byteLength(b, "utf8");
			if (bytes > 64 * 1024 * 1024) { failed = "출력 크기 제한 초과"; stop(); }
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

function findBwrap() {
	for (const dir of (process.env.PATH || "").split(path.delimiter)) {
		const bin = path.resolve(dir, "bwrap");
		try { fs.accessSync(bin, fs.constants.X_OK); if (fs.statSync(bin).isFile()) return bin; } catch {}
	}
	return null;
}

function reviewerSandboxArgs(promptDir, id, rootDir = ROOT, registered = false) {
	const root = fs.realpathSync(rootDir), cwd = fs.realpathSync(process.cwd());
	const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
	const home = fs.realpathSync(os.homedir());
	const runtimePath = path.join(home, ".gemini");
	const runtime = id === "agy" && (!registered || fs.existsSync(runtimePath)) ? fs.realpathSync(runtimePath) : null;
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

function snapshotRegisteredProvider(provider) {
 if(!provider||!path.isAbsolute(provider.file)||fs.realpathSync(provider.file)!==provider.file)throw new Error("Registered provider path differs");
 const fd=fs.openSync(provider.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let bytes;
 try{const stat=fs.fstatSync(fd,{bigint:true});if(!stat.isFile()||stat.size>1024n*1024n*1024n)throw new Error("Invalid native provider");bytes=fs.readFileSync(fd);const after=fs.fstatSync(fd,{bigint:true});if(stat.size!==after.size||stat.mtimeNs!==after.mtimeNs||!bytes.subarray(0,4).equals(Buffer.from([127,69,76,70]))||sha256(bytes)!==provider.sha256)throw new Error("Registered provider bytes differ");}finally{fs.closeSync(fd);}
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"registered-provider-"));fs.chmodSync(dir,0o700);const file=path.join(dir,"provider");fs.writeFileSync(file,bytes,{mode:0o500,flag:"wx"});return{file,dir};
}

async function runReviewers(ids, prompt, abs, preManifest, roOpt, planRoot, signal) {
	let dir, failure;
	let stage = "config-read";
	const startedAt = Date.now();
	try {
		const models = lib.reviewModelsFor(planRoot);
		stage = "prompt-create";
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-plan-dual-"));
		const file = path.join(dir, "prompt.txt");
		fs.writeFileSync(file, prompt, { mode: 0o600 });
		stage = "sandbox-prepare";
		const bwrap = roOpt?.registeredProviders ? (fs.existsSync("/usr/bin/bwrap") ? "/usr/bin/bwrap" : null) : findBwrap();
		const configs = Object.fromEntries(ids.map((id) => [id, lib.validateReviewModelEntry(id, models[id])]));
		const runners = ids.map((id) => configs[id].runner);
		if (runners.some((runner) => runner === "codex" || runner === "claude") && !bwrap) throw new Error("리뷰어: bwrap 읽기 전용 격리 없음");
		if (isRecoveryMode(planRoot) && runners.some((runner) => runner !== "muse") && !bwrap) throw new Error("복구 모드: bwrap 읽기 전용 격리 없음");
		const sandboxArgs = runners.some((runner) => runner !== "muse") && bwrap ? reviewerSandboxArgs(dir, runners.includes("agy") ? "agy" : runners.includes("codex") ? "codex" : "claude", planRoot, Boolean(roOpt?.registeredProviders)) : null;
		const boundedRecovery = isRecoveryMode(planRoot) && Boolean(sandboxArgs);
		stage = "snapshot-before";
		const before = boundedRecovery ? null : readOnlySnapshot(Boolean(sandboxArgs), planRoot);
		const beforeState = boundedRecovery ? stateSnapshot() : null;
		const beforeManifest = preManifest === undefined ? (() => { try { return lib.reviewInputManifest(abs, planRoot, roOpt); } catch { return null; } })() : preManifest;
		stage = "reviewers";
		const results = await Promise.all(ids.map(async (id) => {
			const config = configs[id];
			let bin, args, input = "";
			if (config.runner === "muse") {
				bin = MUSE;
				args = ["exec", "--disable-approval", "--disable-sandbox", "--disable-write", "--disable-shell", "--no-session-log", "--model", config.model, "--reasoning-effort", config.effort, "--prompt-file", file];
			} else if (config.runner === "codex") {
				bin = process.env.APPROVAL_PLAN_CODEX_BIN || "codex";
				args = ["exec", "-m", config.model, "-c", `model_reasoning_effort=${config.effort}`, "-s", "read-only", "--skip-git-repo-check", "--ephemeral", "-"];
				input = prompt;
			} else if (config.runner === "claude") {
				bin = process.env.APPROVAL_PLAN_CLAUDE_BIN || "claude";
				args = ["-p", "--model", config.model, "--effort", config.effort, "--setting-sources", ""];
				input = prompt;
			} else {
				bin = process.env.APPROVAL_PLAN_ARGON_BIN || "agy";
				args = ["--model", config.model, "--effort", config.effort, "--mode", "plan", "--sandbox", "--disable-slash-commands", "--output-format", "text"];
				input = prompt;
			}
            let providerSnapshot=null;
            if(roOpt?.registeredProviders){providerSnapshot=snapshotRegisteredProvider(roOpt.registeredProviders[config.runner === "agy" ? "argon" : config.runner]);bin=providerSnapshot.file;}
			let isolation = config.runner !== "muse" ? "snapshot-only" : "cli-read-only";
			if (config.runner !== "muse" && bwrap) {
				args = [...sandboxArgs, ...(providerSnapshot?["--ro-bind",providerSnapshot.dir,providerSnapshot.dir]:[]), "--", bin, ...args];
				bin = bwrap; isolation = "bwrap-ro-bind";
			}
			const env = roOpt?.registeredProviders ? require("./registered-gate-environment.cjs").childEnvironment() : { ...process.env };
			if (config.runner === "claude") delete env.CLAUDE_CODE_EFFORT_LEVEL;
			try{return { id, ...config, isolation, ...await execReviewer(bin, args, input, sha256(prompt), config.model, config.effort, planRoot, env, signal) };}
            finally{if(providerSnapshot)fs.rmSync(providerSnapshot.dir,{recursive:true,force:true});}
		}));
		signal.throwIfAborted();
		stage = "manifest-after";
		let afterManifest = null;
		try {
			const planAfter = JSON.parse(fs.readFileSync(abs, "utf8"));
			const afterRo = lib.planReadOnlyScriptsBinding(planAfter, planRoot);
			if (afterRo.ok) afterManifest = lib.reviewInputManifest(abs, planRoot, { readOnlyScripts: afterRo.items });
		} catch { afterManifest = null; }
		const manifestChanged = beforeManifest === null || beforeManifest === undefined || afterManifest === null || beforeManifest !== afterManifest;
		for (const r of results) {
			if (beforeManifest && r.receipt) r.receipt.input_manifest_sha256 = beforeManifest;
		}
		if (manifestChanged) {
			for (const r of results) r.error = "읽기 전용 검사 실패: 리뷰 대상 또는 실행기가 바뀜";
		} else if (boundedRecovery) {
			let changed = true;
			try { changed = beforeState !== stateSnapshot(); }
			catch (error) { console.error(reviewErrorDetails(error, "snapshot-after", startedAt, planRoot)); }
			if (changed) for (const r of results) r.error = "읽기 전용 검사 실패: 승인 상태가 바뀜";
		} else {
			let changed = true;
			try { changed = before !== readOnlySnapshot(Boolean(sandboxArgs), planRoot); }
			catch (error) { console.error(reviewErrorDetails(error, "snapshot-after", startedAt, planRoot)); }
			if (changed) for (const r of results) r.error = "읽기 전용 검사 실패: git status 또는 작업 트리 내용이 바뀜";
		}
		return results;
	} catch (error) {
		failure = error;
		error.reviewStage = stage;
		throw error;
	} finally {
		// Synchronous Git snapshots can leave a stop signal pending until the event loop runs again.
		try { if (dir) await fs.promises.rm(dir, { recursive: true, force: true }); }
		catch (error) {
			if (failure) console.error(reviewErrorDetails(error, "prompt-cleanup", startedAt, planRoot));
			else { error.reviewStage = "prompt-cleanup"; throw error; }
		}
	}
}

module.exports = {
	runMuse,
	execReviewer,
	findBwrap,
	reviewerSandboxArgs,
	runReviewers,
};
