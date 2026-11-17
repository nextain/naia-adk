'use strict';
const { test, after } = require('node:test');
const tempRoots = [];
after(() => { for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true }); });
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { additionsSpec } = require('../lib/gateway-environment.js');
const { verifiedPlanBinding } = require('../lib/deploy-readiness.js');
const { GATEWAY_RUNNER_FORMATS, classifyProdMutations } = require('../lib/deploy-command-classifier.js');
const runner = path.resolve(__dirname, '../../../scripts/gateway-runner');
const service = 'azure:vm:naia-gateway-prod-az';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('environment declarations accept only unique ordered fixed pairs', () => {
  const key = {name:'AZURE_TTS_KEY', source_id:'azure-tts-key-v1'};
  const region = {name:'AZURE_TTS_REGION', source_id:'azure-tts-region-v1'};
  assert.equal(additionsSpec(), '-');
  assert.equal(additionsSpec([key, region]), 'azure-tts-key-v1,azure-tts-region-v1');
  for (const bad of [[key,key], [region,key], [{...key, value:'secret'}], [{...key, source_id:'other'}], 'bad']) assert.equal(additionsSpec(bad), null);
});

test('bundle fingerprints, classifier and independent read binding reject tampering', () => {
  const files = Object.fromEntries(Object.entries(GATEWAY_RUNNER_FORMATS).map(([name, want]) => {
    const file = path.join(runner, name);
    assert.equal(hash(file), want, name);
    return [file, want];
  }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-gate-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config/deploy-gate.json'), JSON.stringify({services:{[service]:{allowedCommands:['^bash /.*$']}}}));
  const cmd = `bash ${runner}/status-local.sh prod 20261117T120000Z-check env-names`;
  const entry = {commands:[cmd],files};
  const plan = {services:[service], scenario:[entry]};
  const binding = {plan,entry,command:cmd,cwd:root};
  assert.equal(verifiedPlanBinding(binding, '', 'ops', [service], root).ok, true);
  assert.equal(verifiedPlanBinding({...binding, command:cmd+'; id'}, '', 'ops', [service], root).ok, false);
  assert.equal(verifiedPlanBinding({...binding, entry:{...entry,files:{}}}, '', 'ops', [service], root).ok, false);
  assert.ok(classifyProdMutations(cmd, root).some(hit => hit.service === service));
  assert.ok(!classifyProdMutations(`bash ${runner}/status-local.sh dev 20261117T120000Z-check env-names`, path.resolve(__dirname, "../../..")).some(hit => hit.service === service));
  assert.ok(!classifyProdMutations('bash /tmp/status-local.sh test', path.resolve(__dirname, '../../..')).some(hit => hit.service === service));
  for (const invocation of [`bash -e ${runner}/status-local.sh prod 20261117T120000Z-check env-names`, `sh ${runner}/status-local.sh prod 20261117T120000Z-check env-names`, `bash scripts/gateway-runner/status-local.sh prod 20261117T120000Z-check env-names`, `env bash ${runner}/status-local.sh prod 20261117T120000Z-check env-names`, `${runner}/status-local.sh prod 20261117T120000Z-check env-names`]) {
    assert.ok(classifyProdMutations(invocation, path.resolve(__dirname, '../../..')).some(hit => hit.service === service), invocation);
    assert.equal(verifiedPlanBinding({...binding,command:invocation,entry:{...entry,commands:[invocation]}},'', 'ops',[service],root).ok,false,invocation);
  }

});

test('launch, later phases and rollback bind run, files, images, and declaration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-gate-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config/deploy-gate.json'), JSON.stringify({services:{[service]:{allowedCommands:['^bash /[^ ;]+(?: [A-Za-z0-9_:.,-]+)*$']}}}));
  const files = Object.fromEntries(Object.keys(GATEWAY_RUNNER_FORMATS).map(name => { const file=path.join(runner,name); return [file,hash(file)]; }));
  const run='20261117T120000Z-check', previous='sha256:'+'a'.repeat(64), candidate='sha256:'+'b'.repeat(64);
  const launch=`bash ${runner}/launch-local.sh prod ${run} v1 ${candidate} ${previous} rev backup azure-tts-key-v1`;
  const deploy=`bash ${runner}/operation-local.sh prod ${run} deploy`;
  const rollback=`bash ${runner}/rollback-local.sh prod ${run}`;
  const entries=[launch,deploy,rollback].map((command,i)=>({id:`s${i}`, commands:[command],files}));
  const plan={services:[service],environment_additions:[{name:'AZURE_TTS_KEY',source_id:'azure-tts-key-v1'}],changes:[`naia-gateway-prod-az acrnaia83b29893.azurecr.io/naia/gateway old (${previous})`,`naia-gateway-prod-az acrnaia83b29893.azurecr.io/naia/gateway v1 (${candidate})`],scenario:entries};
  const check=(index, kind, image, p=plan, command=entries[index].commands[0], entry=entries[index]) => verifiedPlanBinding({plan:p,entry,command,cwd:root},image,kind,[service],root);
  for (const i of [0,1]) assert.equal(check(i,'feature','v1').ok,true,JSON.stringify(check(i,'feature','v1')));
  assert.equal(check(2,'rollback',previous).ok,true,JSON.stringify(check(2,'rollback',previous)));
  assert.equal(check(1,'feature','v1',{...plan,environment_additions:[]}).ok,false);
  assert.equal(check(1,'feature','v1',{...plan,changes:[plan.changes[0],plan.changes[1].replace(candidate,'sha256:'+'c'.repeat(64))]}).ok,false);
  const changed=deploy.replace(run,'20261117T120000Z-other');
  assert.equal(check(1,'feature','v1',plan,changed,{...entries[1],commands:[changed]}).ok,false);
  const extra=deploy+' && echo INCIDENT_A1_STATUS_CHECKED';
  assert.equal(check(1,'feature','v1',plan,extra,{...entries[1],commands:[extra]}).ok,false);
  assert.equal(check(1,'feature','v1',plan,deploy,{...entries[1],files:{}}).ok,false);
  const cleanup=launch.replace(' backup azure-tts-key-v1', ' cleanup -');
  const cleanupEntry={...entries[0],id:'cleanup',commands:[cleanup]};
  const withCleanup={...plan,scenario:[...entries,cleanupEntry]};
  assert.equal(check(0,'feature','v1',withCleanup).ok,true);
  assert.equal(check(0,'feature','v1',withCleanup,cleanup,cleanupEntry).ok,true);
  const mismatchedCleanup=cleanup.replace(' rev cleanup',' rev2 cleanup');
  const mismatchedEntry={...cleanupEntry,commands:[mismatchedCleanup]};
  assert.equal(check(0,'feature','v1',{...plan,scenario:[...entries,mismatchedEntry]},mismatchedCleanup,mismatchedEntry).ok,false);

  const cleanupWithAdditions=launch.replace(' backup ', ' cleanup ');
  const invalidCleanupEntry={...entries[0],commands:[cleanupWithAdditions]};
  assert.match(check(0,'feature','v1',{...plan,scenario:[invalidCleanupEntry,...entries.slice(1)]},cleanupWithAdditions,invalidCleanupEntry).why,/실행기 본문·인자·의존 파일 불일치/);

  const readCommand=`bash ${runner}/status-local.sh prod ${run} env-names`;
  const readEntry={id:'read',commands:[readCommand],files};
  const readPlan={...plan,scenario:[...entries,readEntry]};
  assert.equal(verifiedPlanBinding({plan:readPlan,entry:readEntry,command:readCommand,cwd:root},'', 'ops',[service],root).ok,true);
  const brokenBackup={...entries[0],files:{}};
  const brokenPlan={...readPlan,scenario:[brokenBackup,...entries.slice(1),readEntry]};
  assert.equal(verifiedPlanBinding({plan:brokenPlan,entry:readEntry,command:readCommand,cwd:root},'', 'ops',[service],root).ok,false);

  const fullPlan = {...plan, schema:'deploy-plan/v1', author_model:'muse', planId:'gateway-sample-01', createdAt:new Date().toISOString(), what_why:'Gateway production deployment for verification', architecture_fit:{original_request:'Gateway production deployment request for a sample', parent_structure:'Common gateway deployment and approval gate', acceptance_rationale:'Use the common runner and approval gate for this change'}, scenario:entries.map((e,i)=>({...e,title:'Gateway deployment step',success_check:'Confirm health after execution',on_failure:'Stop and run rollback procedure',...(i===2?{branch:'rollback'}:{})})), risks:{items:['Service restart interruption'],worst_case:'Temporary service interruption'}, irreversible:['No database recovery occurs automatically'],disconnect_safety:'Inspect status before a separate recovery',rerun_safety:{lock:'Single execution lock',run_dir:'Unique run directory',no_latest_pick:'Explicit image digests'},success_verification:'Verify health and application function',rollback:{method:'Use the pinned rollback wrapper',duration:'1 minute',step_ids:['s2']},residual_risks:['Transient restart interruption'],incident:{criteria:['Unhealthy deployment'],actions:[]}};
  const { formProblems } = require('../lib/deploy-plan.js');
  assert.deepEqual(formProblems(fullPlan), []);
  const planFile=path.join(root,'plan.json'); fs.writeFileSync(planFile,JSON.stringify(fullPlan));
  const { spawnSync } = require('node:child_process');
  const cli=path.resolve(__dirname,'../../../.agents/scripts/plan-cmd-check.cjs');
  assert.equal(spawnSync(process.execPath,[cli,planFile,'s1',deploy,'feature','v1'],{cwd:root}).status,0);
  assert.equal(spawnSync(process.execPath,[cli,planFile,'s1',extra,'feature','v1'],{cwd:root}).status,1);
  for (const mode of ['env-names', 'installed-hashes']) {
    const read = `bash ${runner}/status-local.sh prod ${run} ${mode}`;
    const readEntry = {...entries[0], commands:[read]};
    const readPlan = {...fullPlan, scenario:[readEntry,...fullPlan.scenario.slice(1)]};
    fs.writeFileSync(planFile,JSON.stringify(readPlan));
    assert.ok(formProblems(readPlan).some(x=>x.includes('environment_additions')));
    assert.equal(spawnSync(process.execPath,[cli,planFile,'s0',read,'ops'],{cwd:root}).status,1);
  }
  const otherPlan = {...fullPlan,services:['azure:containerapp:other-prod']};
  fs.writeFileSync(planFile,JSON.stringify(otherPlan));
  assert.ok(formProblems(otherPlan).some(x=>x.includes('environment_additions')));
  assert.equal(spawnSync(process.execPath,[cli,planFile,'s1',deploy,'feature','v1'],{cwd:root}).status,1);
  const extraLaunch = {...entries[0],id:'extra'};
  assert.ok(formProblems({...fullPlan,scenario:[...fullPlan.scenario,extraLaunch]}).some(x=>x.includes('environment_additions')));


});

