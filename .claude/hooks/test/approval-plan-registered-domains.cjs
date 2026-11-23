"use strict";
// Approval gate tests: registered-domains.
const { makeWorkspace, gitRun, sha256, fs, path, writeGateConfig, createValidPlan, deployPlan, SCRIPT_PATH, spawnSync, test, assert } = require("./approval-plan-fixtures.cjs");

function registeredReviewFixture(t, author = "argon") {
	const { tmp, root, stateDir, transcriptPath } = makeWorkspace(t);
	gitRun(root, ["init", "-q"]);
	gitRun(root, ["config", "user.name", "Fixture"]);
	gitRun(root, ["config", "user.email", "automation@localhost"]);
	const scriptPath = "scripts/local-status.sh";
	const script = "#!/bin/sh\nprintf ready\n";
	const everySite = { path: "scripts/show-version.sh", service: "fixture:local", sha256: sha256("printf version\n") };
	const primaryOnly = { path: scriptPath, service: "fixture:local", sha256: sha256(script) };
	fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(root, scriptPath), script);
	fs.writeFileSync(path.join(root, everySite.path), "printf version\n");
	writeGateConfig(root, { readOnlyScripts: [primaryOnly, everySite] });
	const { planFile, gatesDir } = createValidPlan(root, {
		author_model: author, services: ["fixture:local"],
		scenario: [
			{ id: "s1", title: "Print readiness", commands: ["printf ready"], files: { [scriptPath]: primaryOnly.sha256, [everySite.path]: everySite.sha256 }, success_check: "Read the local fixture output", on_failure: "Use the local rollback check" },
			{ id: "r1", branch: "rollback", title: "Print previous status", commands: ["printf previous"], success_check: "Read previous local status", on_failure: "Keep the local fixture stopped" },
		],
	});
	gitRun(root, ["add", "."]);
	gitRun(root, ["commit", "-qm", "Local plan fixture"]);
	const ids = ["primary", "secondary"];
	for (const id of [...ids, "replacement"]) {
		const site = path.join(tmp, id);
		const directory = path.join(site, ".claude", "deploy");
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({
			review_models: { muse: { model: `fixture-${id === "replacement" ? "secondary" : id}`, runner: "muse", effort: "high" } },
		}));
		writeGateConfig(site, { readOnlyScripts: id === "primary" ? [everySite, primaryOnly] : [everySite] });
		gitRun(site, ["init", "-q"]);
		gitRun(site, ["add", "."]);
		gitRun(site, ["-c", "user.name=Fixture", "-c", "user.email=automation@localhost", "commit", "-qm", "Local gate policy"]);
	}
	const reviewer = path.join(tmp, "fixture-reviewer.cjs");
	const criteria = deployPlan.CRITERIA.map(([id]) => id);
	fs.writeFileSync(reviewer, `#!${process.execPath}
const fs = require("node:fs");
const prompt = fs.readFileSync(process.argv[process.argv.indexOf("--prompt-file") + 1], "utf8");
const id = /^Review gate: ([a-z]+)\\./m.exec(prompt)?.[1];
if (!id) process.exit(2);
const reject = id === process.env.FIXTURE_REJECT;
const criteria = ${JSON.stringify(criteria)};
console.log(["판정: " + (reject ? "FAIL" : "PASS"), ...criteria.map((name, i) => name + ": " + (reject && i === 0 ? "FAIL" : "PASS")), "참고 지적: 0", "남은 지적: " + (reject ? 1 : 0)].join("\\n"));
`, { mode: 0o700 });
	const wrapper = path.join(tmp, "registered-review.mjs");
	const cli = require("node:url").pathToFileURL(SCRIPT_PATH).href;
	const pins = require.resolve("../lib/gate-config-pin.js");
	fs.writeFileSync(wrapper, `import { runApprovedApprovalPlan } from ${JSON.stringify(cli)};
import { createRequire } from "node:module";
import path from "node:path";
const pin = createRequire(import.meta.url)(${JSON.stringify(pins)});
const root = ${JSON.stringify(root)}, site = ${JSON.stringify(tmp)};
const ids = ${JSON.stringify(ids)};
const profiles = ids.map(id => {
	const directory = path.join(site, id === "secondary" && process.env.FIXTURE_REPLACEMENT ? "replacement" : id);
	if (process.env.FIXTURE_STRICT === "both" || process.env.FIXTURE_STRICT === id) return { id, root: directory, policy: "strict-defaults" };
	const code = pin.approvalCode(pin.snapshotGateConfig(directory).hash);
	const approverId = "1".repeat(18), channelId = "2".repeat(18), messageId = "3".repeat(18);
	return { id, root: directory, approverId, token: "local-only", refs: [{ code, channelId, messageId }],
		fetchImpl: async () => ({ ok: true, json: async () => ({ id: messageId, channel_id: channelId, author: { id: approverId }, content: id === process.env.FIXTURE_UNVERIFIED ? "pending" : code }) }) };
});
const options = { root, reviewProfiles: profiles, ...(process.env.FIXTURE_ADMISSION ? { admissionProfile: process.env.FIXTURE_ADMISSION } : {}) };
const engine = createRequire(import.meta.url)(${JSON.stringify(require.resolve("../lib/deploy-plan.js"))});
if (process.argv[2] === "fixture-read-only") {
	console.log(JSON.stringify(await engine.withGateConfig(options, () => engine.reviewedReadOnlyScripts(${JSON.stringify(gatesDir)}, root))));
} else if (process.argv[2] === "fixture-admission") {
	const decision = await engine.withGateConfig(options, () => engine.evaluate({
		root, cwd: root, env: process.env, services: ["fixture:local"], command: "printf ready",
		sessionId: "local-fixture", transcriptPath: ${JSON.stringify(transcriptPath)},
		...(process.env.FIXTURE_READ_ONLY ? { readiness: () => ({ ok: true, readOnlyNoCode: true }) } : {}),
	}));
	console.log(JSON.stringify({ allow: decision.allow, event: decision.audit.event }));
} else await runApprovedApprovalPlan(options, process.argv.slice(2));
`);
	const run = (args, env = {}) => spawnSync(process.execPath, [wrapper, ...args], {
		cwd: root, timeout: 30000, encoding: "utf8",
		env: { ...process.env, DEPLOY_APPROVAL_STATE_DIR: stateDir, APPROVAL_PLAN_MUSE_BIN: reviewer, ...env },
	});
	return { tmp, root, gatesDir, planFile, ids, run, scriptPath, everySite, transcriptPath, review: ["review", planFile, "--author", author] };
}

