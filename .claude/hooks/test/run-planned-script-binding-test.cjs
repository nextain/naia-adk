require("../../../scripts/test-signal-safety.cjs");
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { verifiedPlanBinding } = require(process.env.PLANNED_SCRIPT_READINESS || "../lib/deploy-readiness.js");
const hash = s => crypto.createHash("sha256").update(s).digest("hex");
function fixture(t) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "planned-script-"));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,"config"));
 const services=["systemd:sample-runtime"];
 const script=path.join(root,"deploy-runtime.sh");
 const body="#!/bin/bash\nsystemctl --user restart sample-stop.service\n";
 fs.writeFileSync(script,body);
 fs.writeFileSync(path.join(root,"config/deploy-gate.json"), JSON.stringify({plannedScripts:{enabled:true,services,roots:[root],systemdUserUnits:["sample-stop.service"]},services:{[services[0]]:{allowCustomCommands:true}}}));
 const entry={id:"s0",commands:[`bash ${script} s0`],files:{[script]:hash(body)}};
 const plan={services,scenario:[entry]};
 const check=(command=entry.commands[0])=>verifiedPlanBinding({plan,entry,command,cwd:root},"candidate","ops",services,root);
 return {root,script,entry,check};
}
test("hash-bound scripts accept arbitrary releases but do not grant approval", t=>{
 const f=fixture(t);assert.equal(f.check().ok,true);assert.equal(f.check().ops,true);
});
test("changed bytes rejected",t=>{const f=fixture(t);fs.appendFileSync(f.script,"# changed\n");assert.equal(f.check().ok,false)});
test("unplanned script rejected even when command added",t=>{const f=fixture(t);const cmd=`bash ${f.root}/other.sh s0`;f.entry.commands.push(cmd);assert.equal(f.check(cmd).ok,false)});
for(const [name,wrap] of [["cd prefix",s=>`cd /tmp && ${s}`],["chaining",s=>`${s} && true`]])test(name,t=>{const f=fixture(t);const cmd=wrap(f.entry.commands[0]);f.entry.commands.push(cmd);assert.equal(f.check(cmd).ok,false)});
test("other user unit rejected even when newly pinned",t=>{const f=fixture(t);const body="systemctl --user restart other.service\n";fs.writeFileSync(f.script,body);f.entry.files[f.script]=hash(body);assert.equal(f.check().ok,false)});

test("other wrapped user unit rejected even when newly pinned",t=>{const f=fixture(t);const body='userctl "$account" restart other.service\n';fs.writeFileSync(f.script,body);f.entry.files[f.script]=hash(body);assert.equal(f.check().ok,false)});

test("malformed instance config denies without throwing",t=>{const f=fixture(t);const cfg=JSON.parse(fs.readFileSync(path.join(f.root,"config/deploy-gate.json")));cfg.plannedScripts.roots={};fs.writeFileSync(path.join(f.root,"config/deploy-gate.json"),JSON.stringify(cfg));assert.equal(f.check().ok,false)});
test("sudo denied by default and allowed only by explicit instance option",t=>{const f=fixture(t);const cmd=`sudo ${f.entry.commands[0]}`;f.entry.commands.push(cmd);assert.equal(f.check(cmd).ok,false);const file=path.join(f.root,"config/deploy-gate.json");const cfg=JSON.parse(fs.readFileSync(file));cfg.plannedScripts.allowSudo=true;fs.writeFileSync(file,JSON.stringify(cfg));assert.equal(f.check(cmd).ok,true)});
test("configured script family always enters classifier including prefixes and unknown scripts",t=>{
 const f=fixture(t);const {classifyProdMutations}=require("../lib/deploy-command-classifier.js");
 for(const command of [f.entry.commands[0],`sudo ${f.entry.commands[0]}`,`cd /tmp && ${f.entry.commands[0]}`,`${f.entry.commands[0]} && true`,`bash ${f.root}/unplanned.sh s0`]) {
  assert.ok(classifyProdMutations(command,f.root,0,false,f.root).some(h=>h.service==="systemd:sample-runtime"),command);
 }
});

test("reading and syntax checking configured scripts are not planned deployment invocations",t=>{
 const f=fixture(t);const {classifyProdMutations}=require("../lib/deploy-command-classifier.js");
 for(const command of [`cat ${f.script}`,`sha256sum ${f.script}`,`bash -n ${f.script}`]) assert.ok(!classifyProdMutations(command,f.root,0,false,f.root).some(h=>h.service==="systemd:sample-runtime"),command);
});

for (const variant of ['dotdot', 'symlink', 'missing']) test(`unsafe script path ${variant} stays gated and fails binding`, t => {
 const f=fixture(t);const classify=require('../lib/planned-script-binding.js').classifyPlannedScripts;
 const cfg=JSON.parse(fs.readFileSync(path.join(f.root,'config/deploy-gate.json')));
 let target=f.root+'/missing.sh';
 if(variant==='dotdot')target=f.root+'/../'+path.basename(f.root)+'/deploy-runtime.sh';
 if(variant==='symlink'){target=f.root+'-link.sh';fs.symlinkSync(f.script,target);t.after(()=>fs.unlinkSync(target));}
 const cmd=`bash ${target} s0`;f.entry.commands.push(cmd);
 assert.ok(classify(['bash',target,'s0'],f.root,cfg).length>0);
 assert.equal(f.check(cmd).ok,false);
});

test('outer command classifier gates an external symlink through sudo',t=>{
 const f=fixture(t);const link=f.root+'-outside.sh';fs.symlinkSync(f.script,link);t.after(()=>fs.unlinkSync(link));
 const before=process.env.DEPLOY_READINESS_ROOT;process.env.DEPLOY_READINESS_ROOT=f.root;t.after(()=>{if(before===undefined)delete process.env.DEPLOY_READINESS_ROOT;else process.env.DEPLOY_READINESS_ROOT=before});
 const hits=require('../lib/deploy-command-classifier.js').classifyProdMutations(`sudo bash ${link} s0`,f.root);
 assert.ok(hits.some(h=>h.service==='systemd:sample-runtime'));
});

for (const kind of ['outside-missing','outside-dangling'])test(`unresolved script ${kind} fails closed`,t=>{
 const f=fixture(t);const target=f.root+'-'+kind+'.sh';
 if(kind==='outside-dangling'){fs.symlinkSync(f.root+'-no-target.sh',target);t.after(()=>fs.unlinkSync(target));}
 const cfg=JSON.parse(fs.readFileSync(path.join(f.root,'config/deploy-gate.json')));
 const hits=require('../lib/planned-script-binding.js').classifyPlannedScripts(['bash',target,'s0'],f.root,cfg);
 assert.ok(hits.some(h=>h.unclassified===true),'unresolved outside membership must not bypass the gate');
});

test('rollback kind cannot label a forward step to bypass the stop lock',t=>{
 const f=fixture(t);const cfg=JSON.parse(fs.readFileSync(path.join(f.root,'config/deploy-gate.json')));const verify=require('../lib/planned-script-binding.js').verifyPlannedScript;
 const files=new Map([[f.script,fs.readFileSync(f.script,'utf8')]]);const services=cfg.plannedScripts.services;
 const check=entry=>verify({config:cfg,plan:{services,scenario:[entry]},entry,command:entry.commands[0],files,services,kind:'rollback'});
 assert.equal(check(f.entry).ok,false);
 const rollback={...f.entry,id:'r2',branch:'rollback',commands:[`bash ${f.script} r2`]};assert.equal(check(rollback).ok,true);
});
