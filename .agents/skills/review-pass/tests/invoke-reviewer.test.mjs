import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { composePrompt, commandFor, invoke, safeFailureReason, validateAtoms, validateReviewOutput } from "../scripts/invoke-reviewer.mjs";

const atom = { id:"ATOM-1", source_id:"SRC-1", text:"headless", directive_ids:["DIR-1"], subject:"agent_workflow", effect:"constraint", render_policy:"deny", target_ids:["TGT-1"], criterion_ids:["AC-1"], evidence_ids:["EV-1"] };
async function processDisappears(pid, timeoutMs = 1000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return true; throw error; }
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return false;
}
const atoms = validateAtoms([atom]);
// The prompt carries the original ask and the frame obligations, both ahead of
// the author's ledger, so the reviewer can compare the two instead of taking
// the ledger as the definition of the task.
const promptWithRequest = composePrompt("STABLE\n", atoms, "ROLE", "the original ask");
assert.match(promptWithRequest, /^STABLE\n/);
assert.match(promptWithRequest, /--- ORIGINAL REQUEST \(verbatim[^)]*\) ---\nthe original ask/);
assert.match(promptWithRequest, /scope_is_sufficient/);
assert.match(promptWithRequest, /outside_declared_atoms/);
assert.match(promptWithRequest, /runtime_observed/);
assert.ok(promptWithRequest.indexOf("ORIGINAL REQUEST") < promptWithRequest.indexOf("DYNAMIC ATOM LEDGER"),
	"the original request must precede the author's ledger");
assert.match(promptWithRequest, new RegExp(`--- DYNAMIC ATOM LEDGER ---\\n${JSON.stringify(atom).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
assert.match(promptWithRequest, /--- REVIEWER DELTA ---\nROLE\n$/);

// A missing original request is stated, not silently dropped.
assert.match(composePrompt("STABLE\n", atoms, "ROLE"), /ORIGINAL REQUEST ---\nNot supplied/);
assert.deepEqual(validateAtoms([{ ...atoms[0], directive_ids:[], target_ids:[], criterion_ids:[], evidence_ids:[] }])[0].directive_ids, []);
assert.throws(() => validateAtoms([{ ...atoms[0], unexpected:true }]), /canonical projection/);
assert.throws(() => validateAtoms([{ ...atoms[0], evidence_ids:[""] }]), /evidence_ids/);
assert.throws(() => validateAtoms([{ ...atoms[0], effect:"supersede" }]), /invalid effect/);
assert.throws(() => validateAtoms([atoms[0], atoms[0]]), /duplicate/);
for (const tool of ["claude", "codex", "opencode"]) {
	const [, args] = commandFor(tool, "/repo with spaces", "m");
	assert(!args.some((arg) => arg.includes("STABLE")), `${tool} prompt must not be argv`);
}
assert.deepEqual(commandFor("claude", "/repo with spaces", "m")[1], [
	"-p", "--input-format", "text", "--output-format", "json", "--no-session-persistence",
	"--permission-mode", "plan", "--tools", "Read,Glob,Grep", "--strict-mcp-config",
	"--mcp-config", '{"mcpServers":{}}', "--model", "m",
]);
const [, grokArgs] = commandFor("grok", "/repo with spaces", "m", { promptFile: "/owner-only/prompt.txt" });
assert(!grokArgs.some((arg) => arg.includes("STABLE")), "Grok prompt must not be argv");
assert.equal(commandFor("codex", "/r", "")[1].at(-1), "-");
assert(!commandFor("opencode", "/r", "")[1].some((arg) => arg === "-"), "OpenCode reads piped stdin when message is omitted");
assert(commandFor("opencode", "/r", "")[1].includes("--pure"));
assert(commandFor("opencode", "/r", "")[1].includes("adk-adversarial-review"));
assert.deepEqual(grokArgs.slice(0, 7), ["--output-format", "json", "--permission-mode", "plan", "--verbatim", "--prompt-file", "/owner-only/prompt.txt"]);
assert.deepEqual(grokArgs.slice(7), ["--model", "m"]);
assert(commandFor("grok", "/r", "grok-4.6", { promptFile: "/r/prompt.txt" })[1].includes("grok-4.6"));
assert(!commandFor("grok", "/r", "", { promptFile: "/r/prompt.txt" })[1].includes("--no-subagents"), "Grok review must keep subagents enabled");
const frameOk = { runtime_observed:false, frame_assessment:{ scope_is_sufficient:true, missing_concerns:[] } };
const validReview = JSON.stringify({ verdict:"CLEAN", coverage:[{ atom_id:"ATOM-1", status:"COVERED" }], findings:[], ...frameOk });
assert.equal(validateReviewOutput(validReview, ["ATOM-1"]).verdict, "CLEAN");
assert.equal(validateReviewOutput(`result\n\`\`\`json\n${validReview}\n\`\`\``, ["ATOM-1"]).verdict, "CLEAN");
const openCodeTerminal = JSON.stringify({ type:"step_finish", part:{ type:"step-finish", reason:"stop", tokens:{ input:1, output:1 } } });
const fragmented = `${JSON.stringify({ type:"text", part:{ type:"text", text:validReview.slice(0, 30) } })}\n${JSON.stringify({ type:"text", part:{ type:"text", text:validReview.slice(30) } })}\n${openCodeTerminal}`;
assert.equal(validateReviewOutput(fragmented, ["ATOM-1"]).verdict, "CLEAN");
const fencedFileText = 'before ```js\nconsole.log("not review")\n```';
const fencedReviewText = `done\n\`\`\`json\n${validReview}\n\`\`\``;
const interleavedEvents = [fencedFileText, fencedReviewText]
	.map((text) => JSON.stringify({ type: "text", part: { text } }))
	.concat(openCodeTerminal)
	.join("\n");