test('other services can use unrelated same-named scripts while gateway prod remains gated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-other-service-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'config'));
  const other = 'custom:service:other-prod';
  fs.writeFileSync(path.join(root, 'config/deploy-gate.json'), JSON.stringify({services:{[other]:{allowCustomCommands:true,allowedCommands:['^bash /other/status-local\\.sh dev$']}}}));
  const command = 'bash /other/status-local.sh dev';
  const entry = {commands:[command],files:{}};
  const plan = {services:[other],scenario:[entry]};
  const binding = {plan,entry,command,cwd:root};
  assert.equal(verifiedPlanBinding(binding,'candidate','feature',[other],root).ok,true);
  const prod = 'bash /other/status-local.sh prod';
  const rejected = verifiedPlanBinding({...binding,command:prod,entry:{...entry,commands:[prod]}},'candidate','feature',[other],root);
  assert.equal(rejected.ok,false);
  assert.match(rejected.why, /실행기 서비스 또는 명령 불일치/);
});

test('gateway binding honors plugin denials and configuration without allowing plugin bypass', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-policy-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'config'));
  const files = Object.fromEntries(Object.keys(GATEWAY_RUNNER_FORMATS).map(name => { const file=path.join(runner,name); return [file,hash(file)]; }));
  const command=`bash ${runner}/status-local.sh prod 20261117T120000Z-check env-names`;
  const entry={commands:[command],files};
  const plan={services:[service],scenario:[entry]};
  const binding={plan,entry,command,cwd:root};
  const policy=(plugin, extra={}) => fs.writeFileSync(path.join(root,'config/deploy-gate.json'),JSON.stringify({plugin,services:{[service]:{allowedCommands:['^bash /.*$']}},...extra}));
  const plugin=(name,body) => { fs.writeFileSync(path.join(root,`${name}.cjs`),body); return `./${name}.cjs`; };
  const check=(b=binding) => verifiedPlanBinding(b,'','ops',[service],root);
  policy(plugin('deny-binding','module.exports={verifyPlanBinding:()=>({ok:false,why:"binding denied"})}'));
  assert.match(check().why,/binding denied/);
  policy(plugin('deny-service','module.exports={assessService:()=>({ok:false,problems:["service denied"]})}'));
  assert.match(check().why,/service denied/);
  policy(plugin('throw','module.exports={assessService:()=>{throw Error("plugin failed")}}'));
  assert.match(check().why,/plugin failed/);
  policy('./missing.cjs'); assert.equal(check().ok,false);
  policy(plugin('accept','module.exports={verifyPlanBinding:()=>({ok:true}),assessService:()=>({ok:true})}'),{readOnlyScripts:'invalid'});
  assert.match(check().why,/readOnlyScripts/);
  policy('./accept.cjs');
  assert.equal(check().ok,true);
  assert.equal(check({...binding,entry:{...entry,files:{}}}).ok,false);
  policy('./accept.cjs',{services:{[service]:{allowedCommands:['^never$']}}});
  assert.equal(check().ok,false);
  for (const rule of [{}, {allowedCommands:[]}, {allowedCommands:'^bash'}, {allowedCommands:['[']}, {allowedCommands:['^bash',7]}, {allowedCommands:['^bash'],requiredFiles:'invalid'}]) {
    policy('./accept.cjs',{services:{[service]:rule}});
    assert.equal(check().ok,false,JSON.stringify(rule));
  }
});

