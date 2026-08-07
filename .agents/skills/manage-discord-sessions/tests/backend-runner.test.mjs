import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isBenignBackendStdinError, runBackendAttempt } from "../helper/backend-runner.mjs";
import { SessionStore } from "../helper/store.mjs";

const roots = [];
const fakeBackendPath = fileURLToPath(new URL("./fixtures/fake-backend.mjs", import.meta.url));

test("DSO-006 treats normal one-shot stdin pipe closure as non-fatal", () => {
	assert.equal(isBenignBackendStdinError({ code: "EPIPE" }), true);
	assert.equal(isBenignBackendStdinError({ code: "ERR_STREAM_DESTROYED" }), true);
	assert.equal(isBenignBackendStdinError({ code: "EACCES" }), false);
});

test("FET_DSO_014_002 preserves the pre-attempt backend version probe failure stage", async () => {
	const { root, store, jobId } = fixture("codex");
	await assert.rejects(runBackendAttempt({
		store, jobId, backendId: "codex", prompt: "probe", cwd: root,
		runtimeRoot: join(root, "runtime"), executable: join(root, "missing-codex"),
		requireAuthentication: false, parentEnv: { PATH: process.env.PATH },
	}), (error) => error.code === "backend_version_probe_failed");
	assert.equal(store.getJob(jobId, { includeEvents: false }).attemptId, null);
	store.close();
});

test("DSO-014 preserves the pre-attempt backend authentication failure stage", async () => {
	const { root, store, jobId } = fixture("codex");
	const emptyAuthRoot = join(root, "empty-auth");
	mkdirSync(emptyAuthRoot, { mode: 0o700 });
	await assert.rejects(runBackendAttempt({
		store, jobId, backendId: "codex", prompt: "authenticate", cwd: root,
		runtimeRoot: join(root, "runtime"), executable: fakeBackendPath,
		backendVersion: "0.146.0", authRoot: emptyAuthRoot, parentEnv: { PATH: process.env.PATH },
	}), (error) => error.code === "backend_authentication_failed");
	assert.equal(store.getJob(jobId, { includeEvents: false }).attemptId, null);
	store.close();
});

async function waitForStoppedProcess(pid) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			if (stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[0] === "Z") return "Z";
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return "live";
}

