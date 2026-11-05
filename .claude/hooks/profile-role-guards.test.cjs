const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const scratch = path.resolve(__dirname, "..", "..", "..", "tmp-codex-profile");

const write = (file, value) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};
function fixture(t) {
	fs.mkdirSync(scratch, { recursive: true });
	const base = fs.mkdtempSync(path.join(scratch, "role-guards-"));
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	const role = path.join(base, "role");
	const adk = path.join(base, "adk");
	write(path.join(role, ".naia-role.json"), { read: [] });
	write(path.join(adk, ".agents/context/project-index.yaml"), "submodules: {}\n");
	write(path.join(adk, ".agents/context/agents-rules.json"), {});
	write(path.join(adk, ".agents/progress/work.json"), { current_phase: "build" });
	write(path.join(adk, ".claude/deploy/config.json"), { projects: {} });
	write(path.join(adk, ".claude/hooks/gcs-guard.config.json"), { buckets: { "example-archive": "archive" } });
	const deploymentHook = path.join(adk, ".claude/hooks/deploy-guard.js");
	fs.copyFileSync(path.join(__dirname, "deploy-guard.js"), deploymentHook);
	fs.copyFileSync(path.join(__dirname, "_claude-bash-guard.js"), path.join(adk, ".claude/hooks/_claude-bash-guard.js"));
	// Route the isolated adapter to the real shared policy, without replacing
	// its implementation or letting approvals/audit touch the checkout.
	write(path.join(adk, ".agents/hooks/policies/bash.js"),
		`module.exports = require(${JSON.stringify(path.resolve(__dirname, "../../.agents/hooks/policies/bash.js"))});\n`);
	return { base, role, adk, deploymentHook };
}
async function run(name, cwd, payload, adkRoot = "", hookPath = null, extraEnv = {}, expectedCode = 0) {
	const io = fs.mkdtempSync(path.join(scratch, "hook-stdio-"));
	const input = path.join(io, "stdin.json"), output = path.join(io, "stdout"), errors = path.join(io, "stderr");
	fs.writeFileSync(input, JSON.stringify({ cwd, session_id: "profile-test", ...payload }));
	const descriptors = [fs.openSync(input, "r"), fs.openSync(output, "w"), fs.openSync(errors, "w")];
	try {
		const code = await new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [hookPath || path.join(__dirname, name)], {
				cwd, env: { ...process.env, TMPDIR: io, CLAUDE_PROJECT_DIR: cwd, NAIA_ADK_ROOT: adkRoot, CLAUDE_SUBAGENT_GUARD: "", ...extraEnv },
				stdio: descriptors,
			});
			const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${name}: hook timed out`)); }, 10000);
			child.on("error", error => { clearTimeout(timer); reject(error); });
			child.on("close", status => { clearTimeout(timer); resolve(status); });
		});
		assert.equal(code, expectedCode, `${name}: ${fs.readFileSync(errors, "utf8")}`);
		const stdout = fs.readFileSync(output, "utf8");
		return stdout.trim() ? JSON.parse(stdout) : null;
	} finally {
		for (const descriptor of descriptors) fs.closeSync(descriptor);
		fs.rmSync(io, { recursive: true, force: true });
	}
}
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
// Approval guidance includes a newly computed example expiry on every invocation.
const stableDecision = (result) => result && {
	...result, reason: result.reason?.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<timestamp>"),
};

// Hook sources at ed3a30e8, kept as fixtures because CI checkouts are shallow
// and a squash merge drops that commit from the default branch.
function baselineHook(adk, name) {
	const source = fs.readFileSync(path.join(__dirname, "test/fixtures/baseline-ed3a30e8", `${name}.txt`), "utf8");
	assert.ok(source.includes("process"), `${name}: baseline source was loaded`);
	const target = path.join(adk, ".claude/hooks", `baseline-${name}`);
	write(target, source);
	return target;
}

const cases = [
	["commit-guard.js", bash("git commit -m example"), bash("ls")],
	["deploy-guard.js", bash("vercel --prod"), bash("ls")],
	["remote-identity-gate.js", bash("gh repo create example/sample --public"), bash("ls")],
	["gcs-guard.js", bash("gsutil cp ./object gs://example-archive/object"), bash("ls")],
	["prod-gateway-guard.js",
		{ tool_name: "Write", tool_input: { file_path: ".env.local", content: "GATEWAY_URL=https://naia-gateway-123456.region" + ".run.app" } },
		{ tool_name: "Write", tool_input: { file_path: ".env.local", content: "GATEWAY_URL=https://example.invalid" } }],
	["subagent-spawn-guard.js", { tool_name: "Task", tool_input: { prompt: "example" } }, { tool_name: "Read", tool_input: { file_path: "example" } }],
];

for (const [name, denied, allowed] of cases) {
	test(`${name}: real stdin blocks and passes from a role folder and repository`, async (t) => {
		const { role, adk, deploymentHook } = fixture(t);
		const roleHook = name === "deploy-guard.js" ? deploymentHook : null;
		assert.deepEqual(fs.readdirSync(role), [".naia-role.json"]);
		assert.equal((await run(name, role, denied, adk, roleHook))?.decision, "block", "role dangerous input");
		assert.equal((await run(name, role, allowed, adk, roleHook)), null, "role routine input");
		const missingRoot = await run(name, role, denied, "", roleHook);
		assert.equal(missingRoot?.decision || null, name === "commit-guard.js" ? null : "block", "role follows shared policy without a central root");
		// The GCS engine's legacy policy path is next to the hook. Replay that
		// repository arrangement without editing the checkout's actual policy.
		let hookPath = roleHook;
		if (name === "gcs-guard.js") {
			hookPath = path.join(adk, ".claude/hooks", name);
			fs.copyFileSync(path.join(__dirname, name), hookPath);
		}
		assert.equal((await run(name, adk, denied, "", hookPath))?.decision, "block", "repository dangerous input");
		assert.equal((await run(name, adk, allowed, "", hookPath)), null, "repository routine input");
		assert.equal((await run(name, adk, denied, adk, roleHook))?.decision, "block", "repository remains protected with profile env");
		assert.equal((await run(name, adk, allowed, adk, roleHook)), null, "repository routine input with profile env");
	});

	test(`${name}: env alone preserves ed3a30e8 decisions with no ADK progress or policy`, async (t) => {
		const { base, adk } = fixture(t);
		const repository = path.join(base, "repository");
		fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
		fs.unlinkSync(path.join(adk, ".agents/progress/work.json"));
		fs.unlinkSync(path.join(adk, ".claude/hooks/gcs-guard.config.json"));
		for (const helper of ["_claude-bash-guard.js", "_claude-edit-hook.js"]) {
			fs.copyFileSync(path.join(__dirname, helper), path.join(adk, ".claude/hooks", helper));
		}
		write(path.join(adk, ".agents/hooks/policies/edit.js"),
			`module.exports = require(${JSON.stringify(path.resolve(__dirname, "../../.agents/hooks/policies/edit.js"))});\n`);
		write(path.join(adk, ".agents/hooks/core/remote-identity.js"),
			`module.exports = require(${JSON.stringify(path.resolve(__dirname, "../../.agents/hooks/core/remote-identity.js"))});\n`);
		const baseline = baselineHook(adk, name);
		const current = path.join(adk, ".claude/hooks", name);
		fs.copyFileSync(path.join(__dirname, name), current);
		for (const cwd of [repository, adk]) {
			for (const payload of [denied, allowed]) {
				const expected = stableDecision(await run(name, cwd, payload, "", baseline));
				assert.deepEqual(stableDecision(await run(name, cwd, payload, adk, current)), expected, `${cwd === adk ? "ADK" : "other repository"}: env-only matches baseline`);
				assert.deepEqual(stableDecision(await run(name, cwd, payload, "", current)), expected, "no env or role matches baseline");
			}
		}
		if (name === "commit-guard.js") {
			assert.equal(await run(name, repository, bash("git commit -m x"), adk, current), null, "empty ADK progress never blocks another repository");
		}
		if (name === "subagent-spawn-guard.js") {
			write(path.join(repository, ".claude/allow-subagents"), { maxSpawns: 1 });
			assert.equal(await run(name, repository, denied, "", baseline), null);
			assert.equal(await run(name, repository, denied, adk, current), null);
			assert.equal(fs.existsSync(path.join(repository, ".claude/subagent-budget")), false, "env alone retains temporary counters");
		}
	});
}

test("role detection follows CLAUDE_PROJECT_DIR before payload cwd and process cwd", async (t) => {
	const { base, role, adk } = fixture(t);
	const repository = path.join(base, "repository");
	fs.mkdirSync(repository, { recursive: true });
	const absent = path.join(base, "absent");
	const projectRole = { CLAUDE_PROJECT_DIR: role };
	const projectRepository = { CLAUDE_PROJECT_DIR: repository };
	assert.equal((await run("commit-guard.js", repository, bash("git commit -m x"), adk, null, projectRole))?.decision, "block");
	assert.equal(await run("commit-guard.js", role, bash("git commit -m x"), adk, null, projectRepository), null);
	assert.equal((await run("gcs-guard.js", repository, bash("gsutil ls gs://example-prod"), absent, null, projectRole))?.decision, "block");
	assert.equal(await run("gcs-guard.js", role, bash("gsutil ls gs://example-prod"), absent, null, projectRepository), null);
	assert.equal((await run("remote-identity-gate.js", repository, bash("git push origin main"), absent, null, projectRole))?.decision, "block");
	assert.equal(await run("remote-identity-gate.js", role, bash("git push origin main"), absent, null, projectRepository), null);
	for (const [name, payload] of [
		["commit-guard.js", bash("git commit -m x")],
		["gcs-guard.js", bash("gsutil ls gs://example-prod")],
		["remote-identity-gate.js", bash("git push origin main")],
	]) {
		assert.equal(await run(name, repository, { ...payload, cwd: role }, absent, null, { CLAUDE_PROJECT_DIR: "" }), null,
			`${name}: payload cwd does not select role mode when project dir is unset`);
	}
	write(path.join(role, ".claude/allow-subagents"), { maxSpawns: 1 });
	assert.equal(await run("subagent-spawn-guard.js", repository, { tool_name: "Task" }, adk, null, projectRole), null);
	assert.equal(fs.existsSync(path.join(role, ".claude/subagent-budget/profile-test.json")), true);
	assert.equal((await run("subagent-spawn-guard.js", repository, { tool_name: "Task" }, adk, null, projectRepository))?.decision, "block");
	assert.equal((await run("commit-guard.js", role, bash("git commit -m x"), adk, null, { CLAUDE_PROJECT_DIR: "" }))?.decision, "block", "unset project dir falls back to process cwd");
});

test("role commit guard delegates absent, invalid, empty and new-phase progress to shared policy", async (t) => {
	const { base, role, adk } = fixture(t);
	for (const root of [path.join(base, "absent"), adk]) {
		if (root === adk) write(path.join(adk, ".agents/progress/work.json"), "{");
		assert.equal(await run("commit-guard.js", role, bash("git commit -m example"), root), null);
		assert.equal((await run("commit-guard.js", role, bash("ls"), root)), null);
	}
	fs.unlinkSync(path.join(adk, ".agents/progress/work.json"));
	assert.equal(await run("commit-guard.js", role, bash("git commit -m example"), adk), null);
	for (const phase of ["p01", "p06", "p11"]) {
		write(path.join(adk, ".agents/progress/work.json"), { current_phase: phase });
		assert.equal(await run("commit-guard.js", role, bash("git commit -m example"), adk), null, `shared policy accepts ${phase}`);
	}
	write(path.join(adk, ".agents/progress/work.json"), { current_phase: "build" });
	assert.equal((await run("commit-guard.js", role, bash("git commit -m example"), adk))?.decision, "block", "shared build phase still blocks");
	write(path.join(adk, ".agents/progress/work.json"), { current_phase: "commit" });
	assert.equal((await run("commit-guard.js", role, bash("git commit -m example"), adk)), null);
	write(path.join(role, ".agents/progress/work.json"), { current_phase: "build" });
	assert.equal(await run("commit-guard.js", role, bash("git commit -m example"), adk), null, "role evaluates the declared ADK root only");
});

test("role deployment remains blocked with absent policy and approval records", async (t) => {
	const { base, role, deploymentHook } = fixture(t);
	assert.equal((await run("deploy-guard.js", role, bash("vercel --prod"), path.join(base, "absent"), deploymentHook))?.decision, "block");
	assert.equal((await run("deploy-guard.js", role, bash("ls"), path.join(base, "absent"), deploymentHook)), null);
});

test("role deployment reads and consumes approval at the central ADK root", async (t) => {
	const { role, adk, deploymentHook } = fixture(t);
	write(path.join(adk, ".claude/deploy/config.json"), { projects: { sample: { platform: "gcloud", dev_service: "sample-dev" } } });
	const record = path.join(adk, ".claude/deploy/approvals.json");
	write(record, { approvals: [{
		project: "sample", approved_by: "example-owner", approved_at: new Date().toISOString(),
		expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), single_use: true,
	}] });
	const payload = bash("gcloud run deploy sample");
	assert.equal((await run("deploy-guard.js", role, payload, adk, deploymentHook)), null);
	assert.deepEqual(JSON.parse(fs.readFileSync(record, "utf8")).approvals, []);
	assert.equal((await run("deploy-guard.js", role, payload, adk, deploymentHook))?.decision, "block");
	assert.equal((await run("deploy-guard.js", role, bash("gcloud run deploy sample-dev"), adk, deploymentHook)), null);
	assert.ok(fs.readFileSync(path.join(adk, ".claude/deploy/audit.jsonl"), "utf8").includes("approval_consumed"));
	assert.deepEqual(fs.readdirSync(role), [".naia-role.json"]);
});

test("role GCS guard fails closed on absent or invalid central policy", async (t) => {
	const { base, role, adk } = fixture(t);
	for (const root of [path.join(base, "absent"), adk]) {
		if (root === adk) write(path.join(adk, ".claude/hooks/gcs-guard.config.json"), "{");
		assert.equal((await run("gcs-guard.js", role, bash("gsutil cp ./object gs://example-prod/object"), root))?.decision, "block");
		assert.equal((await run("gcs-guard.js", role, bash("ls"), root)), null);
	}
});

test("role remote guard refuses missing central policy and preserves the git target cwd", async (t) => {
	const { base, role, adk } = fixture(t);
	assert.equal((await run("remote-identity-gate.js", role, bash("git push origin main"), path.join(base, "absent")))?.decision, "block");
	assert.equal((await run("remote-identity-gate.js", role, bash("git status"), path.join(base, "absent"))), null);
	assert.equal((await run("remote-identity-gate.js", role, bash("echo git push origin main"), path.join(base, "absent"))), null);
	assert.equal((await run("remote-identity-gate.js", role, bash("gh repo edit example/sample --visibility PUBLIC"), path.join(base, "absent")))?.decision, "block");
	assert.equal((await run("remote-identity-gate.js", role, bash("gh repo edit example/sample --visibility=PUBLIC"), path.join(base, "absent")))?.decision, "block");
	write(path.join(adk, ".agents/context/project-index.yaml"), "submodules:\n  example:\n    path: projects/example\n    repo: example/expected\n");
	const target = path.join(adk, "projects/example");
	fs.mkdirSync(path.join(target, ".git"), { recursive: true });
	const command = `git -C "${target}" remote set-url origin https://github.com/example/wrong.git`;
	assert.equal((await run("remote-identity-gate.js", role, bash(command), adk))?.decision, "block");
	assert.equal((await run("remote-identity-gate.js", adk, bash(command)))?.decision, "block");
	assert.equal((await run("remote-identity-gate.js", role, bash(command.replace("remote set-url", "remote --verbose set-url")), adk))?.decision, "block");
	const anotherAdk = path.join(base, "another-adk");
	write(path.join(anotherAdk, ".agents/context/project-index.yaml"), "submodules: {}\n");
	write(path.join(anotherAdk, ".agents/context/agents-rules.json"), {});
	assert.equal((await run("remote-identity-gate.js", role, bash(command), anotherAdk))?.decision, "block", "a central empty catalogue cannot bypass the target repository's identity policy");
	const external = path.join(base, "external");
	fs.mkdirSync(path.join(external, ".git"), { recursive: true });
	write(path.join(adk, ".agents/context/project-index.yaml"), "submodules:\n  example:\n    path: ../external\n    repo: example/expected\n");
	const externalCommand = `git -C "${external}" remote set-url origin https://github.com/example/wrong.git`;
	assert.equal((await run("remote-identity-gate.js", adk, bash(externalCommand), anotherAdk))?.decision, "block", "the original cwd catalogue still protects targets outside that workspace");
});

