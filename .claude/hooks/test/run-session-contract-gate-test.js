#!/usr/bin/env node
'use strict';
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '../../..');
const core = require('../../../.agents/hooks/core/session-contract.js');
const adapters = ['.claude/hooks/session-contract-gate.js', '.codex/hooks/session-contract-gate.cjs'];
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'session-contract-gate-'));
let checks = 0;
function write(name, value) {
  const file = path.join(fixture, name);
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function run(adapter, tool_name, tool_input, env={}) {
  const result = cp.spawnSync(process.execPath, [path.join(fixture,adapter)], {
    cwd:fixture, input:JSON.stringify({cwd:fixture,session_id:'SESSION-1',tool_name,tool_input}), encoding:'utf8',
    env:{...process.env,AI_HARNESS:'',CLAUDE_HARNESS:'',CODEX_HARNESS:'',ADK_PROJECT_ROOT:'',...env}
  });
  assert.equal(result.status,0,result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}
function allowed(value,label) { assert.equal(value,null,label); checks++; }
function blocked(value,label) { assert.equal(value?.decision,'block',label); checks++; }
try {
  // 실행 중인 저장소의 권한 상태와 분리된 설치 모형을 사용한다.
  for (const dir of ['.agents/hooks/core', '.agents/hooks/policies', '.agents/harness', '.codex/hooks', '.claude/hooks/lib']) {
    fs.cpSync(path.join(root,dir),path.join(fixture,dir),{recursive:true});
  }
  write('.claude/hooks/session-contract-gate.js',fs.readFileSync(path.join(root,adapters[0]),'utf8'));
  write('.agents/context/agents-rules.json',{});
  for(const adapter of adapters) {
    allowed(run(adapter,'Write',{file_path:path.join(fixture,'product.txt'),content:'ordinary'}),'unbound ordinary file');
    blocked(run(adapter,'Write',{file_path:path.join(fixture,'AGENTS.md'),content:'policy'}),'unbound governance');
    write('config/deploy-gate.json',{approver:{discordUserId:'111111111111111111'},plugin:'./config/deploy-gate-plugin.cjs'});
    for (const tool of ['Edit','Write']) for (const file of ['config/deploy-gate.json','config/deploy-gate-plugin.cjs']) {
      blocked(run(adapter,tool,{file_path:path.join(fixture,file),content:'{"approver":{"discordUserId":"333333333333333333"}}',new_string:'{"approver":{"discordUserId":"333333333333333333"}}'}),`${tool} cannot replace gate config or approver: ${file}`);
    }
    blocked(run(adapter,'Bash',{command:'sed -i s/111111111111111111/333333333333333333/ config/deploy-gate.json'}),'shell cannot replace approver');
    write('config/alternate.json',{plugin:'./config/alternate-plugin.cjs'});
    for (const file of ['config/alternate.json','config/alternate-plugin.cjs']) {
      blocked(run(adapter,'Write',{file_path:path.join(fixture,file),content:'{}'},{DEPLOY_GATE_CONFIG:path.join(fixture,'config/alternate.json')}),`alternate config and plugin protected: ${file}`);
    }
    write('nested/config/deploy-gate.json',{plugin:'./config/other-plugin.cjs'});
    for (const file of ['nested/config/deploy-gate.json','nested/config/other-plugin.cjs']) {
      blocked(run(adapter,'Write',{file_path:path.join(fixture,file),content:'{}'},{DEPLOY_READINESS_ROOT:path.join(fixture,'nested')}),`readiness root config and plugin protected: ${file}`);
    }
    write('.agents/progress/alternate.json',{approver:{discordUserId:'111111111111111111'}});
    blocked(run(adapter,'Bash',{command:'sed -i s/111111111111111111/333333333333333333/ .agents/progress/alternate.json'},{DEPLOY_GATE_CONFIG:path.join(fixture,'.agents/progress/alternate.json')}),'progress exception does not allow rewriting the selected config');
    write('.agents/progress/legacy.md','---\nsession_id: SESSION-1\n---\n');
    blocked(run(adapter,'Write',{file_path:path.join(fixture,'AGENTS.md'),content:'policy'}),'legacy progress never grants authority');
    allowed(run(adapter,'Bash',{command:'git status --short'}),'read-only shell');
    blocked(run(adapter,'Bash',{command:'git branch -D protected'}),'destructive shell requires contract');
    for (const tool of ['apply_patch','functions.apply_patch']) {
      blocked(run(adapter,tool,{command:'*** Begin Patch\n*** Add File: product.txt\n+ordinary\n*** Add File: AGENTS.md\n+policy\n*** End Patch\n'}),'mixed governance patch');
      blocked(run(adapter,tool,{command:`*** Begin Patch\n*** Add File: ${path.join(path.dirname(fixture),'escape.txt')}\n+escape\n*** End Patch\n`}), 'outside workspace patch');
    }

    const contract = {
      schema_version:'1.0',id:'gate-test',status:'active',project_root:'.',goal:'test contract gate',scope:['product.txt'],
      non_goals:[],success_criteria:['gate enforces authority'],allowed_paths:['product.txt'],target_ownership:['product.txt'],
      audiences:['developer'],source_refs:['USR-TEST:E01'],session_bindings:[{session_id:'SESSION-1'}],
      progress_file:'.agents/progress/gate-test.json',allowed_shell_commands:['git branch -D protected']
    };
    const digest=core.contractDigest(contract);
    contract.contract_digest=digest;contract.session_bindings[0].contract_digest=digest;
    allowed(run(adapter,'Write',{file_path:path.join(fixture,'.agents/session-contracts/gate-test.json'),content:JSON.stringify(contract)}),'valid contract bootstrap');
    write('.agents/session-contracts/gate-test.json',contract);
    write(contract.progress_file,{contract_id:contract.id,contract_digest:digest});
    const registry={schema_version:'1.0',bindings:{'SESSION-1':{contract_id:contract.id,contract_path:'.agents/session-contracts/gate-test.json',contract_digest:digest}}};
    write('.agents/session-contracts/.session-map.json',registry);
    allowed(run(adapter,'Write',{file_path:path.join(fixture,'product.txt'),content:'bound'}),'bound file');
    allowed(run(adapter,'Bash',{command:'git branch -D protected'}),'exact contracted shell (hook decision only)');
    blocked(run(adapter,'Bash',{command:'git branch -D protected; true'}),'extra shell clause');
    blocked(run(adapter,'Write',{file_path:path.join(fixture,'AGENTS.md'),content:'policy'}),'contract excludes governance');
    contract.goal='tampered';write('.agents/session-contracts/gate-test.json',contract);
    blocked(run(adapter,'Bash',{command:'git branch -D protected'}),'tampered digest');
    allowed(run(adapter,'Write',{file_path:path.join(fixture,'AGENTS.md'),content:'policy'},{AI_HARNESS:'off'}),'explicit harness opt-out');
    fs.rmSync(path.join(fixture,'.agents/session-contracts/.session-map.json'));
    fs.rmSync(path.join(fixture,'.agents/session-contracts/gate-test.json'));
    fs.rmSync(path.join(fixture,contract.progress_file));
  }
  write('.codex/no-harness','');
  allowed(run(adapters[0],'Write',{file_path:path.join(fixture,'AGENTS.md'),content:'policy'}),'cross-host opt-out marker');
  console.log(`session-contract-gate: ${checks}/${checks} PASS`);
} finally { fs.rmSync(fixture,{recursive:true,force:true}); }
// Routine authorization has its own runner; this suite verifies session-contract enforcement.
