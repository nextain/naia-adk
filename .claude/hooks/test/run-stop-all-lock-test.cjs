'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const helper=require('../lib/stop-all-lock.js');
test('fixed policy ignores environment override and fails closed on unreadable lock',t=>{
 const before=process.env.STOP_ALL_LOCK_FILE;process.env.STOP_ALL_LOCK_FILE='/tmp/attacker-lock';
 t.after(()=>{if(before===undefined)delete process.env.STOP_ALL_LOCK_FILE;else process.env.STOP_ALL_LOCK_FILE=before});
 const fixed=helper.lockFile();assert.notEqual(fixed,process.env.STOP_ALL_LOCK_FILE);
 const original=fs.lstatSync;t.after(()=>fs.lstatSync=original);
 fs.lstatSync=p=>{assert.equal(p,fixed);return {isFile:()=>true}};assert.equal(helper.stopAllLocked(),true);
 fs.lstatSync=()=>{throw Object.assign(Error('denied'),{code:'EACCES'})};assert.equal(helper.stopAllLocked(),true);
 fs.lstatSync=()=>{throw Object.assign(Error('missing'),{code:'ENOENT'})};assert.equal(helper.stopAllLocked(),false);
});
test('all available send and deploy consumers use fixed lock helper before side effects',async t=>{
 const original=helper.stopAllLocked;helper.stopAllLocked=()=>true;t.after(()=>helper.stopAllLocked=original);
 const policy=require('../../../.agents/hooks/policies/bash.js');assert.match(policy.emailSend('node send.js send').reason,/잠금/);
 assert.equal(policy.emailSend('cat README.md'),null);
 const readiness=require('../lib/deploy-readiness.js');
 const tmp=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'fixed-lock-consumer-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const gates=path.join(tmp,'.agents/progress/test/gates');fs.mkdirSync(gates,{recursive:true});
 fs.writeFileSync(path.join(gates,'deploy.json'),JSON.stringify({services:['example'],createdAt:new Date().toISOString(),kind:'ops'}));
 assert.match(readiness.assessReadiness(['example'],{root:tmp}).problems.join(' '),/잠금/);
 const classifier=path.join(__dirname,'../lib/mail-command-classifier.js');
 if(fs.existsSync(classifier))assert.match(require(classifier).detectMailSend('node .agents/scripts/mail-send.mjs send draft.json'),/잠금/);
 const mail=path.join(__dirname,'../../../.agents/scripts/mail-send.mjs');
 if(fs.existsSync(mail)){const wrapper=await import(require('node:url').pathToFileURL(mail));await assert.rejects(wrapper.sendDraft('/not-used'),/잠금/);}
});