afterEach(() => {
	while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function fixture(backendId) {
	const root = mkdtempSync(join(tmpdir(), "naia-backend-runner-"));
	roots.push(root);
	const databasePath = join(root, "naia-settings/.sessions/messenger-sessions/runtime.sqlite3");
	const stateRoot = join(root, "naia-settings/.sessions/messenger-sessions");
	const store = new SessionStore(databasePath);
	store.createJob({ jobId: `${backendId}-job`, backendId, revision: "rev-1", activityDetail: "structured", jobType: "issue_work" });
	return { root, stateRoot, store, jobId: `${backendId}-job` };
}

test("DSO-011 re-verifies deterministic context immediately before reserving or spawning an attempt", async () => {
	const { root, store, jobId } = fixture("codex");
	let checks = 0;
	await assert.rejects(runBackendAttempt({
		store,
		jobId,
		backendId: "codex",
		prompt: "must not execute",
		cwd: root,
		runtimeRoot: join(root, "runtime"),
		executable: fakeBackendPath,
		backendVersion: "0.146.0",
		requireAuthentication: false,
		parentEnv: { PATH: process.env.PATH },
		preSpawnCheck: () => { checks += 1; throw Object.assign(new Error("changed"), { code: "context_changed_restart_required" }); },
	}), (error) => error.code === "context_changed_restart_required");
	assert.equal(checks, 1);
	assert.equal(store.getJob(jobId, { includeEvents: false }).attemptId, null);
	assert.equal(readdirSync(join(root, "runtime", "children")).length, 0);
	store.close();
});

test("DSO-011 quarantines a context race after reservation without spawning the provider", async () => {
	const { root, store, jobId } = fixture("codex");
	let checks = 0;
	await assert.rejects(runBackendAttempt({
		store,
		jobId,
		backendId: "codex",
		prompt: "must not execute after race",
		cwd: root,
		runtimeRoot: join(root, "runtime"),
		executable: fakeBackendPath,
		backendVersion: "0.146.0",
		requireAuthentication: false,
		parentEnv: { PATH: process.env.PATH },
		preSpawnCheck: () => {
			checks += 1;
			if (checks === 2) throw Object.assign(new Error("changed"), { code: "context_changed_restart_required" });
		},
	}), (error) => error.code === "context_changed_restart_required");
	assert.equal(checks, 2);
	const job = store.getJob(jobId, { includeEvents: false });
	assert.equal(job.attemptId, null);
	assert.equal(job.lifecycle, "failed");
	assert.equal(job.latestSafeError, "Job failed: context_changed_restart_required");
	store.close();
});

for (const backendId of ["codex", "claude"]) {
	test(`DSO-006 runs ${backendId} independently and persists only safe activity`, async () => {
		const { root, stateRoot, store, jobId } = fixture(backendId);
		const prompt = `private-${backendId}-prompt-987654`;
		const runtimeRoot = join(root, "runtime");
		const result = await runBackendAttempt({ store, jobId, backendId, prompt, cwd: root, runtimeRoot, executable: fakeBackendPath, backendVersion: backendId === "codex" ? "0.146.0" : "2.1.220", requireAuthentication: false, parentEnv: { PATH: process.env.PATH, LANG: "C.UTF-8", DISCORD_TOKEN: "must-not-leak" } });
		assert.equal(result.exitCode, 0);
		const job = store.getJob(jobId);
		assert.equal(job.lifecycle, "result_ready");
		assert.ok(job.events.some((event) => event.kind === "backend_ready"), JSON.stringify(job.events));
		assert.ok(job.events.some((event) => event.kind === "output_activity"));
		assert.ok(job.events.some((event) => event.kind === "attempt_exited"));
		assert.ok(job.events.some((event) => event.kind === "attempt_succeeded"));
		assert.deepEqual(readdirSync(join(runtimeRoot, "children")), []);
		store.close();
		for (const file of ["runtime.sqlite3", "runtime.sqlite3-wal", "runtime.sqlite3-shm"]) {
			const path = join(stateRoot, file);
			try { assert.ok(!readFileSync(path).includes(Buffer.from(prompt))); } catch (error) { if (error.code !== "ENOENT") throw error; }
		}
	});
}

for (const backendId of ["codex", "claude"]) {
	test(`DSO-001 persists bounded public ${backendId} progress and result without projecting their text`, async () => {
		const { root, store, jobId } = fixture(backendId);
		const result = await runBackendAttempt({ store, jobId, backendId, prompt: "__fake_progress__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: backendId === "codex" ? "0.146.0" : "2.1.220", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } });
		assert.equal(result.backendOutcome, "success");
		const job = store.getJob(jobId);
		const progress = job.events.filter((event) => event.kind === "progress_reported");
		const final = job.events.filter((event) => event.kind === "result_reported");
		assert.equal(progress.length, 1);
		assert.equal(final.length, 1);
		assert.match(progress[0].safeSummary, /\[REDACTED\]/);
		assert.match(progress[0].safeSummary, /\[LOCAL_PATH\]/);
		assert.equal(progress[0].redactionLevel, "local_safe");
		assert.equal(final[0].safeSummary, "Result: fake-model-content");
		assert.equal(final[0].redactionLevel, "local_safe");
		assert.ok(progress[0].sequence < final[0].sequence);
		assert.ok(final[0].sequence < job.events.find((event) => event.kind === "attempt_succeeded").sequence);
		assert.equal(job.currentActivity.includes("checking"), false);
		store.close();
	});
}

test("DSO-006 runs a Windows npm-shim backend through a pinned node command and script prefix", async () => {
	const { root, store, jobId } = fixture("codex");
	const result = await runBackendAttempt({
		store,
		jobId,
		backendId: "codex",
		prompt: "prefix command",
		cwd: root,
		runtimeRoot: join(root, "runtime"),
		executable: { command: process.execPath, prefixArgs: [fakeBackendPath] },
		backendVersion: "0.146.0",
		requireAuthentication: false,
		parentEnv: { PATH: process.env.PATH },
	});
	assert.equal(result.exitCode, 0);
	assert.equal(store.getJob(jobId).lifecycle, "result_ready");
	store.close();
});

test("DSO-006 times out, escalates termination, and records failure", async () => {
	const { root, stateRoot, store, jobId } = fixture("codex");
	const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt: "__fake_hang__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, timeoutMs: 150, killGraceMs: 20, parentEnv: { PATH: process.env.PATH } });
	assert.equal(result.terminationReason, "timeout");
	const job = store.getJob(jobId);
	assert.equal(job.lifecycle, "failed");
	assert.ok(job.events.some((event) => event.kind === "cancel_requested"));
	assert.ok(job.events.some((event) => event.kind === "attempt_exited" && (process.platform === "win32" || event.safeSummary.includes("SIGKILL"))));
	store.close();
});

test("DSO-007 no-progress intervention terminates an active child without an approval wait", async () => {
	const { root, store, jobId } = fixture("codex");
	const controller = new AbortController();
	const pending = runBackendAttempt({ store, jobId, backendId: "codex", prompt: "__fake_hang__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, signal: controller.signal, timeoutMs: 5_000, killGraceMs: 20, parentEnv: { PATH: process.env.PATH } });
	for (let attempt = 0; attempt < 50 && !store.getJob(jobId, { includeEvents: false })?.attemptId; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(store.getJob(jobId, { includeEvents: false })?.attemptId, "child did not start in time");
	controller.abort("no_progress");
	const result = await pending;
	const job = store.getJob(jobId);
	assert.equal(result.terminationReason, "no_progress");
	assert.equal(job.lifecycle, "failed");
	assert.equal(job.latestSafeError, "Job failed: no_progress_timeout");
	assert.equal(job.events.some((event) => event.kind === "approval_required"), false);
	store.close();
});

test("DSO-006 rejects an approval UI instead of waiting for a child prompt", async () => {
	const { root, store, jobId } = fixture("codex");
	const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt: "__fake_approval_ui__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, commandOptions: { sandbox: "workspace-write", approvalPolicy: "never" }, backendVersion: "0.146.0", requireAuthentication: false, timeoutMs: 1_000, killGraceMs: 20, parentEnv: { PATH: process.env.PATH } });
	assert.equal(result.terminationReason, "approval_ui");
	const job = store.getJob(jobId);
	assert.equal(job.lifecycle, "failed");
	assert.equal(job.events.some((event) => event.kind === "approval_required"), false);
	assert.equal(job.latestSafeError, "Job failed: approval_ui_detected");
	store.close();
});

for (const prompt of ["__fake_stderr_approval_ui__"]) {
	test(`DSO-007 rejects ${prompt} without waiting for a newline or a hidden approval field`, async () => {
		const { root, store, jobId } = fixture("codex");
		const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt, cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, commandOptions: { sandbox: "workspace-write", approvalPolicy: "never" }, backendVersion: "0.146.0", requireAuthentication: false, timeoutMs: 1_000, killGraceMs: 20, parentEnv: { PATH: process.env.PATH } });
		assert.equal(result.terminationReason, "approval_ui");
		assert.equal(store.getJob(jobId).latestSafeError, "Job failed: approval_ui_detected");
		store.close();
	});
}

test("DSO-007 does not mistake approval words in a structured final result for an interactive prompt", async () => {
	const { root, store, jobId } = fixture("codex");
	const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt: "__fake_approval_text_in_result__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, commandOptions: { sandbox: "workspace-write", approvalPolicy: "never" }, backendVersion: "0.146.0", requireAuthentication: false, timeoutMs: 1_000, killGraceMs: 20, parentEnv: { PATH: process.env.PATH } });
	assert.equal(result.terminationReason, null);
	assert.equal(result.backendOutcome, "success");
	assert.match(result.transientResult, /approval request/);
	assert.equal(store.getJob(jobId).lifecycle, "result_ready");
	store.close();
});

test("DSO-006 binds each child to the requested absolute workspace despite parent cwd", async () => {
	const { root, store, jobId } = fixture("codex");
	const workspace = join(root, "explicit-workspace");
	mkdirSync(workspace, { mode: 0o700 });
	const marker = join(root, "child-cwd");
	await runBackendAttempt({ store, jobId, backendId: "codex", prompt: `__fake_cwd_marker__:${marker}`, cwd: workspace, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } });
	assert.equal(readFileSync(marker, "utf8"), resolve(workspace));
	store.close();
});

test("DSO-006 treats structured failure plus exit zero as failed", async () => {
	const { root, store, jobId } = fixture("claude");
	const result = await runBackendAttempt({ store, jobId, backendId: "claude", prompt: "__fake_structured_failure__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "2.1.220", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } });
	assert.equal(result.backendOutcome, "failure");
	const job = store.getJob(jobId);
	assert.equal(job.lifecycle, "failed");
	assert.equal(job.events.filter((event) => event.kind === "progress_reported").length, 1);
	assert.equal(job.events.some((event) => event.kind === "result_reported"), false);
	store.close();
});

test("DSO-006 records nonzero exit without accepting backend success", async () => {
	const { root, store, jobId } = fixture("codex");
	const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt: "__fake_nonzero__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } });
	assert.equal(result.exitCode, 7);
	assert.equal(store.getJob(jobId).lifecycle, "failed");
	store.close();
});

test("DSO-006 pre-abort cancels the owned process and removes runtime credentials", async () => {
	const { root, store, jobId } = fixture("codex");
	const controller = new AbortController();
	controller.abort();
	const runtimeRoot = join(root, "runtime");
	const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt: "__fake_hang__", cwd: root, runtimeRoot, executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, signal: controller.signal, parentEnv: { PATH: process.env.PATH } });
	assert.equal(result.terminationReason, "cancelled");
	assert.equal(store.getJob(jobId).lifecycle, "cancelled");
	const children = join(runtimeRoot, "children");
	assert.deepEqual(existsSync(children) ? readdirSync(children) : [], []);
	store.close();
});

test("DSO-006 service interruption preserves a job for reboot recovery", async () => {
	const { store, jobId, root } = fixture("codex");
	const controller = new AbortController();
	controller.abort("recovery");
	const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt: "recover me", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, signal: controller.signal, backendVersion: "0.146.0", requireAuthentication: false });
	assert.equal(result.terminationReason, "recovery");
	assert.equal(store.getJob(jobId).lifecycle, "queued");
	assert.equal(store.getJob(jobId).events.at(-1).kind, "recovered");
	store.close();
});

test("DSO-006 service interruption during version probing preserves recovery semantics", async () => {
	const { store, jobId, root } = fixture("codex");
	const controller = new AbortController();
	const running = runBackendAttempt({
		store, jobId, backendId: "codex", prompt: "recover during probe",
		cwd: root, runtimeRoot: join(root, "runtime"),
		executable: { command: process.execPath, prefixArgs: ["-e", "setTimeout(() => console.log('codex-cli 0.146.0'), 100)", "--"] },
		requireAuthentication: false, signal: controller.signal,
	});
	setTimeout(() => controller.abort("recovery"), 10);
	const result = await running;
	assert.equal(result.terminationReason, "recovery");
	assert.equal(store.getJob(jobId).lifecycle, "queued");
	assert.equal(store.getJob(jobId).events.at(-1).kind, "recovered");
	store.close();
});

test("DSO-006 bounds and terminates a stuck backend version probe", async () => {
	const { root, store, jobId } = fixture("codex");
	const startedAt = Date.now();
	await assert.rejects(runBackendAttempt({
		store, jobId, backendId: "codex", prompt: "probe timeout", cwd: root,
		runtimeRoot: join(root, "runtime"),
		executable: { command: process.execPath, prefixArgs: ["-e", "setInterval(() => {}, 1000)", "--"] },
		requireAuthentication: false, parentEnv: { PATH: process.env.PATH }, versionProbeTimeoutMs: 50,
	}), /version probe timed out/);
	assert.ok(Date.now() - startedAt < 2_000);
	assert.equal(store.getJob(jobId).lifecycle, "queued");
	store.close();
});

test("DSO-006 captures immutable ownership before signaling a version-probe process group", () => {
	const source = readFileSync(fileURLToPath(new URL("../helper/backend-owned-process.mjs", import.meta.url)), "utf8");
	const terminationStart = source.indexOf("export async function killAndWaitForChild");
	const terminationEnd = source.indexOf("export function backendCommand", terminationStart);
	const termination = source.slice(terminationStart, terminationEnd);
	const probeStart = source.indexOf("export async function probeBackendVersion");
	const probeEnd = source.indexOf("export function captureChildOwnership", probeStart);
	const probe = source.slice(probeStart, probeEnd);
	const capture = probe.indexOf("readProcessStartIdentity(child.pid)");
	const terminate = probe.indexOf("killAndWaitForChild(child, ownedStartIdentity)");
	assert.ok(capture >= 0 && terminate > capture);
	assert.doesNotMatch(probe, /process\.kill\(-child\.pid/);
	const identityRead = termination.indexOf("const currentIdentity = readProcessStartIdentity(child.pid)");
	const exactGuard = termination.indexOf("if (currentIdentity !== ownedStartIdentity)", identityRead);
	const groupKill = termination.indexOf('process.kill(-child.pid, "SIGKILL")', exactGuard);
	assert.ok(identityRead >= 0 && exactGuard > identityRead && groupKill > exactGuard);
	assert.match(termination.slice(exactGuard, groupKill), /currentIdentity === null[\s\S]+child\.kill\("SIGKILL"\)[\s\S]+return waitForChildExit\(child, 2_000, false\)/);
});

test("DSO-006 spawn failure leaves no attempt credential directory", async () => {
	const { root, store, jobId } = fixture("codex");
	const runtimeRoot = join(root, "runtime");
	await assert.rejects(runBackendAttempt({ store, jobId, backendId: "codex", prompt: "spawn", cwd: root, runtimeRoot, executable: join(root, "missing-codex"), backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } }), /ENOENT/);
	assert.deepEqual(readdirSync(join(runtimeRoot, "children")), []);
	store.close();
});

test("DSO-006 immediate child exit fails and releases its reservation", async () => {
	const { root, store, jobId } = fixture("codex");
	const result = await runBackendAttempt({
		store, jobId, backendId: "codex", prompt: "instant",
		cwd: root, runtimeRoot: join(root, "runtime"),
		executable: { command: process.execPath, prefixArgs: ["-e", "process.exit(0)", "--"] },
		backendVersion: "0.146.0", requireAuthentication: false,
		parentEnv: { PATH: process.env.PATH },
	});
	assert.equal(result.backendOutcome, null);
	assert.equal(result.transientResult, null);
	const job = store.getJob(jobId);
	assert.equal(job.lifecycle, "failed");
	assert.notEqual(job.childState.state, "owned");
	store.close();
});

for (const phase of ["before_commit", "after_commit"]) {
		test(`DSO-006 attach failure ${phase} terminates the child and closes the attempt`, async () => {
			const { root, store, jobId } = fixture("codex");
			const pidFile = join(root, `attach-${phase}-grandchild.pid`);
			const attachExecutable = {
				command: process.execPath,
				prefixArgs: ["-e", `const {spawn}=require("node:child_process");const {writeFileSync}=require("node:fs");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`, "--"],
			};
			const originalAttach = store.attachAttempt.bind(store);
			store.attachAttempt = (...args) => {
				const deadline = Date.now() + 1_000;
				while (!existsSync(pidFile) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
				assert.equal(existsSync(pidFile), true, "fake backend must create its grandchild before attach fails");
				if (phase === "after_commit") originalAttach(...args);
				throw new Error(`injected attach failure ${phase}`);
			};
			await assert.rejects(runBackendAttempt({
				store, jobId, backendId: "codex", prompt: `__fake_grandchild__:${pidFile}`,
			cwd: root, runtimeRoot: join(root, "runtime"),
				executable: attachExecutable, backendVersion: "0.146.0",
			requireAuthentication: false, parentEnv: { PATH: process.env.PATH },
		}), new RegExp(`injected attach failure ${phase}`));
		const job = store.getJob(jobId);
		assert.equal(job.lifecycle, "failed");
			assert.equal(job.attemptId, null);
			assert.equal(job.childState.state, "not_expected");
			const grandchildPid = Number(readFileSync(pidFile, "utf8"));
			assert.throws(() => process.kill(grandchildPid, 0), /ESRCH/);
		store.close();
	});
}

test("DSO-006 rejects backend mismatch and a second active attempt", async () => {
	const mismatch = fixture("codex");
	const mismatchMarker = join(mismatch.root, "mismatch-started");
	await assert.rejects(runBackendAttempt({ store: mismatch.store, jobId: mismatch.jobId, backendId: "claude", prompt: `__fake_marker__:${mismatchMarker}`, cwd: mismatch.root, runtimeRoot: join(mismatch.root, "runtime"), executable: fakeBackendPath, backendVersion: "2.1.220", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } }), /backend mismatch/);
	assert.equal(existsSync(mismatchMarker), false);
	assert.deepEqual(readdirSync(join(mismatch.root, "runtime", "children")), []);
	mismatch.store.close();

	const concurrent = fixture("codex");
	concurrent.store.startAttempt(concurrent.jobId, { attemptId: "existing-attempt", backendId: "codex", childPid: process.pid });
	const concurrentMarker = join(concurrent.root, "concurrent-started");
	await assert.rejects(runBackendAttempt({ store: concurrent.store, jobId: concurrent.jobId, backendId: "codex", prompt: `__fake_marker__:${concurrentMarker}`, cwd: concurrent.root, runtimeRoot: join(concurrent.root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } }), /active attempt/);
	assert.equal(existsSync(concurrentMarker), false);
	assert.equal(concurrent.store.getJob(concurrent.jobId).attemptId, "existing-attempt");
	concurrent.store.close();
});

test("DSO-005 rejects command options that weaken fixed safety boundaries", async () => {
	const { root, store, jobId } = fixture("codex");
	await assert.rejects(runBackendAttempt({ store, jobId, backendId: "codex", prompt: "unsafe", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, commandOptions: { sandbox: "host-root" }, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } }), /unsafe Codex sandbox/);
	await assert.rejects(runBackendAttempt({ store, jobId, backendId: "codex", prompt: "unsafe", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, commandOptions: { executableArgs: ["--dangerously-bypass-approvals-and-sandbox"] }, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } }), /unsupported codex command option/);
	await assert.rejects(runBackendAttempt({ store, jobId, backendId: "codex", prompt: "unsafe", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, commandOptions: { approvalPolicy: "managed" }, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } }), /child approval policy must be never/);
	await assert.rejects(runBackendAttempt({ store, jobId, backendId: "codex", prompt: "unsafe", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, commandOptions: { model: "/azure-foundry/deepseek-v4-pro" }, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } }), /unsafe codex model option/);
	store.close();
});

