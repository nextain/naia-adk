require("../../../scripts/test-signal-safety.cjs");
"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../../..');
test('readiness direct calls fail closed before any plan or readiness parsing',t=>{
 const lock=require('../lib/stop-all-lock.js'),old=lock.stopAllLocked;lock.stopAllLocked=()=>true;t.after(()=>lock.stopAllLocked=old);
 const result=require('../lib/deploy-readiness.js').assessReadiness(['systemd:sample'],{root:'/nonexistent',planBinding:{}});
 assert.equal(result.ok,false);assert.match(result.problems[0],/모두 멈춤 잠금/);
});
test('signal safety rejects copied script and shell syntax before fake native calls',()=>{
 let calls=0,last,lastArgs;function Child(){};Child.prototype.kill=()=>calls++;
 const cp={ChildProcess:Child};for(const n of ['spawn','spawnSync','execFile','execFileSync','exec','execSync','fork'])cp[n]=(...a)=>{calls++;lastArgs=a[1];last=a.find(x=>x&&typeof x==='object'&&!Array.isArray(x))};
 const proc={kill:()=>calls++,_kill:()=>calls++,argv:[],execArgv:['--require',path.join(root,'scripts/test-signal-safety.cjs')],env:{NODE_OPTIONS:'--require='+path.join(root,'scripts/test-signal-safety.cjs')}};
 const sandbox={process:proc,module:{exports:{}},__filename:path.join(root,'scripts/test-signal-safety.cjs'),require:n=>n==='node:child_process'?cp:n==='node:module'?{syncBuiltinESMExports(){}}:require(n)};
 vm.runInNewContext(fs.readFileSync(sandbox.__filename,'utf8'),sandbox);
 for(const cmd of ['true;kill -9 999999','(kill -9 999999)','true&&pkill node','!kill -9 999999','`kill -9 999999`','python3 -c "import os; os.kill(999999,9)"'])assert.throws(()=>cp.spawnSync('bash',['-c',cmd]),/TEST_SAFETY/);
 assert.throws(()=>proc._kill(999999,9),/TEST_SAFETY/);assert.equal(calls,0);
 cp.spawnSync('node',['-v'],{timeout:5,killSignal:'SIGKILL'});assert.equal(last.timeout,undefined);assert.equal(last.killSignal,undefined);
 cp.spawnSync('python3',['--test']);assert.equal(lastArgs.join(' '),'--test');cp.fork('app.cjs',['--test']);assert.equal(lastArgs.join(' '),'--test');cp.spawnSync('node',['--test','fixture.cjs']);assert.equal(lastArgs[0],'--experimental-test-isolation=none');
 assert.equal(proc.env.NODE_OPTIONS,'');assert.deepEqual(proc.execArgv,[]);
 const tmp=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'copied-'));try{const foreign=path.join(tmp,'foreign-guard.cjs');fs.copyFileSync(path.join(root,'scripts/test-signal-safety.cjs'),foreign);assert.doesNotThrow(()=>cp.spawnSync('node',['--require',foreign,'-v']));const copy=path.join(tmp,'innocent.js');fs.copyFileSync(path.join(root,'.claude/hooks/test/run-beh-supervise-wrapper-test.js'),copy);assert.throws(()=>cp.spawnSync('node',[copy]),/TEST_SAFETY/);fs.writeFileSync(copy,fs.readFileSync(copy,'utf8').replace(/\/\*\*[\s\S]*?\*\//,''));assert.throws(()=>cp.spawnSync('node',[copy]),/TEST_SAFETY/);}finally{fs.rmSync(tmp,{recursive:true,force:true})}
});

test('approval startup permits linked workspace ancestor and rejects linked entry leaf',t=>{
 const tmp=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'approval-links-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const real=path.join(tmp,'real'),linked=path.join(tmp,'linked');fs.mkdirSync(real);fs.symlinkSync(real,linked);fs.writeFileSync(path.join(real,'executor.cjs'),'module.exports={}');
 const source=fs.readFileSync(path.join(root,'.agents/scripts/approval-plan.mjs'),'utf8');
 const begin=source.indexOf('const pinnedExecutors ='),end=source.indexOf('for (const { requested, filename }',begin);
 assert.doesNotThrow(()=>vm.runInNewContext(source.slice(begin,end),{PINNED_CJS_EXECUTORS:['executor.cjs'],ROOT:linked,path,fs,die:m=>{throw Error(m)}}));
 const entry=path.join(real,'approval-plan.mjs'),alias=path.join(real,'alias.mjs');fs.writeFileSync(entry,'// fixture');fs.symlinkSync(entry,alias);
 const a=source.indexOf('const bootEntryAbs ='),b=source.indexOf('let BOOT_ENTRY_SHA',a);
 const code=source.slice(a,b).replace('const fallback = fileURLToPath(import.meta.url);','const fallback = entry;');
 for(const [filename,shouldReject]of [[path.join(linked,'approval-plan.mjs'),false],[alias,true]]){
  const reasons=[];vm.runInNewContext(code,{process:{argv:['node',filename]},entry,path,fs,die:m=>reasons.push(m)});assert.equal(reasons.some(m=>m.includes('심볼릭 링크')),shouldReject);
 }
});

test('unsafe Node test coordinator is refused and child test worker stays protected',t=>{
 const filename=path.join(root,'scripts/test-signal-safety.cjs');
 assert.throws(()=>vm.runInNewContext(fs.readFileSync(filename,'utf8'),{process:{execArgv:['--test'],argv:[],env:{}},__filename:filename,module:{exports:{}},require}),/TEST_SAFETY: node --test requires/);
 const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'node-test-safety-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'protected.cjs');fs.writeFileSync(file,`require('node:test')('guard visible inside test process',()=>{const assert=require('node:assert/strict');assert.match(process.kill.toString(),/TEST_SAFETY/);assert.match(require('node:child_process').ChildProcess.prototype.kill.toString(),/TEST_SAFETY/);assert.match(process._kill.toString(),/TEST_SAFETY/)});`);
 const result=require('node:child_process').spawnSync(process.execPath,['--test',file],{encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/pass 1/);
});
