require('../../../scripts/test-signal-safety.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const lib = require('../lib/deploy-plan.js');
const {commandHash:libCommandHash}=require('../lib/deploy-human-approval.js');
const repo = path.resolve(__dirname, '../../..');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
function fixture(t) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-regression-'));
 t.after(() => fs.rmSync(root, {recursive:true, force:true}));
 for (const rel of lib.REVIEW_EXECUTOR_FILES) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), {recursive:true});
  fs.copyFileSync(path.join(repo, rel), path.join(root, rel));
 }
 fs.mkdirSync(path.join(root, 'docs'), {recursive:true});
 const content = '# Sample\n## Steps\n(1) Apply sample setting\n## Acceptance\n(1) Sample screen is visible\n';
 fs.writeFileSync(path.join(root, 'docs/sample.md'), content);
 const plan = {sourceDocs:[{path:'docs/sample.md', sha256:hash(content), section:'Steps', acceptanceSection:'Acceptance', steps:[{id:'1',text:'Apply sample setting'}], acceptance:[{id:'1',text:'Sample screen is visible'}]}],scenario:[{id:'S1',covers:['1'],commands:['apply sample setting']}]};
 const gates = path.join(root, 'gates'); fs.mkdirSync(gates);
 const planFile = path.join(gates, 'deploy-plan.json');
 fs.writeFileSync(planFile, JSON.stringify(plan));
 const cli = (...args) => spawnSync(process.execPath, [path.join(root,'.agents/scripts/approval-plan.mjs'), ...args], {cwd:root,encoding:'utf8',env:{...process.env,NODE_OPTIONS:'',DEPLOY_APPROVAL_STATE_DIR:path.join(root,'state')}});
 const sha=hash(fs.readFileSync(planFile));
 const executed=()=>{fs.mkdirSync(path.join(root,'state'),{recursive:true});fs.writeFileSync(path.join(root,'state/deploy-plan-state.json'),JSON.stringify({challenges:[{kind:'step',planSha:sha,step:'S1',status:'executed',executed:[libCommandHash('apply sample setting')],executedAt:new Date().toISOString()}]}));};
 return {root, plan, gates, planFile, cli, sha, executed};
}
for (const value of ['-','N/A','TBD','확인함','확인 완료',{},false,42,[],null]) {
 test(`completion rejects placeholder or nonstring actual ${JSON.stringify(value)}`, t => {
  const f=fixture(t);
  assert.equal(lib.verifyCompletionReport(f.plan,{acceptance:[{id:'1',actual:value}]},{root:f.root}).ok,false);
 });
}
test('completion rejects primitive report schema', t => {
 const f=fixture(t);
 for (const value of [42,true]) assert.equal(lib.verifyCompletionReport(f.plan,value,{root:f.root}).ok,false);
});
test('final step-ok rejects absent completion report without writing success', t => {
 const f=fixture(t); f.executed(); const evidence=path.join(f.root,'evidence.txt'); fs.writeFileSync(evidence,'sample succeeded');
 const r=f.cli('step-ok',f.planFile,'S1','--evidence',evidence);
 assert.notEqual(r.status,0,r.stdout+r.stderr);
 assert.equal(fs.existsSync(path.join(f.gates,'deploy-steps/S1.json')),false);
});
test('completion CLI rejects report for another plan sha', t => {
 const f=fixture(t); f.executed();
 const ev=path.join(f.root,'ev.txt'); fs.writeFileSync(ev,'observed'); fs.writeFileSync(path.join(f.gates,'deploy-completion.json'),JSON.stringify({plan_sha256:f.sha,acceptance:[{id:'1',actual:'screen observed at 12:00 UTC'}]})); assert.equal(f.cli('step-ok',f.planFile,'S1','--evidence',ev).status,0); const report=path.join(f.gates,'deploy-completion.json');
 fs.writeFileSync(report,JSON.stringify({plan_sha256:'0'.repeat(64),acceptance:[{id:'1',actual:'sample screen visible at 12:00 UTC'}]}));
 const r=f.cli('complete',f.planFile,'--report',report);
 assert.notEqual(r.status,0,r.stdout+r.stderr); assert.match(r.stderr,/sha256|SHA-256/);
});
test('final step-ok binds completion receipt to plan and report sha', t => {
 const f=fixture(t); f.executed(); const report=path.join(f.gates,'deploy-completion.json');
 fs.writeFileSync(report,JSON.stringify({plan_sha256:f.sha,acceptance:[{id:'1',actual:'sample screen visible at 12:00 UTC'}]}));
 const evidence=path.join(f.root,'evidence.txt'); fs.writeFileSync(evidence,'sample succeeded');
 const r=f.cli('step-ok',f.planFile,'S1','--evidence',evidence);
 assert.equal(r.status,0,r.stdout+r.stderr);
 const rec=JSON.parse(fs.readFileSync(path.join(f.gates,'deploy-completion-receipt.json')));
 assert.equal(rec.plan_sha256,f.sha); assert.equal(rec.report_sha256,hash(fs.readFileSync(report)));
});
test('CLI usage includes source-steps and complete commands', t => {
 const f=fixture(t); const r=f.cli();
 assert.match(r.stderr,/source-steps/); assert.match(r.stderr,/complete/);
});
test('completion rejects duplicate acceptance result ids', t => {
 const f=fixture(t);
 assert.equal(lib.verifyCompletionReport(f.plan,{acceptance:[{id:'1',actual:'sample measured at 12:00'},{id:'1',actual:'other measured at 12:01'}]},{root:f.root}).ok,false);
});
test('completion rejects invalid result entries even when required item is present', t => {
 const f=fixture(t);
 assert.equal(lib.verifyCompletionReport(f.plan,{acceptance:[{id:'1',actual:'sample measured at 12:00'},42]},{root:f.root}).ok,false);
});
test('forward final step requires completion even when rollback follows', t => {
 const f=fixture(t); f.plan.scenario.push({id:'R1',branch:'rollback'}); f.plan.rollback={step_ids:['R1']};
 fs.writeFileSync(f.planFile,JSON.stringify(f.plan));
 const evidence=path.join(f.root,'evidence.txt');fs.writeFileSync(evidence,'sample succeeded');
 const r=f.cli('step-ok',f.planFile,'S1','--evidence',evidence);
 assert.notEqual(r.status,0,r.stdout+r.stderr);
});
for (const cmd of ['report','review','preapprove']) test(`${cmd} preserves legacy source warning`, t => {
 const f=fixture(t); const plan=structuredClone(lib.TEMPLATE); plan.author_model='muse';plan.createdAt=new Date().toISOString();
 fs.writeFileSync(f.planFile,JSON.stringify(plan));
 const r=f.cli(cmd,f.planFile,'--author','muse','--session','fake-session','--dry');
 assert.match(r.stderr+r.stdout,/경고: sourceDocs/);
});
test('completion rejects unstructured text that can confuse acceptance ids', t => {
 const f=fixture(t);
 assert.equal(lib.verifyCompletionReport(f.plan,'11 actual: sample screen visible at 12:00 UTC',{root:f.root}).ok,false);
});
for(const actual of ['확인함.','TBD.','N / A','확인했습니다'])test(`completion rejects declaration variant ${actual}`,t=>{const f=fixture(t);assert.equal(lib.verifyCompletionReport(f.plan,{acceptance:[{id:'1',actual}]},{root:f.root}).ok,false)});
test('completion rejects aliased conflicting result id',t=>{const f=fixture(t);assert.equal(lib.verifyCompletionReport(f.plan,{acceptance:[{id:'1',actual:'screen observed at 12:00 UTC'},{id:'(1)',actual:'-',verdict:'fail'}]},{root:f.root}).ok,false)});

