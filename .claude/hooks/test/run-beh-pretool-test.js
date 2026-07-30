#!/usr/bin/env node
/**
 * BEH §3.4 PreToolUse + launcher — fault-injection + replay test (plan §4, §6.4).
 *
 * Pure predicates (background/wrapper/launcher detection, handshake eval) +
 * real-condition replay of beh-pretool.js (handshake fail-closed, unsupervised-
 * background block, launcher/bypass escapes) + beh-launch.sh handshake writing.
 *
 * Usage: node run-beh-pretool-test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const HOOKS = path.join(__dirname, "..");
const CORE = path.join(__dirname, "..", "..", "..", ".agents", "hooks", "core");
const lc = require(path.join(CORE, "beh-launch-core.js"));

let PASS = 0,
	FAIL = 0;
const FAILED = [];
function assert(c, n, d) {
	c ? PASS++ : (FAIL++, FAILED.push(n), console.log(`  ✗ FAIL: ${n}${d ? "\n     " + d : ""}`));
}
function fire(hook, stdin) {
	try {
		return cp.execFileSync("node", [path.join(HOOKS, hook)], { input: JSON.stringify(stdin), encoding: "utf8" });
	} catch (e) {
		return "__EXEC_ERROR__:" + (e.message || "");
	}
}
const blocked = (out) => /"decision":"block"/.test(out);

// ── core predicates ───────────────────────────────────────────────────────
assert(lc.isBackgrounded("sleep 5 &") === true, "core: trailing & → backgrounded");
assert(lc.isBackgrounded("a && b") === false, "core: && operator → not backgrounded");
assert(lc.isBackgrounded("nohup x") === true, "core: nohup → backgrounded");
assert(lc.isBackgrounded("setsid y") === true, "core: setsid → backgrounded");
assert(lc.isBackgrounded("echo '&'") === false, "core: quoted & → not backgrounded");
assert(lc.isBackgrounded("npm test") === false, "core: plain → not backgrounded");
assert(lc.isSuperviseWrapper("node .claude/hooks/beh-supervise.js -- x") === true, "core: supervise wrapper detect");
assert(lc.isSuperviseWrapper("node .claude\\hooks\\beh-supervise.js -- x &") === true, "core: native Windows wrapper path detect");
assert(lc.isSuperviseWrapper("echo beh-supervise.js & malicious-command") === false, "core: wrapper filename cannot bypass background guard");
assert(lc.isSuperviseWrapper("node C:\\attacker\\beh-supervise.js -- x &") === false, "core: trusted basename at untrusted path cannot bypass background guard");
assert(lc.isSuperviseWrapper("C:\\attacker\\node.exe .claude\\hooks\\beh-supervise.js -- x &") === false, "core: untrusted Node executable path cannot bypass background guard");
assert(lc.isLauncher("bash .claude/hooks/beh-launch.sh /repo") === true, "core: launcher detect");
assert(lc.isLauncher("node .claude/hooks/beh-launch.cjs C:\\repo") === true, "core: native Windows launcher detect");
assert(lc.isLauncher("echo beh-launch.cjs & malicious-command") === false, "core: launcher filename cannot bypass handshake guard");
assert(lc.isLauncher("node C:\\attacker\\beh-launch.cjs C:\\repo") === false, "core: launcher basename at untrusted path is rejected");
{
	const now = 1_000_000;
	assert(lc.evaluateHandshake({ handshake: null, currentHash: "h", now, maxAgeMs: 1000 }).ok === false, "core: no handshake → !ok");
	assert(lc.evaluateHandshake({ handshake: { ts: now, settings_hash: "h2" }, currentHash: "h1", now, maxAgeMs: 1e9 }).ok === false, "core: hash mismatch → !ok");
	assert(lc.evaluateHandshake({ handshake: { ts: 0, settings_hash: "h1" }, currentHash: "h1", now, maxAgeMs: 1000 }).ok === false, "core: stale → !ok");
	assert(lc.evaluateHandshake({ handshake: { ts: now, settings_hash: "h1" }, currentHash: null, now, maxAgeMs: 1000 }).ok === false, "core: unreadable current settings hash → !ok");
	assert(lc.evaluateHandshake({ handshake: { settings_hash: "h1" }, currentHash: "h1", now, maxAgeMs: 1000 }).ok === false, "core: missing handshake timestamp → !ok");
	assert(lc.evaluateHandshake({ handshake: { ts: now }, currentHash: "h1", now, maxAgeMs: 1000 }).ok === false, "core: missing handshake hash → !ok");
	assert(lc.evaluateHandshake({ handshake: { ts: now, settings_hash: "h1" }, currentHash: "h1", now, maxAgeMs: 1e9 }).ok === true, "core: fresh+match → ok");
}

// ── adapter replay fixture ──────────────────────────────────────────────────
function setup({ withHandshake = true, drift = false } = {}) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "beh-pt-"));
	fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".claude", "beh-on"), "");
	const settings = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "node .claude/hooks/beh-pretool.js" }] }] } });
	fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), settings);
	if (withHandshake) {
		const hash = drift ? "DRIFTED_HASH" : crypto.createHash("sha256").update(settings).digest("hex");
		fs.writeFileSync(path.join(cwd, ".claude", "beh-handshake"), JSON.stringify({ ts: Date.now(), settings_hash: hash }));
	}
	return cwd;
}
const SID = "pt-sess";

// malformed adapter input and missing enforcement cores fail closed.
{
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "beh-missing-core-"));
	const copiedHook = path.join(cwd, ".claude", "hooks", "beh-pretool.js");
	fs.mkdirSync(path.dirname(copiedHook), { recursive: true });
	fs.copyFileSync(path.join(HOOKS, "beh-pretool.js"), copiedHook);
	const disabledMalformed = cp.spawnSync(process.execPath, [copiedHook], { cwd, input: "{", encoding: "utf8", shell: false });
	assert(!blocked(disabledMalformed.stdout), "core: malformed hook input remains silent while BEH is disabled", disabledMalformed.stdout);
	fs.writeFileSync(path.join(cwd, ".claude", "beh-on"), "");
	const enabledMalformed = cp.spawnSync(process.execPath, [copiedHook], { cwd, input: "{", encoding: "utf8", shell: false });
	assert(blocked(enabledMalformed.stdout), "core: malformed hook input fails closed after BEH opt-in", enabledMalformed.stdout);
	const missing = cp.spawnSync(process.execPath, [copiedHook], { input: JSON.stringify({ cwd, tool_name: "Bash", tool_input: { command: "npm test" } }), encoding: "utf8", shell: false });
	assert(blocked(missing.stdout) && /core could not be loaded/.test(missing.stdout), "core: enabled session with missing enforcement core fails closed", missing.stdout);
	fs.rmSync(cwd, { recursive: true, force: true });
}

// valid handshake + plain command → allow.
{
	const cwd = setup();
	const out = fire("beh-pretool.js", { cwd, session_id: SID, tool_name: "Bash", tool_input: { command: "npm test" } });
	assert(!blocked(out), "1. valid handshake + plain Bash → allow", out.slice(0, 160));
	fs.rmSync(cwd, { recursive: true, force: true });
}
// valid handshake + backgrounded → block.
{
	const cwd = setup();
	const out = fire("beh-pretool.js", { cwd, session_id: SID, tool_name: "Bash", tool_input: { command: "sleep 99 &" } });
	assert(blocked(out) && /Unsupervised background/.test(out), "2. backgrounded Bash → block", out.slice(0, 160));
	fs.rmSync(cwd, { recursive: true, force: true });
}
// valid handshake + run_in_background → block.
{
	const cwd = setup();
	const out = fire("beh-pretool.js", { cwd, session_id: SID, tool_name: "Bash", tool_input: { command: "long-task", run_in_background: true } });
	assert(blocked(out), "3. run_in_background → block", out.slice(0, 120));
	fs.rmSync(cwd, { recursive: true, force: true });
}
// valid handshake + supervise-wrapped background → allow.
{
	const cwd = setup();
	const out = fire("beh-pretool.js", { cwd, session_id: SID, tool_name: "Bash", tool_input: { command: "node .claude/hooks/beh-supervise.js --probe-type file_lines -- big &" } });
	assert(!blocked(out), "4. supervise-wrapped background → allow", out.slice(0, 160));
	fs.rmSync(cwd, { recursive: true, force: true });
}
// missing handshake → fail-closed block (even a plain command).
{
	const cwd = setup({ withHandshake: false });
	const out = fire("beh-pretool.js", { cwd, session_id: SID, tool_name: "Bash", tool_input: { command: "npm test" } });
	assert(blocked(out) && /fail-CLOSED/.test(out), "5. missing handshake → fail-closed block", out.slice(0, 160));
	fs.rmSync(cwd, { recursive: true, force: true });
}
// missing handshake + launcher command → allow (to establish handshake).
{
	const cwd = setup({ withHandshake: false });
	const command=process.platform === "win32" ? "node .claude/hooks/beh-launch.cjs ." : "bash .claude/hooks/beh-launch.sh .";
	const out = fire("beh-pretool.js", { cwd, session_id: SID, tool_name: "Bash", tool_input: { command } });
	assert(!blocked(out), "6. launcher cmd w/o handshake → allow", out.slice(0, 120));
	fs.rmSync(cwd, { recursive: true, force: true });
}
// drifted handshake (hash mismatch) → block.
{
	const cwd = setup({ drift: true });
	const out = fire("beh-pretool.js", { cwd, session_id: SID, tool_name: "Bash", tool_input: { command: "npm test" } });
	assert(blocked(out) && /드리프트/.test(out), "7. drifted settings hash → block", out.slice(0, 160));
	fs.rmSync(cwd, { recursive: true, force: true });
}
// bypass marker → allow + consumed.
{
	const cwd = setup({ withHandshake: false });
	fs.writeFileSync(path.join(cwd, ".claude", "beh-launch-bypass"), "");
	const out = fire("beh-pretool.js", { cwd, session_id: SID, tool_name: "Bash", tool_input: { command: "npm test" } });
	const consumed = !fs.existsSync(path.join(cwd, ".claude", "beh-launch-bypass"));
	assert(!blocked(out) && consumed, "8. bypass marker → allow + consumed", out.slice(0, 120));
	fs.rmSync(cwd, { recursive: true, force: true });
}

// ── launcher beh-launch.sh ──────────────────────────────────────────────────
function launchFixture(registerAll = true) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "beh-lan-"));
	fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
	const dstCore = path.join(cwd, ".agents", "hooks", "core");
	fs.mkdirSync(dstCore, { recursive: true });
	for (const c of ["beh-ledger.js", "beh-receipts.js", "beh-supervise-core.js", "beh-launch-core.js"]) {
		fs.copyFileSync(path.join(CORE, c), path.join(dstCore, c));
	}
	const registered = {
		UserPromptSubmit: "beh-tick.js",
		PostToolUse: "beh-record.js",
		...(registerAll ? { Stop: "beh-stop.js", PreToolUse: "beh-pretool.js" } : {}),
	};
	const hooks = Object.fromEntries(Object.entries(registered).map(([eventName, hookName]) => [eventName, [{ hooks: [{ type: "command", command: `node .claude/hooks/${hookName}` }] }]]));
	fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ hooks }));
	return cwd;
}
// filenames in unrelated JSON fields must not masquerade as registrations.
{
	const cwd = launchFixture(false);
	const settingsPath = path.join(cwd, ".claude", "settings.json");
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	settings.note = "beh-stop.js beh-pretool.js";
	fs.writeFileSync(settingsPath, JSON.stringify(settings));
	const launcher=process.platform === "win32" ? [process.execPath,[path.join(HOOKS,"beh-launch.cjs"),cwd]] : ["bash",[path.join(HOOKS,"beh-launch.sh"),cwd]];
	const r = cp.spawnSync(launcher[0],launcher[1], { encoding: "utf8",shell:false });
	assert(r.status === 1 && !fs.existsSync(path.join(cwd, ".claude", "beh-handshake")), "11. launcher: unrelated filename strings cannot fake registration", `status=${r.status}`);
	fs.rmSync(cwd, { recursive: true, force: true });
}
// required basenames at external paths, or with trailing argv, are not trusted registrations.
{
	const cwd = launchFixture(true);
	const settingsPath = path.join(cwd, ".claude", "settings.json");
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	settings.hooks.Stop[0].hooks[0].command = "node C:/attacker/.claude/hooks/beh-stop.js --bypass";
	fs.writeFileSync(settingsPath, JSON.stringify(settings));
	const launcher=process.platform === "win32" ? [process.execPath,[path.join(HOOKS,"beh-launch.cjs"),cwd]] : ["bash",[path.join(HOOKS,"beh-launch.sh"),cwd]];
	const r = cp.spawnSync(launcher[0],launcher[1], { encoding: "utf8",shell:false });
	assert(r.status === 1 && !fs.existsSync(path.join(cwd, ".claude", "beh-handshake")), "12. launcher: external hook path and trailing argv are rejected", `status=${r.status}`);
	fs.rmSync(cwd, { recursive: true, force: true });
}
// success: all hooks registered + cores load → handshake written.
{
	const cwd = launchFixture(true);
	const launcher=process.platform === "win32" ? [process.execPath,[path.join(HOOKS,"beh-launch.cjs"),cwd]] : ["bash",[path.join(HOOKS,"beh-launch.sh"),cwd]];
	const r = cp.spawnSync(launcher[0],launcher[1], { encoding: "utf8",shell:false });
	const hs = fs.existsSync(path.join(cwd, ".claude", "beh-handshake"));
	assert(r.status === 0 && hs, "9. launcher: all registered → handshake written", `status=${r.status} ${r.stdout}${r.stderr}`);
	const relaunched = cp.spawnSync(launcher[0],launcher[1], { encoding: "utf8",shell:false });
	assert(relaunched.status === 0 && fs.existsSync(path.join(cwd, ".claude", "beh-handshake")), "9. launcher: existing handshake is safely refreshed", `status=${relaunched.status} ${relaunched.stderr}`);
	// the written handshake must satisfy the pretool check.
	const out = fire("beh-pretool.js", { cwd, session_id: SID, tool_name: "Bash", tool_input: { command: "npm test" } });
	assert(!blocked(out), "9. launcher handshake satisfies pretool → allow", out.slice(0, 120));
	fs.rmSync(cwd, { recursive: true, force: true });
}
// failure: a required hook unregistered → launcher fails, no handshake.
{
	const cwd = launchFixture(false);
	const launcher=process.platform === "win32" ? [process.execPath,[path.join(HOOKS,"beh-launch.cjs"),cwd]] : ["bash",[path.join(HOOKS,"beh-launch.sh"),cwd]];
	const r = cp.spawnSync(launcher[0],launcher[1], { encoding: "utf8",shell:false });
	const hs = fs.existsSync(path.join(cwd, ".claude", "beh-handshake"));
	assert(r.status === 1 && !hs, "10. launcher: hook unregistered → FAIL, no handshake", `status=${r.status} ${r.stdout}`);
	fs.rmSync(cwd, { recursive: true, force: true });
}

console.log(`\nBEH pretool/launcher: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) {
	console.log("FAILED: " + FAILED.join(", "));
	process.exit(1);
}
