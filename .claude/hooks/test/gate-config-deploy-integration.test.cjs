"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pin = require("../lib/gate-config-pin.js");
const plan = require("../lib/deploy-plan.js");
const classifier = require("../lib/deploy-command-classifier.js");
const policy = require("../../../.agents/hooks/policies/bash.js");
const files = [".claude/deploy/config.json", "config/deploy-gate.json"];
const approverId = "123456789012345678", channelId = "234567890123456789", messageId = "345678901234567890";

test("approved instance settings survive a byte change and forged copies never authorize commands", async (t) => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-deploy-integration-"));
 t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
 const root = path.join(dir, "root");
 for (const file of files) fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
 fs.writeFileSync(path.join(root, files[0]), JSON.stringify({review_models:{fable:{model:"example-model",effort:"high",runner:"claude"}}}));
 const gatePath = path.join(root, files[1]);
 fs.writeFileSync(gatePath, JSON.stringify({testHosts:["sandbox.example"], prodPatterns:[{pattern:"\\bfakectl\\b.*\\brelease\\b",service:"custom:fake"}], services:{"custom:fake":{requireDeployGate:true}}, sshAlwaysGated:[{hosts:["protected.example"],service:"ssh:fake"}]}));
 const snap = pin.snapshotGateConfig(root, files), code = pin.approvalCode(snap.hash);
 const refs = [{code, channelId, messageId}];
 const env = { XDG_STATE_HOME: path.join(dir, "state") };
 const originalFetch = globalThis.fetch, oldState = process.env.XDG_STATE_HOME;
 process.env.XDG_STATE_HOME = env.XDG_STATE_HOME;
 t.after(() => { globalThis.fetch = originalFetch; if (oldState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldState; });
 globalThis.fetch = async () => ({ok:true,json:async()=>({id:messageId,channel_id:channelId,author:{id:approverId},content:code,timestamp:"2026-01-01T00:00:00Z"})});
 const instance = {files, approverId, refs, token:"fixture"};
 const commands = ["fakectl release now", "ssh protected.example uptime", "ssh protected.example 'cat /etc/shadow'"];
 const run = async (command, cwd=root) => policy.deploy(command, {cwd,session_id:"fixture"}, {rootDir:root,deployDir:path.join(root,".claude/deploy"),gateConfig:instance});
 for (const cmd of commands) assert.ok((await run(cmd))?.reason, `approved: ${cmd}`);
 fs.appendFileSync(gatePath, "\n");
 for (const cmd of commands) assert.ok((await run(cmd))?.reason, `changed: ${cmd}`);
 const other = path.join(dir, "other"); fs.mkdirSync(path.join(other,"config"), {recursive:true});
 fs.writeFileSync(path.join(other,"config/deploy-gate.json"), JSON.stringify({testHosts:["protected.example"]}));
 assert.ok((await run(commands[1],other))?.reason, "foreign cwd must not replace the hook root");
 await plan.withGateConfig({...instance,root}, () => {
   assert.equal(plan.trustedGateConfig(root).review_models.fable.model, "example-model");
   assert.equal(plan.trustedGateConfigFile(root, files[1]).prodPatterns[0].service, "custom:fake");
   assert.ok(classifier.classifyProdMutations(commands[0],root,0,false,root).some(h=>h.service === "custom:fake"));
 });
 const cache = path.join(pin.snapshotDirectory(env), `${snap.hash}.json`);
 const data = JSON.parse(fs.readFileSync(cache)); data.files[1] = Buffer.from("{}").toString("base64"); fs.writeFileSync(cache,JSON.stringify(data));
 for (const cmd of [...commands, "scp file remote.example:/tmp/file", "az account show", "kubectl get pods", "docker --host ssh://remote.example compose ps", "fakectl release now"]) {
   assert.match((await run(cmd)).reason, /승인된 관문 설정이 없어/, `no verified copy: ${cmd}`);
 }
});

