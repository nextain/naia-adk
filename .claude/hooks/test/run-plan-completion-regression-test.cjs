require('../../../scripts/test-signal-safety.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const lib = require('../lib/deploy-plan.js');
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
 const plan = {sourceDocs:[{path:'docs/sample.md', sha256:hash(content), section:'Steps', acceptanceSection:'Acceptance', steps:[{id:'1',text:'Apply sample setting'}], acceptance:[{id:'1',text:'Sample screen is visible'}]}],scenario:[{id:'S1',covers:['1']}]};
 const gates = path.join(root, 'gates'); fs.mkdirSync(gates);
 const planFile = path.join(gates, 'deploy-plan.json');
 fs.writeFileSync(planFile, JSON.stringify(plan));
 const cli = (...args) => spawnSync(process.execPath, [path.join(root,'.agents/scripts/approval-plan.mjs'), ...args], {cwd:root,encoding:'utf8',env:{...process.env,NODE_OPTIONS:''}});
 return {root, plan, gates, planFile, cli, sha:hash(fs.readFileSync(planFile))};
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
 const f=fixture(t); const evidence=path.join(f.root,'evidence.txt'); fs.writeFileSync(evidence,'sample succeeded');
 const r=f.cli('step-ok',f.planFile,'S1','--evidence',evidence);
 assert.notEqual(r.status,0,r.stdout+r.stderr);
 assert.equal(fs.existsSync(path.join(f.gates,'deploy-steps/S1.json')),false);
});
test('completion CLI rejects report for another plan sha', t => {
 const f=fixture(t); const report=path.join(f.gates,'deploy-completion.json');
 fs.writeFileSync(report,JSON.stringify({plan_sha256:'0'.repeat(64),acceptance:[{id:'1',actual:'sample screen visible at 12:00 UTC'}]}));
 const r=f.cli('complete',f.planFile,'--report',report);
 assert.notEqual(r.status,0,r.stdout+r.stderr);
});
test('final step-ok binds completion receipt to plan and report sha', t => {
 const f=fixture(t); const report=path.join(f.gates,'deploy-completion.json');
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
