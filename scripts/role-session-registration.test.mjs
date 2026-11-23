import nodeTest from 'node:test';
const test=(name,fn)=>nodeTest(name,{skip:process.platform!=='linux'},fn);
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from './role-session-registration.mjs';

async function capture(fn){
  const chunks=[],write=process.stdout.write;process.stdout.write=text=>{chunks.push(String(text));return true;};
  try{return {code:await fn(),result:JSON.parse(chunks.join(''))};}finally{process.stdout.write=write;}
}
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'registration-cli-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const thread='11111111-2222-4333-8444-555555555555',profile={pane_id:'w2:p7',session:{kind:'codex-jsonl',
    thread_id:thread,cwd:dir,native_path:path.join(dir,'native.jsonl')},registration:{uid:process.getuid(),
    state_dir:path.join(dir,'state'),frontend_executable:'/fixture/codex',launcher_executable:'/bin/bash',backend:{kind:'embedded'}}};
  const config=path.join(dir,'config.json');await fs.writeFile(config,JSON.stringify({roles:{writer:profile}}));
  let current={pid:20,start:'200',uid:process.getuid(),cwd:dir,exe:'/bin/bash',argv:['bash','start.sh'],files:[]};
  const data=new Map(),store={lock:fn=>fn(),read:async key=>data.get(key)??null,write:async(key,value)=>data.set(key,value)};
  const deps={store:async()=>store,process:async()=>current,bootId:async()=>'boot-a',uuid:()=> 'launch-one',now:()=>1,
    native:async()=>({id:thread,cwd:dir,path:profile.session.native_path,file_id:'3:4'})};
  const argv=['/fixture/codex','resume',thread,'exact private prompt'];
  const call=(action,extra=[],stdin=()=>JSON.stringify(argv))=>capture(()=>main([action,'--config',config,'--role','writer',...extra],deps,stdin));
  return {profile,config,argv,deps,call,activate(){current={...current,exe:'/fixture/codex',argv,files:['3:4']};}};
}

test('launcher intent, bounded watcher and owner stdin resolution share one canonical lease',async t=>{
  const f=await fixture(t),intent=await f.call('intent',['--launcher-pid','20']);
  assert.equal(intent.code,0);assert.ok(!JSON.stringify(intent).includes('exact private prompt'));
  f.activate();const observed=await f.call('watch',['--launch-id',intent.result.intent.launch_id,'--timeout-ms','0']);
  assert.equal(observed.code,0);assert.equal(observed.result.lease.frontend.pid,20);
  const owner=await capture(()=>main(['resolve-stdin'],f.deps,()=>JSON.stringify({role:'writer',profile:f.profile})));
  assert.equal(owner.code,0);assert.equal(owner.result.session.thread_id,f.profile.session.thread_id);
  assert.deepEqual(Object.keys(owner.result.session).sort(),['kind','thread_id','cwd','native_path','pid','process_start'].sort());
});

test('watch timeout is bounded and a missing native process is never restarted',async t=>{
  const f=await fixture(t),intent=await f.call('intent',['--launcher-pid','20']);
  const pending=await f.call('watch',['--launch-id',intent.result.intent.launch_id,'--timeout-ms','0']);
  assert.equal(pending.code,75);assert.equal(pending.result.reason,'frontend_not_ready');
  await assert.rejects(f.call('watch',['--launch-id',intent.result.intent.launch_id,'--timeout-ms','30001']),{code:'registration_arguments_invalid'});
});

test('actual stdin pipe returns missing registration 75 without reopening dev/stdin or creating state',async t=>{
  const f=await fixture(t),entry=fileURLToPath(new URL('./role-session-registration.mjs',import.meta.url));
  let failure;
  try{execFileSync(process.execPath,[entry,'resolve-stdin'],{input:JSON.stringify({role:'writer',profile:f.profile}),encoding:'utf8',timeout:5000});}
  catch(error){failure=error;}
  assert.equal(failure.status,75);assert.equal(failure.stderr,'');
  assert.deepEqual(JSON.parse(failure.stdout),{code:75,reason:'registration_missing'});
  await assert.rejects(fs.stat(f.profile.registration.state_dir),{code:'ENOENT'});
});

test('intent retries a transient role mutex at most three times before startup proceeds',async t=>{
  const f=await fixture(t),base=f.deps.store;let attempts=0;
  f.deps.store=async()=>{const store=await base();return {...store,lock:async fn=>++attempts<3?null:fn()};};
  assert.equal((await f.call('intent',['--launcher-pid','20'])).code,0);assert.equal(attempts,3);
});

test('prepare records exact planned argv and launches only one bounded metadata observer',async t=>{
  const f=await fixture(t),calls=[];
  f.deps.observer=async options=>calls.push(options);
  const result=await capture(()=>main(['prepare','--config',f.config,'--role','writer','--launcher-pid','20','--',...f.argv],
    f.deps,()=>assert.fail('planned argv must not consume the TUI stdin')));
  assert.equal(result.code,0);assert.equal(result.result.reason,'launch_observer_started');assert.equal(calls.length,1);
  assert.deepEqual(calls[0],{role:'writer',profile:f.profile,config:f.config,launchId:'launch-one',timeoutMs:30000});
  assert.ok(!JSON.stringify(result).includes('exact private prompt'));
  assert.ok(!JSON.stringify(calls).includes('exact private prompt'));
});

test('prepare invalid argv never starts an observer and observer launch failure never reports startup readiness',async t=>{
  const f=await fixture(t);let calls=0;
  f.deps.observer=async()=>{calls++;throw new Error('private request must not be logged');};
  const args=['prepare','--config',f.config,'--role','writer','--launcher-pid','20','--'];
  const invalid=await capture(()=>main([...args,'codex','resume','wrong-thread'],f.deps));
  assert.equal(invalid.code,75);assert.equal(calls,0);
  const failed=await capture(()=>main([...args,...f.argv],f.deps));
  assert.equal(failed.code,75);assert.equal(failed.result.reason,'registration_observer_unavailable');assert.equal(calls,1);
  assert.ok(!JSON.stringify(failed).includes('private'));
});

test('prepare metadata flags cannot be borrowed from the planned native argv',async t=>{
  const f=await fixture(t);let calls=0;f.deps.observer=async()=>{calls++;};
  await assert.rejects(capture(()=>main(['prepare','--role','writer','--launcher-pid','20','--',
    ...f.argv,'--config',f.config],f.deps)),{code:'registration_arguments_invalid'});
  assert.equal(calls,0);
});
