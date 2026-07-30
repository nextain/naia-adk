#!/usr/bin/env node
/**
 * BEH supervise wrapper (§3.3, §6.3) — runs a long background tool process
 * under a wall + stall deadline with a monotonic probe, and KILLS it safely on
 * timeout/stall/free-form-probe.
 *
 * Decision logic = pure core .agents/hooks/core/beh-supervise-core.js. This
 * file does only spawn / probe-read / kill / confirm.
 *
 * Isolation + kill (plan §3.3):
 *   preferred — systemd-run --user transient service → own cgroup v2 scope;
 *               kill = `systemctl --user stop`, then CONFIRM cgroup.events
 *               populated=0 (else hard-failure). No migration / no sub-cgroup.
 *   degraded  — no usable systemd --user: detached child in its own process
 *               group (setsid); kill = TERM then KILL the PGID, confirm no
 *               members. Status = UNSUPERVISED-DEGRADED + shorter forced wall
 *               unless --approve-degraded. (Targeted PGID kill — never pkill -f.)
 *
 * Usage:
 *   node beh-supervise.js --probe-type file_lines --probe-arg out.log \
 *        --max-wall 3600 --max-stall 600 [--poll 15] [--grace 300] \
 *        [--lease build] [--class build] [--approve-degraded] \
 *        [--force-degraded] [--cwd <dir>] -- <command...>
 *
 * Exit: 0 DONE | 1 FAIL | 3 killed (TIMEOUT/STALL) | 2 usage/lease-denied.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");
const core = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "beh-supervise-core.js"));

// ── arg parse ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
	const o = { poll: 15, cwd: process.cwd(), approveDegraded: false, forceDegraded: false };
	const dash = argv.indexOf("--");
	const cmd = dash >= 0 ? argv.slice(dash + 1) : [];
	const flags = dash >= 0 ? argv.slice(0, dash) : argv;
	for (let i = 0; i < flags.length; i++) {
		const a = flags[i];
		const next = () => flags[++i];
		if (a === "--probe-type") o.probeType = next();
		else if (a === "--probe-arg") o.probeArg = next();
		else if (a === "--probe-pattern") o.probePattern = next();
		else if (a === "--max-wall") o.maxWall = parseInt(next(), 10);
		else if (a === "--max-stall") o.maxStall = parseInt(next(), 10);
		else if (a === "--poll") o.poll = Math.max(1, parseInt(next(), 10) || 15);
		else if (a === "--grace") o.grace = parseInt(next(), 10);
		else if (a === "--lease") o.lease = next();
		else if (a === "--class") o.cls = next();
		else if (a === "--cwd") o.cwd = next();
		else if (a === "--approve-degraded") o.approveDegraded = true;
		else if (a === "--force-degraded") o.forceDegraded = true;
		else if (a === "--degraded-max-wall") o.degradedMaxWall = parseInt(next(), 10);
	}
	o.cmd = cmd;
	return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Date.now();
function log(msg) {
	process.stderr.write(`[beh-supervise] ${msg}\n`);
}

// ── allowlisted probe readers → monotonic number (or null) ──────────────────
function readProbe(o) {
	try {
		switch (o.probeType) {
			case "file_lines": {
				const buf = fs.readFileSync(o.probeArg, "utf8");
				return buf.length ? buf.split("\n").length : 0;
			}
			case "file_bytes":
				return fs.statSync(o.probeArg).size;
			case "file_mtime":
				return Math.floor(fs.statSync(o.probeArg).mtimeMs / 1000);
			case "path_count": {
				// probeArg = directory, probePattern = filename regex (bounded)
				const re = o.probePattern ? new RegExp(o.probePattern) : /.*/;
				return fs.readdirSync(o.probeArg).filter((f) => re.test(f)).length;
			}
			case "log_match_count": {
				const buf = fs.readFileSync(o.probeArg, "utf8");
				const re = new RegExp(o.probePattern || ".");
				return buf.split("\n").filter((l) => re.test(l)).length;
			}
			default:
				return null;
		}
	} catch {
		return null; //  unreadable yet — treated as no-progress, not a crash
	}
}

