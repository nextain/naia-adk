#!/usr/bin/env node
/**
 * BEH §5 propagation enforcement — fault-injection + CLI test (plan §4, §6.7).
 *
 * Pure manifest sign/verify/diff (round-trip, tamper, wrong-key, epoch
 * rollback, managed-region drift) + the real beh-manifest.js CLI against a
 * hermetic managed region (generate → verify → mutate → verify fails).
 *
 * Usage: BEH_SIGN_KEY=... node run-beh-manifest-test.js  (key auto-set if unset)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const M = require(path.join(__dirname, "..", "..", "..", ".agents", "hooks", "core", "beh-manifest.js"));
const CLI = path.join(__dirname, "..", "beh-manifest.js");

let PASS = 0,
	FAIL = 0;
const FAILED = [];
function assert(c, n, d) {
	c ? PASS++ : (FAIL++, FAILED.push(n), console.log(`  ✗ FAIL: ${n}${d ? "\n     " + d : ""}`));
}
const KEY = "test-sign-key-1234";

// ── core ────────────────────────────────────────────────────────────────────
const files = [
	{ path: ".claude/hooks/beh-a.js", content: "AAA" },
	{ path: ".agents/hooks/core/beh-b.js", content: "BBB" },
];
{
	const man = M.generateManifest(files, { epoch: 5, key: KEY });
	assert(M.verifyManifest(man, { key: KEY }).ok, "1. generate→verify round-trip");
	assert(M.verifyManifest(man, { key: KEY, minEpoch: 5 }).ok, "1b. epoch == minEpoch ok");
}
{
	const man = M.generateManifest(files, { epoch: 5, key: KEY });
	man.sig = man.sig.slice(0, -2) + "00";
	assert(!M.verifyManifest(man, { key: KEY }).ok, "2. tampered sig → invalid");
}
{
	const man = M.generateManifest(files, { epoch: 5, key: KEY });
	assert(!M.verifyManifest(man, { key: "WRONG-KEY-9999" }).ok, "3. wrong key → invalid");
}
{
	const man = M.generateManifest(files, { epoch: 5, key: KEY });
	const v = M.verifyManifest(man, { key: KEY, minEpoch: 7 });
	assert(!v.ok && /롤백|anti-rollback/.test(v.reason), "4. epoch rollback (5<7) → invalid");
}
{
	const man = M.generateManifest(files, { epoch: 5, key: KEY });
	const okHashes = {};
	for (const f of files) okHashes[f.path] = M.hashContent(f.content);
	assert(M.diffManagedRegion(man, okHashes).ok, "5. diff: matching region → ok");
	const changed = { ...okHashes, ".claude/hooks/beh-a.js": "deadbeef" };
	const d1 = M.diffManagedRegion(man, changed);
	assert(!d1.ok && d1.drifted.includes(".claude/hooks/beh-a.js"), "5b. diff: changed file → drifted");
	const miss = { ".claude/hooks/beh-a.js": okHashes[".claude/hooks/beh-a.js"] };
	const d2 = M.diffManagedRegion(man, miss);
	assert(d2.missing.includes(".agents/hooks/core/beh-b.js"), "5c. diff: missing file → missing");
	const extra = { ...okHashes, "fork/own-thing.js": "xyz" };
	assert(M.diffManagedRegion(man, extra).ok, "5d. diff: out-of-region file → NOT flagged (3-way base-only)");
}

// ── CLI against a hermetic managed region ───────────────────────────────────
function fixture() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "beh-man-"));
	fs.mkdirSync(path.join(cwd, ".claude", "hooks"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".agents", "hooks", "core"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".claude", "hooks", "beh-foo.js"), "// foo v1\n");
	fs.writeFileSync(path.join(cwd, ".agents", "hooks", "core", "beh-bar.js"), "// bar v1\n");
	fs.writeFileSync(path.join(cwd, ".agents", "hooks", "beh-registry.json"), '{"entries":[]}\n');
	return cwd;
}
const ENV = { ...process.env, BEH_SIGN_KEY: KEY };
function run(args, cwd) {
	return cp.spawnSync("node", [CLI, ...args], { encoding: "utf8", env: ENV });
}

// generate → verify passes.
{
	const cwd = fixture();
	const g = run(["generate", cwd, "10"], cwd);
	const lockExists = fs.existsSync(path.join(cwd, ".agents", "hooks", "beh-manifest.lock"));
	assert(g.status === 0 && lockExists, "6. CLI generate → lock written", `${g.stdout}${g.stderr}`);
	const v = run(["verify", cwd], cwd);
	assert(v.status === 0, "6b. CLI verify intact region → pass", `${v.stdout}${v.stderr}`);
	fs.rmSync(cwd, { recursive: true, force: true });
}
// mutate a managed file → verify fails (drift).
{
	const cwd = fixture();
	run(["generate", cwd, "10"], cwd);
	fs.writeFileSync(path.join(cwd, ".claude", "hooks", "beh-foo.js"), "// foo TAMPERED\n");
	const v = run(["verify", cwd], cwd);
	assert(v.status === 1 && /DRIFT/.test(v.stderr || ""), "7. CLI verify drifted file → fail", `${v.stdout}${v.stderr}`);
	fs.rmSync(cwd, { recursive: true, force: true });
}
// --min-epoch above lock epoch → rollback fail.
{
	const cwd = fixture();
	run(["generate", cwd, "10"], cwd);
	const v = run(["verify", cwd, "--min-epoch", "20"], cwd);
	assert(v.status === 1 && /롤백|anti-rollback/.test(v.stderr || ""), "8. CLI verify min-epoch>lock → rollback fail");
	fs.rmSync(cwd, { recursive: true, force: true });
}
// missing key → exit 2.
{
	const cwd = fixture();
	const r = cp.spawnSync("node", [CLI, "generate", cwd, "10"], { encoding: "utf8", env: { ...process.env, BEH_SIGN_KEY: "" } });
	assert(r.status === 2 && /서명 키 없음/.test(r.stderr || ""), "9. CLI no key → exit 2");
	fs.rmSync(cwd, { recursive: true, force: true });
}

console.log(`\nBEH manifest/propagation: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) {
	console.log("FAILED: " + FAILED.join(", "));
	process.exit(1);
}