test('example policy permits only supported runner command shapes', () => {
  const cfg=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../config/deploy-gate.example.json')));
  const patterns=cfg.services[service].allowedCommands.map(p=>new RegExp(p));
  const allowed=c=>patterns.some(p=>p.test(c));
  const prefix='/opt/example/gateway-runner';
  const run='20261117T120000Z-check', digest='sha256:'+'a'.repeat(64);
  const base=`bash ${prefix}/launch-local.sh prod ${run} v1 ${digest} ${digest} rev`;
  for(const command of [base,`${base} backup`,`${base} backup azure-tts-key-v1,azure-tts-region-v1`,`${base} cleanup`,`${base} cleanup -`, ...['deploy','verify','status','rollback'].map(x=>`bash ${prefix}/operation-local.sh prod ${run} ${x}`),...['',' recent',' full-log',' env-names',' installed-hashes'].map(x=>`bash ${prefix}/status-local.sh prod ${run}${x}`),`bash ${prefix}/rollback-local.sh prod ${run}`]) assert.ok(allowed(command),command);
  for(const command of [`${base} cleanup azure-tts-key-v1`,`${base} backup unknown`,`${base} backup - extra`,`${base} ; id`,`bash ${prefix}/status-local.sh prod ${run} env-names extra`,`bash ${prefix}/operation-local.sh prod ${run} env-names`,`bash ${prefix}/rollback-local.sh prod ${run} extra`]) assert.ok(!allowed(command),command);
});