assert.equal(validateReviewOutput(interleavedEvents, ["ATOM-1"]).verdict, "CLEAN");
const claudeEnvelope = JSON.stringify({ type:"result", result:fencedReviewText });
assert.equal(validateReviewOutput(claudeEnvelope, ["ATOM-1"]).verdict, "CLEAN");
const nestedStringEnvelope = JSON.stringify({ type:"result", payload:JSON.stringify({ part:{ text:fencedReviewText } }) });
assert.equal(validateReviewOutput(nestedStringEnvelope, ["ATOM-1"]).verdict, "CLEAN");
const illustrativeStatusText = JSON.stringify({ type:"text", part:{ text:'example: {"status_code":402} and code:payment_required' } });
assert.equal(validateReviewOutput(`${illustrativeStatusText}\n${openCodeTerminal}\n${validReview}`, ["ATOM-1"]).verdict, "CLEAN", "quota-like examples in successful text must remain text");
assert.throws(() => validateReviewOutput(`${JSON.stringify({ type:"text", part:{ type:"text", text:validReview } })}\n${validReview}`, ["ATOM-1"]), /incomplete or failed stream \(missing terminal\)/);
assert.throws(() => validateReviewOutput(`${openCodeTerminal}\n${JSON.stringify({ type:"step_start", part:{ type:"step-start" } })}\n${JSON.stringify({ type:"text", part:{ type:"text", text:validReview } })}`, ["ATOM-1"]), /incomplete or failed stream \(missing terminal\)/, "a new step after stop needs its own terminal");
assert.throws(() => validateReviewOutput(`${JSON.stringify({ type:"step_finish", part:{ type:"step-finish", reason:"mystery" } })}\n${validReview}`, ["ATOM-1"]), /incomplete or failed stream \(mystery\)/);
for (const reason of ["length", "max_tokens"]) {
	assert.throws(() => validateReviewOutput(`${JSON.stringify({ type:"step_finish", part:{ type:"step-finish", reason, tokens:{ input:1, output:1 } } })}\n${validReview}`, ["ATOM-1"]), new RegExp(`incomplete or failed stream \\(${reason}\\)`));
}
assert.throws(() => validateReviewOutput(`${JSON.stringify({ type:"step_finish", part:{ type:"step-finish", reason:"error", error:{ message:"provider failed" } } })}\n${validReview}`, ["ATOM-1"]), /incomplete or failed stream \(error\)/);
assert.throws(() => validateReviewOutput(`${JSON.stringify({ type:"step_finish", reason:"length" })}\n${validReview}`, ["ATOM-1"]), /incomplete or failed stream \(length\)/);
assert.throws(() => validateReviewOutput(`${JSON.stringify({ type:"error", error:{ message:"provider failed" } })}\n${validReview}`, ["ATOM-1"]), /incomplete or failed stream \(error\)/);
assert.throws(() => validateReviewOutput(`${JSON.stringify({ type:"step_finish", status:"incomplete" })}\n${validReview}`, ["ATOM-1"]), /incomplete or failed stream \(incomplete\)/);
assert.throws(() => validateReviewOutput(`${JSON.stringify({ type:"step_finish", status:"truncated" })}\n${validReview}`, ["ATOM-1"]), /incomplete or failed stream \(truncated\)/);
assert.throws(() => validateReviewOutput(`${JSON.stringify({ type:"step_finish", truncated:true })}\n${validReview}`, ["ATOM-1"]), /incomplete or failed stream \(truncated\)/);
const echoedDraftThenFinal = [
	JSON.stringify({ type:"text", part:{ text:JSON.stringify({ coverage:[] }) } }),
	JSON.stringify({ type:"text", part:{ text:fencedReviewText } }),
	openCodeTerminal,
].join("\n");
assert.equal(validateReviewOutput(echoedDraftThenFinal, ["ATOM-1"]).verdict, "CLEAN");
let deeplyNested = JSON.parse(validReview);
for (let i = 0; i < 40; i++) deeplyNested = { nested:deeplyNested };
assert.throws(() => validateReviewOutput(JSON.stringify(deeplyNested), ["ATOM-1"]), /no structured coverage/);
assert.throws(() => validateReviewOutput(JSON.stringify({ verdict:"NOT_CLEAN", coverage:[], findings:[] , ...frameOk }), ["ATOM-1"]), /misses atoms/);
assert.throws(() => validateReviewOutput(JSON.stringify({ verdict:"NOT_CLEAN", coverage:[{ atom_id:"ATOM-1", status:"COVERED" }, { atom_id:"ATOM-1", status:"COVERED" }], findings:[] , ...frameOk }), ["ATOM-1"]), /duplicates atom/);
assert.throws(() => validateReviewOutput(JSON.stringify({ verdict:"CLEAN", coverage:[{ atom_id:"ATOM-1", status:"COVERED" }], findings:[{ atom_id:"ATOM-1", file_location:"x", impact:"y", minimal_fix:"z" }] , ...frameOk }), ["ATOM-1"]), /CLEAN review/);
assert.throws(() => validateReviewOutput(JSON.stringify({ verdict:"NOT_CLEAN", coverage:[{ atom_id:"ATOM-1", status:"NOT_COVERED" }], findings:[{ atom_id:"ATOM-1", location:"x" }] , ...frameOk }), ["ATOM-1"]), /file_location/);

