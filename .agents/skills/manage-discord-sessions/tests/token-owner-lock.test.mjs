import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireDiscordTokenOwnerLock, defaultDiscordTokenLockDirectory, discordTokenFingerprint } from "../helper/token-owner-lock.mjs";

const moduleUrl = pathToFileURL(fileURLToPath(new URL("../helper/token-owner-lock.mjs", import.meta.url))).href;
const roots = [];

test("DSO-011 derives one stable kernel lock identity from the credential bytes", () => {
	assert.equal(discordTokenFingerprint("fake-same-token-value-long-enough"), discordTokenFingerprint("fake-same-token-value-long-enough"));
	assert.notEqual(discordTokenFingerprint("fake-same-token-value-long-enough"), discordTokenFingerprint("fake-other-token-value-long-enough"));
});
const workerSource = `
import { acquireDiscordTokenOwnerLock } from ${JSON.stringify(moduleUrl)};
try {
  const lock = acquireDiscordTokenOwnerLock({ token: process.env.TEST_TOKEN, lockDirectory: process.env.TEST_LOCK_ROOT });
  const keepAlive = setInterval(() => {}, 1000);
  if (process.env.TEST_CRASH === "1") {
    process.stdout.write("acquired\\n", () => process.kill(process.pid, "SIGKILL"));
  } else {
    process.stdout.write("acquired\\n");
  }
  process.stdin.setEncoding("utf8");
	process.stdin.resume();
  process.stdin.once("data", () => { clearInterval(keepAlive); lock.release(); process.exit(0); });
} catch (error) {
  process.stderr.write(String(error?.message ?? error));
  process.exit(2);
}
`;

afterEach(() => {
	while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function worker(root, token, extraEnv = {}) {
	return spawn(process.execPath, ["--input-type=module", "--eval", workerSource], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, TEST_LOCK_ROOT: root, TEST_TOKEN: token, ...extraEnv },
	});
}

function collect(child) {
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	let finishExit;
	let finished = false;
	const exit = new Promise((resolve) => { finishExit = resolve; });
	const finish = (code, signal) => {
		if (finished) return;
		finished = true;
		clearTimeout(deadline);
		finishExit({ code, signal, stdout, stderr });
	};
	child.once("exit", finish);
	child.once("error", (error) => { stderr += String(error?.message ?? error); finish(2, null); });
	const deadline = setTimeout(() => {
		try { child.kill("SIGKILL"); } catch {}
		child.stdin.destroy();
		child.stdout.destroy();
		child.stderr.destroy();
		child.unref();
		finish(2, "TEST_TIMEOUT");
	}, 3_000);
	const acquired = new Promise((resolve) => {
		let observed = false;
		child.stdout.on("data", (chunk) => {
			if (!observed && String(chunk).includes("acquired")) {
				observed = true;
				resolve(true);
			}
		});
		void exit.then(() => { if (!observed) resolve(false); });
	});
	return { child, exit, acquired };
}

async function stop(holder) {
	holder.child.stdin.end("release\n");
	const result = await holder.exit;
	assert.equal(result.code, 0, result.stderr);
}

test("DSO-009 atomically owns one Discord token across processes without exposing lock identity", async () => {
	const root = mkdtempSync(join(tmpdir(), "naia-token-owner-lock-"));
	roots.push(root);
	const tokenA = "test-token-a-1234567890";
	const tokenB = "test-token-b-1234567890";
	const first = collect(worker(root, tokenA));
	const firstAcquired = await first.acquired;
	assert.equal(firstAcquired, true, "first token-lock worker did not acquire the lock");

	const contender = collect(worker(root, tokenA));
	const rejected = await contender.exit;
	assert.equal(rejected.code, 2);
	assert.equal(rejected.stderr, "Discord token is already owned by another process");
	assert.equal(rejected.stderr.includes(tokenA), false);
	for (const entry of readdirSync(root)) assert.equal(rejected.stderr.includes(entry), false);

	const different = collect(worker(root, tokenB));
	assert.equal(await different.acquired, true);
	await Promise.all([stop(first), stop(different)]);

	const crashed = collect(worker(root, tokenA, { TEST_CRASH: "1" }));
	assert.equal(await crashed.acquired, true);
	const crashResult = await crashed.exit;
	assert.equal(crashResult.signal, "SIGKILL");
	const crashContenders = Array.from({ length: 4 }, () => collect(worker(root, tokenA)));
	const crashRace = await Promise.all(crashContenders.map((candidate) => candidate.acquired));
	assert.equal(crashRace.filter(Boolean).length, 1, JSON.stringify(crashRace));
	const crashWinner = crashContenders[crashRace.findIndex(Boolean)];
	await stop(crashWinner);
	const crashLosers = await Promise.all(crashContenders.filter((candidate) => candidate !== crashWinner).map((candidate) => candidate.exit));
	assert.equal(crashLosers.every((result) => result.code === 2 && result.stderr === "Discord token is already owned by another process"), true, JSON.stringify(crashLosers));
	assert.equal(readdirSync(root).some((entry) => entry.includes(".stale-")), false);
	assert.equal(readdirSync(root).some((entry) => entry.endsWith(".reclaim")), false);

	const racers = Array.from({ length: 8 }, () => collect(worker(root, tokenB)));
	const raceResults = await Promise.all(racers.map((candidate) => candidate.acquired));
	assert.equal(raceResults.filter(Boolean).length, 1);
	const winner = racers[raceResults.findIndex(Boolean)];
	await stop(winner);
	const loserResults = await Promise.all(racers.filter((candidate) => candidate !== winner).map((candidate) => candidate.exit));
	assert.equal(loserResults.every((result) => result.code === 2), true, JSON.stringify(loserResults));
});