test("DSO-005 accepts a provider-qualified OpenCode model identifier", async () => {
	const { root, store, jobId } = fixture("opencode");
	const result = await runBackendAttempt({
		store, jobId, backendId: "opencode", prompt: "provider model", cwd: root,
		runtimeRoot: join(root, "runtime"), executable: fakeBackendPath,
		commandOptions: { approvalPolicy: "never", model: "azure-foundry/deepseek-v4-pro", auto: true },
		backendVersion: "1.18.15", requireAuthentication: false, parentEnv: { PATH: process.env.PATH },
	});
	assert.equal(result.exitCode, 0);
	assert.equal(store.getJob(jobId).lifecycle, "result_ready");
	store.close();
});

test("FET_DSO_014_005 passes the router Codex balanced profile through the real runner adapter boundary", async () => {
	const { root, store, jobId } = fixture("codex");
	const result = await runBackendAttempt({
		store, jobId, backendId: "codex", prompt: "balanced profile", cwd: root,
		runtimeRoot: join(root, "runtime"), executable: fakeBackendPath,
		commandOptions: { sandbox: "read-only", approvalPolicy: "never", model: "gpt-5.4", costProfile: "balanced" },
		backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH },
	});
	assert.equal(result.exitCode, 0);
	assert.equal(store.getJob(jobId).lifecycle, "result_ready");
	store.close();
});