test("role public-repository approval and audit stay in the central ADK root", async (t) => {
	const { role, adk } = fixture(t);
	const record = path.join(adk, ".agents/work/public-repository-approval.json");
	write(record, {
		operation: "create_public", repo: "example/sample", reason: "test fixture", approved_by: "example-owner",
		expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
	});
	const payload = bash("gh repo create example/sample --public");
	assert.equal((await run("remote-identity-gate.js", role, payload, adk)), null);
	assert.ok(JSON.parse(fs.readFileSync(record, "utf8")).consumed_at);
	assert.ok(fs.readFileSync(path.join(adk, ".agents/work/public-repository-audit.jsonl"), "utf8").includes("create_public"));
	assert.equal((await run("remote-identity-gate.js", role, payload, adk))?.decision, "block", "approval is single-use");
	assert.deepEqual(fs.readdirSync(role), [".naia-role.json"]);
});

test("subagent counters are isolated between two roles with the same session id", async (t) => {
	const { base, role, adk } = fixture(t);
	const other = path.join(base, "other-role");
	write(path.join(other, ".naia-role.json"), { read: [] });
	const payload = { tool_name: "Task", tool_input: { prompt: "example" } };
	for (const dir of [role, other]) write(path.join(dir, ".claude/allow-subagents"), { maxSpawns: 1 });
	assert.equal((await run("subagent-spawn-guard.js", role, payload, adk)), null);
	assert.equal((await run("subagent-spawn-guard.js", role, payload, adk))?.decision, "block");
	assert.equal((await run("subagent-spawn-guard.js", other, payload, adk)), null, "another role has its own budget");
	assert.equal((await run("subagent-spawn-guard.js", other, payload, adk))?.decision, "block");
	for (const dir of [role, other]) {
		const state = JSON.parse(fs.readFileSync(path.join(dir, ".claude/subagent-budget/profile-test.json"), "utf8"));
		assert.equal(state.spawns, 1);
	}
	assert.equal(fs.existsSync(path.join(adk, ".claude/subagent-budget")), false);
});