test("registered gates independently review one plan through review, check, report and preapprove", (t) => {
	const { root, gatesDir, planFile, ids, run, scriptPath, everySite, transcriptPath, review } = registeredReviewFixture(t);
	const unverified = run(review, { FIXTURE_UNVERIFIED: "secondary" });
	assert.notEqual(unverified.status, 0);
	assert.equal(fs.existsSync(path.join(gatesDir, "reviews")), false);
	const prompts = run(["review-prompt", planFile]);
	assert.equal(prompts.status, 0, prompts.stderr);
	for (const id of ids) assert.match(prompts.stdout, new RegExp(`Review gate: ${id}\\.`));
	const rejected = run(review, { FIXTURE_REJECT: "secondary" });
	assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
	assert.match(rejected.stdout + rejected.stderr, /secondary/);
	assert.equal(run(["check", planFile]).status, 1);
	const pendingReads = run(["fixture-read-only"]);
	assert.equal(pendingReads.status, 0, pendingReads.stderr);
	assert.deepEqual(JSON.parse(pendingReads.stdout), []);
	const read = id => JSON.parse(fs.readFileSync(path.join(gatesDir, "reviews", id, deployPlan.REVIEW_FILE)));
	assert.deepEqual(ids.map(id => read(id).reviewers[0].model), ["fixture-primary", "fixture-secondary"]);
	const accepted = run(review);
	assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
	const records = ids.map(read);
	assert.deepEqual(records.map(record => record.review_profile.id), ids);
	assert.deepEqual(records.map(record => record.read_only_scripts.map(row => row.path)), [[scriptPath, everySite.path], [everySite.path]]);
	const exceptions = run(["fixture-read-only"]);
	assert.equal(exceptions.status, 0, exceptions.stderr);
	assert.deepEqual(JSON.parse(exceptions.stdout), [{ ...everySite, script_sha256: everySite.sha256 }]);
	assert.equal(deployPlan.isPlanReviewRecordPath(path.join(gatesDir, "reviews", "primary", deployPlan.REVIEW_FILE), root), true);
	assert.notEqual(records[0].prompt_sha256, records[1].prompt_sha256);
	assert.notEqual(records[0].reviewers[0].receipt.input_manifest_sha256, records[1].reviewers[0].receipt.input_manifest_sha256);
	for (const id of ids) assert.equal(fs.existsSync(path.join(gatesDir, "reviews", id, "deploy-plan-review-findings.md")), true);
	assert.equal(fs.existsSync(path.join(gatesDir, deployPlan.REVIEW_FILE)), false);
	for (const args of [["check", planFile], ["report", planFile], ["preapprove", planFile, "--session", "local-fixture"]]) {
		const accepted = run(args);
		assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
		const changed = run(args, { FIXTURE_REPLACEMENT: "1" });
		assert.equal(changed.status, 1, changed.stdout + changed.stderr);
	}
	const issued = run(["preapprove", planFile, "--session", "local-fixture"]);
	const codes = issued.stdout.match(/\b(?:PLAN|STEP)-[0-9A-F]{64}\b/g);
	assert.equal(codes.length, 3);
	const admit = env => {
		const result = run(["fixture-admission"], env);
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout);
	};
	assert.equal(admit({}).allow, false, "human consent is still required");
	fs.appendFileSync(transcriptPath, JSON.stringify({ type: "user", timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text: codes.join(" ") }] } }) + "\n");
	assert.equal(admit({ FIXTURE_REPLACEMENT: "1" }).allow, false);
	assert.equal(admit({}).allow, true);
});

