#!/usr/bin/env node
/**
 * BEH supervise WRAPPER — hermetic real-process test (plan §4, §6.3).
 *
 * Spawns a real Node parent + descendant under beh-supervise.js with a flat
 * probe so it STALLS, and asserts: (a) supervise exits 3, (b) the supervised
 * process tree is DEAD, and (c) an independent sibling started outside the
 * supervisor SURVIVES. Also asserts free-form probe-type is rejected.
 *
 * Takes ~5s (real timers). Usage: node run-beh-supervise-wrapper-test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const WRAPPER = path.join(__dirname, "..", "beh-supervise.js");
const wrapperCore = require(WRAPPER);
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
	const pgidFile = path.join(cwd, "child-pids.json");

	// independent sibling — must SURVIVE the targeted kill.
	const sibling = cp.spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { detached: true, stdio: "ignore",shell:false,windowsHide:true });
	sibling.on("error",()=>{});
	sibling.unref();
	const siblingPid = sibling.pid;

	// Supervised dummy records parent + descendant PIDs, then stalls.
	const helper=path.join(cwd,"sleeper.cjs");
	fs.writeFileSync(helper,`const cp=require('child_process');const fs=require('fs');const grandchild=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',shell:false,windowsHide:true});fs.writeFileSync(process.argv[2],JSON.stringify({parent:process.pid,grandchild:grandchild.pid}));setInterval(()=>{},1000);`);
	const command=[process.execPath,helper,pgidFile];
	const sup = cp.spawn(
		"node",
		[WRAPPER, "--force-degraded", "--approve-degraded", "--probe-type", "file_lines", "--probe-arg", path.join(cwd, "out.log"),
			"--max-wall", "120", "--max-stall", "2", "--grace", "0", "--poll", "1", "--cwd", cwd, "--", ...command],
		{ encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
	);
	let exitCode = null;
	sup.on("exit", (code) => (exitCode = code));

	// wait for the child to record its PID.
	let childPid = null;
	let grandchildPid = null;
	for (let i = 0; i < 40 && (childPid == null || grandchildPid == null); i++) {
		await sleep(250);
		try {
			const pids=JSON.parse(fs.readFileSync(pgidFile, "utf8"));
			childPid = Number(pids.parent) || null;
			grandchildPid = Number(pids.grandchild) || null;
		} catch {
			/* not yet */
		}
	}
	assert(childPid != null && alive(childPid), "B. supervised child spawned + alive", `pid=${childPid}`);
	assert(grandchildPid != null && alive(grandchildPid), "C. supervised grandchild spawned + alive", `pid=${grandchildPid}`);

	// wait for supervise to kill it (STALL ~2-3s + confirm).
	for (let i = 0; i < 60 && exitCode == null; i++) await sleep(250);
	assert(exitCode === 3, "D. supervise exits 3 (STALL kill)", `exit=${exitCode}`);
	assert(childPid != null && !alive(childPid), "E. supervised child is DEAD after kill", `pid=${childPid} alive=${childPid && alive(childPid)}`);
	assert(grandchildPid != null && !alive(grandchildPid), "F. supervised grandchild is DEAD after tree kill", `pid=${grandchildPid} alive=${grandchildPid && alive(grandchildPid)}`);
	assert(alive(siblingPid), "G. independent sibling SURVIVES (targeted tree kill, not name-based kill)", `siblingPid=${siblingPid}`);

	// Root-exits-first race: the Job Object must retain and terminate the orphaned
	// descendant even though the process that created it has already disappeared.
	const earlyExitFile = path.join(cwd, "early-exit-pids.json");
	const earlyExitHelper = path.join(cwd, "early-exit.cjs");
	fs.writeFileSync(earlyExitHelper, `const cp=require('child_process');const fs=require('fs');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:${process.platform === "win32"},stdio:'ignore',shell:false,windowsHide:true});fs.writeFileSync(process.argv[2],JSON.stringify({root:process.pid,descendant:child.pid}));child.unref();`);
	const early = cp.spawn(
		"node",
		[WRAPPER, "--force-degraded", "--approve-degraded", "--probe-type", "file_lines", "--probe-arg", path.join(cwd, "out.log"),
			"--max-wall", "30", "--max-stall", "20", "--grace", "0", "--poll", "10", "--cwd", cwd, "--", process.execPath, earlyExitHelper, earlyExitFile],
		{ encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
	);
	let earlyExitCode = null;
	early.on("exit", (code) => (earlyExitCode = code));
	let earlyPids = null;
	for (let i = 0; i < 40 && !earlyPids; i++) {
		await sleep(100);
		try { earlyPids = JSON.parse(fs.readFileSync(earlyExitFile, "utf8")); } catch {}
	}
	assert(earlyPids?.descendant && alive(earlyPids.descendant), "H. root-exits-first descendant was created", JSON.stringify(earlyPids));
	for (let i = 0; i < 160 && earlyExitCode == null; i++) await sleep(100);
	assert(earlyExitCode === 0, "I. root-exits-first target preserves its successful exit", `exit=${earlyExitCode}`);
	assert(earlyPids?.descendant && !alive(earlyPids.descendant), `J. ${process.platform === "win32" ? "Job Object" : "process group"} kills descendant after root exits`, `pid=${earlyPids?.descendant} alive=${earlyPids?.descendant && alive(earlyPids.descendant)}`);
	assert(alive(siblingPid), "K. root-exits-first cleanup still preserves sibling", `siblingPid=${siblingPid}`);

	// Argument boundaries must remain exact on every platform. A semicolon in an
	// intended argv element must never be rebuilt into a shell command.
	const argvFile = path.join(cwd, "argv.json");
	const injectionMarker = path.join(cwd, "shell-injection.txt");
	const argvHelper = path.join(cwd, "argv-helper.cjs");
	fs.writeFileSync(argvHelper, "require('fs').writeFileSync(process.argv[2],JSON.stringify(process.argv.slice(3)))");
	const injectionScript = `require('fs').writeFileSync(${JSON.stringify(injectionMarker)},'bad')`;
	const literalArgument = `literal;node -e ${JSON.stringify(injectionScript)}`;
	const argvRun = cp.spawnSync(process.execPath, [WRAPPER, "--force-degraded", "--approve-degraded", "--probe-type", "file_lines", "--probe-arg", path.join(cwd, "out.log"),
		"--max-wall", "30", "--max-stall", "20", "--grace", "0", "--poll", "1", "--cwd", cwd, "--", process.execPath, argvHelper, argvFile, literalArgument],
		{ encoding: "utf8", shell: false, timeout: 30000 });
	const exactArgs = JSON.parse(fs.readFileSync(argvFile, "utf8"));
	assert(argvRun.status === 0 && exactArgs.length === 1 && exactArgs[0] === literalArgument, "L. supervisor preserves exact argv boundaries", JSON.stringify(exactArgs));
	assert(!fs.existsSync(injectionMarker), "M. shell metacharacters inside argv are never executed");

	if (process.platform === "win32") {
		const nativePython = wrapperCore.resolveNativeWindowsPython();
		assert(path.isAbsolute(nativePython) && path.extname(nativePython).toLowerCase() === ".exe", "N. native Windows CPython is resolved to a pinned PE path", nativePython);
		const poisonPath = path.join(cwd, "poison-path");
		fs.mkdirSync(poisonPath);
		fs.writeFileSync(path.join(poisonPath, "python.cmd"), "@echo off\r\nwsl.exe python %*\r\n");
		let poisonRejected = false;
		try { wrapperCore.resolveNativeWindowsPython({ ...process.env, PATH: poisonPath, Path: poisonPath, PATHEXT: ".CMD;.EXE" }); } catch { poisonRejected = true; }
		assert(poisonRejected, "O. PATH wrapper cannot redirect the helper through WSL");
		const statusFile = path.join(cwd, "assign-failure.status.json");
		const controlFile = path.join(cwd, "assign-failure.control.json");
		const jobHelper = path.join(__dirname, "..", "beh-windows-job.py");
		const failed = cp.spawnSync(nativePython, [jobHelper, "--cwd", cwd, "--status", statusFile, "--control", controlFile, "--owner-pid", String(process.pid), "--", process.execPath, "-e", "setInterval(()=>{},1000)"], {
			encoding: "utf8", shell: false, windowsHide: true, env: { ...process.env, NAIA_BEH_TEST_ASSIGN_FAILURE: "1" },
		});
		const failureState = JSON.parse(fs.readFileSync(statusFile, "utf8"));
		assert(failed.status === 2 && failureState.state === "error", "P. Job assignment failure is fail-closed", JSON.stringify(failureState));
		assert(failureState.root_pid && !alive(failureState.root_pid), "Q. unassigned suspended target is terminated", `pid=${failureState.root_pid}`);
	}

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
