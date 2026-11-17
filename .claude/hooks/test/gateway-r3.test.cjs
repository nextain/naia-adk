'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {verifiedPlanBinding}=require('../lib/deploy-readiness.js');
const {classifyProdMutations,GATEWAY_RUNNER_FORMATS}=require('../lib/deploy-command-classifier.js');
const {formProblems}=require('../lib/deploy-plan.js');
const service='azure:vm:naia-gateway-prod-az';
const src=path.resolve(__dirname,'../../../scripts/gateway-runner');
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-r3-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'runner'); fs.cpSync(src,dir,{recursive:true});
 fs.mkdirSync(path.join(root,'config')); fs.writeFileSync(path.join(root,'config/deploy-gate.json'),JSON.stringify({services:{[service]:{allowedCommands:['^bash /.*$']}}}));
 const files=Object.fromEntries(Object.keys(GATEWAY_RUNNER_FORMATS).map(n=>[path.join(dir,n),sha(path.join(dir,n))]));
 const run='20261117T120000Z-test', old='sha256:'+'a'.repeat(64), next='sha256:'+'b'.repeat(64);
 const launch=`bash ${dir}/launch-local.sh prod ${run} v1 ${next} ${old} rev`;
 const changes=[`${service} acrnaia83b29893.azurecr.io/naia/gateway old (${old})`,`${service} acrnaia83b29893.azurecr.io/naia/gateway v1 (${next})`];
 return {root,dir,files,run,launch,changes};
}
for (const separate of [false,true]) test(`1-1 cleanup ${separate ? 'different run from backup' : 'standalone'}`,t=>{
 const f=fixture(t); const cmd=f.launch+' cleanup -'; const entry={commands:[cmd],files:f.files};
 const backup={commands:[f.launch.replace(f.run,'20261117T120001Z-other')+' backup -'],files:f.files};
 const plan={services:[service],changes:f.changes,scenario:separate?[entry,backup]:[entry]};
 const result=verifiedPlanBinding({plan,entry,command:cmd,cwd:f.root},'v1','feature',[service],f.root);
 assert.equal(result.ok,true,JSON.stringify(result));
});
for(const [name,allowed,tag] of [['2-1 allowed command cannot hide altered runner',true,'v1'],['2-b az argument cannot hide altered runner',false,'az']]) test(name,t=>{
 const f=fixture(t); if(!allowed) fs.writeFileSync(path.join(f.root,'config/deploy-gate.json'),JSON.stringify({services:{[service]:{}}}));
 fs.appendFileSync(path.join(f.dir,'launch-local.sh'),'\naz vm restart -g rg-prod -n another-prod\n');
 const hits=classifyProdMutations(f.launch.replace(' v1 ',` ${tag} `)+' backup -',f.root,0,false,f.root);
 assert.ok(hits.some(x=>x.service===service),JSON.stringify(hits)); assert.ok(hits.some(x=>x.service==='azure:vm:another-prod'),JSON.stringify(hits));
});
for(const mode of ['env-names','installed-hashes']) test(`3-1 ${mode} validates invalid declarations`,t=>{
 const f=fixture(t); const cmd=`bash ${f.dir}/status-local.sh prod ${f.run} ${mode}`, entry={commands:[cmd],files:f.files};
 const plan={services:[service],scenario:[entry],environment_additions:[{name:'AZURE_TTS_KEY',source_id:'evil-source'}]};
 assert.equal(verifiedPlanBinding({plan,entry,command:cmd,cwd:f.root},'','ops',[service],f.root).ok,false);
});
for(const services of [[service],['azure:containerapp:other-prod']]) test(`3-2 unbound additions rejected for ${services[0]}`,t=>{
 const f=fixture(t); const cmd=`bash ${f.dir}/status-local.sh prod ${f.run} env-names`;
 const plan={services,scenario:[{commands:[cmd],files:f.files}],environment_additions:[{name:'AZURE_TTS_KEY',source_id:'azure-tts-key-v1'}]};
 assert.ok(formProblems(plan).some(x=>x.includes('environment_additions') && x.includes('결합')),JSON.stringify(formProblems(plan)));
});

