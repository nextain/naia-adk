"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {spawnSync}=require("node:child_process"),{pathToFileURL}=require("node:url");
const readiness=require("../lib/deploy-readiness.js"),planLib=require("../lib/deploy-plan.js");
const sha=x=>crypto.createHash("sha256").update(x).digest("hex");
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"plan-preparation-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const gates=path.join(root,".agents/progress/test/gates"),script=path.join(root,"change.cjs"),target=path.join(root,"target.txt"),before=path.join(root,"before.txt"),after=path.join(root,"after.txt");fs.mkdirSync(gates,{recursive:true});fs.mkdirSync(path.join(root,"config"));
 fs.writeFileSync(script,"process.stdout.write('disposable');\n");for(const [p,b]of[[target,"before"],[before,"before"],[after,"after"]])fs.writeFileSync(p,b);
 const service="local:preparation-fixture",command=id=>`node ${script} ${id}`,cfg={services:{[service]:{allowCustomCommands:true,allowedCommands:["^node "+script.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+" (s1|r1)$"],requiredFiles:["change.cjs"]}}};
 const cfgFile=path.join(root,"config/deploy-gate.json");fs.writeFileSync(cfgFile,JSON.stringify(cfg));
 const plan={...structuredClone(planLib.TEMPLATE),planId:"disposable-preparation",createdAt:new Date().toISOString(),author_model:"codex",services:[service],
  what_why:"Validate a disposable read-only preparation plan.",
  changes:["Only temporary local target changes."],
  risks:{items:["Temporary target may remain after."],worst_case:"Disposable file remains changed."},
  irreversible:["No external writes."],
  disconnect_safety:"Inspect the exact temporary target.",
  rerun_safety:{lock:"No execution occurs.",run_dir:root,no_latest_pick:"Use this exact directory."},
  success_verification:"Read the temporary target.",
  residual_risks:["Fixture only."],
  incident:{criteria:["Temporary target differs."],actions:[]},
  architecture_fit:{original_request:"Inspect a temporary whole plan.",parent_structure:"The existing shared readiness engine.",acceptance_rationale:"Use the separate read-only preparation surface."},
  scenario:[{id:"s1",title:"Apply disposable file",commands:[command("s1")],files:{[script]:sha(fs.readFileSync(script)),[target]:sha("before")},success_check:"Read after.",on_failure:"Stop."},{id:"r1",branch:"rollback",title:"Restore disposable file",commands:[command("r1")],files:{[script]:sha(fs.readFileSync(script)),[target]:sha("after")},success_check:"Read before.",on_failure:"Stop."}],
  file_pins:[{path:target,role:"target",before:sha("before"),after:sha("after"),before_source:before,after_source:after,transitions:{s1:{to:"after"},r1:{to:"before"}}}],rollback:{method:"Reviewed r1",duration:"One second",step_ids:["r1"]}};
 const inspect=()=>readiness.inspectPlanPreparation({plan,root,cwd:root,gatesDir:gates});return{root,gates,script,target,before,after,service,command,cfg,cfgFile,plan,inspect};
}
test("whole-plan preparation accepts declared future preimages without mutating approval state",t=>{
 const f=fixture(t),stateDir=path.join(f.root,"approval-state");fs.mkdirSync(stateDir);const state=path.join(stateDir,"deploy-challenges.json"),previous=process.env.DEPLOY_APPROVAL_STATE_DIR;process.env.DEPLOY_APPROVAL_STATE_DIR=stateDir;t.after(()=>{if(previous===undefined)delete process.env.DEPLOY_APPROVAL_STATE_DIR;else process.env.DEPLOY_APPROVAL_STATE_DIR=previous;});fs.writeFileSync(state,'{"sentinel":"unchanged"}');const stateBefore=fs.readFileSync(state);
 const result=f.inspect();assert.equal(result.ok,true,JSON.stringify(result.problems));assert.equal(result.purpose,"plan-preparation/v1");assert.deepEqual(result.steps.map(s=>s.status),["READY_CURRENT","READY_DECLARED_TRANSITION"]);assert.deepEqual(fs.readFileSync(state),stateBefore);assert.deepEqual(fs.readdirSync(stateDir),["deploy-challenges.json"]);
 assert.throws(()=>planLib.verifyTargetPreconditions(f.plan,f.root,f.plan.scenario[1]),/시작 지문 불일치/);
 fs.writeFileSync(f.target,"after");const after=f.inspect();assert.equal(after.ok,true,JSON.stringify(after.problems));assert.deepEqual(after.steps.map(s=>s.status),["READY_DECLARED_TRANSITION","READY_CURRENT"]);assert.throws(()=>planLib.verifyTargetPreconditions(f.plan,f.root,f.plan.scenario[0]),/시작 지문 불일치/);
});
for(const [name,mutate]of[
 ["wrong command",f=>f.plan.scenario[1].commands[0]+=" --foreign"],
 ["wrong service",f=>f.plan.services.push("local:unregistered")],
 ["unused registered service",f=>{f.plan.services.push("unused.service");f.cfg.services["unused.service"]={allowCustomCommands:true,allowedCommands:["^node /unrelated/fixed.cjs$"]};fs.writeFileSync(f.cfgFile,JSON.stringify(f.cfg));}],
 ["missing immutable",f=>delete f.plan.scenario[1].files[f.script]],
 ["changed immutable",f=>fs.appendFileSync(f.script,"changed")],
 ["wrong preimage",f=>f.plan.scenario[1].files[f.target]=sha("before")],
 ["corrupt source",f=>fs.writeFileSync(f.after,"corrupt")],
 ["third current state",f=>fs.writeFileSync(f.target,"third")],
 ["aliased source",f=>f.plan.file_pins[0].before_source=f.target],
 ["missing future transition",f=>delete f.plan.file_pins[0].transitions.r1],
 ["unsupported future plugin",f=>{const p=path.join(f.root,"plugin.cjs");fs.writeFileSync(p,"module.exports={verifyPlanBinding:()=>({ok:true})};");f.cfg.plugin=p;fs.writeFileSync(f.cfgFile,JSON.stringify(f.cfg));}],
])test("preparation rejects "+name,t=>{const f=fixture(t);mutate(f);const r=f.inspect();assert.equal(r.ok,false,JSON.stringify(r));assert(r.problems.length);});
test("official prepare CLI binds exact plan, engine and both policy profiles without approval writes",t=>{
 const f=fixture(t),common=path.join(f.root,"common-site"),state=path.join(f.root,"state");fs.mkdirSync(common);fs.mkdirSync(state);fs.writeFileSync(path.join(state,"sentinel"),"untouched");
 assert.equal(spawnSync("/usr/bin/git",["-C",f.root,"init","-q"]).status,0);
 const file=path.join(f.gates,"deploy-plan.json");fs.writeFileSync(file,JSON.stringify(f.plan));
 const entry=pathToFileURL(path.resolve(__dirname,"../../../.agents/scripts/approval-plan.mjs")).href;
 const options={root:f.root,reviewProfiles:[{id:"common",root:common,policy:"strict-defaults"},{id:"company",root:f.root,policy:"strict-defaults"}]};
 const script=`import {runApprovedApprovalPlan} from ${JSON.stringify(entry)};await runApprovedApprovalPlan(${JSON.stringify(options)},["prepare",${JSON.stringify(file)}]);`;
 const r=spawnSync(process.execPath,["--input-type=module","-e",script],{cwd:f.root,env:{...process.env,DEPLOY_APPROVAL_STATE_DIR:state},encoding:"utf8",timeout:15000});assert.equal(r.status,0,r.stdout+r.stderr);const out=JSON.parse(r.stdout);
 assert.equal(out.purpose,"plan-preparation/v1");assert.equal(out.plan_sha256,sha(fs.readFileSync(file)));assert.match(out.engine_commit,/^[a-f0-9]{40}$/);assert.match(out.engine_entry_sha256,/^[a-f0-9]{64}$/);assert.match(out.executor_manifest_sha256,/^[a-f0-9]{64}$/);assert.equal(out.ok,true);
 assert.deepEqual(out.profiles.map(p=>p.id),["common","company"]);for(const p of out.profiles){assert.match(p.policy_sha256,/^[a-f0-9]{64}$/);assert.match(p.scope_sha256,/^[a-f0-9]{64}$/);assert.match(p.input_manifest_sha256,/^[a-f0-9]{64}$/);assert.deepEqual(p.steps.map(s=>s.id),["s1","r1"]);}
 assert.deepEqual(fs.readdirSync(state),["sentinel"]);assert.equal(fs.readFileSync(path.join(state,"sentinel"),"utf8"),"untouched");assert.equal(fs.existsSync(path.join(f.root,".claude/deploy/audit.jsonl")),false);assert.equal(out.review.ok,false,"preparation never fabricates model review");
});
test("actual execution hook rejects future preimages despite planning payload and environment injection",t=>{
 const f=fixture(t);assert.equal(spawnSync("/usr/bin/git",["-C",f.root,"init","-q"]).status,0);fs.writeFileSync(path.join(f.gates,"deploy-plan.json"),JSON.stringify(f.plan));
 const state=path.join(f.root,"state");fs.mkdirSync(state);const stateFile=path.join(state,"deploy-challenges.json");fs.writeFileSync(stateFile,'{"challenges":[],"sentinel":"fixed"}');
 const env={...process.env,DEPLOY_READINESS_ROOT:f.root,DEPLOY_APPROVAL_STATE_DIR:state,DEPLOY_AUDIT_PATH:path.join(f.root,"audit.jsonl"),PLAN_PREPARATION_OK:"1",DEPLOY_PLANNING_RESULT:JSON.stringify(f.inspect())};
 const payload={cwd:f.root,session_id:"preparation-injection",tool_name:"Bash",tool_input:{command:f.command("r1")},planning_result:f.inspect(),planning_mode:true};
 const r=spawnSync(process.execPath,[path.resolve(__dirname,"../deploy-guard.js")],{cwd:f.root,env,input:JSON.stringify(payload),encoding:"utf8",timeout:10000});assert.equal(r.status,0,r.stderr);const decision=JSON.parse(r.stdout);assert.equal(decision.decision,"block");assert.match(decision.reason,/시작 지문 불일치/);assert.equal(fs.readFileSync(stateFile,"utf8"),'{"challenges":[],"sentinel":"fixed"}');
});
test("the new preparation executable participates in the real cold cache boundary",()=>{
 const file=path.resolve(__dirname,"../lib/deploy-readiness-planning.js"),entry=pathToFileURL(path.resolve(__dirname,"../../../.agents/scripts/approval-plan.mjs")).href;
 const code=`import {createRequire} from "node:module";const r=createRequire(import.meta.url);r.cache[${JSON.stringify(file)}]={exports:{}};await import(${JSON.stringify(entry)});`;
 const r=spawnSync(process.execPath,["--input-type=module","-e",code],{encoding:"utf8",timeout:10000});assert.equal(r.status,1);assert.match(r.stderr,/require\.cache/);
 assert(planLib.REVIEW_EXECUTOR_FILES.includes(".claude/hooks/lib/deploy-readiness-planning.js"));
});
module.exports={fixture};
