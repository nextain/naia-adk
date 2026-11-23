import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { run, parseArgs } from "./adk-user-profile.mjs"
const require=createRequire(import.meta.url),ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..")
const { fixture: runtimeFixture, sha }=require("../.claude/hooks/test/registered-executor-v3-fixtures.cjs")
function fixture(t){
 const f=runtimeFixture(t),home=path.join(f.tmp,"home"),userFile=path.join(home,".codex/hooks.json"),projectFile=path.join(f.instance,".codex/hooks.json")
 for(const dir of[path.dirname(userFile),path.dirname(projectFile)])fs.mkdirSync(dir,{recursive:true})
 const existing={hooks:{SessionStart:[{hooks:[{type:"command",command:"printf existing-session"}]}],PreToolUse:[{matcher:"Bash",hooks:[{type:"command",command:"printf existing-policy"}]}],PostToolUse:[{hooks:Array.from({length:23},(_,i)=>({type:"command",command:`printf existing-after-${i}`}))}]}}
 fs.writeFileSync(projectFile,JSON.stringify(existing));
 fs.chmodSync(projectFile,0o640)
 const descriptor=path.join(f.tmp,"native-installer.json"),data={schema:"adk-registered-deploy-hooks/v1",home,instanceRoot:f.instance,engine:{root:f.engine,commit:f.data.engine.commit,entrySha256:sha(fs.readFileSync(path.join(f.engine,".agents/scripts/approval-plan.mjs")))},registration:{file:f.record,sha256:f.digest()},entries:f.profiles.map(({id,scope,root})=>({id,scope,root}))}
 fs.writeFileSync(descriptor,JSON.stringify(data))
 const args={mode:"apply",target:"codex",home,adkRoot:ROOT,instanceRoot:f.instance,registeredDeployHooks:descriptor,registeredDeployHooksSha256:sha(fs.readFileSync(descriptor)),codexHooksFile:userFile}
 return{...f,home,userFile,projectFile,existing,args,descriptor}
}
const registered=settings=>Object.entries(settings.hooks||{}).flatMap(([event,groups])=>groups.flatMap(g=>g.hooks.map(h=>({event,matcher:g.matcher,command:h.command}))).filter(h=>h.command.includes("approval-plan.mjs")))
test("native registered check previews both Codex files without writing",t=>{
 const f=fixture(t),before=fs.readFileSync(f.projectFile),result=run({...f.args,mode:"check"});
 assert(result.drift.includes(f.userFile));
 assert(result.drift.includes(f.projectFile));
 assert.equal(fs.existsSync(f.userFile),false);
 assert.deepEqual(fs.readFileSync(f.projectFile),before);
 assert.equal(fs.existsSync(path.join(f.home,".claude")),false)
})
test("native registered apply preserves all25 project handlers and adds only the two dedicated slots",t=>{
 const f=fixture(t),result=run(f.args),user=JSON.parse(fs.readFileSync(f.userFile)),project=JSON.parse(fs.readFileSync(f.projectFile));
 assert.deepEqual(result.changed.sort(),[f.userFile,f.projectFile].sort());
 assert.deepEqual(project.hooks.SessionStart,f.existing.hooks.SessionStart);
 assert.deepEqual(project.hooks.PostToolUse,f.existing.hooks.PostToolUse);
 assert.deepEqual(project.hooks.PreToolUse[0],f.existing.hooks.PreToolUse[0]);
 assert.equal(Object.values(project.hooks).flatMap(g=>g.flatMap(x=>x.hooks)).length,26);
 assert.equal(registered(user).length,1);
 assert.equal(registered(project).length,1);
 assert.match(registered(user)[0].command,/--profile' 'scope-one'/);assert.match(registered(project)[0].command,/--profile' 'scope-two'/);
 assert.equal(registered(user)[0].matcher,"Bash");
 assert.equal(user.hooks.SessionStart,undefined);
 assert.equal(fs.statSync(f.userFile).mode&0o777,0o600);
 assert.equal(fs.statSync(f.projectFile).mode&0o777,0o640);
 assert.equal(fs.existsSync(path.join(f.home,".claude")),false)
})
test("native registered pair is idempotent and its check becomes clean",t=>{
 const f=fixture(t);
 run(f.args);
 assert.deepEqual(run(f.args).changed,[]);
 assert.deepEqual(run({...f.args,mode:"check"}).drift,[])
})
test("native pair second-write failure restores both exact preimages",t=>{
 const f=fixture(t),before=fs.readFileSync(f.projectFile),rename=fs.renameSync;
 let failed=false
 fs.renameSync=(from,to)=>{if(to===f.projectFile&&!failed){failed=true;
 throw new Error("Fixture native second rename")}return rename(from,to)}
 try{assert.throws(()=>run(f.args),/Fixture native second rename/)}finally{fs.renameSync=rename}
 assert.equal(fs.existsSync(f.userFile),false);
 assert.deepEqual(fs.readFileSync(f.projectFile),before);
 assert.equal(fs.statSync(f.projectFile).mode&0o777,0o640)
})
test("actual rendered native commands reach both canonical profiles for a normal read payload",t=>{
 const f=fixture(t);
 run(f.args);
 const input={cwd:f.instance,session_id:"native-component-fixture",tool_name:"Bash",tool_input:{command:"pwd"},tool_use_id:"native-component-only"}
 for(const file of[f.userFile,f.projectFile]){const hook=registered(JSON.parse(fs.readFileSync(file)))[0],r=spawnSync("/bin/sh",["-c",hook.command],{cwd:f.instance,input:JSON.stringify(input),encoding:"utf8",timeout:15000});
 assert.equal(r.status,0,r.stderr);
 assert.equal(r.stdout,"")}
 for(const p of f.profiles)assert.equal(fs.existsSync(p.stateDir),false)
})
test("native registered mode binds the selected default Codex home",t=>{
 const f=fixture(t);
 assert.throws(()=>run({...f.args,codexHooksFile:path.join(f.tmp,"different-hooks.json")}),/Codex|codex|native|binding/);
 assert.equal(fs.existsSync(f.userFile),false)
})
test("CLI accepts paired registered arguments for explicit native Codex target",t=>{
 const f=fixture(t),args=parseArgs(["check","--home",f.home,"--adk-root",ROOT,"--instance-root",f.instance,"--target","codex","--registered-deploy-hooks",f.descriptor,"--registered-deploy-hooks-sha256",f.args.registeredDeployHooksSha256]);
 assert.equal(args.target,"codex");
 assert.equal(args.codexHooksFile,f.userFile)
})
test("native user hook preserves an unrelated workspace's ordinary read",t=>{
 const f=fixture(t);
 run(f.args);
 const other=path.join(f.tmp,"unrelated");
 fs.mkdirSync(other);
 const hook=registered(JSON.parse(fs.readFileSync(f.userFile)))[0],r=spawnSync("/bin/sh",["-c",hook.command],{cwd:other,input:JSON.stringify({cwd:other,session_id:"unrelated-native-read",tool_name:"Bash",tool_input:{command:"pwd"}}),encoding:"utf8",timeout:15000});
 assert.equal(r.status,0,r.stderr);
 assert.equal(r.stdout,"");
 for(const p of f.profiles)assert.equal(fs.existsSync(p.stateDir),false)
})