test("DSO-011 uses one per-user token lock namespace and never auto-reclaims PID reuse", () => {
	assert.equal(defaultDiscordTokenLockDirectory({ XDG_RUNTIME_DIR: "/tmp/naia-runtime-a" }), "/tmp/naia-runtime-a/naia-adk/messenger-token-locks");
	assert.equal(defaultDiscordTokenLockDirectory({ NAIA_DISCORD_TOKEN_LOCK_DIRECTORY: "/tmp/shared-locks", XDG_RUNTIME_DIR: "/tmp/ignored" }), "/tmp/shared-locks");
	if (process.platform !== "win32") {
		const firstBoot = defaultDiscordTokenLockDirectory({}, { platform: "linux", bootId: "boot-a" });
		const secondBoot = defaultDiscordTokenLockDirectory({}, { platform: "linux", bootId: "boot-b" });
		assert.notEqual(firstBoot, secondBoot, "non-XDG /tmp fallback must not carry stale ownership across boots");
		assert.match(firstBoot, /^\/tmp\/naia-adk-[^/]+\/boots\/[0-9a-f]{16}\/messenger-token-locks$/);
	}
	const root = mkdtempSync(join(tmpdir(), "naia-token-owner-identity-"));
	roots.push(root);
	const token = "test-token-reused-pid-1234567890";
	acquireDiscordTokenOwnerLock({ token, lockDirectory: root });
	const lockName = readdirSync(root).find((entry) => entry.endsWith(".lock"));
	assert.ok(lockName);
	const ownerPath = join(root, lockName, "owner.json");
	const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
	writeFileSync(ownerPath, JSON.stringify({ ...owner, processStartIdentity: `${owner.processStartIdentity}-reused` }), { mode: 0o600 });
	assert.throws(() => acquireDiscordTokenOwnerLock({ token, lockDirectory: root }), /already owned/);
	assert.equal(readdirSync(root).some((entry) => entry.includes(".stale-")), false);
});

test("DSO-011 never reclaims an incomplete live lock by elapsed initialization time", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-token-owner-incomplete-"));
	roots.push(root);
	const token = "test-token-incomplete-owner-1234567890";
	acquireDiscordTokenOwnerLock({ token, lockDirectory: root });
	const lockName = readdirSync(root).find((entry) => entry.endsWith(".lock"));
	unlinkSync(join(root, lockName, "owner.json"));
	assert.throws(() => acquireDiscordTokenOwnerLock({ token, lockDirectory: root }), /already owned/);
});

test("DSO-011 never auto-reclaims a complete owner record from a different boot", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-token-owner-boot-"));
	roots.push(root);
	const token = "test-token-old-boot-1234567890";
	acquireDiscordTokenOwnerLock({ token, lockDirectory: root });
	const lockName = readdirSync(root).find((entry) => entry.endsWith(".lock"));
	const ownerPath = join(root, lockName, "owner.json");
	const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
	writeFileSync(ownerPath, JSON.stringify({ ...owner, bootId: "different-boot" }), { mode: 0o600 });
	assert.throws(() => acquireDiscordTokenOwnerLock({ token, lockDirectory: root }), /already owned/);
});

test("DSO-011 Linux kernel token ownership releases automatically on process death", { skip: process.platform === "win32" || !existsSync("/usr/bin/flock") }, async () => {
	const root = mkdtempSync(join(tmpdir(), "naia-token-kernel-lock-"));
	roots.push(root);
	const lockPath = join(root, "bot-111111111111111111.lock");
	const holder = spawn("/usr/bin/flock", ["--no-fork", "--nonblock", "--conflict-exit-code", "78", lockPath, process.execPath, "-e", "process.stdout.write('held\\n'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
	await new Promise((resolveHeld, rejectHeld) => {
		holder.stdout.once("data", resolveHeld);
		holder.once("error", rejectHeld);
	});
	assert.equal(spawnSync("/usr/bin/flock", ["--no-fork", "--nonblock", "--conflict-exit-code", "78", lockPath, "/usr/bin/true"]).status, 78);
	holder.kill("SIGKILL");
	await new Promise((resolveExit) => holder.once("exit", resolveExit));
	assert.equal(spawnSync("/usr/bin/flock", ["--no-fork", "--nonblock", "--conflict-exit-code", "78", lockPath, "/usr/bin/true"]).status, 0);
});