test("explicit strict review registrations use code-fixed independent reviews and grant no read-only exceptions", t => {
	const { tmp, planFile, gatesDir, ids, run, review } = registeredReviewFixture(t, "codex");
	const seconds = path.join(tmp, "secondary", ".claude", "deploy", "config.json");
	fs.renameSync(seconds, seconds + ".unused");
	const mixed = { FIXTURE_STRICT: "secondary" }, both = { FIXTURE_STRICT: "both" };
	const receipt = id => JSON.parse(fs.readFileSync(path.join(gatesDir, "reviews", id, deployPlan.REVIEW_FILE)));
	const succeeds = (args, env) => {
		const result = run(args, env);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		return result.stdout;
	};
	const prompts = succeeds(["review-prompt", planFile], mixed);
	assert.equal(prompts.match(/Review gate:/g).length, 2);
	assert.equal(prompts.match(/Review policy: strict-defaults/g).length, 1);
	succeeds(review, mixed);
	assert.equal(receipt("primary").reviewers[0].model, "fixture-primary");
	assert.equal(receipt("secondary").reviewers[0].model, deployPlan.REVIEW_MODELS.muse.model);
	assert.deepEqual(receipt("secondary").read_only_scripts, []);
	succeeds(["check", planFile], mixed);
	assert.deepEqual(JSON.parse(succeeds(["fixture-read-only"], mixed)), []);
	assert.equal(run(["check", planFile], both).status, 1, "changing the trusted registration requires fresh reviews");
	succeeds(review, both);
	const records = ids.map(receipt);
	assert.deepEqual(records.map(row => row.review_profile.policy), ["strict-defaults", "strict-defaults"]);
	assert.ok(records.every(row => row.reviewers[0].model === deployPlan.REVIEW_MODELS.muse.model && !row.read_only_scripts.length));
	assert.notEqual(records[0].prompt_sha256, records[1].prompt_sha256);
	assert.notEqual(records[0].reviewers[0].receipt.input_manifest_sha256, records[1].reviewers[0].receipt.input_manifest_sha256);
	succeeds(["check", planFile], both);
	assert.deepEqual(JSON.parse(succeeds(["fixture-admission"], { ...both, FIXTURE_READ_ONLY: "1" })), { allow: false, event: "plan-approval-requested" });
	fs.writeFileSync(seconds, "{}\n");
	for (const args of [["check", planFile], ["report", planFile], ["preapprove", planFile, "--session", "fixture"]]) {
		assert.equal(run(args, both).status, 1, "an observed site policy change invalidates persisted evidence");
	}
});

