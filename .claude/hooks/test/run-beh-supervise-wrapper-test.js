#!/usr/bin/env node
/**
 * BEH supervise WRAPPER — hermetic real-process test (plan §4, §6.3).
 *
 * Spawns a real dummy `sleep` under beh-supervise.js (degraded PGID path,
 * deterministic) with a flat probe so it STALLS, and asserts: (a) supervise
 * exits 3 (killed), (b) the supervised process is actually DEAD, (c) an
 * INDEPENDENT sibling sleep started outside supervise SURVIVES (targeted PGID
 * kill, never pkill -f). Also asserts free-form probe-type is rejected.
 *
 * Takes ~5s (real timers). Usage: node run-beh-supervise-wrapper-test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const WRAPPER = path.join(__dirname, "..", "beh-supervise.js");
let PASS = 0,
	FAIL = 0;
const FAILED = [];
function assert(c, n, d) {
	c ? PASS++ : (FAIL++, FAILED.push(n), console.log(`  ✗ FAIL: ${n}${d ? "\n     " + d : ""}`));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function main() {
	// free-form probe-type rejected (usage exit 2) — fast check.
	{
		const r = cp.spawnSync("node", [WRAPPER, "--probe-type", "run_anything.sh", "--max-wall", "10", "--max-stall", "2", "--", "true"], { encoding: "utf8" });
		assert(r.status === 2 && /free-form/.test(r.stderr || ""), "A. free-form probe-type → rejected (exit 2)", `status=${r.status}`);
	}

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "beh-sup-"));
	fs.writeFileSync(path.join(cwd, "out.log"), ""); //  static probe file (never grows → STALL)
	const pgidFile = path.join(cwd, "child.pid");

	// independent sibling — must SURVIVE the targeted kill.
	const sibling = cp.spawn("sleep", ["8"], { detached: true, stdio: "ignore" });
	sibling.unref();
	const siblingPid = sibling.pid;

	// supervised dummy: records its own PID, then sleeps. Flat probe → STALL.
	const cmd = `echo "$$" > '${pgidFile}'; exec sleep 60`;
	const sup = cp.spawn(
		"node",
		[WRAPPER, "--force-degraded", "--approve-degraded", "--probe-type", "file_lines", "--probe-arg", path.join(cwd, "out.log"),
			"--max-wall", "120", "--max-stall", "2", "--grace", "0", "--poll", "1", "--cwd", cwd, "--", cmd],
		{ encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
	);
	let exitCode = null;
	sup.on("exit", (code) => (exitCode = code));

	// wait for the child to record its PID.
	let childPid = null;
	for (let i = 0; i < 40 && childPid == null; i++) {
		await sleep(250);
		try {
			childPid = parseInt(fs.readFileSync(pgidFile, "utf8").trim(), 10) || null;
		} catch {
			/* not yet */
		}
	}
	assert(childPid != null && alive(childPid), "B. supervised child spawned + alive", `pid=${childPid}`);

	// wait for supervise to kill it (STALL ~2-3s + confirm).
	for (let i = 0; i < 60 && exitCode == null; i++) await sleep(250);
	assert(exitCode === 3, "C. supervise exits 3 (STALL kill)", `exit=${exitCode}`);
	assert(childPid != null && !alive(childPid), "D. supervised child is DEAD after kill", `pid=${childPid} alive=${childPid && alive(childPid)}`);
	assert(alive(siblingPid), "E. independent sibling SURVIVES (targeted PGID kill, not pkill -f)", `siblingPid=${siblingPid}`);

	// cleanup
	try {
		process.kill(siblingPid, "SIGKILL");
	} catch {}
	fs.rmSync(cwd, { recursive: true, force: true });

	console.log(`\nBEH supervise wrapper (real-process): ${PASS} passed, ${FAIL} failed`);
	if (FAIL > 0) {
		console.log("FAILED: " + FAILED.join(", "));
		process.exit(1);
	}
}
main().catch((e) => {
	console.log("test error: " + e.message);
	process.exit(1);
});
