"use strict";
// node .claude/hooks/test/run-protected-paths-test.cjs
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..", "..");
const policy = require(path.join(root, ".agents", "hooks", "policies", "protected-paths.js"));

const protectedPaths = ["secrets/human-only.md", "ops/approve.mjs", "private-dir"];
const opts = { protectedPaths, root: "/ws", cwd: "/ws" };
const edit = (file, extra) => policy.editPath({ cwd: "/ws", tool_input: { file_path: file }, ...extra }, opts);

// ── edit gate ──
for (const file of [
	"/ws/secrets/human-only.md",
	"secrets/human-only.md",
	"/ws/sub/../secrets/human-only.md",
	"/ws/ops/approve.mjs",
	"/other/clone/ops/approve.mjs", // trailing path segment
	"/ws/private-dir/a/b.txt", // inside a protected directory
	"/ws/private-dir",
]) {
	assert.match(edit(file)?.block || "", /보호 경로 차단/, `must block: ${file}`);
}
for (const file of ["/ws/secrets/other.md", "/ws/private-dir2/a.txt", "/ws/README.md", "/ws/xops/approve.mjs.bak"]) {
	assert.strictEqual(edit(file), null, `must allow: ${file}`);
}
assert.ok(policy.editPath({ cwd: "/ws", tool_input: { notebook_path: "/ws/private-dir/n.ipynb" } }, opts), "notebook_path is checked");
assert.strictEqual(policy.editPath({ cwd: "/ws", tool_input: {} }, opts), null);

// ── command gate ──
const cmd = (c) => policy.commandPath(c, opts);
for (const c of [
	"cat secrets/human-only.md",
	"node ops/approve.mjs --yes",
	"cat ./private-dir/x && echo ok",
	"echo hi; sed -n 1p secrets/human-only.md",
	"cat 'secrets/human-only.md'",
	"bash -c 'cat secrets/human-only.md'",
	"echo $(cat secrets/human-only.md)",
]) {
	assert.match(cmd(c)?.reason || "", /보호 경로 차단/, `must block: ${c}`);
}
for (const c of [
	"ls",
	"git status",
	"cat secrets/other.md",
	'git commit -m "docs: mention secrets/human-only.md in the notes"', // quoted free text
]) {
	assert.strictEqual(cmd(c), null, `must allow: ${c}`);
}

// ── no list → nothing is blocked ──
const empty = { protectedPaths: [], root: "/ws", cwd: "/ws" };
assert.strictEqual(policy.editPath({ cwd: "/ws", tool_input: { file_path: "/ws/secrets/human-only.md" } }, empty), null);
assert.strictEqual(policy.commandPath("cat secrets/human-only.md", empty), null);
const bare = fs.mkdtempSync(path.join(os.tmpdir(), "protected-paths-"));
assert.deepStrictEqual(policy.loadProtectedPaths(bare, {}).list.filter(() => false), []);
// shipped policy file is empty, so the repository itself blocks nothing by default
assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, ".agents", "context", "protected-paths.json"), "utf8")).protected_paths, []);

// ── policy file discovery: nearest ancestor wins, malformed file blocks nothing ──
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "protected-paths-ws-"));
fs.mkdirSync(path.join(ws, ".agents", "context"), { recursive: true });
fs.mkdirSync(path.join(ws, "deep", "dir"), { recursive: true });
const policyFile = path.join(ws, ".agents", "context", "protected-paths.json");
fs.writeFileSync(policyFile, JSON.stringify({ protected_paths: ["keys/", " ", 5, "keys\\win.txt"] }));
const found = policy.loadProtectedPaths(path.join(ws, "deep", "dir"), {});
assert.strictEqual(found.root, ws);
assert.deepStrictEqual(found.list, ["keys", "keys/win.txt"]);
fs.writeFileSync(policyFile, "{ not json");
assert.deepStrictEqual(policy.loadProtectedPaths(path.join(ws, "deep"), {}).list.filter((p) => p.startsWith("keys")), []);

// ── adapters: real hook processes ──
const run = (hook, payload, cwd) => {
	const r = spawnSync(process.execPath, [path.join(root, ".claude", "hooks", hook)], { input: JSON.stringify(payload), encoding: "utf8", cwd });
	assert.strictEqual(r.status, 0, r.stderr);
	return r.stdout ? JSON.parse(r.stdout) : null;
};
fs.writeFileSync(policyFile, JSON.stringify({ protected_paths: ["keys/human.txt"] }));
const edited = run("protected-path-guard.js", { tool_name: "Write", cwd: ws, tool_input: { file_path: path.join(ws, "keys", "human.txt") } }, ws);
assert.strictEqual(edited?.decision, "block");
assert.strictEqual(run("protected-path-guard.js", { tool_name: "Write", cwd: ws, tool_input: { file_path: path.join(ws, "keys", "ok.txt") } }, ws), null);
assert.strictEqual(run("protected-path-guard.js", { tool_name: "Bash", cwd: ws, tool_input: { command: "cat keys/human.txt" } }, ws), null, "edit adapter ignores Bash");
const ran = run("protected-path-command-guard.js", { tool_name: "Bash", cwd: ws, tool_input: { command: "cat keys/human.txt" } }, ws);
assert.strictEqual(ran?.decision, "block");
assert.strictEqual(run("protected-path-command-guard.js", { tool_name: "Bash", cwd: ws, tool_input: { command: "cat keys/ok.txt" } }, ws), null);

// ── registered in the project settings ──
const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
const registered = (name) => settings.hooks.PreToolUse.some((g) => (g.hooks || []).some((h) => (h.command || "").includes(name)));
assert.ok(registered("protected-path-guard.js"), "edit adapter registered");
assert.ok(registered("protected-path-command-guard.js"), "command adapter registered");

console.log("protected-paths: ok");