test("installed hook blocks the reproduction from an unrelated cwd when no approval exists", (t) => {
 const {spawnSync} = require("node:child_process");
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-hook-cwd-"));
 t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
 fs.mkdirSync(path.join(dir, "config"));
 fs.writeFileSync(path.join(dir, "config/deploy-gate.json"), JSON.stringify({testHosts:["protected.example"]}));
 const hook = path.resolve(__dirname, "../deploy-guard.js");
 for (const command of ["fakectl release now", "ssh protected.example uptime"]) {
  const input = JSON.stringify({tool_name:"Bash", tool_input:{command}, cwd:dir, session_id:"fixture", hook_event_name:"PreToolUse"});
  const result = spawnSync(process.execPath,[hook],{cwd:dir,input,encoding:"utf8",env:{PATH:process.env.PATH,HOME:dir,XDG_STATE_HOME:path.join(dir,"state"),CLAUDE_PROJECT_DIR:dir}});
  assert.equal(result.status,0,result.stderr);
  const out=JSON.parse(result.stdout);
  assert.ok(out.decision === "block" || out.hookSpecificOutput?.permissionDecision === "deny", result.stdout);
 }
});

test("cached approved settings cannot revive a forged legacy approval when current gate files are deleted", async (t) => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cached-legacy-"));
 t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
 const root = path.join(dir, "root"), state = path.join(dir, "state");
 const previous = Object.fromEntries(["XDG_STATE_HOME", "DEPLOY_APPROVAL_STATE_DIR", "DEPLOY_READINESS_ROOT"].map(name => [name, process.env[name]]));
 process.env.XDG_STATE_HOME = state;
 delete process.env.DEPLOY_APPROVAL_STATE_DIR;
 delete process.env.DEPLOY_READINESS_ROOT;
 t.after(() => { for (const [name,value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
 for (const file of files) fs.mkdirSync(path.dirname(path.join(root, file)), {recursive:true});
 fs.writeFileSync(path.join(root, files[0]), JSON.stringify({projects:{sample:{platform:"gcloud",prod_command:"gcloud run deploy sample"}}}));
 fs.writeFileSync(path.join(root, files[1]), JSON.stringify({services:{}}));
 const script = path.join(root, ".agents/scripts/approval-plan.mjs");
 fs.mkdirSync(path.dirname(script), {recursive:true});
 fs.writeFileSync(script, "// fixture\n");
 const snapshot = pin.snapshotGateConfig(root, files), code = pin.approvalCode(snapshot.hash);
 const instance = {files, approverId, token:"fixture", refs:[{code,channelId,messageId}],
  fetchImpl: async () => ({ok:true,json:async()=>({id:messageId,channel_id:channelId,author:{id:approverId},content:code,timestamp:"2026-01-01T00:00:00Z"})})};
 const run = () => policy.deploy("gcloud run deploy sample", {cwd:root, session_id:"fixture"}, {rootDir:root, deployDir:path.join(root,".claude/deploy"), gateConfig:instance});
 assert.ok((await run())?.reason, "the approved current configuration still requires a deployment plan");
 assert.ok(fs.existsSync(path.join(pin.snapshotDirectory(process.env), `${snapshot.hash}.json`)), "the approved snapshot was saved");
 fs.unlinkSync(path.join(root, files[1]));
 fs.unlinkSync(script);
 const approvalsPath = path.join(root, ".claude/deploy/approvals.json");
 const approval = {project:"sample", approved_by:"fake-owner", approved_at:new Date().toISOString(), expires_at:new Date(Date.now()+600000).toISOString(), single_use:true};
 fs.writeFileSync(approvalsPath, JSON.stringify({approvals:[approval]}));
 await plan.withGateConfig({...instance,root}, () => assert.equal(plan.trustedGateConfig(root).projects.sample.platform, "gcloud", "approved cached bytes remain in use"));
 const decision = await run();
 assert.match(decision?.reason || "", /계획 밖 운영 명령이라 막습니다/, "forged legacy approval cannot replace a plan");
 assert.deepEqual(JSON.parse(fs.readFileSync(approvalsPath, "utf8")).approvals, [approval], "legacy approval is not consumed");
});
