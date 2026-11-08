"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const safety=require('../../../scripts/test-signal-safety.cjs');
test('safety blocks native and child signals without invoking either',()=>{
 let fakeNativeCalls=0;function FakeChild(){};FakeChild.prototype.kill=()=>{fakeNativeCalls++};
 const cp={ChildProcess:FakeChild};for(const name of ['spawn','spawnSync','execFile','execFileSync','exec','execSync','fork'])cp[name]=()=>{fakeNativeCalls++};
 const fakeProcess={kill:()=>{fakeNativeCalls++},argv:[],env:{}};
 const sandbox={process:fakeProcess,module:{exports:{}},__filename:'/fixture/safety.cjs',require:name=>{if(name==='node:child_process')return cp;if(name==='node:module')return {syncBuiltinESMExports(){}};throw Error(name)}};
 require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../../../scripts/test-signal-safety.cjs'),'utf8'),sandbox);
 assert.throws(()=>fakeProcess.kill(123,'SIGKILL'),/TEST_SAFETY/);assert.throws(()=>FakeChild.prototype.kill.call({},'SIGKILL'),/TEST_SAFETY/);assert.equal(fakeNativeCalls,0);
});
test('safety blocks forbidden test and timeout SIGKILL before spawn',()=>{
 for(const [c,a,o] of [['node',['run-beh-supervise-wrapper-test.js'],{}],['timeout',['-s','KILL','1','node'],{}],['node',[],{timeout:1}],['node',[],{killSignal:'SIGKILL'}]])assert.throws(()=>safety.validate(c,a,o),/TEST_SAFETY/);
 assert.doesNotThrow(()=>safety.validate('node',['--test','safe.cjs'],{}));
});

test('child env stripping still carries signal protection and ESM exports match',async()=>{
 const cp=require('node:child_process'),esm=await import('node:child_process');assert.equal(esm.spawnSync,cp.spawnSync);assert.equal(esm.fork,cp.fork);
 const result=cp.spawnSync(process.execPath,['-e',"console.log(process.kill.name,process.kill.toString().includes('TEST_SAFETY'))"],{env:{},encoding:'utf8'});
 assert.equal(result.status,0);assert.match(result.stdout,/denied true/);
});

test('native synchronous capture has no overflow signal path',()=>{assert.equal(safety.normalizeCapture({maxBuffer:8}).maxBuffer,Infinity);assert.throws(()=>safety.validate('node',[],{signal:{}}),/TEST_SAFETY/)});