test("only role adapters fail closed when shared policy code is missing or broken", async (t) => {
	const { base, role, adk } = fixture(t);
	for (const name of ["commit-guard.js", "deploy-guard.js", "prod-gateway-guard.js", "remote-identity-gate.js"]) {
		const brokenRoot = path.join(base, name.replace(/\.js$/, ""));
		const copiedHook = path.join(brokenRoot, ".claude/hooks", name);
		write(copiedHook, fs.readFileSync(path.join(__dirname, name), "utf8"));
		for (const helper of ["_claude-bash-guard.js", "_claude-edit-hook.js"]) {
			fs.copyFileSync(path.join(__dirname, helper), path.join(brokenRoot, ".claude/hooks", helper));
		}
		const payload = cases.find(([hook]) => hook === name)[1];
		assert.equal((await run(name, role, payload, adk, copiedHook))?.decision, "block", `${name}: profile loader fails closed`);
		assert.equal((await run(name, role, payload, "", copiedHook))?.decision, "block", `${name}: role marker fails closed`);
		assert.equal((await run(name, adk, payload, adk, copiedHook, { CLAUDE_PROJECT_DIR: role }))?.decision, "block", `${name}: project role takes priority over cwd`);
		if (name !== "remote-identity-gate.js") {
			assert.equal(await run(name, adk, payload, adk, copiedHook), null, `${name}: profile env preserves legacy loader failure`);
			assert.equal(await run(name, role, payload, adk, copiedHook, { CLAUDE_PROJECT_DIR: adk }), null, `${name}: project repository ignores cwd role marker`);
			assert.equal(await run(name, adk, payload, "", copiedHook), null, `${name}: legacy repository fallback is preserved`);
		} else {
			assert.equal(await run(name, adk, payload, adk, copiedHook, {}, 1), null, "profile env preserves legacy remote loader exit");
			assert.equal(await run(name, role, payload, adk, copiedHook, { CLAUDE_PROJECT_DIR: adk }, 1), null, "project repository ignores cwd role marker for remote loader");
			const legacyExit = await new Promise((resolve, reject) => {
				const child = spawn(process.execPath, [copiedHook], {
					cwd: adk, env: { ...process.env, NAIA_ADK_ROOT: "", CLAUDE_PROJECT_DIR: adk }, stdio: "ignore",
				});
				const timer = setTimeout(() => { child.kill(); reject(new Error("legacy remote loader timed out")); }, 10000);
				child.on("error", error => { clearTimeout(timer); reject(error); });
				child.on("close", code => { clearTimeout(timer); resolve(code); });
			});
			assert.equal(legacyExit, 1, "legacy missing remote module still fails as before");
		}
		const policyFile = name === "remote-identity-gate.js" ? ".agents/hooks/core/remote-identity.js"
			: name === "prod-gateway-guard.js" ? ".agents/hooks/policies/edit.js" : ".agents/hooks/policies/bash.js";
		write(path.join(brokenRoot, policyFile), "this is invalid JavaScript");
		assert.equal((await run(name, role, payload, adk, copiedHook))?.decision, "block", `${name}: broken shared code fails closed`);
	}
});
