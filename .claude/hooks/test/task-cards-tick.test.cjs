const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { run, resolveRole, parseInput } = require("../task-cards-tick.js");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const hook = path.join(repoRoot, ".claude", "hooks", "task-cards-tick.js");

// Temporary repository with the real card script and one card for role "ops".
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-cards-tick-"));
	fs.mkdirSync(path.join(root, ".git"));
	fs.mkdirSync(path.join(root, "scripts"));
	for (const name of ["task-cards.mjs", "notify.mjs"]) {
		fs.copyFileSync(path.join(repoRoot, "scripts", name), path.join(root, "scripts", name));
	}
	const made = spawnSync(process.execPath, [path.join(root, "scripts", "task-cards.mjs"), "--root", root, "new", "--role", "ops", "--title", "Ship it", "--source", "msg 1", "--next", "write tests"], { encoding: "utf8" });
	assert.equal(made.status, 0, made.stderr);
	return root;
}

const input = (root, extra = {}) => ({ session_id: "sess-1", cwd: path.join(root, "scripts"), hook_event_name: "UserPromptSubmit", ...extra });

test("first call adds the role's cards, the next call inside the hour is quiet", () => {
	const root = fixture();
	const env = { ...process.env, ADK_AGENT_ROLE: "ops" };
	const first = JSON.parse(run(input(root), { env }));
	assert.equal(first.hookSpecificOutput.hookEventName, "UserPromptSubmit");
	assert.match(first.hookSpecificOutput.additionalContext, /^\[task cards hourly check\]\n- \[doing\] \d{8}-Ship-it /);
	assert.ok(fs.existsSync(path.join(root, ".agents", "work", "task-cards", "tick-sess-1.json")));
	assert.equal(run(input(root), { env }), "");
});

test("role comes from session-roles.json when the env value is absent", () => {
	const root = fixture();
	const dir = path.join(root, ".agents", "work", "task-cards");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "session-roles.json"), JSON.stringify({ "sess-1": "ops" }));
	const env = { ...process.env, ADK_AGENT_ROLE: "" };
	assert.equal(resolveRole(root, "sess-1", env), "ops");
	assert.equal(resolveRole(root, "other", env), "");
	assert.match(run(input(root), { env }), /Ship-it/);
});

test("no session, no role, no repository or no script: nothing is added", () => {
	const root = fixture();
	const env = { ...process.env, ADK_AGENT_ROLE: "" };
	assert.equal(run({}, { env }), "");
	assert.equal(run(input(root), { env }), "");
	assert.equal(run(input(root, { cwd: os.tmpdir() }), { env: { ...env, ADK_AGENT_ROLE: "ops" } }), "");
	fs.rmSync(path.join(root, "scripts", "task-cards.mjs"));
	assert.equal(run(input(root), { env: { ...env, ADK_AGENT_ROLE: "ops" } }), "");
});

test("the hook process exits 0 on bad input", () => {
	assert.deepEqual(parseInput("{not json"), {});
	const child = spawnSync(process.execPath, [hook, "PostToolUse"], { input: "{not json", encoding: "utf8" });
	assert.equal(child.status, 0);
	assert.equal(child.stdout, "");
});