test("DSO-006 keeps provider failure sticky when a later success marker appears", async () => {
	const { root, store, jobId } = fixture("codex");
	const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt: "__fake_failure_then_success__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } });
	assert.equal(result.backendOutcome, "failure");
	assert.equal(store.getJob(jobId).lifecycle, "failed");
	store.close();
});

test("DSO-006 kills the owned process group including a grandchild", async () => {
	const { root, store, jobId } = fixture("codex");
	const pidFile = join(root, "grandchild.pid");
	await runBackendAttempt({ store, jobId, backendId: "codex", prompt: `__fake_grandchild__:${pidFile}`, cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, timeoutMs: 150, killGraceMs: 20, parentEnv: { PATH: process.env.PATH } });
	assert.ok(existsSync(pidFile));
	const grandchildPid = Number(readFileSync(pidFile, "utf8"));
	assert.throws(() => process.kill(grandchildPid, 0), /ESRCH/);
	store.close();
});

test("DSO-006 does not signal an orphaned group after immutable leader identity disappears", { skip: process.platform === "win32" ? "POSIX orphaned process groups" : false }, async () => {
	const { root, store, jobId } = fixture("codex");
	const pidFile = join(root, "orphan.pid");
	const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt: `__fake_orphan__:${pidFile}`, cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } });
	assert.equal(result.exitCode, 0);
	const orphanPid = Number(readFileSync(pidFile, "utf8"));
	assert.equal(await waitForStoppedProcess(orphanPid), "live");
	process.kill(orphanPid, "SIGKILL");
	assert.ok([null, "Z"].includes(await waitForStoppedProcess(orphanPid)));
	store.close();
});

