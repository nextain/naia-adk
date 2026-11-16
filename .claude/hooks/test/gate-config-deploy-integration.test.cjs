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
const instanceId = "fixture-instance";
const approverId = "123456789012345678", channelId = "234567890123456789", messageId = "345678901234567890";

test("approved instance settings survive a byte change and forged copies never authorize commands", async (t) => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-deploy-integration-"));
 t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
 const root = path.join(dir, "root");
 for (const file of files) fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
 fs.writeFileSync(path.join(root, files[0]), JSON.stringify({review_models:{fable:{model:"example-model",effort:"high",runner:"claude"}}}));
 const gatePath = path.join(root, files[1]);
 fs.writeFileSync(gatePath, JSON.stringify({testHosts:["sandbox.example"], prodPatterns:[{pattern:"\\bfakectl\\b.*\\brelease\\b",service:"custom:fake"}], services:{"custom:fake":{requireDeployGate:true}}, sshAlwaysGated:[{hosts:["protected.example"],service:"ssh:fake"}]}));
 const snap = pin.snapshotGateConfig(root, files, instanceId), code = pin.approvalCode(snap.hash);
 const refs = [{code, channelId, messageId}];
 const env = { XDG_STATE_HOME: path.join(dir, "state") };
 const originalFetch = globalThis.fetch, oldState = process.env.XDG_STATE_HOME;
 process.env.XDG_STATE_HOME = env.XDG_STATE_HOME;
 t.after(() => { globalThis.fetch = originalFetch; if (oldState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldState; });
 globalThis.fetch = async () => ({ok:true,json:async()=>({id:messageId,channel_id:channelId,author:{id:approverId},content:code,timestamp:"2026-01-01T00:00:00Z"})});
 const instance = {files, instanceId, approverId, refs, token:"fixture"};
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
 const cache = path.join(pin.snapshotDirectory(env, instanceId), `${snap.hash}.json`);
 const data = JSON.parse(fs.readFileSync(cache)); data.files[1] = Buffer.from("{}").toString("base64"); fs.writeFileSync(cache,JSON.stringify(data));
 for (const cmd of [commands[1], "scp file remote.example:/tmp/file", "gcloud run deploy sample"]) {
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
 for (const command of ["ssh protected.example uptime"]) {
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
 const snapshot = pin.snapshotGateConfig(root, files, instanceId), code = pin.approvalCode(snapshot.hash);
 const instance = {files, instanceId, approverId, token:"fixture", refs:[{code,channelId,messageId}],
  fetchImpl: async () => ({ok:true,json:async()=>({id:messageId,channel_id:channelId,author:{id:approverId},content:code,timestamp:"2026-01-01T00:00:00Z"})})};
 const run = () => policy.deploy("gcloud run deploy sample", {cwd:root, session_id:"fixture"}, {rootDir:root, deployDir:path.join(root,".claude/deploy"), gateConfig:instance});
 assert.ok((await run())?.reason, "the approved current configuration still requires a deployment plan");
 assert.ok(fs.existsSync(path.join(pin.snapshotDirectory(process.env, instanceId), `${snapshot.hash}.json`)), "the approved snapshot was saved");
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

test("missing identity or approver blocks classified remote operations while leaving ordinary commands and approval tools available", async (t) => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-empty-instance-"));
 t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
 for (const name of files) { const file=path.join(dir,name); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,"{}"); }
 for (const name of [".claude/hooks/gate-config-approval.js", ".agents/scripts/approval-plan.mjs"]) { const target=path.join(dir,name); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.copyFileSync(path.resolve(__dirname,"../../..",name),target); }
 for (const instance of [{files, instanceId:"", approverId}, {files, instanceId, approverId:null}]) {
  const run = command => policy.deploy(command, {cwd:dir, session_id:"fixture"}, {rootDir:dir,deployDir:path.join(dir,".claude/deploy"),gateConfig:instance});
  for (const command of ["ls", "git status", "npm test", "true", "node .claude/hooks/gate-config-approval.js", "node .agents/scripts/approval-plan.mjs template"]) {
   assert.equal(await run(command), null, command);
  }
  for (const command of ["ssh fixture-remote uptime", "gcloud run deploy fixture-service"]) {
   assert.match((await run(command))?.reason || "", /node \.claude\/hooks\/gate-config-approval\.js/, command);
  }
 }
});

test("unapproved rules can add blocks but cannot grant exemptions or run a plugin", async (t) => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gate-untrusted-hints-"));
 t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
 const marker=path.join(dir,"plugin-ran"), plugin=path.join(dir,"plugin.cjs");
 fs.writeFileSync(plugin, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran'); module.exports={classifyCommand(){return null}};`);
 for (const name of files) fs.mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});
 fs.writeFileSync(path.join(dir,files[0]),"{}");
 fs.writeFileSync(path.join(dir,files[1]),JSON.stringify({plugin, testHosts:["fixture-test"],prodPatterns:[{pattern:"\\bfakectl\\b.*\\brelease\\b",service:"custom:fixture"},{pattern:"[",service:"broken"}]}));
 const instance={files, instanceId, approverId:null, plugins:{[plugin]:require}};
 const run=command=>policy.deploy(command,{cwd:dir,session_id:"fixture"},{rootDir:dir,deployDir:path.join(dir,".claude/deploy"),gateConfig:instance});
 assert.equal(await run("ls"),null);
 assert.match((await run("fakectl release now"))?.reason || "",/승인된 관문 설정이 없어/);
 assert.match((await run("ssh fixture-test uptime"))?.reason || "",/승인된 관문 설정이 없어/);
 assert.equal(fs.existsSync(marker),false);
});