test('legacy final step-ok needs no completion report',t=>{const f=fixture(t);delete f.plan.sourceDocs;fs.writeFileSync(f.planFile,JSON.stringify(f.plan));const ev=path.join(f.root,'ev.txt');fs.writeFileSync(ev,'legacy observed');const r=f.cli('step-ok',f.planFile,'S1','--evidence',ev);assert.equal(r.status,0,r.stderr);assert.equal(fs.existsSync(path.join(f.gates,'deploy-completion-receipt.json')),false)});
for(const cmd of ['step-ok','complete'])test(`${cmd} rejects unexecuted source step and invalidates stale receipts`,t=>{const f=fixture(t);const ev=path.join(f.root,'ev.txt');fs.writeFileSync(ev,'observed');fs.writeFileSync(path.join(f.gates,'deploy-completion.json'),JSON.stringify({plan_sha256:f.sha,acceptance:[{id:'1',actual:'screen observed at 12:00 UTC'}]}));fs.mkdirSync(path.join(f.gates,'deploy-steps'));fs.writeFileSync(path.join(f.gates,'deploy-steps/S1.json'),'{}');fs.writeFileSync(path.join(f.gates,'deploy-completion-receipt.json'),'{}');const r=f.cli(cmd,f.planFile,...(cmd==='step-ok'?['S1','--evidence',ev]:[]));assert.notEqual(r.status,0);assert.equal(fs.existsSync(path.join(f.gates,'deploy-completion-receipt.json')),false);if(cmd==='step-ok')assert.equal(fs.existsSync(path.join(f.gates,'deploy-steps/S1.json')),false)});
test('failed repeated step-ok removes earlier success and completion receipt',t=>{const f=fixture(t);f.executed();const ev=path.join(f.root,'ev.txt');fs.writeFileSync(ev,'observed');const report=path.join(f.gates,'deploy-completion.json');fs.writeFileSync(report,JSON.stringify({plan_sha256:f.sha,acceptance:[{id:'1',actual:'screen observed at 12:00 UTC'}]}));assert.equal(f.cli('step-ok',f.planFile,'S1','--evidence',ev).status,0);fs.writeFileSync(report,'{}');assert.notEqual(f.cli('step-ok',f.planFile,'S1','--evidence',ev).status,0);assert.equal(fs.existsSync(path.join(f.gates,'deploy-steps/S1.json')),false);assert.equal(fs.existsSync(path.join(f.gates,'deploy-completion-receipt.json')),false)});
test('invalid evidence directory leaves no completion receipt',t=>{const f=fixture(t);f.executed();fs.writeFileSync(path.join(f.gates,'deploy-completion.json'),JSON.stringify({plan_sha256:f.sha,acceptance:[{id:'1',actual:'screen observed at 12:00 UTC'}]}));assert.notEqual(f.cli('step-ok',f.planFile,'S1','--evidence',f.root).status,0);assert.equal(fs.existsSync(path.join(f.gates,'deploy-completion-receipt.json')),false)});
for(const cmd of ['step-ok','complete'])test(`${cmd} enforces instance required policy for legacy plan`,t=>{const f=fixture(t);delete f.plan.sourceDocs;fs.writeFileSync(f.planFile,JSON.stringify(f.plan));fs.mkdirSync(path.join(f.root,'config'));fs.writeFileSync(path.join(f.root,'config/deploy-gate.json'),JSON.stringify({sourcePolicy:'required'}));const ev=path.join(f.root,'ev.txt');fs.writeFileSync(ev,'observed');const r=f.cli(cmd,f.planFile,...(cmd==='step-ok'?['S1','--evidence',ev]:[]));assert.notEqual(r.status,0);assert.match(r.stderr,/sourceDocs/);assert.equal(fs.existsSync(path.join(f.gates,'deploy-completion-receipt.json')),false)});
test('complete cannot bypass missing success with pending-step flag',t=>{const f=fixture(t);f.executed();fs.writeFileSync(path.join(f.gates,'deploy-completion.json'),JSON.stringify({plan_sha256:f.sha,acceptance:[{id:'1',actual:'screen observed at 12:00 UTC'}]}));const r=f.cli('complete',f.planFile,'--pending-step','S1');assert.notEqual(r.status,0);assert.equal(fs.existsSync(path.join(f.gates,'deploy-completion-receipt.json')),false)});
test('partial newer attempt cannot reuse executed commands from earlier attempt',t=>{const f=fixture(t);f.executed();const stateFile=path.join(f.root,'state/deploy-plan-state.json');const state=JSON.parse(fs.readFileSync(stateFile));state.challenges.push({kind:'step',planSha:f.sha,step:'S1',status:'pending',executed:[]});fs.writeFileSync(stateFile,JSON.stringify(state));const ev=path.join(f.root,'ev.txt');fs.writeFileSync(ev,'observed');fs.writeFileSync(path.join(f.gates,'deploy-completion.json'),JSON.stringify({plan_sha256:f.sha,acceptance:[{id:'1',actual:'screen observed at 12:00 UTC'}]}));const r=f.cli('step-ok',f.planFile,'S1','--evidence',ev);assert.notEqual(r.status,0);assert.equal(fs.existsSync(path.join(f.gates,'deploy-completion-receipt.json')),false)});
test('complete requires previous step success and clears earlier receipt on report failure',t=>{const f=fixture(t);f.executed();const ev=path.join(f.root,'ev.txt');fs.writeFileSync(ev,'observed');const report=path.join(f.gates,'deploy-completion.json');fs.writeFileSync(report,JSON.stringify({plan_sha256:f.sha,acceptance:[{id:'1',actual:'screen observed at 12:00 UTC'}]}));assert.equal(f.cli('step-ok',f.planFile,'S1','--evidence',ev).status,0);assert.equal(f.cli('complete',f.planFile).status,0);fs.writeFileSync(report,'{}');assert.notEqual(f.cli('complete',f.planFile).status,0);assert.equal(fs.existsSync(path.join(f.gates,'deploy-completion-receipt.json')),false)});