test("DSO-006 bounds inherited stream drain without signalling an unowned group after the POSIX leader exits", { skip: process.platform === "win32" ? "POSIX process groups" : false }, async () => {
	const { root, store, jobId } = fixture("codex");
	const pidFile = join(root, "inherited-stream-descendant.pid");
	const script = `
		const { spawn } = require("node:child_process");
		const { writeFileSync } = require("node:fs");
		process.stdin.resume();
		process.stdin.on("end", () => {
			const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: ["ignore", "inherit", "inherit"] });
			writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
			process.stdout.write([
				JSON.stringify({ type: "thread.started", thread_id: "inherited-stream-test" }),
				JSON.stringify({ type: "turn.started" }),
				JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
				JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
			].join("\\n") + "\\n", () => process.exit(0));
		});
	`;
	const startedAt = Date.now();
	const result = await runBackendAttempt({
		store, jobId, backendId: "codex", prompt: "inherit streams", cwd: root,
		runtimeRoot: join(root, "runtime"), executable: { command: process.execPath, prefixArgs: ["-e", script, "--"] },
		backendVersion: "0.146.0", requireAuthentication: false, timeoutMs: 10_000, killGraceMs: 20,
		parentEnv: { PATH: process.env.PATH },
	});
	assert.ok(Date.now() - startedAt < 2_500, "inherited stream cleanup exceeded its bound");
	assert.equal(result.exitCode, 0);
	assert.equal(result.terminationReason, "internal_error");
	const descendantPid = Number(readFileSync(pidFile, "utf8"));
	// The leader identity has disappeared, so the harness must not authorize a
	// negative-PID group signal. The service manager/cgroup remains the recovery
	// boundary; clean up this deliberately orphaned fixture explicitly.
	assert.equal(await waitForStoppedProcess(descendantPid), "live");
	process.kill(descendantPid, "SIGKILL");
	assert.ok([null, "Z"].includes(await waitForStoppedProcess(descendantPid)));
	store.close();
});

