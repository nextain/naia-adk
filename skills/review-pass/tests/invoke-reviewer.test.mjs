import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { composePrompt, commandFor, invoke, validateAtoms, validateReviewOutput } from "../scripts/invoke-reviewer.mjs";

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
assert.equal(composePrompt("STABLE\n", atoms, "ROLE"), `STABLE\n\n--- DYNAMIC ATOM LEDGER ---\n${JSON.stringify(atom)}\n\n--- REVIEWER DELTA ---\nROLE\n`);
assert.deepEqual(validateAtoms([{ ...atoms[0], directive_ids:[], target_ids:[], criterion_ids:[], evidence_ids:[] }])[0].directive_ids, []);
assert.throws(() => validateAtoms([{ ...atoms[0], unexpected:true }]), /canonical projection/);
assert.throws(() => validateAtoms([{ ...atoms[0], evidence_ids:[""] }]), /evidence_ids/);
assert.throws(() => validateAtoms([{ ...atoms[0], effect:"supersede" }]), /invalid effect/);
assert.throws(() => validateAtoms([atoms[0], atoms[0]]), /duplicate/);
for (const tool of ["claude", "codex", "opencode"]) {
	const [, args] = commandFor(tool, "/repo with spaces", "m");
	assert(!args.some((arg) => arg.includes("STABLE")), `${tool} prompt must not be argv`);
}
assert.equal(commandFor("codex", "/r", "")[1].at(-1), "-");
assert(!commandFor("opencode", "/r", "")[1].some((arg) => arg === "-"), "OpenCode reads piped stdin when message is omitted");
assert(commandFor("opencode", "/r", "")[1].includes("--pure"));
assert(commandFor("opencode", "/r", "")[1].includes("adk-adversarial-review"));
const validReview = JSON.stringify({ verdict:"CLEAN", coverage:[{ atom_id:"ATOM-1", status:"COVERED" }], findings:[] });
assert.equal(validateReviewOutput(validReview, ["ATOM-1"]).verdict, "CLEAN");
assert.equal(validateReviewOutput(`result\n\`\`\`json\n${validReview}\n\`\`\``, ["ATOM-1"]).verdict, "CLEAN");
const fragmented = `${JSON.stringify({ type:"text", part:{ text:validReview.slice(0, 30) } })}\n${JSON.stringify({ type:"text", part:{ text:validReview.slice(30) } })}`;
assert.equal(validateReviewOutput(fragmented, ["ATOM-1"]).verdict, "CLEAN");
let deeplyNested = JSON.parse(validReview);
for (let i = 0; i < 40; i++) deeplyNested = { nested:deeplyNested };
assert.throws(() => validateReviewOutput(JSON.stringify(deeplyNested), ["ATOM-1"]), /no structured coverage/);
assert.throws(() => validateReviewOutput(JSON.stringify({ verdict:"NOT_CLEAN", coverage:[], findings:[] }), ["ATOM-1"]), /misses atoms/);
assert.throws(() => validateReviewOutput(JSON.stringify({ verdict:"NOT_CLEAN", coverage:[{ atom_id:"ATOM-1", status:"COVERED" }, { atom_id:"ATOM-1", status:"COVERED" }], findings:[] }), ["ATOM-1"]), /duplicates atom/);
assert.throws(() => validateReviewOutput(JSON.stringify({ verdict:"CLEAN", coverage:[{ atom_id:"ATOM-1", status:"COVERED" }], findings:[{ atom_id:"ATOM-1", file_location:"x", impact:"y", minimal_fix:"z" }] }), ["ATOM-1"]), /CLEAN review/);
assert.throws(() => validateReviewOutput(JSON.stringify({ verdict:"NOT_CLEAN", coverage:[{ atom_id:"ATOM-1", status:"NOT_COVERED" }], findings:[{ atom_id:"ATOM-1", location:"x" }] }), ["ATOM-1"]), /file_location/);

const dir = await mkdtemp(path.join(os.tmpdir(), "review-invoke-"));
const fake = path.join(dir, "fake.mjs");
await writeFile(fake, `#!/usr/bin/env node\nlet input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => { if (input !== "ONE-SHOT") process.exit(2); console.log(${JSON.stringify(validReview)}); });\n`, { mode: 0o700 });
await invoke({ tool:"codex", repo:dir, prompt:"ONE-SHOT", atomIds:["ATOM-1"], startupMs:1000, idleMs:1000, totalMs:2000, executable:fake });
const fail = path.join(dir, "fail.mjs");
await writeFile(fail, '#!/usr/bin/env node\nconsole.error("token=sk-secretvalue123"); console.log(JSON.stringify({type:"error",error:{data:{message:"provider login required"}}})); process.exit(7);\n', { mode: 0o700 });
await assert.rejects(invoke({ tool:"opencode", repo:dir, prompt:"x", startupMs:1000, idleMs:1000, totalMs:2000, executable:fail }), (error) => error.exitCode === 7 && /provider login required/.test(error.message) && !/secretvalue/.test(error.message));
const failSecret = path.join(dir, "fail-secret.mjs");
await writeFile(failSecret, '#!/usr/bin/env node\nconsole.error("token=sk-secretvalue123"); process.exit(8);\n', { mode: 0o700 });
await assert.rejects(invoke({ tool:"opencode", repo:dir, prompt:"x", startupMs:1000, idleMs:1000, totalMs:2000, executable:failSecret }), (error) => error.exitCode === 8 && /token=<redacted>/.test(error.message) && !/secretvalue/.test(error.message));
const oversized = path.join(dir, "oversized.mjs");
await writeFile(oversized, '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(1024 * 1024 + 1));\n', { mode: 0o700 });
await assert.rejects(invoke({ tool:"codex", repo:dir, prompt:"x", startupMs:1000, idleMs:1000, totalMs:2000, executable:oversized }), (error) => error.exitCode === 1 && /output exceeds/.test(error.message));
const envFake = path.join(dir, "env-fake.mjs");
await writeFile(envFake, `#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end", () => { const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT); if (config.permission["*"] !== "deny") process.exit(3); console.log(${JSON.stringify(validReview)}); });\n`, { mode: 0o700 });
const priorOpenCodeConfig = process.env.OPENCODE_CONFIG_CONTENT;
process.env.OPENCODE_CONFIG_CONTENT = '{"permission":{"*":"allow"}}';
await invoke({ tool:"opencode", repo:dir, prompt:"x", atomIds:["ATOM-1"], startupMs:1000, idleMs:1000, totalMs:2000, executable:envFake });
if (priorOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG_CONTENT; else process.env.OPENCODE_CONFIG_CONTENT = priorOpenCodeConfig;
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
