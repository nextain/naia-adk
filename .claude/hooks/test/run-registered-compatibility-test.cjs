"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{spawnSync}=require("node:child_process"),{pathToFileURL}=require("node:url");
const {fixture,nativeReviewer,sha}=require("./registered-executor-v3-fixtures.cjs");
const ROOT=path.resolve(__dirname,"../../.."),utility="scripts/lib/registered-git-identity.cjs";
async function installer(f){
 const home=path.join(f.tmp,"home");fs.mkdirSync(home);const file=path.join(f.tmp,"installer.json");
 const descriptor={schema:"adk-registered-deploy-hooks/v1",home,instanceRoot:f.instance,engine:{root:f.engine,commit:f.data.engine.commit,entrySha256:sha(fs.readFileSync(path.join(f.engine,".agents/scripts/approval-plan.mjs")))},registration:{file:f.record,sha256:f.digest()},entries:f.profiles.map(({id,scope,root})=>({id,scope,root}))};
 fs.writeFileSync(file,JSON.stringify(descriptor));const api=await import(pathToFileURL(path.join(ROOT,"scripts/lib/registered-deploy-hooks.mjs")).href);
 return()=>api.loadRegisteredDeployHooks({home,instanceRoot:f.instance,target:"claude",registeredDeployHooks:file,registeredDeployHooksSha256:sha(fs.readFileSync(file))});
}
function changeOwner(file,uid,gid){
 if(process.getuid()===0){fs.chownSync(file,uid,gid);return true;}
 return spawnSync("/usr/bin/sudo",["-n","/usr/bin/chown",`${uid}:${gid}`,file],{stdio:"ignore"}).status===0;
}
test("one real mixed-owner checkout passes initial/final installation identity and registered runtime startup",async t=>{
 const f=fixture(t);nativeReviewer(f);const query="process.stdout.write('Read-only fixture');\n",rule={sha256:sha(query),path:"query.cjs",service:"azure:containerapp:sample-web-prod"};
 for(const root of[f.instance,f.global]){const config=path.join(root,"config/deploy-gate.json");fs.mkdirSync(path.dirname(config),{recursive:true});const data=fs.existsSync(config)?JSON.parse(fs.readFileSync(config)):{};data.readOnlyScripts=[rule];fs.writeFileSync(config,JSON.stringify(data));fs.writeFileSync(path.join(root,"query.cjs"),query);if(root===f.global)assert.equal(spawnSync("/usr/bin/git",["-C",root,"init","-q"]).status,0);}
 f.data.instance.files.find(p=>p.file==="config/deploy-gate.json").sha256=sha(fs.readFileSync(path.join(f.instance,"config/deploy-gate.json")));f.document.scenario[0].files["query.cjs"]=sha(query);fs.writeFileSync(f.planFile,JSON.stringify(f.document));f.save();
 for(const root of[f.instance,f.global])for(const args of[["add","."],["-c","user.name=Fixture","-c","user.email=fixture@localhost","commit","-qm","Read-only binding fixture"]])assert.equal(spawnSync("/usr/bin/git",["-C",root,...args]).status,0);
 fs.writeFileSync(path.join(f.instance,"ordinary-work.txt"),"Dirty plan workspace remains reviewable.\n");const load=await installer(f),owner=fs.statSync(f.engine),instanceOwner=fs.statSync(f.instance),globalOwner=fs.statSync(f.global),changed=owner.uid===10001?10002:10001;
 if(!changeOwner(f.engine,changed,changed)){t.skip("A disposable mixed-owner directory requires OS chown permission");return;}
 try{assert(changeOwner(f.instance,changed,changed));assert(changeOwner(f.global,changed,changed));const bound=load();bound.verify();const result=f.invoke();assert.equal(result.status,0,result.stderr);const decision=JSON.parse(result.stdout);assert.doesNotMatch(decision.reason,/Registered hook unavailable|runtime revision differs/);assert.match(decision.reason,/적대 리뷰|PLAN-/);
 for(const op of["prepare","ready"]){const r=f.invoke(op,[f.planFile]);assert.equal(r.status,op==="prepare"?0:1,r.stdout+r.stderr);const body=JSON.parse(r.stdout);assert.equal(body.engine_commit,f.data.engine.commit);assert.equal(body.purpose,"plan-preparation/v1");assert.equal(body.ok,op==="prepare");}
 for(const p of f.profiles)assert.equal(fs.existsSync(p.stateDir),false);
 const reviewed=f.invoke("review",[f.planFile,"--author","codex"]);assert.equal(reviewed.status,0,reviewed.stdout+reviewed.stderr);
 const ready=f.invoke("ready",[f.planFile]);assert.equal(ready.status,0,ready.stdout+ready.stderr);assert.equal(JSON.parse(ready.stdout).ok,true);
 const issued=f.invoke("preapprove",[f.planFile,"--session","registered-fixture"]);assert.equal(issued.status,0,issued.stdout+issued.stderr);assert.equal(new Set(issued.stdout.match(/(?:PLAN|STEP)-[A-F0-9]{64}/g)).size,6);
 for(const p of f.profiles){const blocked=f.invoke("hook",[],{},{},p.id);assert.equal(blocked.status,0,blocked.stderr);assert.match(JSON.parse(blocked.stdout).reason,/PLAN-|전체 계획/);assert.doesNotMatch(blocked.stdout,/Git identity|dubious|runtime revision/);}
}
 finally{assert(changeOwner(f.global,globalOwner.uid,globalOwner.gid));assert(changeOwner(f.instance,instanceOwner.uid,instanceOwner.gid));assert(changeOwner(f.engine,owner.uid,owner.gid),"Restore disposable directory ownership");}
});
test("installer and runtime reject the same dirty checkout",async t=>{
 const f=fixture(t),load=await installer(f);assert.doesNotThrow(load);fs.writeFileSync(path.join(f.engine,"unreviewed.txt"),"fixture");assert.throws(load,/clean checkout|identity/);const r=f.invoke();assert.equal(r.status,0,r.stderr);assert.match(JSON.parse(r.stdout).reason,/identity|clean checkout/);
});
test("the shared utility uses the declared root and commit and rejects mismatches",t=>{
 const f=fixture(t),{assertRegisteredGitIdentity}=require(path.join(ROOT,utility));assert.doesNotThrow(()=>assertRegisteredGitIdentity({root:f.engine,commit:f.data.engine.commit}));assert.throws(()=>assertRegisteredGitIdentity({root:f.engine,commit:"0".repeat(40)}),/identity|HEAD|commit/);assert.throws(()=>assertRegisteredGitIdentity({root:path.join(f.engine,".agents"),commit:f.data.engine.commit}),/root|identity/);
});
test("the shared identity helper is mandatory sealed application source",t=>{
 const f=fixture(t);assert(f.data.engine.files.some(p=>p.file===utility));const helper=path.join(f.engine,utility);fs.appendFileSync(helper,"\n// Changed disposable identity helper\n");const r=f.invoke();assert.equal(r.status,0,r.stderr);assert.match(JSON.parse(r.stdout).reason,/Registered source differs/);
});
for(const [name,body,ok]of[["undefined falls through","undefined",true],["explicit rejection remains rejected","({ok:false,why:'fixture policy rejected'})",false],["malformed result remains rejected","({applicable:false})",false]])test("preparation plugin compatibility: "+name,t=>{
 const f=fixture(t),plugin="policy.cjs",file=path.join(f.instance,plugin);fs.writeFileSync(file,"module.exports={verifyPlanPreparation:()=>"+body+"};\n");const cfgFile=path.join(f.instance,"config/deploy-gate.json"),cfg=JSON.parse(fs.readFileSync(cfgFile));cfg.plugin=plugin;fs.writeFileSync(cfgFile,JSON.stringify(cfg));f.data.instance.files.find(p=>p.file==="config/deploy-gate.json").sha256=sha(fs.readFileSync(cfgFile));f.data.instance.files.push({file:plugin,sha256:sha(fs.readFileSync(file))});f.save();const r=f.invoke("prepare",[f.planFile]);assert.equal(r.status,ok?0:1,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).ok,ok);
});