test("strict current rules survive a verified older exemption, and offline state never authorizes one", async (t) => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gate-directional-"));
 const oldState=process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME=path.join(dir,"state");
 t.after(()=>{ if(oldState===undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME=oldState; fs.rmSync(dir,{recursive:true,force:true}); });
 for(const file of files) fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});
 fs.writeFileSync(path.join(dir,files[0]),"{}");
 const gatePath=path.join(dir,files[1]);
 fs.writeFileSync(gatePath,JSON.stringify({testHosts:["fixture-host","fixture-other"]}));
 const snapshot=pin.snapshotGateConfig(dir,files,instanceId),code=pin.approvalCode(snapshot.hash);
 let calls=0,online=true;
 const instance={files,instanceId,approverId,token:"fixture",refs:[{code,channelId,messageId}],fetchImpl:async()=>{
  calls++; if(!online) throw Error("offline");
  return {ok:true,json:async()=>({id:messageId,channel_id:channelId,author:{id:approverId},content:code,timestamp:"2026-01-01T00:00:00Z"})};
 }};
 const run=command=>policy.deploy(command,{cwd:dir,session_id:"fixture"},{rootDir:dir,deployDir:path.join(dir,".claude/deploy"),gateConfig:instance});
 assert.equal(await run("ls"),null); assert.equal(calls,0,"ordinary commands do not consult Discord");
 assert.equal(await run("ssh fixture-host uptime"),null,"verified exemption applies"); assert.ok(calls>0);
 online=false; calls=0;
 // Old receipt-style files are attacker-controlled and must have no effect.
 const crypto=require("node:crypto"), {statePath}=require("../lib/deploy-human-approval.js");
 const base=path.dirname(statePath(process.env)), key=crypto.randomBytes(32);
 const receiptDir=path.join(base,"gate-config-receipts",crypto.createHash("sha256").update(instanceId).digest("hex"));
 fs.mkdirSync(receiptDir,{recursive:true}); fs.writeFileSync(path.join(base,"gate-config-receipt.key"),key);
 const payload={hash:snapshot.hash,channelId,messageId,approverId,at:Date.now(),checked:Date.now()};
 const filename=crypto.createHash("sha256").update(`${snapshot.hash}/${channelId}/${messageId}`).digest("hex")+".json";
 fs.writeFileSync(path.join(receiptDir,filename),JSON.stringify({payload,mac:crypto.createHmac("sha256",key).update(JSON.stringify(payload)).digest("hex")}));
 const denied=await run("ssh fixture-host uptime");
 assert.match(denied?.reason||"",/디스코드 승인 확인에 실패했거나 조회가 지연/); assert.ok(calls>0);
 fs.writeFileSync(gatePath,JSON.stringify({testHosts:["fixture-host"],sshAlwaysGated:[{hosts:["fixture-host"],service:"ssh:fixture"}],prodPatterns:[{pattern:"\\bfakectl\\b.*\\brelease\\b",service:"custom:fixture"}],services:{"local:systemd:fixture.service":{}}}));
 online=true;
 for(const cmd of ["ssh fixture-host uptime","fakectl release now","ssh fixture-other 'fakectl release now'","systemctl restart fixture.service"]) assert.ok((await run(cmd))?.reason,cmd);
 fs.appendFileSync(gatePath,"\n");
 for(const cmd of ["ssh fixture-host uptime","fakectl release now","ssh fixture-other 'fakectl release now'","systemctl restart fixture.service"]) assert.ok((await run(cmd))?.reason,`one byte: ${cmd}`);
 calls=0; online=false; assert.equal(await run("git status"),null); assert.equal(calls,0);
});

