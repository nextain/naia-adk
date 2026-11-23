"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {fixture,nativeReviewer,plan}=require("./registered-executor-v3-fixtures.cjs"),commands=require("../lib/deploy-plan-commands.js");
const action=(command,extra={})=>({id:"a1",commands:[command],why_safe:"Disposable fixture operation; no actual operation is run.",...extra});
function setActions(f,actions){f.document.incident.actions=actions;
 fs.writeFileSync(f.planFile,JSON.stringify(f.document));}
test("one pure enumeration retains every namespace, entry position and literal occurrence",()=>{
 const first={id:"same",commands:["repeat","repeat"]},second={id:"same",commands:["repeat"]},document={scenario:[first],incident:{actions:[second]}};
 assert.equal(typeof commands.planCommandEntries,"function");
 const result=commands.planCommandEntries(document);
 assert.deepEqual(result.map(r=>[r.kind,r.position,r.entry]),[["scenario",0,first],["incident",0,second]]);
 assert.equal(result.flatMap(r=>r.entry.commands).length,3);
});
test("registered whole-plan preparation rejects outside-service and unclassified incident actions before every provider",t=>{
 for(const command of["az containerapp revision deactivate -n unregistered-other-prod -g sample-rg --revision unregistered-other-prod--bad","printf UNCLASSIFIED_INCIDENT"]){const f=fixture(t),provider=nativeReviewer(f);setActions(f,[action(command)]);
 const prepared=f.invoke("prepare",[f.planFile]);
 assert.notEqual(prepared.status,0,prepared.stdout+prepared.stderr);
 for(const extra of[[],["--skip-ready"]]){const reviewed=f.invoke("review",[f.planFile,"--author","codex",...extra]);
 assert.notEqual(reviewed.status,0,reviewed.stdout+reviewed.stderr);
 assert.equal(fs.existsSync(provider.log),false);}}
});
test("valid incident preparation has complete position coverage without normal allowedCommands or consent",t=>{
 const f=fixture(t),command="az containerapp revision deactivate -n sample-web-prod -g sample-rg --revision sample-web-prod--bad";setActions(f,[action(command)]);
 const prepared=f.invoke("prepare",[f.planFile]);
 assert.equal(prepared.status,0,prepared.stdout+prepared.stderr);
 const output=JSON.parse(prepared.stdout);
 for(const p of output.profiles){assert.equal(p.coverage.length,3);
 assert.deepEqual(p.coverage.map(r=>[r.kind,r.position,r.command_index]),[["scenario",0,0],["scenario",1,0],["incident",0,0]]);
 assert.equal(p.coverage[2].id,"a1");
 assert.equal(p.coverage[2].command_sha256,require("../lib/deploy-human-approval.js").commandHash(command));
 assert.equal(fs.existsSync(f.profiles.find(x=>x.id===p.id).stateDir),false);}
 const admission=f.invoke("hook",[],{tool_input:{command}});
 assert.equal(admission.status,0,admission.stderr);
 assert.equal(JSON.parse(admission.stdout).decision,"block");
 assert.match(admission.stdout,/PLAN-|전체 계획|리뷰/);
});
test("lookup preserves each plan, first matching entry and namespace priority",t=>{
 const f=fixture(t),literal=f.document.scenario[0].commands[0];f.document.scenario[0].commands.push(literal);setActions(f,[action(literal)]);
 const other=path.join(f.instance,".agents/progress/zzz-other/gates");
 fs.mkdirSync(other,{recursive:true});
 fs.writeFileSync(path.join(other,"deploy-plan.json"),JSON.stringify({...f.document,planId:"second-plan"}));
 const found=commands.plansForCommand(literal,f.instance);
 assert.equal(found.length,2);
 assert.deepEqual(found.map(row=>row.file),commands.recentPlans(f.instance).map(row=>row.file));
 for(const row of found){assert.equal(row.step.id,"s1");
 assert.equal(row.action.id,"a1");
 assert.equal(row.step.commands.length,2);}
});
test("registered coverage retains repeated literals by command position",t=>{
 const f=fixture(t);f.document.scenario[0].commands.push(f.document.scenario[0].commands[0]);
 fs.writeFileSync(f.planFile,JSON.stringify(f.document));
 const r=f.invoke("prepare",[f.planFile]);
 assert.equal(r.status,0,r.stdout+r.stderr);
 for(const p of JSON.parse(r.stdout).profiles){assert.equal(p.coverage.length,3);
 assert.equal(p.coverage[0].command_sha256,p.coverage[1].command_sha256);
 assert.deepEqual(p.coverage.map(c=>[c.kind,c.position,c.command_index]),[["scenario",0,0],["scenario",0,1],["scenario",1,0]]);}
});
test("incident pin failures reject before providers and legacy unregistered preparation stays unchanged",t=>{
 const f=fixture(t),provider=nativeReviewer(f),command="az containerapp revision deactivate -n sample-web-prod -g sample-rg --revision sample-web-prod--bad",missing=path.join(f.tmp,"missing-input");setActions(f,[action(command,{files:{[missing]:"0".repeat(64)}})]);
 const rejected=f.invoke("review",[f.planFile,"--author","codex"]);
 assert.notEqual(rejected.status,0,rejected.stdout+rejected.stderr);
 assert.equal(fs.existsSync(provider.log),false);
 setActions(f,[action("az containerapp revision deactivate -n unregistered-other-prod -g sample-rg --revision unregistered-other-prod--bad")]);
 const legacy=require("../lib/deploy-readiness.js").inspectPlanPreparation({plan:f.document,root:f.instance,cwd:f.instance,gatesDir:path.dirname(f.planFile)});
 assert.equal(legacy.ok,true,legacy.problems.join(";"));
 assert.equal(legacy.coverage,undefined);
 const registered=f.invoke("prepare",[f.planFile]);
 assert.notEqual(registered.status,0);
});
test("registered incident execution retains genuine PLAN and independent verdict without STEP consent",t=>{
 const f=fixture(t),provider=nativeReviewer(f,"VERDICT: incident\n"),command="az containerapp revision deactivate -n sample-web-prod -g sample-rg --revision sample-web-prod--bad";setActions(f,[action(command)]);
 const reviewed=f.invoke("review",[f.planFile,"--author","codex"]);
 assert.equal(reviewed.status,0,reviewed.stdout+reviewed.stderr);
 const issued=f.invoke("preapprove",[f.planFile,"--session","registered-fixture"]);
 assert.equal(issued.status,0,issued.stdout+issued.stderr);
 const plans=issued.stdout.match(/\bPLAN-[A-F0-9]{64}\b/g);
 assert.equal(plans.length,2);
 const transcript=path.join(f.tmp,"human.jsonl");
 fs.writeFileSync(transcript,JSON.stringify({type:"user",timestamp:new Date().toISOString(),message:{role:"user",content:[{type:"text",text:plans.join(" ")}]}})+"\n");
 const payload={tool_input:{command},transcript_path:transcript};const before=f.invoke("hook",[],payload);
 assert.equal(before.status,0,before.stderr);
 assert.match(JSON.parse(before.stdout).reason,/장애 판정|판정 기록/);
 const evidence=path.join(f.tmp,"evidence.txt");
 fs.writeFileSync(evidence,"Synthetic incident evidence only.\n");
 const judged=f.invoke("judge",[f.planFile,"--evidence",evidence,"--executor-session","registered-fixture"]);
 assert.equal(judged.status,0,judged.stdout+judged.stderr);
 for(const p of f.profiles){const admitted=f.invoke("hook",[],payload,{},p.id);
 assert.equal(admitted.status,0,admitted.stderr);
 assert.equal(admitted.stdout,"",admitted.stdout);
 const state=JSON.parse(fs.readFileSync(plan.stateFile({DEPLOY_APPROVAL_STATE_DIR:p.stateDir})));
 assert.equal(state.incidents.length,1);
 assert(state.challenges.filter(c=>c.kind==="step").every(c=>!c.executed?.length&&!c.approvedAt));}
 assert.equal(fs.readFileSync(provider.log,"utf8").trim().split("\n").length,3);
});
test("incident preparation accepts declared target images while execution keeps its actual preimage strict",t=>{
 const f=fixture(t),{sha}=require("./registered-executor-v3-fixtures.cjs"),target=path.join(f.instance,"target.txt"),snap=path.join(f.instance,"snapshots");
 fs.mkdirSync(snap);
 fs.writeFileSync(target,"before");
 fs.writeFileSync(path.join(snap,"before"),"before");
 fs.writeFileSync(path.join(snap,"after"),"after");
 const before=sha("before"),after=sha("after");
 f.document.file_pins=[{path:target,role:"target",before,after,before_source:path.join(snap,"before"),after_source:path.join(snap,"after"),transitions:{s1:{to:"after"},r1:{to:"before"}}}];f.document.scenario[0].files[target]=before;f.document.scenario[1].files={[target]:after};const command="az containerapp revision deactivate -n sample-web-prod -g sample-rg --revision sample-web-prod--bad";setActions(f,[action(command,{files:{[target]:after}})]);
 const prepared=f.invoke("prepare",[f.planFile]);
 assert.equal(prepared.status,0,prepared.stdout+prepared.stderr);
 const admission=f.invoke("hook",[],{tool_input:{command}});
 assert.equal(admission.status,0,admission.stderr);
 assert.match(JSON.parse(admission.stdout).reason,/target|대상|고정/);
 const provider=nativeReviewer(f);
 fs.writeFileSync(target,"third-image");
 const invalid=f.invoke("review",[f.planFile,"--author","codex"]);
 assert.notEqual(invalid.status,0,invalid.stdout+invalid.stderr);
 assert.equal(fs.existsSync(provider.log),false);
});
