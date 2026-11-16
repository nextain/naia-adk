'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const cli = path.join(root, '.agents/scripts/approval-plan.mjs');
const lib = require('../lib/deploy-plan.js');
const { classifyProdMutations } = require('../lib/deploy-command-classifier.js');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'assert-contract-'));

test('registered targets fail closed for expansion, duplicate options and resource IDs', t => {
 const dir = fixture(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 fs.mkdirSync(path.join(dir, 'config'));
 fs.writeFileSync(path.join(dir, 'config/deploy-gate.json'), JSON.stringify({services: {'azure:vm:demo-dev-01': {}, 'azure:group:rg-demo-dev': {}, 'ssh:demo-host-dev': {}, 'azure:storage:storage-dev': {}}}));
 const run = cmd => classifyProdMutations(cmd, dir, 0, false, dir);
 for (const cmd of [
  'az vm run-command invoke -g rg-x -n demo-dev-01$EMPTY',
  'az vm run-command invoke -g rg-x -n "$(echo demo-dev-01)"',
  'az vm run-command invoke -g rg-x -n `echo demo-dev-01`',
  'az vm run-command invoke -g rg-x -n ${V:-demo-dev-01}',
  'az vm run-command invoke -g rg-x -n demo-dev-0$((1))',
  'ssh $(echo demo-host-dev) touch /tmp/a',
  'az disk delete --ids /subscriptions/s/resourceGroups/rg-demo-dev/providers/Microsoft.Compute/disks/d-dev-1 --yes',
  'az vm run-command invoke -g rg-x -n other-dev-02 -n demo-dev-01',
 ]) assert.ok(run(cmd).length, cmd);
 for (const cmd of ['az vm restart -g rg-dev -n other-dev', 'ssh storage-dev touch /tmp/a']) assert.equal(run(cmd).length, 0, cmd);
 assert.ok(run('ssh demo-host-dev touch /tmp/a').length);
 assert.ok(run('ssh demo-dev-01 touch /tmp/a').length);
 assert.ok(run('az ssh vm -g rg-dev -n demo-dev-01').length);
 assert.ok(run('az vm restart -g rg-dev -n demo-dev-01').length);
 assert.ok(run('az group delete --name rg-demo-dev --yes').length);
});

test('Discord confirmation is bound to current plan, command, pins and instance approver', async t => {
 const dir=fixture(); t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
 const gates=path.join(dir,'gates'); fs.mkdirSync(gates);
 const file=path.join(dir,'script.sh'); fs.writeFileSync(file,'body');
 const plan={scenario:[{id:'s1',commands:['echo hello'],files:{[file]:hash('body')}}]};
 const sha=hash(JSON.stringify(plan)); const code=lib.stepCode(sha,'s1','echo hello');
 const digest=crypto.createHash('sha256').update(`plan-step-v1\0${sha}\0s1\0${hash('echo hello')}`).digest();
 const bits=[...digest].map(b=>b.toString(2).padStart(8,'0')).join('');
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
 assert.equal(code,'STEP-'+Array.from({length:10},(_,i)=>alphabet[parseInt(bits.slice(i*5,i*5+5),2)]).join(''));
 const author='111111111111111111', channel='222222222222222222', message='333333333333333333';
 fs.writeFileSync(path.join(gates,'deploy-approval-discord.json'),JSON.stringify({approvals:[{code,channelId:channel,messageId:message}]}));
 const fetchImpl=async () => ({ok:true,json:async () => ({id:message,channel_id:channel,author:{id:author},content:code,timestamp:'2026-01-01T00:00:00Z'})});
 const options={gatesDir:gates,approverId:author,discordToken:'token',fetchImpl};
 assert.equal(await lib.assertApprovedStep(plan,sha,'s1',dir,options),null);
 assert.ok(await lib.assertApprovedStep(plan,sha,'s1',dir,{...options,discordToken:''}));
 assert.ok(await lib.assertApprovedStep(plan,hash('other'),'s1',dir,options));
 assert.ok(await lib.assertApprovedStep(plan,sha,'s2',dir,options));
 const multi={scenario:[{...plan.scenario[0],commands:['echo hello','echo second']}]};
 const multiSha=hash(JSON.stringify(multi)); const first=lib.stepCode(multiSha,'s1','echo hello'), second=lib.stepCode(multiSha,'s1','echo second');
 fs.writeFileSync(path.join(gates,'deploy-approval-discord.json'),JSON.stringify({approvals:[{code:first,channelId:channel,messageId:message}]}));
 const messageFor=content=>async()=>({ok:true,json:async()=>({id:message,channel_id:channel,author:{id:author},content,timestamp:'2026-01-01T00:00:00Z'})});
 assert.ok(await lib.assertApprovedStep(multi,multiSha,'s1',dir,{...options,fetchImpl:messageFor(first)}));
 fs.writeFileSync(path.join(gates,'deploy-approval-discord.json'),JSON.stringify({approvals:[{code:first,channelId:channel,messageId:message},{code:second,channelId:channel,messageId:message}]}));
 assert.equal(await lib.assertApprovedStep(multi,multiSha,'s1',dir,{...options,fetchImpl:messageFor(`${first} ${second}`)}),null);
 fs.writeFileSync(path.join(gates,'deploy-approval-discord.json'),JSON.stringify({approvals:[{code,channelId:channel,messageId:message}]}));
 for(const change of [{author:{id:author,bot:true}},{author:{id:'444444444444444444'}},{webhook_id:'444444444444444444'}]) {
  const bad=async()=>({ok:true,json:async()=>({id:message,channel_id:channel,author:{id:author},content:code,timestamp:'2026-01-01T00:00:00Z',...change})});
  assert.ok(await lib.assertApprovedStep(plan,sha,'s1',dir,{...options,fetchImpl:bad}));
 }
 fs.writeFileSync(file,'changed'); assert.ok(await lib.assertApprovedStep(plan,sha,'s1',dir,options));
});

test('exact language line is required before all body code and only it is exempt', t => {
 const dir=fixture(); t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
 const planFile=path.join(dir,'deploy-plan.json'), marker=path.join(dir,'marker');
 fs.writeFileSync(planFile,'{}');
 for(const [name,interpreter,shebang,body] of [
  ['job.sh','bash','#!/bin/bash',`touch '${marker}'`],
  ['job.cjs','node','',`require('fs').writeFileSync('${marker}','x')`],
  ['job.mjs','node','',`(await import('node:fs')).writeFileSync('${marker}','x')`],
  ['job.py','python3','',`open('${marker}','w').write('x')`],
 ]) {
  const script=path.join(dir,name); fs.writeFileSync(script,(shebang?shebang+'\n':'')+body+'\n');
  const line=lib.assertLine(planFile,'s1',script);
  const text=(shebang?shebang+'\n':'')+line+'\n'+body+'\n'; fs.writeFileSync(script,text);
  const plan={scenario:[{id:'s1',commands:[`${interpreter} ${script}`],files:{[script]:hash(text)}}]};
  fs.writeFileSync(planFile,JSON.stringify(plan));
  const state=path.join(dir,'state'); fs.mkdirSync(state,{recursive:true});
  fs.writeFileSync(path.join(state,'deploy-plan-state.json'),JSON.stringify({challenges:[{kind:'step',planSha:hash(JSON.stringify(plan)),step:'s1',code:'STEP-FAKE',approvedAt:'x',approvedVia:'discord',executed:[hash(`${interpreter} ${script}`)]}]}));
  assert.deepEqual(lib.assertScriptProblems(plan,dir,planFile),[],name);
  for (const env of [{...process.env,HOME:dir,XDG_STATE_HOME:state,DEPLOY_APPROVAL_STATE_DIR:state},{...process.env,HOME:'/root',XDG_STATE_HOME:'',DEPLOY_APPROVAL_STATE_DIR:state}])
   assert.notEqual(spawnSync(interpreter,[script],{encoding:'utf8',env}).status,0,name);
  assert.equal(fs.existsSync(marker),false,name);
  const refs=lib.referencedFiles(`${interpreter} ${script}`,dir,{planFile,stepId:'s1'}).map(x=>x.path);
  if(interpreter==='bash') assert.ok(!refs.includes(planFile));
  fs.writeFileSync(script,(shebang?shebang+'\n':'')+line+'; touch /tmp/fake-escape\n'+body+'\n');
  assert.ok(lib.assertScriptProblems(plan,dir,planFile).length,name+' injected');
  fs.writeFileSync(script,(shebang?shebang+'\n':'')+'//tmp/evil.sh\n'+line+'\n'+body+'\n');
  assert.ok(lib.assertScriptProblems(plan,dir,planFile).length,name);
 }
 const unknown=path.join(dir,'job.fish'); fs.writeFileSync(unknown,'#!/usr/bin/fish\necho hi\n');
 assert.match(lib.assertScriptProblems({scenario:[{id:'s1',files:{[unknown]:hash(fs.readFileSync(unknown))}}]},dir,planFile)[0],/assert 형식 없는 언어/);
});

test('pinned executable scripts require the line regardless of invocation', t => {
 const dir=fixture(); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'script.sh'); fs.writeFileSync(file,'#!/bin/bash\necho no\n');
 const planFile=path.join(dir,'deploy-plan.json');
 for(const command of [`bash -e ${file} s1`,`bash ${file} s1 -e`,`bash ${file} s1 -p`,`source ${file} s1`,`. ${file} s1`,`cat ${file} | bash`,`perl ${file}`,`ssh h bash -s < ${file}`]) {
  assert.ok(lib.assertScriptProblems({scenario:[{id:'s1',commands:[command],files:{[file]:hash(fs.readFileSync(file))}}]},dir,planFile).length,command);
 }
});