const validReviewObject = {
	verdict:"CLEAN",
	coverage:[{ atom_id:"ATOM-1", status:"COVERED" }],
	findings:[],
	...frameOk,
};
const invalidOutputCases = [
	["", /no structured coverage/],
	[JSON.stringify({ ...validReviewObject, frame_assessment: undefined }), /no frame_assessment/],
	[JSON.stringify({ ...validReviewObject, runtime_observed: undefined }), /runtime_observed/],
	[JSON.stringify({ ...validReviewObject, coverage:[{ atom_id:"UNKNOWN", status:"COVERED" }] }), /unknown atom/],
	[JSON.stringify({ ...validReviewObject, frame_assessment:{ scope_is_sufficient:"yes", missing_concerns:[] } }), /must be a boolean/],
];
for (const [raw, message] of invalidOutputCases) {
	assert.throws(
		() => validateReviewOutput(raw, ["ATOM-1"]),
		(error) => error?.kind === "invalid_output" && message.test(error.message),
	);
}
assert.equal(
	safeFailureReason("codex", new Error("provider authority policy denied")),
	"codex reviewer process failed",
);
assert.equal(
	safeFailureReason("codex", Object.assign(new Error("review output must state runtime_observed as a boolean"), { kind:"invalid_output" })),
	"codex reviewer returned invalid output",
);
assert.equal(
	safeFailureReason("codex", new Error("unauthorized")),
	"codex reviewer authentication or account access is unavailable",
);

