require("../../scripts/test-signal-safety.cjs");
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
// Keep every fixture under the system temporary folder, never beside the checkout.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "naia-user-guards-"));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const hookDirectory = path.join(root, "templates/claude-user-profile/hooks");
function fixture() {
  const home = fs.mkdtempSync(path.join(scratch, "user-guards-"));
  const config = path.join(home, ".claude");
  const role = path.join(home, "role");
  fs.mkdirSync(config);
  fs.mkdirSync(role);
  fs.writeFileSync(path.join(role, ".naia-role.json"), JSON.stringify({ role: "worker", read: [] }));
  return { home, config, role };
}
async function invoke(name, input, fixture, extraEnv = {}, args = []) {
  // Supply only fixture-owned paths. No real credentials, meter or transcript
  // can be reached through an inherited Claude environment.
  const io = fs.mkdtempSync(path.join(fixture.home, "hook-io-"));
  const inputFile = path.join(io, "stdin.json");
  const outputFile = path.join(io, "stdout.json");
  const errorFile = path.join(io, "stderr.txt");
  fs.writeFileSync(inputFile, typeof input === "string" ? input : JSON.stringify(input));
  const descriptors = [];
  let result;
  try {
    descriptors.push(fs.openSync(inputFile, "r"));
    descriptors.push(fs.openSync(outputFile, "w"));
    descriptors.push(fs.openSync(errorFile, "w"));
    result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(hookDirectory, name), ...args], {
        cwd: fixture.role,
        env: { PATH: process.env.PATH, HOME: fixture.home, CLAUDE_CONFIG_DIR: fixture.config, CLAUDE_PROJECT_DIR: fixture.role, ...extraEnv },
        stdio: descriptors,
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`hook timed out: ${name}`));
      }, 10000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", (status, signal) => { clearTimeout(timer); resolve({ status, signal }); });
    });
  } finally {
    for (const descriptor of descriptors) fs.closeSync(descriptor);
  }
  const stdout = fs.readFileSync(outputFile, "utf8");
  const stderr = fs.readFileSync(errorFile, "utf8");
  assert.equal(result.status, 0, stderr);
  return stdout.trim() ? JSON.parse(stdout) : null;
}

test("cost guard blocks missing, malformed and invalid policies on every registered event", async () => {
  const f = fixture();
  const policy = path.join(f.config, "cost-guard/policy.json");
  const events = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Stop", "PreCompact"];
  for (const state of ["missing", "malformed", "invalid"]) {
    if (state !== "missing") {
      fs.mkdirSync(path.dirname(policy), { recursive: true });
      fs.writeFileSync(policy, state === "malformed" ? "{" : "{}");
    }
    for (const event of events) {
      const out = await invoke("cost-guard.cjs", { hook_event_name: event, session_id: "test", prompt: "continue" }, f, { NAIA_COST_GUARD_POLICY: policy }, [event]);
      if (event === "PreCompact") assert.equal(out.decision, "block");
      else assert.equal(out.continue, false);
    }
  }
});