test("a registered policy must be explicit and stable throughout a strict review", async t => {
	const { tmp, root } = makeWorkspace(t);
	const site = path.join(tmp, "site");
	fs.mkdirSync(site);
	const registered = (policy, fn) => deployPlan.withGateConfig({ root, reviewProfiles: [{ id: "secondary", root: site, policy }] }, fn);
	for (const policy of [undefined, "approved-config", "unknown"]) {
		await assert.rejects(registered(policy, () => "unexpected success"));
	}
	await registered("strict-defaults", () => {
		assert.deepEqual(deployPlan.registeredReviewProfileIds(root), ["secondary"]);
		fs.mkdirSync(path.join(site, "config"));
		fs.writeFileSync(path.join(site, "config", "deploy-gate.json"), "{}\n");
		assert.throws(() => deployPlan.registeredReviewProfileIds(root), /policy changed/);
	});
});

test("registered admission domains reject copied state and preserve independent human confirmation", t => {
 const f=registeredReviewFixture(t,"codex"),strict={FIXTURE_STRICT:"both"};
 const execute=(args,env)=>{const r=f.run(args,{...strict,...env});assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 execute(f.review,{});
 const primary={FIXTURE_ADMISSION:"primary",DEPLOY_APPROVAL_STATE_DIR:path.join(f.tmp,"primary-state")};
 const secondary={FIXTURE_ADMISSION:"secondary",DEPLOY_APPROVAL_STATE_DIR:path.join(f.tmp,"secondary-state")};
 const issue=env=>{const r=execute(["preapprove",f.planFile,"--session","local-fixture"],env);const tokens=r.stdout.match(/\b(?:PLAN|STEP)-[A-F0-9]{64}\b/g);assert.equal(tokens.length,3);return tokens;};
 const human=tokens=>fs.appendFileSync(f.transcriptPath,JSON.stringify({type:"user",timestamp:new Date().toISOString(),message:{role:"user",content:[{type:"text",text:tokens.join(" ")}]}})+"\n");
 const first=issue(primary);human(first);
 fs.mkdirSync(secondary.DEPLOY_APPROVAL_STATE_DIR,{recursive:true});
 fs.copyFileSync(deployPlan.stateFile(primary),deployPlan.stateFile(secondary));
 const foreign=JSON.parse(execute(["fixture-admission"],secondary).stdout);
 assert.equal(foreign.allow,false,"another admission's copied challenge must not become consent");
 assert.equal(foreign.event,"plan-approval-requested");
 assert.equal(JSON.parse(execute(["fixture-admission"],primary).stdout).allow,true);
 const second=issue(secondary);assert.equal(new Set([...first,...second]).size,6);human(second);
 assert.equal(JSON.parse(execute(["fixture-admission"],secondary).stdout).allow,true);
});

test("an admission identity must name a required registered review profile",async t=>{
 const f=registeredReviewFixture(t,"codex");
 const bad=f.run(["review-prompt",f.planFile],{FIXTURE_STRICT:"both",FIXTURE_ADMISSION:"unregistered"});
 assert.notEqual(bad.status,0);
 await assert.rejects(deployPlan.withGateConfig({root:f.root,admissionProfile:"primary"},()=>true),/registered review profiles/);
});

module.exports = {
	registeredReviewFixture,
};
