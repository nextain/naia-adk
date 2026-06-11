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
		["--user", "--collect", `--unit=${unit}`, "--quiet", "--working-directory", o.cwd, "/bin/sh", "-c", o.cmd.join(" ")],
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
	if (o.lease) {
		const dir = path.join(o.cwd, ".agents", "harness", "leases");
		fs.mkdirSync(dir, { recursive: true });
		leasePath = path.join(dir, `${o.lease.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
		let current = null;
		try {
			current = JSON.parse(fs.readFileSync(leasePath, "utf8"));
		} catch {
			/* none */
		}
		const owner = `pid-${process.pid}`;
		const res = core.acquireLease(current, { owner, now: nowMs(), ttlMs: (o.maxWall || 3600) * 1000 + 60_000 });
		if (!res.granted) {
			log(`lease "${o.lease}" 거부 — ${res.reason}`);
			process.exit(2);
		}
		fs.writeFileSync(leasePath, JSON.stringify(res.lease));
	}

	const config = {
		maxWallMs: (o.maxWall || 3600) * 1000,
		maxStallMs: (o.maxStall || 600) * 1000,
		graceMs: o.grace != null ? o.grace * 1000 : undefined,
		probeType: o.probeType,
		approvedDegraded: o.approveDegraded,
		degradedMaxWallMs: o.degradedMaxWall != null ? o.degradedMaxWall * 1000 : undefined,
	};

	const useSystemd = !o.forceDegraded && systemdUserUsable();
	const startTs = nowMs();
	const probeSeries = [];
	let unit = null;
	let child = null;
	let pgid = null;

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
		config.degraded = true;
		child = cp.spawn("/bin/sh", ["-c", o.cmd.join(" ")], { cwd: o.cwd, detached: true, stdio: "ignore" });
		pgid = child.pid; //  detached → child is its own process-group leader
		child.on("exit", () => {});
		log(`degraded(detached PGID=${pgid}) 시작${o.approveDegraded ? " (승인됨)" : " — 짧은 wall 강제"}`);
	}

	const cleanupLease = () => {
		if (leasePath) {
			try {
				fs.unlinkSync(leasePath);
			} catch {
				/* best-effort */
			}
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
		} else if (child) {
			if (child.exitCode != null) exit = child.exitCode;
			else if (child.signalCode != null) exit = 1;
		}

		const decision = core.evaluateSupervisor({ now, startTs, exit, probeSeries, config });

		if (decision.action === "kill") {
			log(`KILL — status=${decision.status} reason=${decision.reason}`);
			let confirmed;
			if (unit) confirmed = await killSystemd(unit);
			else confirmed = await killPgid(pgid);
			cleanupLease();
			if (!confirmed) {
				log("⛔ HARD-FAILURE: 대상이 종료 확인 안 됨(cgroup populated=1 / PGID 잔존). 수동 점검 필요.");
				process.exit(1);
			}
			log(`종료 확인 완료 (${unit ? "cgroup populated=0" : "PGID 소멸"}).`);
			process.exit(3);
		}
		if (decision.status === "DONE") {
			log("DONE (exit 0)");
			cleanupLease();
			process.exit(0);
		}
		if (decision.status === "FAIL") {
			log(`FAIL (${decision.reason})`);
			cleanupLease();
			process.exit(1);
		}
		// RUNNING / DEGRADED(no-kill) → keep watching
	}
}

main().catch((e) => {
	log("supervise error: " + (e && e.message));
	process.exit(1);
});