test("reviewed floor survives removal and approved exemptions while extra current rules remain removable", async (t) => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gate-floor-"));
 const oldState=process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME=path.join(dir,"state");
 t.after(()=>{ if(oldState===undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME=oldState; fs.rmSync(dir,{recursive:true,force:true}); });
 for(const file of files) fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});
 fs.writeFileSync(path.join(dir,files[0]),"{}");
 const gatePath=path.join(dir,files[1]);
 const floor={prodPatterns:[{pattern:"\\bfloortool\\b.*\\bship\\b",service:"custom:floor"}], services:{"ssh:fixture-host":{},"gcloud:run:fixture-test":{},"local:systemd:fixture.service":{}}, sshAlwaysGated:[{hosts:["fixture-read"],service:"ssh:fixture-read"}]};
 fs.writeFileSync(gatePath,JSON.stringify({testHosts:["fixture-host","fixture-read","fixture-test"],prodPatterns:[{pattern:"\\bextratool\\b.*\\bship\\b",service:"custom:extra"},{pattern:"ssh fixture-read uptime",service:"custom:overlap"}]}));
 const snap=pin.snapshotGateConfig(dir,files,instanceId),code=pin.approvalCode(snap.hash);
 let calls=0;
 const instance={files,instanceId,approverId,floor,token:"fixture",refs:[{code,channelId,messageId}],fetchImpl:async()=>{calls++; return {ok:true,json:async()=>({id:messageId,channel_id:channelId,author:{id:approverId},content:code,timestamp:"2026-01-01T00:00:00Z"})};}};
 const run=command=>policy.deploy(command,{cwd:dir,session_id:"fixture"},{rootDir:dir,deployDir:path.join(dir,".claude/deploy"),gateConfig:instance});
 assert.equal(await run("ls"),null); assert.equal(calls,0);
 await plan.withGateConfig({...instance,root:dir},()=>{
  const hits=classifier.classifyProdMutations("ssh fixture-read uptime",dir,0,false,dir,{floorHints:floor});
  assert.ok(hits.some(hit=>hit.service==="custom:overlap"));
  assert.ok(hits.some(hit=>hit.service==="ssh:fixture-read"),"an approved overlapping pattern cannot hide the floor service");
 });
 for(const cmd of ["floortool ship now","extratool ship now","ssh fixture-read uptime","ssh fixture-host uptime","scp file fixture-host:/tmp/file","gcloud run deploy fixture-test","systemctl restart fixture.service"]) assert.ok((await run(cmd))?.reason,`approved: ${cmd}`);
 fs.writeFileSync(gatePath,JSON.stringify({testHosts:["fixture-host","fixture-read","fixture-test"]}));
 for(const cmd of ["floortool ship now","ssh fixture-read uptime","ssh fixture-host uptime","scp file fixture-host:/tmp/file","gcloud run deploy fixture-test","systemctl restart fixture.service"]) assert.ok((await run(cmd))?.reason,`removed: ${cmd}`);
 assert.equal(await run("extratool ship now"),null,"current-only restriction can be removed");
});

test("a later approval from another instance cannot exempt this instance after a byte change", async (t) => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gate-two-instances-"));
 const oldState=process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME=path.join(dir,"state");
 t.after(()=>{if(oldState===undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME=oldState; fs.rmSync(dir,{recursive:true,force:true});});
 const refs=[], messages={};
 const fetchImpl=async url=>{const id=String(url).split('/').pop(); return messages[id] ? {ok:true,json:async()=>messages[id]} : {ok:false};};
 const make=(name, gate, message)=>{
  const root=path.join(dir,name), id=`fixture-${name}`;
  for(const file of files) fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});
  fs.writeFileSync(path.join(root,files[0]),"{}"); fs.writeFileSync(path.join(root,files[1]),JSON.stringify(gate));
  const code=pin.approvalCode(pin.snapshotGateConfig(root,files,id).hash);
  const ref={code,channelId,messageId:message}; refs.push(ref);
  messages[message]={id:message,channel_id:channelId,author:{id:approverId},content:code,timestamp:name==='x'?'2026-02-01T00:00:00Z':'2026-01-01T00:00:00Z'};
  const instance={files,instanceId:id,approverId,refs,token:"fixture",fetchImpl};
  return {root,instance,run:command=>policy.deploy(command,{cwd:root,session_id:"fixture"},{rootDir:root,deployDir:path.join(root,".claude/deploy"),gateConfig:instance})};
 };
 const y=make('y',{prodPatterns:[{pattern:"\\bfloortool\\b.*\\bship\\b",service:"custom:floor"}]},"345678901234567890");
 const x=make('x',{testHosts:["fixture-host"]},"345678901234567891");
 assert.ok((await y.run("floortool ship now"))?.reason);
 assert.equal(await x.run("ssh fixture-host uptime"),null);
 assert.notEqual(pin.snapshotDirectory(process.env,y.instance.instanceId),pin.snapshotDirectory(process.env,x.instance.instanceId));
 fs.appendFileSync(path.join(y.root,files[1]),"\n");
 assert.ok((await y.run("floortool ship now"))?.reason);
 const xcode=refs[1].code;
 assert.equal(await pin.approvedGateConfig({...y.instance,root:y.root,refs:[refs[1]],env:{XDG_STATE_HOME:path.join(dir,"empty-state")}}),null,`foreign approval ${xcode} cannot approve Y`);
});
