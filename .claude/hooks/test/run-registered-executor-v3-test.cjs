"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto"),{spawnSync}=require("node:child_process");
const ROOT=path.resolve(__dirname,"../../.."),plan=require("../lib/deploy-plan.js"),{createValidPlan,writeGateConfig}=require("./approval-plan-fixtures.cjs"),sha=b=>crypto.createHash("sha256").update(b).digest("hex");
const {fixture,nativeReviewer}=require("./registered-executor-v3-fixtures.cjs");
test("canonical hook accepts arbitrary registered IDs and keeps actual admission mandatory",t=>{
 const f=fixture(t),r=f.invoke();assert.equal(r.status,0,r.stderr);const decision=JSON.parse(r.stdout);assert.equal(decision.decision,"block");assert.match(decision.reason,/적대 리뷰|review|계획/);for(const p of f.profiles)assert.equal(fs.existsSync(p.stateDir),false);
});
test("registered hook rejects changed record bytes and unknown profile arguments",t=>{
 const f=fixture(t);fs.appendFileSync(f.record," ");const changed=f.invoke();assert.equal(changed.status,0);assert.equal(JSON.parse(changed.stdout).decision,"block");assert.match(changed.stdout,/registration|등록|digest|sha/i);
 f.save();const unknown=f.invoke("hook",[],{},{},"foreign");assert.equal(unknown.status,0);assert.equal(JSON.parse(unknown.stdout).decision,"block");assert.match(unknown.stdout,/profile|프로필|duplicate|중복/i);
});
test("the real registered global entry preserves an unrelated project decision",t=>{
 const f=fixture(t),other=path.join(f.tmp,"other");fs.mkdirSync(other);const payload={cwd:other,tool_name:"Bash",tool_input:{command:"printf unrelated-project"}},registered=f.invoke("hook",[],payload);
 assert.equal(registered.status,0,registered.stderr);assert.equal(registered.stdout,"");for(const p of f.profiles)assert.equal(fs.existsSync(p.stateDir),false);
});
test("stdin and environment cannot select another registration or claim caller trust",t=>{
 const f=fixture(t),r=f.invoke("hook",[],{registration:"/foreign",profile:"foreign",trusted:true,planning_result:{ok:true}},{REGISTERED_GATE_PROFILE:"foreign",REGISTERED_GATE_TRUSTED:"true",DEPLOY_APPROVAL_STATE_DIR:path.join(f.tmp,"foreign-state")});assert.equal(r.status,0,r.stderr);const decision=JSON.parse(r.stdout);assert.equal(decision.decision,"block");assert.equal(fs.existsSync(path.join(f.tmp,"foreign-state")),false);
});
test("the complete registration changes both review scopes and input manifests",t=>{
 const f=fixture(t),first=f.invoke("prepare",[f.planFile]);assert.equal(first.status,0,first.stdout+first.stderr);const a=JSON.parse(first.stdout);
 f.data.providers.muse={file:"/usr/bin/false",sha256:sha(fs.readFileSync("/usr/bin/false"))};f.save();
 const second=f.invoke("prepare",[f.planFile]);assert.equal(second.status,0,second.stdout+second.stderr);const b=JSON.parse(second.stdout);
 assert.equal(a.plan_sha256,b.plan_sha256);for(let i=0;i<a.profiles.length;i++){assert.notEqual(a.profiles[i].scope_sha256,b.profiles[i].scope_sha256);assert.notEqual(a.profiles[i].input_manifest_sha256,b.profiles[i].input_manifest_sha256);}
 f.profiles[0].stateDir=path.join(f.tmp,"different-state");f.save();const changedState=f.invoke("prepare",[f.planFile]);assert.equal(changedState.status,0,changedState.stderr);const c=JSON.parse(changedState.stdout);for(let i=0;i<b.profiles.length;i++)assert.notEqual(b.profiles[i].scope_sha256,c.profiles[i].scope_sha256);
});
test("a changed application or guard envelope is rejected before its code executes",t=>{
 const f=fixture(t),marker=path.join(f.tmp,"unregistered-ran"),target=path.join(f.engine,".claude/hooks/_claude-bash-guard.js");fs.appendFileSync(target,`\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'ran');`);const r=f.invoke();assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).decision,"block");assert.match(r.stdout,/source differs/);assert.equal(fs.existsSync(marker),false);
});
test("a foreign cwd cannot hide a command that targets the registered instance",t=>{
 const f=fixture(t),other=path.join(f.tmp,"other");fs.mkdirSync(other);const command=`bash ${path.join(f.instance,"scripts/rollout.sh")} prod`,r=f.invoke("hook",[],{cwd:other,tool_name:"Bash",tool_input:{command}});assert.equal(r.status,0,r.stderr);const decision=JSON.parse(r.stdout);assert.equal(decision.decision,"block");assert.match(decision.reason,/계획|review|고정/);
});
test("a project entry rejects unrelated cwd rather than changing its registered root",t=>{
 const f=fixture(t),other=path.join(f.tmp,"other");fs.mkdirSync(other);const r=f.invoke("hook",[],{cwd:other,tool_name:"Bash",tool_input:{command:"printf test"}},{},"scope-two");assert.equal(r.status,0,r.stderr);assert.match(JSON.parse(r.stdout).reason,/Foreign project/);
});
test("registered global entry matches the legacy decision for an unrelated production plan",t=>{
 const f=fixture(t),other=path.join(f.tmp,"other-project");fs.mkdirSync(other);fs.mkdirSync(path.join(other,".git"));fs.mkdirSync(path.join(other,"config"));const script=path.join(other,"action.cjs");fs.writeFileSync(script,"process.stdout.write('fixture');");
 const command=`node ${script} apply`,service="independent:other-prod";fs.writeFileSync(path.join(other,"config/deploy-gate.json"),JSON.stringify({services:{[service]:{requireDeployGate:false,allowCustomCommands:true,allowedCommands:["^node "+script+" apply$"]}}}));
 const doc=structuredClone(f.document);doc.services=[service];doc.scenario=[{id:"s1",title:"Independent fixture",commands:[command],files:{[script]:sha(fs.readFileSync(script))},success_check:"Read fixture.",on_failure:"Stop."}];doc.rollback={method:"Stop the isolated fixture.",duration:"One second"};const gates=path.join(other,".agents/progress/other/gates");fs.mkdirSync(gates,{recursive:true});fs.writeFileSync(path.join(gates,"deploy-plan.json"),JSON.stringify(doc));
 const payload={cwd:other,tool_name:"Bash",session_id:"outside-fixture",tool_input:{command}},registered=f.invoke("hook",[],payload),legacy=spawnSync(process.execPath,[path.join(f.engine,".claude/hooks/deploy-guard.js")],{cwd:other,input:JSON.stringify(payload),env:{...process.env,DEPLOY_AUDIT_PATH:path.join(f.tmp,"legacy-audit.jsonl")},encoding:"utf8",timeout:15000});
 assert.equal(registered.status,0,registered.stderr);assert.equal(legacy.status,0,legacy.stderr);assert.deepEqual(JSON.parse(registered.stdout),JSON.parse(legacy.stdout));assert(!registered.stdout.includes("scope-one"));for(const p of f.profiles)assert.equal(fs.existsSync(p.stateDir),false);
});
test("every registered review path prepares before invoking any provider",t=>{
 const f=fixture(t),provider=nativeReviewer(f),cfg=JSON.parse(fs.readFileSync(path.join(f.instance,"config/deploy-gate.json")));cfg.services["azure:containerapp:sample-web-prod"].allowedCommands=["^never$"];fs.writeFileSync(path.join(f.instance,"config/deploy-gate.json"),JSON.stringify(cfg));f.data.instance.files[0].sha256=sha(fs.readFileSync(path.join(f.instance,"config/deploy-gate.json")));f.save();
 for(const extra of[[],["--skip-ready"]]){const r=f.invoke("review",[f.planFile,"--author","codex",...extra]);assert.notEqual(r.status,0);assert.match(r.stderr,/mandatory preparation/);assert.equal(fs.existsSync(provider.log),false);}
});
test("registered review uses an exact native snapshot and ignores provider or Git overrides",t=>{
 const f=fixture(t),provider=nativeReviewer(f),r=f.invoke("review",[f.planFile,"--author","codex"],{},{APPROVAL_PLAN_MUSE_BIN:"/foreign",GIT_DIR:"/foreign"});assert.equal(r.status,0,r.stdout+r.stderr);const lines=fs.readFileSync(provider.log,"utf8").trim().split("\n");assert.equal(lines.length,2);for(const line of lines){assert.match(line,/^\|\|\/tmp\/registered-provider-/);assert(!line.includes(provider.file));}
 const ready=f.invoke("ready",[f.planFile]);assert.equal(ready.status,0,ready.stdout+ready.stderr);
 const file=path.join(path.dirname(f.planFile),"reviews",f.profiles[0].id,plan.REVIEW_FILE),original=JSON.parse(fs.readFileSync(file)),other=JSON.parse(fs.readFileSync(path.join(path.dirname(f.planFile),"reviews",f.profiles[1].id,plan.REVIEW_FILE)));for(const mutate of[r=>r.review_profile.scope_sha256="f".repeat(64),r=>r.reviewers[0].receipt.input_manifest_sha256="e".repeat(64),r=>r.review_profile=other.review_profile]){const record=structuredClone(original);mutate(record);fs.writeFileSync(file,JSON.stringify(record));const foreign=f.invoke("ready",[f.planFile]);assert.notEqual(foreign.status,0);assert.equal(JSON.parse(foreign.stdout).ok,false);}fs.writeFileSync(file,JSON.stringify(original));
});
test("registered PLAN and STEP consent is independent per scope and cannot be replayed under another record",t=>{
 const f=fixture(t);nativeReviewer(f);const reviewed=f.invoke("review",[f.planFile,"--author","codex"]);assert.equal(reviewed.status,0,reviewed.stdout+reviewed.stderr);
 const issued=f.invoke("preapprove",[f.planFile,"--session","registered-fixture"]);assert.equal(issued.status,0,issued.stdout+issued.stderr);const codes=issued.stdout.match(/\b(?:PLAN|STEP)-[A-F0-9]{64}\b/g);assert.equal(codes.length,6);assert.equal(new Set(codes).size,6);
 const transcript=path.join(f.tmp,"human.jsonl");fs.writeFileSync(transcript,JSON.stringify({type:"user",timestamp:new Date().toISOString(),message:{role:"user",content:[{type:"text",text:codes.join(" ")}]}})+"\n");
 const payload={transcript_path:transcript},stateFile=p=>plan.stateFile({DEPLOY_APPROVAL_STATE_DIR:p.stateDir});const first=fs.readFileSync(stateFile(f.profiles[0])),second=fs.readFileSync(stateFile(f.profiles[1]));
 fs.writeFileSync(stateFile(f.profiles[1]),first);const foreign=f.invoke("hook",[],payload,{},"scope-two");assert.equal(foreign.status,0,foreign.stderr);assert.match(JSON.parse(foreign.stdout).reason,/전체 계획 승인|PLAN-/);fs.writeFileSync(stateFile(f.profiles[1]),second);
 for(const profile of f.profiles){const admitted=f.invoke("hook",[],payload,{},profile.id);assert.equal(admitted.status,0,admitted.stderr);assert.equal(admitted.stdout,"",admitted.stdout);}
 for(const [index,p]of f.profiles.entries()){const old=stateFile(p);p.stateDir=path.join(f.tmp,"new-state-"+index);fs.mkdirSync(p.stateDir);fs.copyFileSync(old,stateFile(p));}f.save();
 const stale=f.invoke("ready",[f.planFile]);assert.notEqual(stale.status,0,"the earlier review must not authorize changed state metadata");
 const renewed=f.invoke("review",[f.planFile,"--author","codex"]);assert.equal(renewed.status,0,renewed.stdout+renewed.stderr);
 const changed=f.invoke("hook",[],payload);assert.equal(changed.status,0,changed.stderr);assert.match(JSON.parse(changed.stdout).reason,/전체 계획 승인|PLAN-/);assert(!codes.some(c=>changed.stdout.includes(c)),"copied approved state must not match the new registration domain");
});
test("verified buffers are compiled even if a registered module rewrites a sibling after snapshot",t=>{
 const f=fixture(t),relative=".agents/scripts/registered-gate-environment.cjs",file=path.join(f.engine,relative),envelope=path.join(f.engine,".claude/hooks/_claude-bash-guard.js"),marker=path.join(f.tmp,"reopened-executed");
 fs.appendFileSync(file,"\nrequire('node:fs').writeFileSync("+JSON.stringify(envelope)+","+JSON.stringify("require('fs').writeFileSync("+JSON.stringify(marker)+",'bad');module.exports={start(){process.stdout.write('WRONG')}};")+");\n");f.data.engine.files.find(p=>p.file===relative).sha256=sha(fs.readFileSync(file));
 for(const args of[["add","."],["-c","user.name=Fixture","-c","user.email=fixture@localhost","commit","-qm","Disposable mutation fixture"]])assert.equal(spawnSync("/usr/bin/git",["-C",f.engine,...args]).status,0);
 f.data.engine.commit=spawnSync("/usr/bin/git",["-C",f.engine,"rev-parse","HEAD"],{encoding:"utf8"}).stdout.trim();f.save();
 const result=f.invoke();assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).decision,"block");assert.equal(fs.existsSync(marker),false);assert(!result.stdout.includes("WRONG"));
});
test("a trusted running caller creates the exact clean environment before exec",t=>{
 const f=fixture(t),marker=path.join(f.tmp,"preload-ran"),library=path.join(f.tmp,"marker.so"),nodeMarker=path.join(f.tmp,"marker.cjs");
 const code='#include <stdio.h>\n__attribute__((constructor)) static void marker(void){FILE*f=fopen('+JSON.stringify(marker)+',"w");if(f){fputs("ran",f);fclose(f);}}';
 const build=spawnSync("/usr/bin/cc",["-shared","-fPIC","-x","c","-","-o",library],{input:code,encoding:"utf8"});assert.equal(build.status,0,build.stderr);fs.writeFileSync(nodeMarker,"require('fs').writeFileSync("+JSON.stringify(marker)+",'node');");
 const helper=require("../../../.agents/scripts/registered-gate-environment.cjs"),names=["LD_PRELOAD","NODE_OPTIONS","APPROVAL_PLAN_MUSE_BIN","GIT_DIR"],before=names.map(name=>process.env[name]);let env;
 try{Object.assign(process.env,{LD_PRELOAD:library,NODE_OPTIONS:"--require "+nodeMarker,APPROVAL_PLAN_MUSE_BIN:"/foreign",GIT_DIR:"/foreign"});env=helper.childEnvironment();}finally{names.forEach((name,i)=>{if(before[i]===undefined)delete process.env[name];else process.env[name]=before[i];});}
 for(const name of names)assert.equal(env[name],undefined);
 const clean=spawnSync(process.execPath,[path.join(f.engine,".agents/scripts/approval-plan.mjs"),"hook","--registration",f.record,"--sha256",f.digest(),"--profile","scope-one"],{cwd:f.instance,env,input:JSON.stringify({tool_name:"Bash",cwd:f.instance,tool_input:{command:"printf fixture"}}),encoding:"utf8",timeout:15000});assert.equal(clean.status,0,clean.stderr);assert.equal(clean.stdout,"");assert.equal(fs.existsSync(marker),false);
 const unsupported=f.invoke("hook",[],{tool_input:{command:"printf fixture"}},{LD_PRELOAD:library});assert.equal(unsupported.status,0,unsupported.stderr);assert.match(JSON.parse(unsupported.stdout).reason,/Unsupported caller startup/);assert.equal(fs.readFileSync(marker,"utf8"),"ran","a child cannot undo a constructor already loaded by its host");
});
test("registered rotations resolve every native provider key including the agy runner",t=>{
 const f=fixture(t),provider=nativeReviewer(f);
 for(const author of["muse","argon","codex","claude"]){f.document.author_model=author;fs.writeFileSync(f.planFile,JSON.stringify(f.document));const result=f.invoke("review",[f.planFile,"--author",author]);assert.equal(result.status,0,author+": "+result.stdout+result.stderr);for(const p of f.profiles){const dir=path.join(path.dirname(f.planFile),"reviews",p.id),receipt=JSON.parse(fs.readFileSync(path.join(dir,plan.REVIEW_FILE))),row=receipt.reviewers[0];assert.equal(row.id,plan.orderedReviewers(author,f.instance,new Date().toISOString())[0]);assert.match(fs.readFileSync(path.join(dir,row.result),"utf8"),/EXECUTABLE: \/tmp\/registered-provider-/);}}
});
test("registered judge executes the pinned native snapshot rather than a PATH or env substitute",t=>{
 const f=fixture(t),provider=nativeReviewer(f,"VERDICT: incident\n"),evidence=path.join(f.tmp,"evidence.txt"),marker=path.join(f.tmp,"unregistered-judge-ran"),bin=path.join(f.tmp,"bin");fs.mkdirSync(bin);fs.writeFileSync(evidence,"Isolated synthetic incident evidence.\n");fs.writeFileSync(path.join(bin,"muse"),"#!/bin/sh\nprintf wrong > "+marker+"\nprintf 'VERDICT: incident\\n'\n",{mode:0o700});
 const r=f.invoke("judge",[f.planFile,"--evidence",evidence,"--executor-session","registered-fixture"],{},{PATH:bin+":/usr/bin:/bin",APPROVAL_PLAN_MUSE_BIN:path.join(bin,"muse")});assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(fs.existsSync(marker),false);const lines=fs.readFileSync(provider.log,"utf8").trim().split("\n");assert.equal(lines.length,1);assert.match(lines[0],/^\|\|\/tmp\/registered-provider-/);
 const directory=path.join(path.dirname(f.planFile),"deploy-incident"),rows=fs.readdirSync(directory);assert.equal(rows.length,1);const record=JSON.parse(fs.readFileSync(path.join(directory,rows[0])));assert.equal(record.verdict,"incident");assert.equal(record.executor_session,"registered-fixture");assert.match(record.raw_output,/disposable native test provider/);
});
test("registered quota fallback keeps the Argon and Codex provider identity commitments",t=>{
 const f=fixture(t);nativeReviewer(f);f.document.author_model="muse";fs.writeFileSync(f.planFile,JSON.stringify(f.document));const fail=path.join(f.tmp,"quota-provider"),built=spawnSync("/usr/bin/cc",["-x","c","-","-o",fail],{input:'#include <stdio.h>\nint main(){fputs("429 rate limit",stderr);return 1;}',encoding:"utf8"});assert.equal(built.status,0,built.stderr);f.data.providers.argon={file:fail,sha256:sha(fs.readFileSync(fail))};f.save();
 const r=f.invoke("review",[f.planFile,"--author","muse"]);assert.equal(r.status,0,r.stdout+r.stderr);for(const p of f.profiles){const dir=path.join(path.dirname(f.planFile),"reviews",p.id),record=JSON.parse(fs.readFileSync(path.join(dir,plan.REVIEW_FILE)));assert.equal(record.reviewers[0].id,"codex");assert.equal(record.skipped[0].id,"argon");assert.match(fs.readFileSync(path.join(dir,record.reviewers[0].result),"utf8"),/EXECUTABLE: \/tmp\/registered-provider-/);}
});