test('a real script proceeds only when mocked Discord confirms its deterministic code', t => {
 const dir=fixture(); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const rel of ['.agents/scripts/approval-plan.mjs','.claude/hooks/lib/deploy-human-approval.js','.claude/hooks/lib/git-command-parser.js','.claude/hooks/lib/effective-argv.js','.claude/hooks/lib/deploy-instance-identity.js','.claude/hooks/lib/deploy-plan.js']) {
  const dest=path.join(dir,rel); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.copyFileSync(path.join(root,rel),dest);
 }
 const fakeCli=path.join(dir,'.agents/scripts/approval-plan.mjs');
 const user='111111111111111111', channel='222222222222222222', message='333333333333333333';
 let source=fs.readFileSync(fakeCli,'utf8');
 const identity=path.join(dir,'.claude/hooks/lib/deploy-instance-identity.js');
 fs.writeFileSync(identity,fs.readFileSync(identity,'utf8').replace('const APPROVER_DISCORD_ID = "";',`const APPROVER_DISCORD_ID = "${user}";`));
 source=source.replace('approverId: INSTANCE_APPROVER_DISCORD_ID, gatesDir:',`approverId: INSTANCE_APPROVER_DISCORD_ID, discordToken: "mock-token", fetchImpl: async () => ({ok:true,json:async()=>JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir,'mock-message.json'))},'utf8'))}), gatesDir:`);
 fs.writeFileSync(fakeCli,source);
 fs.mkdirSync(path.join(dir,'.git')); const gates=path.join(dir,'.agents/progress/work/gates'); fs.mkdirSync(gates,{recursive:true});
 const planFile=path.join(gates,'deploy-plan.json'), script=path.join(dir,'run.sh'), marker=path.join(dir,'ran');
 fs.writeFileSync(script,'#!/bin/sh\n');
 const instance=require(path.join(dir,'.claude/hooks/lib/deploy-plan.js'));
 const line=instance.assertLine(planFile,'s1',script);
 const body=`#!/bin/sh\n${line}\ntouch '${marker}'\n`; fs.writeFileSync(script,body);
 const plan={scenario:[{id:'s1',commands:[`bash ${script}`],files:{[script]:hash(body)}}]};
 fs.writeFileSync(planFile,JSON.stringify(plan)); const code=instance.stepCode(hash(JSON.stringify(plan)),'s1',plan.scenario[0].commands[0]);
 fs.writeFileSync(path.join(gates,'deploy-approval-discord.json'),JSON.stringify({approvals:[{code,channelId:channel,messageId:message}]}));
 const mock={id:message,channel_id:channel,author:{id:user},content:code,timestamp:'2026-01-01T00:00:00Z'};
 fs.writeFileSync(path.join(dir,'mock-message.json'),JSON.stringify({...mock,author:{id:user,bot:true}}));
 assert.notEqual(spawnSync('bash',[script],{cwd:dir}).status,0); assert.equal(fs.existsSync(marker),false);
 fs.writeFileSync(path.join(dir,'mock-message.json'),JSON.stringify(mock));
 const result=spawnSync('bash',[script],{cwd:dir,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr); assert.equal(fs.existsSync(marker),true);
 fs.unlinkSync(marker);
 if (spawnSync('sudo',['-n','true']).status === 0) {
  const elevated=spawnSync('sudo',['-n','bash',script],{cwd:dir,encoding:'utf8',env:{...process.env,HOME:'/root',XDG_STATE_HOME:'',DEPLOY_APPROVAL_STATE_DIR:'/tmp/not-the-state'}});
  assert.equal(elevated.status,0,elevated.stderr); assert.equal(fs.existsSync(marker),true);
 }
});

