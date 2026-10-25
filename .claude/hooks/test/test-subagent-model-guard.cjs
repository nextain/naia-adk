const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const guard = require("../subagent-model-guard.cjs");

const tempBase = path.resolve(process.env.TMPDIR || os.tmpdir());
fs.mkdirSync(tempBase, { recursive: true });
const suiteRoot = fs.mkdtempSync(path.join(tempBase, "subagent-model-guard-"));
const guardPath = path.resolve(__dirname, "../subagent-model-guard.cjs");
const fixedNow = Date.parse("2026-10-26T00:00:00.000Z");
const validPrompt = "상위 목표: 긴급한 경우에만 상위 모델을 사용한다.\n막히면 올림: 범위 밖 변경은 중단하고 보고한다.";
let passed = 0;

function fixture(name, { policy, override, homePolicy } = {}) {
	const root = path.join(suiteRoot, name);
	const claudeDir = path.join(root, ".claude");
	const home = path.join(root, "home");
	fs.mkdirSync(claudeDir, { recursive: true });
	if (policy !== undefined) {
		fs.writeFileSync(path.join(claudeDir, "subagent-model-policy.json"), typeof policy === "string" ? policy : JSON.stringify(policy));
	}
	else if (override !== undefined) fs.writeFileSync(path.join(claudeDir, "subagent-model-policy.json"), "{}");
	if (override !== undefined) fs.writeFileSync(path.join(claudeDir, "allow-upper-subagent-until"), override);
	if (homePolicy !== undefined) {
		const homeClaude = path.join(home, ".claude");
		fs.mkdirSync(homeClaude, { recursive: true });
		fs.writeFileSync(path.join(homeClaude, "subagent-model-policy.json"), typeof homePolicy === "string" ? homePolicy : JSON.stringify(homePolicy));
	}
	return { root, home };
}


function evaluate(fixtureValue, options = {}) {
	const toolName = options.toolName || "Task";
	const model = Object.hasOwn(options, "model") ? options.model : "sonnet";
	const prompt = Object.hasOwn(options, "prompt") ? options.prompt : validPrompt;
	const subagentType = options.subagentType;
	const env = options.env || {};
	const now = options.now ?? fixedNow;
	return guard.evaluate({
		toolName,
		toolInput: { model, prompt, subagent_type: subagentType },
		cwd: fixtureValue.root,
		home: fixtureValue.home,
		env: { HOME: fixtureValue.home, ...env },
		now,
	});
}

function check(condition, message) {
	assert.ok(condition, message);
	passed += 1;
}

function checkBlocked(result, message) {
	check(Boolean(result?.reason), message);
	check(result.reason.startsWith("[SUBAGENT MODEL GUARD]"), `${message}: block reason should use the standard prefix`);
}

function runCli(input, env = {}) {
	return spawnSync(process.execPath, [guardPath], {
		input,
		encoding: "utf8",
		env: { PATH: process.env.PATH || "", HOME: path.join(suiteRoot, "cli-home"), ...env },
	});
}