test("DSO-007 every negative-PID termination requires an exact current leader identity", () => {
	const source = readFileSync(fileURLToPath(new URL("../helper/backend-owned-process.mjs", import.meta.url)), "utf8");
	const start = source.indexOf("export function createOwnedProcessTreeSignaler");
	const signaler = source.slice(start);
	const identityRead = signaler.indexOf("const currentIdentity = readProcessStartIdentity(child.pid)");
	const exactGuard = signaler.indexOf("if (currentIdentity !== ownedStartIdentity) return", identityRead);
	const groupKill = signaler.indexOf("process.kill(-child.pid, signalName)", exactGuard);
	assert.ok(identityRead >= 0 && exactGuard > identityRead && groupKill > exactGuard);
	assert.doesNotMatch(signaler.slice(identityRead, groupKill), /leaderExited|processGroupIsAlive/);
});

test("DSO-005 unbounded backend lines time out safely without raw persistence", async () => {
	const { root, stateRoot, store, jobId } = fixture("codex");
	await runBackendAttempt({ store, jobId, backendId: "codex", prompt: "__fake_oversized_line__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, timeoutMs: 1_000, killGraceMs: 20, parentEnv: { PATH: process.env.PATH } });
	assert.equal(store.getJob(jobId).latestSafeError, "Job failed: timeout");
	store.close();
	assert.ok(!readFileSync(join(stateRoot, "runtime.sqlite3")).includes(Buffer.from("x".repeat(1_024))));
});

test("DSO-006 skips an oversized structured tool result and still accepts the final response", async () => {
	const { root, store, jobId } = fixture("codex");
	const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt: "__fake_oversized_tool_then_success__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } });
	assert.equal(result.backendOutcome, "success");
	assert.equal(result.transientResult, "fake-model-content");
	assert.equal(store.getJob(jobId).lifecycle, "result_ready");
	assert.equal(store.getJob(jobId).events.some((event) => event.kind === "cancel_requested"), false);
	store.close();
});