test('Discord token lookup has the same result for ordinary and sudo environments', async t => {
 const probe=spawnSync('sudo',['-n','true'],{encoding:'utf8'});
 if(probe.status!==0) return t.skip('passwordless sudo unavailable');
 const dir=fixture(); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'config')); fs.writeFileSync(path.join(dir,'config/deploy-gate.json'),JSON.stringify({discord:{instances:['fixture']}}));
 fs.mkdirSync(path.join(dir,'.agents/skills'),{recursive:true});
 fs.symlinkSync(path.join(root,'.agents/skills/manage-discord-sessions'),path.join(dir,'.agents/skills/manage-discord-sessions'));
 const configDir=path.join(dir,'naia-settings/messenger-sessions/instances/fixture'); fs.mkdirSync(configDir,{recursive:true});
 const keyDir=path.join(dir,'naia-settings/.keys/messenger-sessions'); fs.mkdirSync(keyDir,{recursive:true,mode:0o700}); fs.chmodSync(keyDir,0o700);
 const config={schemaVersion:1,enabled:true,workspaceId:'test',persona:{name:'Observer',instructions:'Observe safely.'},role:{name:'reader',allowedActions:['read','reply'],requiresApproval:[]},backend:{selected:'codex',profiles:{codex:{enabled:true},claude:{enabled:false}}},discord:{credentialRef:'token',botUserId:'111111111111111111',operatorUserIds:[],bindings:[{kind:'dm',userId:'222222222222222222',respondWhen:'always',allowedUserIds:['222222222222222222'],canStartConversation:true,operatorActions:true}]},runtime:{heartbeatSeconds:10,softSilenceSeconds:2,noProgressInterventionSeconds:2,operatorResponseSeconds:1,approvalPolicy:'never',permissionProfileEpoch:'test',maxConcurrentJobs:1},observability:{discordStatusProjection:false},service:{autoStart:true,startAt:'login'},recovery:{autoRetry:true}};
 fs.writeFileSync(path.join(configDir,'config.json'),JSON.stringify(config),{mode:0o600}); fs.writeFileSync(path.join(keyDir,'token'),'fixture-token-123456789',{mode:0o600});
 const normal=await lib.loadDiscordToken(dir); assert.equal(normal,'fixture-token-123456789');
 const code=`require(${JSON.stringify(path.join(root,'.claude/hooks/lib/deploy-plan.js'))}).loadDiscordToken(${JSON.stringify(dir)}).then(t=>process.stdout.write(String(t === 'fixture-token-123456789')))`;
 const sudo=spawnSync('sudo',['-n',process.execPath,'-e',code],{encoding:'utf8',env:{...process.env,HOME:'/root',XDG_STATE_HOME:'',DEPLOY_APPROVAL_STATE_DIR:'/tmp/not-the-state'}});
 assert.equal(sudo.status,0,sudo.stderr); assert.equal(sudo.stdout,'true');
});

test('malformed first-line assert receives no reference exemption', t => {
 const dir=fixture(); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const planFile=path.join(dir,'deploy-plan.json'), script=path.join(dir,'run.sh'), evil=path.join(dir,'evil.sh');
 fs.writeFileSync(planFile,'{}'); fs.writeFileSync(evil,'#!/bin/sh\nexit 0\n');
 fs.writeFileSync(script,'#!/bin/sh\n'); const line=lib.assertLine(planFile,'s1',script);
 for (const altered of [
  `node ${cli} assert ${dir}/;{bash,${evil}};/../../deploy-plan.json "$1" || exit 1`,
  `${line} || bash ${evil}`,
 ]) {
  const body=`#!/bin/sh\n${altered}\n`;
  fs.writeFileSync(script,body);
  const plan={scenario:[{id:'s1',commands:[`bash ${script}`],files:{[script]:hash(body)}}]};
  assert.ok(lib.assertScriptProblems(plan,dir,planFile).length);
  const refs=lib.referencedFiles(`bash ${script}`,dir,{planFile,stepId:'s1'}).map(x=>x.path);
  assert.ok(refs.includes(cli),altered);
  if (altered.endsWith(evil)) assert.ok(refs.includes(evil));
 }
});