test("parity: key path checks reject unsafe fixture directories before any cloud call",t=>{
 const {dir}=fixture(t); const launch=path.join(dir,"launch-local.sh");
 const run="20261111T050000Z-test",tag="candidate",a="a".repeat(64),b="b".repeat(64);
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
  const script=path.join(runner,"check.sh"); fs.writeFileSync(script,prefix+"  echo PREFLIGHT_OK\nfi\necho PATH_CHECK_OK\n");
  const invoke=(file=script,env=process.env,stage="backup")=>spawnSync("bash",[file,"prod",run,tag,`sha256:${b}`,`sha256:${a}`,"rev",stage],{encoding:"utf8",env});
  const ok=invoke(); assert.equal(ok.status,0,ok.stderr+ok.stdout); assert.match(ok.stdout,/PREFLIGHT_OK/);
  const rejected=()=>{const r=invoke(); assert.notEqual(r.status,0); assert.match(r.stdout,/MOTIF_KEY_FILE_INVALID/); assert.doesNotMatch(r.stdout,/PREFLIGHT_OK/);};
  const cleanup=invoke(script,process.env,"cleanup"); assert.equal(cleanup.status,0,cleanup.stderr+cleanup.stdout); assert.match(cleanup.stdout,/PATH_CHECK_OK/);
  fs.chmodSync(keydir,0o720); rejected();
  const unsafeCleanup=invoke(script,process.env,"cleanup"); assert.notEqual(unsafeCleanup.status,0); assert.match(unsafeCleanup.stdout,/MOTIF_KEY_FILE_INVALID/); assert.doesNotMatch(unsafeCleanup.stdout,/PATH_CHECK_OK/);
  fs.chmodSync(keydir,0o700);
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

for(const other of [false,true]) test(`3-2 offline preflight rejects unbound additions in ${other?'other service':'standalone read'} plan`,t=>{
 const f=fixture(t); const {spawnSync}=require('node:child_process');
 const target=other?'azure:containerapp:other-prod':service;
 const command=other?'az containerapp update -g rg-prod -n other-prod --min-replicas 2':`bash ${f.dir}/status-local.sh prod ${f.run} env-names`;
 if (other) fs.writeFileSync(path.join(f.root,'config/deploy-gate.json'),JSON.stringify({services:{[target]:{allowCustomCommands:true,allowedCommands:['^az containerapp .*']}}}));
 const entry={id:'s1',title:'Inspect or update service',commands:[command],files:other?{}:f.files,success_check:'Verify service health',on_failure:'Stop and report failure'};
 const plan={schema:'deploy-plan/v1',author_model:'muse',planId:'sample-gateway',createdAt:new Date().toISOString(),services:[target],what_why:'Production service verification for test',architecture_fit:{original_request:'Test a production service verification request',parent_structure:'Use the common deployment gate structure',acceptance_rationale:'Exercise the common approval gate'},changes:['Service inspection and verification'],environment_additions:[{name:'AZURE_TTS_KEY',source_id:'azure-tts-key-v1'}],scenario:[entry],risks:{items:['Possible service interruption'],worst_case:'Temporary service interruption'},irreversible:['No database changes'],disconnect_safety:'Inspect status and report failures',rerun_safety:{lock:'Unique execution lock',run_dir:'Unique run directory',no_latest_pick:'Use explicit version'},success_verification:'Verify the service health',rollback:{method:'Use approved recovery steps',duration:'One minute',step_ids:[]},residual_risks:['Possible interruption'],incident:{criteria:['Service unhealthy'],actions:[]}};
 const planFile=path.join(f.root,'plan.json'); fs.writeFileSync(planFile,JSON.stringify(plan));
 const cli=path.resolve(__dirname,'../../../.agents/scripts/plan-cmd-check.cjs');
 const result=spawnSync(process.execPath,[cli,planFile,'s1',command,'ops'],{cwd:f.root,encoding:'utf8'});
 assert.notEqual(result.status,0,result.stdout+result.stderr);
});