test("cost guard preserves verified account blocks and permits matching fixture account", async () => {
  const f = fixture();
  const policyFile = path.join(f.config, "cost-guard/policy.json");
  const meterFile = path.join(path.dirname(policyFile), "meter.json");
  fs.mkdirSync(path.dirname(policyFile), { recursive: true });
  const policy = { configDir: f.config, expectedEmail: "account@example.invalid" };
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  fs.writeFileSync(path.join(f.config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token" } }));
  const meter = {
    schema_version: 1, checked_at: Date.now() / 1000, config_dir: f.config,
    credential_fingerprint: crypto.createHash("sha256").update("fixture-token").digest("hex"),
    account_email: "other@example.invalid",
    quota: { status: "known", windows: { five_hour: { utilization: 5 }, seven_day: { utilization: 5 } } },
    host_activity: { status: "known", responses_hour: 0, processing_tokens_10m: 0, observed_messages: {} },
  };
  fs.writeFileSync(meterFile, JSON.stringify(meter));
  const input = { hook_event_name: "UserPromptSubmit", session_id: "test-account", prompt: "continue", transcript_path: path.join(f.home, "empty.jsonl") };
  const blocked = await invoke("cost-guard.cjs", input, f, { NAIA_COST_GUARD_POLICY: policyFile }, ["UserPromptSubmit"]);
  assert.equal(blocked.continue, false);
  meter.account_email = policy.expectedEmail;
  fs.writeFileSync(meterFile, JSON.stringify(meter));
  const allowed = await invoke("cost-guard.cjs", input, f, { NAIA_COST_GUARD_POLICY: policyFile }, ["UserPromptSubmit"]);
  assert.notEqual(allowed?.continue, false);
  assert.notEqual(allowed?.decision, "block");
});

test("cost guard checks an oversized tool result without halting and still halts an oversized prompt", async () => {
  const f = fixture();
  const policy = path.join(f.config, "cost-guard/policy.json");
  const image = "A".repeat(200 * 1024);
  const tool = { session_id: "large-tool", transcript_path: path.join(f.home, "empty.jsonl"), hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/x.png" }, tool_response: { type: "image", file: { base64: image } } };
  const missing = await invoke("cost-guard.cjs", tool, f, { NAIA_COST_GUARD_POLICY: policy }, ["PostToolUse"]);
  assert.equal(missing.continue, false);
  assert.doesNotMatch(missing.stopReason, /크기 제한/);
  fs.mkdirSync(path.dirname(policy), { recursive: true });
  fs.writeFileSync(policy, JSON.stringify({ configDir: f.config, expectedEmail: "account@example.invalid" }));
  const checked = await invoke("cost-guard.cjs", tool, f, { NAIA_COST_GUARD_POLICY: policy }, ["PostToolUse"]);
  assert.notEqual(checked?.continue, false);
  const prompt = { hook_event_name: "UserPromptSubmit", session_id: "large-prompt", prompt: image };
  const halted = await invoke("cost-guard.cjs", prompt, f, { NAIA_COST_GUARD_POLICY: policy }, ["UserPromptSubmit"]);
  assert.match(halted.stopReason, /크기 제한/);
});

test("cost guard blocks template and nested placeholders on every registered event", async () => {
  const f = fixture();
  const policyFile = path.join(f.config, "cost-guard/policy.json");
  fs.mkdirSync(path.dirname(policyFile), { recursive: true });
  const example = JSON.parse(fs.readFileSync(path.join(root, "templates/claude-user-profile/cost-guard.policy.example.json"), "utf8"));
  for (const policy of [example, { configDir: f.config, expectedEmail: "{{ACCOUNT}}@example.invalid" }, { configDir: f.config, expectedEmail: "account@example.invalid", extraEmails: ["{{SECOND_ACCOUNT}}"] }]) {
    fs.writeFileSync(policyFile, JSON.stringify(policy));
    for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Stop", "PreCompact"]) {
      const out = await invoke("cost-guard.cjs", { hook_event_name: event, session_id: "placeholder", prompt: "continue" }, f, { NAIA_COST_GUARD_POLICY: policyFile }, [event]);
      if (event === "PreCompact") assert.equal(out.decision, "block");
      else assert.equal(out.continue, false);
    }
  }
});

test("RunPod guard asks for every original creation or loop pattern and passes a read", async () => {
  const f = fixture();
  for (const command of ["runpodctl pod create --gpu test", "runpod api pod create", "./auto-validate.sh", "./retry-validate.sh", "nohup ./start-pod.sh", "runpodctl get pods &", "for i in 1 2; do pod create; done"]) {
    const out = await invoke("guard-runpod-create.cjs", { tool_name: "Bash", tool_input: { command } }, f);
    assert.equal(out.hookSpecificOutput.permissionDecision, "ask", command);
  }
  assert.equal((await invoke("guard-runpod-create.cjs", { tool_name: "Bash", tool_input: { command: "runpodctl get pods" } }, f)), null);
});

test("subagent model guard blocks missing or corrupt policy and preserves model and brief checks", async () => {
  const f = fixture();
  const policy = path.join(f.config, "subagent-model-policy.json");
  const env = { NAIA_SUBAGENT_MODEL_POLICY: policy };
  const valid = { tool_name: "Agent", tool_input: { model: "sonnet", prompt: "상위 목표: inspect\n막히면 올림: report" } };
  assert.equal((await invoke("subagent-model-guard.cjs", valid, f, env)).decision, "block");
  fs.writeFileSync(policy, "{");
  assert.equal((await invoke("subagent-model-guard.cjs", valid, f, env)).decision, "block");
  fs.copyFileSync(path.join(root, "templates/claude-user-profile/subagent-model.policy.example.json"), policy);
  for (const tool_name of ["Task", "Agent"]) {
    assert.equal((await invoke("subagent-model-guard.cjs", { ...valid, tool_name }, f, env)), null);
    for (const tool_input of [
      { prompt: valid.tool_input.prompt }, { model: "opus", prompt: valid.tool_input.prompt },
      { model: "sonnet", prompt: "no required brief" },
      { model: "sonnet", prompt: valid.tool_input.prompt, subagent_type: "fork" },
    ]) assert.equal((await invoke("subagent-model-guard.cjs", { tool_name, tool_input }, f, env)).decision, "block");
  }
  assert.equal((await invoke("subagent-model-guard.cjs", { tool_name: "Workflow" }, f, env)).decision, "block");
  assert.equal((await invoke("subagent-model-guard.cjs", { tool_name: "Bash", tool_input: { command: "ls" } }, f, env)), null);
});

test("subagent model override keeps brief mandatory and refuses expiry outside its window", async () => {
  const f = fixture();
  const policy = path.join(f.config, "subagent-model-policy.json");
  fs.copyFileSync(path.join(root, "templates/claude-user-profile/subagent-model.policy.example.json"), policy);
  const marker = path.join(f.config, "allow-upper-subagent-until");
  const env = { NAIA_SUBAGENT_MODEL_POLICY: policy };
  const input = { tool_name: "Agent", tool_input: { model: "opus", prompt: "상위 목표: inspect\n막히면 올림: report" } };
  for (const expires of [Date.now() - 60000, Date.now() + 25 * 3600000]) {
    fs.writeFileSync(marker, new Date(expires).toISOString());
    assert.equal((await invoke("subagent-model-guard.cjs", input, f, env)).decision, "block");
  }
  fs.writeFileSync(marker, new Date(Date.now() + 3600000).toISOString());
  assert.equal((await invoke("subagent-model-guard.cjs", input, f, env)), null);
  assert.equal((await invoke("subagent-model-guard.cjs", { ...input, tool_input: { model: "opus", prompt: "missing" } }, f, env)).decision, "block");
});

test("subagent model guard blocks placeholders even when their model or override would match", async () => {
  const f = fixture();
  const policyFile = path.join(f.config, "subagent-model-policy.json");
  const example = JSON.parse(fs.readFileSync(path.join(root, "templates/claude-user-profile/subagent-model.policy.example.json"), "utf8"));
  for (const policy of [
    { ...example, allowedModels: ["{{MODEL}}"] },
    { ...example, overrideFile: "{{OVERRIDE_FILE}}" },
    { ...example, metadata: { operator: "{{OPERATOR}}" } },
  ]) {
    fs.writeFileSync(policyFile, JSON.stringify(policy));
    const input = { tool_name: "Agent", tool_input: { model: policy.allowedModels[0], prompt: "상위 목표: inspect\n막히면 올림: report" } };
    assert.equal((await invoke("subagent-model-guard.cjs", input, f, { NAIA_SUBAGENT_MODEL_POLICY: policyFile })).decision, "block");
  }
});
