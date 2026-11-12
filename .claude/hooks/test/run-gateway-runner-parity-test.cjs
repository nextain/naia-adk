"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { verifiedPlanBinding } = require("../lib/deploy-readiness.js");
const { classifyProdMutations } = require("../lib/deploy-command-classifier.js");
const fixture = process.env.GW_FIXTURE || path.join(__dirname, "fixtures/gateway-runner");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-runner-test-"));
const dir = path.join(root, "runner");
fs.cpSync(fixture, dir, { recursive: true });
fs.mkdirSync(path.join(root, "config"));
fs.writeFileSync(path.join(root, "config/deploy-gate.json"), JSON.stringify({services:{"azure:vm:naia-gateway-prod-az":{allowCustomCommands:true}}}));
const svc = "azure:vm:naia-gateway-prod-az";
const sha = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const allPins = () => Object.fromEntries(fs.readdirSync(dir).map(n => [path.join(dir,n),sha(path.join(dir,n))]));
const a = "a".repeat(64), b = "b".repeat(64), run = "20261111T050000Z-gwvoiceonly";
const tag = "candidate-abcd1234";
const launch = path.join(dir,"launch-local.sh");
const command = `bash ${launch} prod ${run} ${tag} sha256:${b} sha256:${a} revision backup`;
const entry = {id:"s1",commands:[command],files:allPins()};
const plan = {services:[svc], changes:[`${svc} 이미지 acrnaia83b29893.azurecr.io/naia/gateway: old (sha256:${a}) → ${tag} (sha256:${b})`], scenario:[entry]};
const binding = (p=plan,e=entry,c=e.commands[0],kind="feature",candidate=tag,services=[svc]) => verifiedPlanBinding({plan:p,entry:e,command:c,cwd:root},candidate,kind,services,root);
test("reviewed launch and dynamic VM target bind to the concrete service",()=>{
 assert.equal(binding().ok,true,JSON.stringify(binding()));
 const hits = classifyProdMutations(command,root,0,false,root);
 assert.deepEqual([...new Set(hits.map(x=>x.service))],[svc],JSON.stringify(hits));
});
test("wrong body is rejected even when its altered hash is declared in the plan",()=>{
 const orig=fs.readFileSync(launch); fs.appendFileSync(launch,"\n# modified\n");
 try { const e={...entry,files:allPins()}; assert.equal(binding({...plan,scenario:[e]},e).ok,false); }
 finally { fs.writeFileSync(launch,orig); }
});
test("different environment, relative path and different name do not gain runner binding",()=>{
 for(const cmd of [command.replace(" prod "," dev "), command.replace(launch,"runner/launch-local.sh"),command.replace(launch,path.join(dir,"other-local.sh"))]) {
  const e={...entry,commands:[cmd]}; assert.equal(binding({...plan,scenario:[e]},e).ok,false,cmd);
 }
});
test("run ID, candidate, service and dependent file must agree",()=>{
 assert.equal(binding(plan,entry,command,"feature","other-candidate").ok,false);
 assert.equal(binding(plan,entry,command,"feature",tag,["azure:vm:other"]).ok,false);
 const status=path.join(dir,"status-local.sh");
 const cmd=`bash ${status} prod 20261111T050001Z-other recent`;
 const e={...entry,id:"s2",commands:[cmd]};
 assert.equal(binding({...plan,scenario:[entry,e]},e).ok,false);
 const pins={...entry.files}; delete pins[path.join(dir,"gateway-operation.py")];
 const missing={...entry,files:pins}; assert.equal(binding({...plan,scenario:[missing]},missing).ok,false);
});
test("status, deploy and rollback bind to the launch in the same plan",()=>{
 for (const [name,args,kind,candidate] of [
  ["status-local.sh","recent","ops",""],
  ["operation-local.sh","deploy","feature",tag],
  ["operation-local.sh","verify","feature",tag],
  ["rollback-local.sh","","rollback",`sha256:${a}`],
 ]) {
  const cmd=`bash ${path.join(dir,name)} prod ${run}${args ? ` ${args}` : ""}`;
  const e={...entry,id:"s2",commands:[cmd]};
  const result=binding({...plan,scenario:[entry,e]},e,cmd,kind,candidate);
  assert.equal(result.ok,true,JSON.stringify({cmd,result}));
 }
});
test("an altered named runner cannot hide a second production target",()=>{
 const orig=fs.readFileSync(launch); fs.appendFileSync(launch,"\naz vm restart -g rg-prod -n another-prod\n");
 try {
  const hits=classifyProdMutations(command,root,0,false,root);
  assert(hits.some(x=>x.service === svc),JSON.stringify(hits));
  assert(hits.some(x=>x.service === "azure:vm:another-prod"),JSON.stringify(hits));
 } finally {fs.writeFileSync(launch,orig);}
});
test("an az argument does not hide an altered runner's other target",()=>{
 const orig=fs.readFileSync(launch); fs.appendFileSync(launch,"\naz vm restart -g rg-prod -n another-prod\n");
 try {
  const cmd=command.replace(` ${tag} `," az ");
  const hits=classifyProdMutations(cmd,root,0,false,root);
  assert(hits.some(x=>x.service === svc),JSON.stringify(hits));
  assert(hits.some(x=>x.service === "azure:vm:another-prod"),JSON.stringify(hits));
  const e={...entry,commands:[cmd],files:allPins()};
  assert.equal(binding({...plan,scenario:[e]},e,cmd,"feature","az").ok,false);
 } finally {fs.writeFileSync(launch,orig);}
});
test("key path checks reject unsafe fixture directories before any cloud call",()=>{
 const {spawnSync}=require("node:child_process");
 const fake=fs.mkdtempSync(path.join(os.tmpdir(),"gw-path-test-"));
 try {
  const repo=path.join(fake,"repo"), runner=path.join(repo,"a/b/c/d/e");
  const keydir=path.join(repo,"data-private/key"), key=path.join(keydir,"motif-api-key.env");
  fs.mkdirSync(runner,{recursive:true}); fs.mkdirSync(keydir,{recursive:true});
  fs.mkdirSync(path.join(repo,".git")); fs.writeFileSync(path.join(repo,"AGENTS.md"),"");
  fs.writeFileSync(key,"",{mode:0o600});
  for(const p of [repo,path.join(repo,"data-private"),keydir]) fs.chmodSync(p,0o700);
  // Execute only the local preflight prefix, ending before the key is read or any Azure call.
  const prefix=fs.readFileSync(launch,"utf8").split("  MOTIF_VALUE='' ".trimEnd())[0];
  assert(prefix.includes("KEY_DIR_MODE"));
  const script=path.join(runner,"check.sh"); fs.writeFileSync(script,prefix+"  echo PREFLIGHT_OK\nfi\n");
  const invoke=(file=script,env=process.env)=>spawnSync("bash",[file,"prod",run,tag,`sha256:${b}`,`sha256:${a}`,"rev","backup"],{encoding:"utf8",env});
  const ok=invoke(); assert.equal(ok.status,0,ok.stderr+ok.stdout); assert.match(ok.stdout,/PREFLIGHT_OK/);
  const rejected=()=>{const r=invoke(); assert.notEqual(r.status,0); assert.match(r.stdout,/MOTIF_KEY_FILE_INVALID/); assert.doesNotMatch(r.stdout,/PREFLIGHT_OK/);};
  fs.chmodSync(keydir,0o720); rejected(); fs.chmodSync(keydir,0o700);
  fs.chmodSync(repo,0o702); rejected(); fs.chmodSync(repo,0o700);
  // Simulate a foreign owner on an otherwise 0700 parent without requiring chown privileges.
  const bin=path.join(fake,"bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,"stat"),`#!/bin/bash\nif [[ "$2" == "%u" && "$4" == "$FAKE_OWNER_DIR" ]]; then echo 4294967294; else exec /usr/bin/stat "$@"; fi\n`,{mode:0o755});
  const foreign=invoke(script,{...process.env,PATH:bin+path.delimiter+process.env.PATH,FAKE_OWNER_DIR:repo});
  assert.notEqual(foreign.status,0); assert.match(foreign.stdout,/MOTIF_KEY_FILE_INVALID/);
  fs.renameSync(keydir,keydir+"-real"); fs.symlinkSync(keydir+"-real",keydir); rejected();
  fs.unlinkSync(keydir); fs.renameSync(keydir+"-real",keydir);
  fs.renameSync(path.join(repo,"AGENTS.md"),path.join(repo,"AGENTS.missing")); rejected();
  fs.renameSync(path.join(repo,"AGENTS.missing"),path.join(repo,"AGENTS.md"));
  fs.renameSync(path.join(repo,".git"),path.join(repo,"git-missing")); rejected();
  fs.renameSync(path.join(repo,"git-missing"),path.join(repo,".git"));
  fs.chmodSync(key,0o640); rejected(); fs.chmodSync(key,0o600);
  const link=path.join(runner,"link.sh"); fs.symlinkSync(script,link);
  const r=invoke(link); assert.notEqual(r.status,0); assert.match(r.stdout,/MOTIF_KEY_FILE_INVALID/);
 } finally {fs.rmSync(fake,{recursive:true,force:true});}
});
test("assignments and wrappers cannot bypass runner binding",()=>{
 for (const cmd of [`FOO=bar ${command}`, `timeout 30 ${command}`, `bash -c '${command}'`]) {
  const e={...entry,commands:[cmd]};
  assert.equal(binding({...plan,scenario:[e]},e).ok,false,cmd);
 }
});