// ── systemd --user availability ─────────────────────────────────────────────
function systemdUserUsable() {
	try {
		cp.execFileSync("systemctl", ["--user", "show", "-p", "Version"], { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 });
		cp.execFileSync("systemd-run", ["--version"], { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

// ── spawn ────────────────────────────────────────────────────────────────────
function spawnSystemd(o, unit) {
	// transient service: returns immediately, child runs in beh-<unit>.service
	// cgroup. --collect garbage-collects the unit when it dies.
	cp.execFileSync(
		"systemd-run",
		["--user", "--collect", `--unit=${unit}`, "--quiet", "--working-directory", o.cwd, ...o.cmd],
		{ stdio: ["ignore", "ignore", "pipe"], timeout: 15000 },
	);
}

function controlGroupPath(unit) {
	try {
		const out = cp.execFileSync("systemctl", ["--user", "show", unit, "-p", "ControlGroup", "--value"], { encoding: "utf8", timeout: 5000 }).trim();
		return out ? path.join("/sys/fs/cgroup", out) : null;
	} catch {
		return null;
	}
}

function cgroupPopulated(cgPath) {
	try {
		const ev = fs.readFileSync(path.join(cgPath, "cgroup.events"), "utf8");
		const m = ev.match(/populated\s+(\d)/);
		return m ? m[1] === "1" : false;
	} catch {
		return false; //  cgroup gone = not populated
	}
}

function systemdState(unit) {
	try {
		const out = cp.execFileSync("systemctl", ["--user", "show", unit, "-p", "SubState", "-p", "ExecMainStatus", "--value"], { encoding: "utf8", timeout: 5000 });
		const [subState, mainStatus] = out.trim().split("\n");
		return { subState, exit: subState === "exited" || subState === "dead" || subState === "failed" ? parseInt(mainStatus, 10) || 0 : null };
	} catch {
		return { subState: "unknown", exit: null };
	}
}

// ── kill + confirm ───────────────────────────────────────────────────────────
async function killSystemd(unit) {
	const cg = controlGroupPath(unit);
	try {
		cp.execFileSync("systemctl", ["--user", "stop", unit], { stdio: ["ignore", "ignore", "ignore"], timeout: 15000 });
	} catch {
		/* may already be gone */
	}
	for (let i = 0; i < 10; i++) {
		if (!cg || !cgroupPopulated(cg)) return true;
		await sleep(500);
	}
	return false; //  still populated → hard-failure
}

function pgidAlive(pgid) {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false; //  ESRCH = no members
	}
}

async function killPgid(pgid) {
	try {
		process.kill(-pgid, "SIGTERM");
	} catch {
		/* gone */
	}
	for (let i = 0; i < 6; i++) {
		if (!pgidAlive(pgid)) return true;
		await sleep(500);
	}
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {
		/* gone */
	}
	for (let i = 0; i < 6; i++) {
		if (!pgidAlive(pgid)) return true;
		await sleep(500);
	}
	return false;
}

function readJson(file) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function publishJson(file, value) {
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
	fs.renameSync(temporary, file);
}

function resolveNativeWindowsPython(environment = process.env, execFileSync = cp.execFileSync) {
	const searchPath = environment.PATH || environment.Path || "";
	const extensions = (environment.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
	let candidate = null;
	for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
		for (const extension of extensions) {
			const attempted = path.join(directory.replace(/^"|"$/g, ""), `python${extension.toLowerCase()}`);
			if (!fs.existsSync(attempted)) continue;
			candidate = fs.realpathSync(attempted);
			break;
		}
		if (candidate) break;
	}
	if (!candidate || path.extname(candidate).toLowerCase() !== ".exe") throw new Error("native Windows CPython executable not found first on PATH");
	const header = fs.readFileSync(candidate).subarray(0, 2).toString("ascii");
	if (header !== "MZ" || /(?:^|[\\/])(?:wsl|cygwin|msys)(?:[\\/]|$)/i.test(candidate)) throw new Error("Python helper must be a native Windows PE executable");
	const probe = execFileSync(candidate, ["-c", "import json,sys;print(json.dumps({'platform':sys.platform,'executable':sys.executable}))"], {
		encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000, windowsHide: true, env: environment,
	}).trim();
	const identity = JSON.parse(probe.split(/\r?\n/).pop());
	if (identity.platform !== "win32" || fs.realpathSync(identity.executable) !== candidate) throw new Error("Python helper identity is not pinned native Windows CPython");
	return candidate;
}

async function spawnWindowsJob(o) {
	const directory = path.join(o.cwd, ".agents", "harness", "windows-jobs");
	fs.mkdirSync(directory, { recursive: true });
	const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const status = path.join(directory, `${id}.status.json`);
	const control = path.join(directory, `${id}.control.json`);
	const helper = path.join(__dirname, "beh-windows-job.py");
	const pythonExecutable = resolveNativeWindowsPython();
	const child = cp.spawn(pythonExecutable, [helper, "--cwd", o.cwd, "--status", status, "--control", control, "--owner-pid", String(process.pid), "--", ...o.cmd], {
		cwd: o.cwd, stdio: "ignore", shell: false, windowsHide: true,
	});
	child.on("error", () => {});
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const state = readJson(status);
		if (state?.state === "ready") return { child, status, control, rootPid: state.root_pid };
		if (state?.state === "error" || child.exitCode != null) throw new Error(`Windows Job Object helper failed: ${state?.error || `exit ${child.exitCode}`}`);
		await sleep(50);
	}
	try { publishJson(control, { action: "terminate" }); } catch {}
	throw new Error("Windows Job Object helper readiness timeout");
}

async function terminateWindowsJob(job) {
	try { publishJson(job.control, { action: "terminate" }); } catch (error) { log(`cannot signal Windows Job Object: ${error.code || error.message}`); return false; }
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		const state = readJson(job.status);
		if (state?.state === "terminated") return state.active_processes === 0;
		if (state?.state === "error") return false;
		await sleep(50);
	}
	return false;
}

function pidAlive(pid) {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

function withLeaseLock(leasePath, fn) {
	const lockPath = `${leasePath}.lock`;
	const nonce = crypto.randomBytes(16).toString("hex");
	let quarantine = null;
	const acquire = () => {
		try { fs.mkdirSync(lockPath); }
		catch (error) {
			if (error.code !== "EEXIST") throw error;
			let owner = null;
			try { owner = readJson(path.join(lockPath, "owner.json")); } catch {}
			if (!owner?.pid) {
				let age = 0;
				try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch {}
				if (age < 30000) throw Object.assign(new Error("ownerless lease publication lock is still within its publication grace"), { code: "lease_lock_busy" });
			} else if (pidAlive(owner.pid)) throw Object.assign(new Error("lease publication lock busy"), { code: "lease_lock_busy" });
			quarantine = `${lockPath}.stale.${process.pid}.${nonce}`;
			try { fs.renameSync(lockPath, quarantine); }
			catch { throw Object.assign(new Error("lease publication lock changed during stale recovery"), { code: "lease_lock_busy" }); }
			try { fs.mkdirSync(lockPath); }
			catch (mkdirError) {
				fs.rmSync(quarantine, { recursive: true, force: true });
				throw Object.assign(new Error(`lease publication lock reacquire failed: ${mkdirError.code || mkdirError.message}`), { code: "lease_lock_busy" });
			}
		}
		fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, nonce, ts: Date.now() })}\n`, { encoding: "utf8", flag: "wx" });
	};
	acquire();
	try { return fn(); }
	finally {
		const owner = readJson(path.join(lockPath, "owner.json"));
		if (owner?.nonce === nonce) fs.rmSync(lockPath, { recursive: true, force: true });
		if (quarantine) fs.rmSync(quarantine, { recursive: true, force: true });
	}
}

function cleanupOwnedLease(leasePath, expectedOwner) {
	return withLeaseLock(leasePath, () => {
		let current = null;
		try { current = JSON.parse(fs.readFileSync(leasePath, "utf8")); } catch { return false; }
		if (current.owner !== expectedOwner) return false;
		fs.unlinkSync(leasePath);
		return true;
	});
}

// ── main supervise loop ──────────────────────────────────────────────────────
async function main() {
	const o = parseArgs(process.argv.slice(2));
	if (!o.cmd.length) {
		log("usage: ... --probe-type <t> --max-wall <s> --max-stall <s> -- <command...>");
		process.exit(2);
	}
	if (!core.validateProbeType(o.probeType)) {
		log(`probe-type 미허용(free-form 금지): ${o.probeType}. 허용=${[...core.ALLOWED_PROBES].join(",")}`);
		process.exit(2);
	}

	// lease (single-instance / single-writer)
	let leasePath = null;
	let leaseOwner = null;
	if (o.lease) {
		const dir = path.join(o.cwd, ".agents", "harness", "leases");
		fs.mkdirSync(dir, { recursive: true });
		leasePath = path.join(dir, `${o.lease.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
		const owner = `pid-${process.pid}`;
		leaseOwner = owner;
		const res = withLeaseLock(leasePath, () => {
			let current = null;
			try { current = JSON.parse(fs.readFileSync(leasePath, "utf8")); } catch {}
			const decision = core.acquireLease(current, { owner, now: nowMs(), ttlMs: (o.maxWall || 3600) * 1000 + 60_000 });
			if (decision.granted) fs.writeFileSync(leasePath, JSON.stringify(decision.lease));
			return decision;
		});
		if (!res.granted) {
			log(`lease "${o.lease}" 거부 — ${res.reason}`);
			process.exit(2);
		}
	}

	const config = {
		maxWallMs: (o.maxWall || 3600) * 1000,
		maxStallMs: (o.maxStall || 600) * 1000,
		graceMs: o.grace != null ? o.grace * 1000 : undefined,
		probeType: o.probeType,
		approvedDegraded: o.approveDegraded,
		degradedMaxWallMs: o.degradedMaxWall != null ? o.degradedMaxWall * 1000 : undefined,
	};

	const nativeWindows = process.platform === "win32";
	const useSystemd = !nativeWindows && !o.forceDegraded && systemdUserUsable();
	const startTs = nowMs();
	const probeSeries = [];
	let unit = null;
	let child = null;
	let pgid = null;
	let windowsJob = null;

	if (useSystemd) {
		unit = `beh-${process.pid}-${(startTs % 100000)}`;
		try {
			spawnSystemd(o, unit);
			log(`systemd transient service 시작: ${unit}.service (cgroup 격리)`);
		} catch (e) {
			log(`systemd-run 실패 → degraded 폴백: ${e.message}`);
			unit = null;
		}
	}
	if (!unit) {
		if (nativeWindows) {
			windowsJob = await spawnWindowsJob(o);
			child = windowsJob.child;
			pgid = windowsJob.rootPid;
			config.degraded = false;
			log(`Windows Job Object 시작 PID=${pgid}`);
		} else {
			config.degraded = true;
			child = cp.spawn(o.cmd[0], o.cmd.slice(1), { cwd: o.cwd, detached: true, stdio: "ignore", shell: false });
			pgid = child.pid;
			child.on("exit", () => {});
			child.on("error", (error) => log(`child spawn error: ${error.code || error.message}`));
			log(`degraded(detached PGID=${pgid}) 시작${o.approveDegraded ? " (감시 확장 opt-in)" : " — 짧은 wall 강제"}`);
		}
	}

	const cleanupLease = () => {
		if (leasePath && leaseOwner) {
			try { cleanupOwnedLease(leasePath, leaseOwner); }
			catch (error) { log(`lease cleanup deferred safely: ${error.code || error.message}`); }
		}
	};

	// monitor
	while (true) {
		await sleep(o.poll * 1000);
		const now = nowMs();
		const value = readProbe(o);
		probeSeries.push({ ts: now, value });

		// terminal detection
		let exit = null;
		if (unit) {
			const st = systemdState(unit);
			exit = st.exit;
		} else if (windowsJob) {
			const state = readJson(windowsJob.status);
			if (state?.state === "error") exit = 1;
			else if (state?.state === "exited") exit = state.exit_code;
		} else if (child) {
			if (child.exitCode != null) exit = child.exitCode;
			else if (child.signalCode != null) exit = 1;
		}

		const decision = core.evaluateSupervisor({ now, startTs, exit, probeSeries, config });

		if (decision.action === "kill") {
			log(`KILL — status=${decision.status} reason=${decision.reason}`);
			let confirmed;
			if (unit) confirmed = await killSystemd(unit);
			else if (nativeWindows) confirmed = await terminateWindowsJob(windowsJob);
			else confirmed = await killPgid(pgid);
			cleanupLease();
			if (!confirmed) {
				log("⛔ HARD-FAILURE: 대상이 종료 확인 안 됨(cgroup populated=1 / PGID 잔존). 수동 점검 필요.");
				process.exit(1);
			}
			log(`종료 확인 완료 (${unit ? "cgroup populated=0" : nativeWindows ? "Windows process tree 소멸" : "PGID 소멸"}).`);
			process.exit(3);
		}
		if (decision.status === "DONE") {
			if (windowsJob && !await terminateWindowsJob(windowsJob)) { cleanupLease(); process.exit(1); }
			if (!unit && !nativeWindows && !await killPgid(pgid)) { cleanupLease(); process.exit(1); }
			log("DONE (exit 0)");
			cleanupLease();
			process.exit(0);
		}
		if (decision.status === "FAIL") {
			if (windowsJob && !await terminateWindowsJob(windowsJob)) { cleanupLease(); process.exit(1); }
			if (!unit && !nativeWindows && !await killPgid(pgid)) { cleanupLease(); process.exit(1); }
			log(`FAIL (${decision.reason})`);
			cleanupLease();
			process.exit(1);
		}
		// RUNNING / DEGRADED(no-kill) → keep watching
	}
}

if (require.main === module) {
	main().catch((e) => {
		log("supervise error: " + (e && e.message));
		process.exit(1);
	});
} else {
	module.exports = { readJson, publishJson, resolveNativeWindowsPython, withLeaseLock, cleanupOwnedLease };
}