const dir = await mkdtemp(path.join(os.tmpdir(), "review-invoke-"));
const fake = path.join(dir, "fake.mjs");
await writeFile(fake, `#!/usr/bin/env node\nlet input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => { if (input !== "ONE-SHOT") process.exit(2); console.log(${JSON.stringify(validReview)}); });\n`, { mode: 0o700 });
await invoke({ tool:"codex", repo:dir, prompt:"ONE-SHOT", atomIds:["ATOM-1"], startupMs:1000, idleMs:1000, totalMs:2000, executable:fake });
const fail = path.join(dir, "fail.mjs");
await writeFile(fail, '#!/usr/bin/env node\nconsole.error("token=sk-secretvalue123"); console.log(JSON.stringify({type:"error",error:{data:{message:"provider login required"}}})); process.exit(7);\n', { mode: 0o700 });
await assert.rejects(invoke({ tool:"opencode", repo:dir, model:"azure-foundry/deepseek-v4-pro", prompt:"x", startupMs:1000, idleMs:1000, totalMs:2000, executable:fail }), (error) => error.exitCode === 7 && /provider login required/.test(error.message) && !/secretvalue/.test(error.message));
const failSecret = path.join(dir, "fail-secret.mjs");
await writeFile(failSecret, '#!/usr/bin/env node\nconsole.error("token=sk-secretvalue123"); process.exit(8);\n', { mode: 0o700 });
await assert.rejects(invoke({ tool:"opencode", repo:dir, model:"azure-foundry/deepseek-v4-pro", prompt:"x", startupMs:1000, idleMs:1000, totalMs:2000, executable:failSecret }), (error) => error.exitCode === 8 && /token=<redacted>/.test(error.message) && !/secretvalue/.test(error.message));
const oversized = path.join(dir, "oversized.mjs");
await writeFile(oversized, '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(1024 * 1024 + 1));\n', { mode: 0o700 });
await assert.rejects(invoke({ tool:"codex", repo:dir, prompt:"x", startupMs:1000, idleMs:1000, totalMs:2000, executable:oversized }), (error) => error.exitCode === 1 && /output exceeds/.test(error.message));
const envFake = path.join(dir, "env-fake.mjs");
const hostileHome = path.join(dir, "hostile-home");
const hostileXdg = path.join(dir, "hostile-xdg");
const hostileConfig = JSON.stringify({
	"$schema": "https://example.invalid/opencode.json",
	provider: { "azure-foundry": { options: { baseURL: "https://example.invalid" } } },
	model: "hostile-model",
	small_model: "hostile-small-model",
	permission: { "*": "allow" },
	plugin: ["hostile-plugin"],
	agent: { build: { permission: { "*": "allow" } } },
});
await mkdir(path.join(hostileHome, ".config", "opencode"), { recursive: true, mode: 0o700 });
await mkdir(path.join(hostileXdg, "opencode"), { recursive: true, mode: 0o700 });
const hostileHomeConfig = path.join(hostileHome, ".config", "opencode", "opencode.jsonc");
const hostileXdgConfig = path.join(hostileXdg, "opencode", "opencode.jsonc");
await writeFile(hostileHomeConfig, hostileConfig, { encoding: "utf8", mode: 0o600 });
await writeFile(hostileXdgConfig, hostileConfig, { encoding: "utf8", mode: 0o600 });
await chmod(hostileHomeConfig, 0o600);
await chmod(hostileXdgConfig, 0o600);
const explicitOpenCodeModel = "azure-foundry/deepseek-v4-pro";
const envMarker = path.join(dir, "opencode-env-marker.json");
await writeFile(envFake, `#!/usr/bin/env node
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
const expectedModel = ${JSON.stringify(explicitOpenCodeModel)};
const expectedHome = ${JSON.stringify(hostileHome)};
const expectedXdg = ${JSON.stringify(hostileXdg)};
const marker = ${JSON.stringify(envMarker)};
process.stdin.resume();
process.stdin.on("end", () => {
 const configPath = process.env.OPENCODE_CONFIG;
 const config = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : {};
 const providerPath = process.env.XDG_CONFIG_HOME + "/opencode/opencode.jsonc";
 const provider = existsSync(providerPath) ? JSON.parse(readFileSync(providerPath, "utf8")) : {};
 const mode = configPath ? statSync(configPath).mode & 0o777 : 0;
 const providerMode = existsSync(providerPath) ? statSync(providerPath).mode & 0o777 : 0;
 const readOnly = (value) => value && value["*"] === "deny" && value.read === "allow" && value.glob === "allow" && value.grep === "allow" && value.list === "allow" && Object.keys(value).length === 5;
 const selected = config.agent?.["adk-adversarial-review"];
 const build = config.agent?.build;
 const safe = mode === 0o600 && providerMode === 0o600 && readOnly(config.permission) && selected?.mode === "primary" && readOnly(selected.permission) && build?.mode === "primary" && readOnly(build.permission) && Array.isArray(config.plugin) && config.plugin.length === 0 && config.model === expectedModel && config.small_model === expectedModel && provider.model === expectedModel && provider.small_model === expectedModel && !Object.hasOwn(provider, "permission") && !Object.hasOwn(provider, "plugin") && process.env.HOME !== expectedHome && process.env.XDG_CONFIG_HOME !== expectedXdg && process.env.XDG_CONFIG_HOME !== expectedHome && process.env.OPENCODE_DISABLE_PROJECT_CONFIG === "1" && process.env.OPENCODE_CONFIG_CONTENT === undefined && process.env.OPENCODE_CONFIG_DIR === undefined && process.env.OPENCODE_PERMISSION === undefined;
 if (!safe) { console.error(JSON.stringify({ mode, providerMode, config, provider, home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME })); process.exit(3); }
 writeFileSync(marker, JSON.stringify({ childHome: process.env.HOME, configPath, providerPath }));
 console.log(${JSON.stringify(validReview)});
});
`, { mode: 0o700 });
const priorOpenCodeConfig = process.env.OPENCODE_CONFIG_CONTENT;
const priorOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
const priorOpenCodePermission = process.env.OPENCODE_PERMISSION;
const priorHome = process.env.HOME;
const priorXdgConfig = process.env.XDG_CONFIG_HOME;
process.env.OPENCODE_CONFIG_CONTENT = '{"permission":{"*":"allow"}}';
process.env.OPENCODE_CONFIG_DIR = dir;
process.env.OPENCODE_PERMISSION = '{"*":"allow"}';
process.env.HOME = hostileHome;
process.env.XDG_CONFIG_HOME = hostileXdg;
try {
	await invoke({ tool:"opencode", repo:dir, model:explicitOpenCodeModel, prompt:"x", atomIds:["ATOM-1"], startupMs:1000, idleMs:1000, totalMs:2000, executable:envFake });
} finally {
	if (priorOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG_CONTENT; else process.env.OPENCODE_CONFIG_CONTENT = priorOpenCodeConfig;
	if (priorOpenCodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = priorOpenCodeConfigDir;
	if (priorOpenCodePermission === undefined) delete process.env.OPENCODE_PERMISSION; else process.env.OPENCODE_PERMISSION = priorOpenCodePermission;
	if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
	if (priorXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorXdgConfig;
}
const envReceipt = JSON.parse(await readFile(envMarker, "utf8"));
assert.match(envReceipt.childHome, /review-opencode-/);
await assert.rejects(readFile(envReceipt.childHome, "utf8"), { code: "ENOENT" }, "OpenCode child HOME must be removed after invocation");
await assert.rejects(readFile(envReceipt.configPath, "utf8"), { code: "ENOENT" }, "OpenCode overlay must be removed after invocation");
await assert.rejects(readFile(envReceipt.providerPath, "utf8"), { code: "ENOENT" }, "OpenCode provider copy must be removed after invocation");
const grokFake = path.join(dir, "grok-fake.mjs");
const grokMarker = path.join(dir, "grok-marker.json");
await writeFile(grokFake, `#!/usr/bin/env node\nimport { readFileSync, statSync, writeFileSync } from "node:fs"; const args=process.argv.slice(2); const index=args.indexOf("--prompt-file"); const promptFile=index >= 0 ? args[index + 1] : ""; const mode=promptFile ? statSync(promptFile).mode & 0o777 : 0; let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => { if (!args.includes("--verbatim") || !promptFile || mode !== 0o600 || readFileSync(promptFile,"utf8") !== "GROK-PROMPT" || input) process.exit(11); writeFileSync(process.env.GROK_MARKER, JSON.stringify({ promptFile, mode })); console.log(${JSON.stringify(validReview)}); });\n`, { mode: 0o700 });
const priorGrokMarker = process.env.GROK_MARKER;
process.env.GROK_MARKER = grokMarker;
await invoke({ tool:"grok", repo:dir, prompt:"GROK-PROMPT", atomIds:["ATOM-1"], startupMs:1000, idleMs:1000, totalMs:2000, executable:grokFake });
const grokReceipt = JSON.parse(await readFile(grokMarker, "utf8"));
assert.equal(grokReceipt.mode, 0o600, "Grok prompt file must be owner-only");
assert.match(grokReceipt.promptFile, /review-grok-/);
await assert.rejects(readFile(grokReceipt.promptFile, "utf8"), { code: "ENOENT" }, "Grok prompt file must be removed after invocation");
if (priorGrokMarker === undefined) delete process.env.GROK_MARKER; else process.env.GROK_MARKER = priorGrokMarker;
const grokFail = path.join(dir, "grok-fail.mjs");
const grokFailMarker = path.join(dir, "grok-fail-marker.json");
await writeFile(grokFail, `#!/usr/bin/env node\nimport { readFileSync, statSync, writeFileSync } from "node:fs"; const args=process.argv.slice(2); const index=args.indexOf("--prompt-file"); const promptFile=index >= 0 ? args[index + 1] : ""; const mode=promptFile ? statSync(promptFile).mode & 0o777 : 0; if (!args.includes("--verbatim") || !promptFile || mode !== 0o600 || readFileSync(promptFile,"utf8") !== "GROK-FAIL-PROMPT") process.exit(12); writeFileSync(process.env.GROK_FAIL_MARKER, JSON.stringify({ promptFile, mode })); process.exit(19);\n`, { mode: 0o700 });
const priorGrokFailMarker = process.env.GROK_FAIL_MARKER;
process.env.GROK_FAIL_MARKER = grokFailMarker;
await assert.rejects(invoke({ tool:"grok", repo:dir, prompt:"GROK-FAIL-PROMPT", startupMs:1000, idleMs:1000, totalMs:2000, executable:grokFail }), (error) => error.exitCode === 19);
const grokFailReceipt = JSON.parse(await readFile(grokFailMarker, "utf8"));
assert.equal(grokFailReceipt.mode, 0o600, "failed Grok invocation must still use an owner-only prompt");
await assert.rejects(readFile(grokFailReceipt.promptFile, "utf8"), { code: "ENOENT" }, "Grok prompt file must be removed after failure");
if (priorGrokFailMarker === undefined) delete process.env.GROK_FAIL_MARKER; else process.env.GROK_FAIL_MARKER = priorGrokFailMarker;
await assert.rejects(invoke({ tool:"codex", repo:dir, prompt:"x", startupMs:0, idleMs:1, totalMs:1, executable:fake }), /startupMs/);
const hang = path.join(dir, "hang.mjs");
await writeFile(hang, '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n', { mode: 0o700 });
await assert.rejects(invoke({ tool:"claude", repo:dir, prompt:"x", startupMs:40, idleMs:40, totalMs:200, killGraceMs:40, executable:hang }), (error) => error.exitCode === 124 && /startup timeout/.test(error.message));
if (process.platform !== "win32") {
	const descendantPidFile = path.join(dir, "descendant.pid");
	const exitsEarly = path.join(dir, "exits-early.mjs");
	await writeFile(exitsEarly, `#!/usr/bin/env node\nimport { spawn } from "node:child_process"; import { writeFileSync } from "node:fs"; const child=spawn(process.execPath,["-e",'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)']); writeFileSync(${JSON.stringify(descendantPidFile)},String(child.pid)); process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000);\n`, { mode: 0o700 });
	await assert.rejects(invoke({ tool:"codex", repo:dir, prompt:"x", startupMs:300, idleMs:300, totalMs:1000, killGraceMs:100, executable:exitsEarly }), /startup timeout/);
	const descendantPid = Number(await readFile(descendantPidFile, "utf8"));
	assert.equal(await processDisappears(descendantPid), true, "timeout escalation must kill descendants after the leader exits");
}
console.log("review invocation tests: PASS");