try {
	check(JSON.stringify(guard.DEFAULT_POLICY) === JSON.stringify({
		allowedModels: ["haiku", "sonnet"],
		requireExplicitModel: true,
		requireBrief: true,
		overrideFile: "allow-upper-subagent-until",
		maxOverrideHours: 24,
	}), "default policy should match the user-level guard defaults");

	const missingModel = fixture("missing-model");
	checkBlocked(evaluate(missingModel, { model: undefined }), "missing model must block by default");
	check(/haiku\/sonnet/u.test(evaluate(missingModel, { model: "opus" }).reason), "disallowed-model reason should give allowed model names");
	check(evaluate(missingModel, { model: "Sonnet" }) === null, "sonnet should pass case-insensitively");
	check(evaluate(missingModel, { model: "HAIKU" }) === null, "haiku should pass case-insensitively");

	const fork = evaluate(missingModel, { model: "sonnet", subagentType: "fork" });
	checkBlocked(fork, "fork should block without an exception marker");
	check(/부모 모델을 그대로 물려받습니다/u.test(fork.reason), "fork block should explain model inheritance");

	const allowedOverride = fixture("fork-override", { override: "2026-10-26T01:00:00.000Z\n" });
	const forkOverride = evaluate(allowedOverride, { model: "opus", subagentType: "fork" });
	check(Boolean(forkOverride?.stderr) && /3600초 남음/u.test(forkOverride.stderr), "active override should permit a fork and report remaining time");

	const workflow = evaluate(missingModel, { toolName: "Workflow" });
	checkBlocked(workflow, "Workflow should block without an exception marker");
	const workflowOverride = evaluate(allowedOverride, { toolName: "wOrKfLoW" });
	check(Boolean(workflowOverride?.stderr), "active exception should permit Workflow case-insensitively");

	const missingBrief = fixture("missing-brief", { override: "2026-10-26T01:00:00.000Z\n" });
	const noGoal = evaluate(missingBrief, { prompt: "막히면 올림: 중단하고 보고한다." });
	checkBlocked(noGoal, "missing upper-goal line must block even with an override marker");
	check(/상위 목표:/u.test(noGoal.reason) && /긴급 예외 표지로도/u.test(noGoal.reason), "brief block should name the missing line and override limitation");
	checkBlocked(evaluate(missingBrief, { prompt: "상위 목표: 비용을 줄인다." }), "missing escalation line must block");

	const expired = fixture("expired-override", { override: "2026-10-25T23:59:59.999Z\n" });
	checkBlocked(evaluate(expired, { model: "opus" }), "expired override should not permit a disallowed model");
	const tooFar = fixture("too-far-override", { override: "2026-10-27T01:00:00.000Z\n" });
	checkBlocked(evaluate(tooFar, { model: "opus" }), "override beyond the 24-hour default should be invalid");
	const multiline = fixture("multiline-override", { override: "2026-10-26T01:00:00.000Z\nsecond line\n" });
	checkBlocked(evaluate(multiline, { model: "opus" }), "multi-line override should be invalid");
	const malformedTime = fixture("malformed-time", { override: "next week\n" });
	checkBlocked(evaluate(malformedTime, { model: "opus" }), "non-ISO override should be invalid");
	check(guard.readOverride(path.join(expired.root, ".claude", "allow-upper-subagent-until"), fixedNow, 24).state === "expired", "expired marker state should be exposed to tests");
	check(guard.readOverride(path.join(tooFar.root, ".claude", "allow-upper-subagent-until"), fixedNow, 24).state === "too_far", "overlong marker state should be exposed to tests");

	const mixed = fixture("mixed-models", { policy: { allowedModels: ["haiku", 42, " SONNET ", ""] } });
	check(evaluate(mixed, { model: "sonnet" }) === null, "mixed model lists should retain valid strings only");
	checkBlocked(evaluate(mixed, { model: "opus" }), "mixed model list should still reject unlisted models");
	const noValidModels = fixture("no-valid-models", { policy: { allowedModels: [42, null, " "] } });
	check(evaluate(noValidModels, { model: "haiku" }) === null, "model list with no valid strings should use defaults");
	const brokenPolicy = fixture("broken-policy", { policy: "{ broken json" });
	check(evaluate(brokenPolicy, { model: "haiku" }) === null, "broken policy should use all default fields");
	checkBlocked(evaluate(brokenPolicy, { model: "opus" }), "broken policy should not allow an upper model");

	const fieldFallback = fixture("field-fallback", {
		policy: { allowedModels: ["custom"], requireExplicitModel: "false", requireBrief: 4, overrideFile: "../outside", maxOverrideHours: 0 },
	});
	const normalized = guard.readPolicy({ cwd: fieldFallback.root, home: fieldFallback.home, env: { HOME: fieldFallback.home } });
	check(normalized.allowedModels[0] === "custom", "valid policy fields should survive unrelated invalid fields");
	check(normalized.requireExplicitModel === true && normalized.requireBrief === true, "invalid booleans should default by field");
	check(normalized.overrideFile === "allow-upper-subagent-until" && normalized.maxOverrideHours === 24, "invalid override fields should default by field");

	const disabled = fixture("disabled");
	for (const value of ["off", "0", "false", "no"]) {
		check(evaluate(disabled, { model: "opus", env: { CLAUDE_SUBAGENT_MODEL_GUARD: value } }) === null, `off value ${value} should pass through`);
	}
	check(evaluate(disabled, { toolName: "Read", model: "opus" }) === null, "non-target tool should pass through");
	check(evaluate(disabled, { toolName: "AGENT", model: "haiku" }) === null, "target tool matching should ignore case");

	const projectPolicy = fixture("project-policy", { policy: { allowedModels: ["project"] }, homePolicy: { allowedModels: ["home"] } });
	check(evaluate(projectPolicy, { model: "project" }) === null, "nearest project policy should precede the home policy");
	checkBlocked(evaluate(projectPolicy, { model: "home" }), "home policy should not replace a nearer project policy");
	const homeFallback = fixture("home-fallback", { homePolicy: { allowedModels: ["home"] } });
	check(evaluate(homeFallback, { model: "home" }) === null, "home policy should be used when no project policy exists");
	const envPolicyPath = path.join(suiteRoot, "env-policy.json");
	fs.writeFileSync(envPolicyPath, JSON.stringify({ allowedModels: ["environment"] }));
	check(evaluate(projectPolicy, { model: "environment", env: { CLAUDE_SUBAGENT_MODEL_POLICY: envPolicyPath } }) === null, "environment policy path should precede project policy");
	checkBlocked(evaluate(projectPolicy, { model: "project", env: { CLAUDE_SUBAGENT_MODEL_POLICY: envPolicyPath } }), "environment policy should replace lower-precedence policies");
	const envPolicyClaude = path.join(suiteRoot, ".claude");
	fs.mkdirSync(envPolicyClaude, { recursive: true });
	fs.writeFileSync(path.join(envPolicyClaude, "allow-upper-subagent-until"), "2026-10-26T01:00:00.000Z\n");
	check(Boolean(evaluate(projectPolicy, { model: "opus", env: { CLAUDE_SUBAGENT_MODEL_POLICY: envPolicyPath } })?.stderr), "an environment policy should use the sibling .claude override marker");
	const longerOverride = fixture("longer-override", { policy: { allowedModels: ["haiku"], overrideFile: "urgent-until", maxOverrideHours: 30 } });
	fs.writeFileSync(path.join(longerOverride.root, ".claude", "urgent-until"), "2026-10-27T02:00:00.000Z\n");
	check(Boolean(evaluate(longerOverride, { model: "opus" })?.stderr), "configured override name and duration should be honored");

	const invalidJson = runCli("{broken");
	check(invalidJson.status === 0 && invalidJson.stdout === "" && invalidJson.stderr === "", "invalid hook JSON should pass silently");
	const unrelatedCli = runCli(JSON.stringify({ tool_name: "Read", tool_input: { model: "opus" } }));
	check(unrelatedCli.status === 0 && unrelatedCli.stdout === "" && unrelatedCli.stderr === "", "non-target hook tools should pass silently");
	const cliHome = path.join(suiteRoot, "cli-home");
	const cliProject = fixture("cli-project");
	const cliBlock = runCli(JSON.stringify({ tool_name: "Task", tool_input: { model: "opus", prompt: validPrompt }, cwd: cliProject.root }), { HOME: cliProject.home });
	check(cliBlock.status === 0 && cliBlock.stderr === "", "model block should exit zero without stderr");
	const envelope = JSON.parse(cliBlock.stdout);
	check(envelope.decision === "block" && envelope.reason.startsWith("[SUBAGENT MODEL GUARD]"), "model block should use the Claude hook JSON envelope");
	const cliOverrideHome = path.join(suiteRoot, "cli-override-home");
	fs.mkdirSync(path.join(cliOverrideHome, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(cliOverrideHome, ".claude", "allow-upper-subagent-until"), new Date(Date.now() + 60_000).toISOString() + "\n");
	const cliOverride = runCli(JSON.stringify({ tool_name: "Task", tool_input: { model: "opus", prompt: validPrompt }, cwd: suiteRoot }), { HOME: cliOverrideHome });
	check(cliOverride.status === 0 && cliOverride.stdout === "", "active CLI exception should leave stdout unblocked");
	check(/^\[SUBAGENT MODEL GUARD\] 긴급 예외 표지 활성 — .*초 남음 \(.*Z\)\.\n$/u.test(cliOverride.stderr), "active CLI exception should report remaining time on stderr");
	const cliDisabled = runCli(JSON.stringify({ tool_name: "Workflow" }), { CLAUDE_SUBAGENT_MODEL_GUARD: "false" });
	check(cliDisabled.status === 0 && cliDisabled.stdout === "" && cliDisabled.stderr === "", "disabled CLI guard should pass silently");
	check(fs.existsSync(cliHome) === false, "malformed and unrelated CLI inputs should not create home files");

	console.log(`subagent model guard tests passed (${passed} checks)`);
} finally {
	fs.rmSync(suiteRoot, { recursive: true, force: true });
}
