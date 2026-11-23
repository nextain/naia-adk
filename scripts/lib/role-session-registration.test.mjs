import test from 'node:test';
import assert from 'node:assert/strict';
import { beginRegistration, observeRegistration, resolveRegistration, argvDigest } from './role-session-registration.mjs';

const THREAD = '11111111-2222-4333-8444-555555555555';

function fixture({ uid = 1000, base = '/private/site-a', daemon = false } = {}) {
  const profile = { pane_id:'w2:p7', session:{kind:'codex-jsonl',thread_id:THREAD,
    cwd:base+'/project',native_path:base+'/native.jsonl'}, registration:{state_dir:base+'/state',uid,
    frontend_executable:base+'/bin/codex',launcher_executable:'/bin/bash',node_entry:base+'/bin/codex.js',backend:daemon ? {
      kind:'unix',socket_path:base+'/socket',probe_command:[base+'/bin/read-role-thread'],
    } : {kind:'embedded'}} };
  const argv=[base+'/bin/codex',...(daemon?['--remote','unix://'+base+'/socket']:[]),
    '-m','configured-model','resume',THREAD];
  const records = new Map(), processes = new Map();
  const launcher={pid:20,start:'200',uid,cwd:profile.session.cwd,exe:'/bin/bash',argv:['bash','role-start.sh'],files:[]};
  processes.set(20,launcher);
  let locked=false, generation=0;
  const store={async lock(fn) { if(locked)return null;locked=true;try{return await fn(this);}finally{locked=false;} },
    async read(name){return structuredClone(records.get(name)??null);},
    async write(name,value){records.set(name,structuredClone(value));}};
  const endpoint={path:base+'/socket',target:base+'/socket',file_id:'4:50',inode:'600',uid,protected:true,
    owners:[]};
  const deps={store:async()=>store,bootId:async()=>'boot-a',uuid:()=>`launch-${++generation}`,now:()=>1,
    process:async pid=>structuredClone(processes.get(pid)??null),
    children:async pid=>structuredClone([...processes.values()].filter(p=>p.ppid===pid)),
    native:async()=>({id:THREAD,cwd:profile.session.cwd,path:profile.session.native_path,file_id:'4:70'}),
    endpoint:async()=>structuredClone(endpoint),
    thread:async()=>({id:THREAD,cwd:profile.session.cwd,path:profile.session.native_path,status:{type:'idle'}})};
  const begin=()=>beginRegistration({role:'writer',profile,launcherPid:20,argv},deps);
  const activate=({child=false}={})=>{
    const native={...launcher,pid:child?21:20,ppid:child?20:1,start:child?'201':'200',
      exe:profile.registration.frontend_executable,argv:[...argv],files:daemon?[]:['4:70']};
    if(child)processes.set(20,{...launcher,exe:'/usr/bin/node',entry:profile.registration.node_entry});
    processes.set(native.pid,native);
    if(daemon){
      const owner={pid:90,ppid:1,start:'70',uid,cwd:base,exe:profile.registration.frontend_executable,
        argv:[profile.registration.frontend_executable,'app-server'],files:['4:70'],sockets:['600']};
      processes.set(90,owner);endpoint.owners=[{pid:90,start:'70'}];
    }
    return native;
  };
  return {profile,argv,deps,records,processes,endpoint,begin,activate,launcher};
}

for(const options of [{uid:1000,base:'/private/site-a'},{uid:1001,base:'/other/site-b'}]) {
  for(const child of [false,true])test(`explicit normal startup and lease resolution uid=${options.uid}, child=${child}`,async()=>{
    const f=fixture(options), intent=await f.begin();assert.equal(intent.code,0);
    const native=f.activate({child});
    const published=await observeRegistration({role:'writer',profile:f.profile,launchId:intent.intent.launch_id},f.deps);
    assert.equal(published.code,0);assert.equal(published.lease.frontend.pid,native.pid);
    assert.equal(published.lease.owner.pid,native.pid);
    const resolved=await resolveRegistration({role:'writer',profile:f.profile},f.deps);
    assert.equal(resolved.code,0);assert.equal(resolved.session.pid,native.pid);
    assert.equal(resolved.session.process_start,native.start);assert.equal(resolved.session.thread_id,THREAD);
    assert.equal(resolved.lease.uid,options.uid);
  });
}

test('separate daemon owner is not required to descend from the frontend or share its cwd',async()=>{
  const f=fixture({daemon:true}), started=await f.begin();f.activate();
  const result=await observeRegistration({role:'writer',profile:f.profile,launchId:started.intent.launch_id},f.deps);
  assert.equal(result.code,0);assert.equal(result.lease.frontend.pid,20);assert.equal(result.lease.owner.pid,90);
  assert.equal(result.lease.endpoint.inode,'600');
  assert.equal((await resolveRegistration({role:'writer',profile:f.profile},f.deps)).code,0);
});

test('same configured thread renews a generation without modifying model argv or static profile',async()=>{
  const f=fixture(), original=structuredClone(f.profile);const one=await f.begin();f.activate();
  await observeRegistration({role:'writer',profile:f.profile,launchId:one.intent.launch_id},f.deps);
  f.processes.set(20,{...f.launcher,start:'300'});
  const two=await f.begin();assert.equal(two.intent.generation,2);
  f.activate();f.processes.get(20).start='300';
  assert.equal((await observeRegistration({role:'writer',profile:f.profile,launchId:two.intent.launch_id},f.deps)).code,0);
  assert.deepEqual(f.profile,original);assert.equal(two.intent.argv_sha256,argvDigest(f.argv));
});

for(const [name,mutate,reason] of [
  ['wrong resumed thread',f=>{f.processes.get(20).argv.at(-1);f.processes.get(20).argv[f.argv.length-1]='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';},'frontend_argv_mismatch'],
  ['changed model argv',f=>{f.processes.get(20).argv[2]='other-model';},'frontend_argv_mismatch'],
  ['recycled launch PID',f=>{f.processes.get(20).start='900';},'launcher_changed'],
  ['different UID',f=>{f.processes.get(20).uid=1009;},'launcher_changed'],
  ['different frontend cwd',f=>{f.processes.get(20).cwd='/elsewhere';},'frontend_identity_mismatch'],
  ['other root file only',f=>{f.processes.get(20).files=['4:99'];},'native_owner_mismatch'],
  ['another native thread',f=>{f.deps.native=async()=>({id:'other-thread',cwd:f.profile.session.cwd,path:f.profile.session.native_path,file_id:'4:70'});},'native_metadata_mismatch'],
  ['different boot',f=>{f.deps.bootId=async()=>'boot-b';},'launcher_changed'],
])test(`registration preserves input when ${name}`,async()=>{
  const f=fixture(), start=await f.begin();f.activate();mutate(f);
  const result=await observeRegistration({role:'writer',profile:f.profile,launchId:start.intent.launch_id},f.deps);
  assert.equal(result.code,75);assert.equal(result.reason,reason);assert.equal(f.records.has('lease'),false);
});

test('new thread or account policy cannot reuse an old intent or lease',async()=>{
  for(const field of ['thread','uid']){
    const f=fixture(), start=await f.begin();f.activate();
    await observeRegistration({role:'writer',profile:f.profile,launchId:start.intent.launch_id},f.deps);
    if(field==='thread')f.profile.session.thread_id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    else f.profile.registration.uid=1001;
    assert.equal((await resolveRegistration({role:'writer',profile:f.profile},f.deps)).reason,'registration_policy_changed');
  }
});

test('a new intent supersedes an observer before its atomic publish',async()=>{
  const f=fixture(), start=await f.begin();f.activate();
  const native=f.deps.native;
  f.deps.native=async()=>{
    const value=await native();f.deps.native=native;
    const current=await f.deps.process(20);f.processes.set(20,{...f.launcher});const next=await f.begin();f.processes.set(20,current);assert.equal(next.code,0);return value;
  };
  const result=await observeRegistration({role:'writer',profile:f.profile,launchId:start.intent.launch_id},f.deps);
  assert.equal(result.reason,'intent_superseded');assert.equal(f.records.has('lease'),false);
});

test('an old restored lease cannot replace the current generation',async()=>{
  const f=fixture(), one=await f.begin();f.activate();
  await observeRegistration({role:'writer',profile:f.profile,launchId:one.intent.launch_id},f.deps);
  const old=structuredClone(f.records.get('lease'));f.processes.set(20,{...f.launcher});const two=await f.begin();f.activate();
  await observeRegistration({role:'writer',profile:f.profile,launchId:two.intent.launch_id},f.deps);
  f.records.set('lease',old);
  assert.equal((await resolveRegistration({role:'writer',profile:f.profile},f.deps)).reason,'registration_generation_mismatch');
});

for(const [name,mutate,reason] of [
  ['frontend does not name endpoint',f=>{f.argv.splice(1,2);f.processes.get(20).argv=[...f.argv];},'frontend_endpoint_mismatch'],
  ['another UID owns endpoint',f=>{f.endpoint.uid=1009;},'endpoint_identity_mismatch'],
  ['unprotected endpoint',f=>{f.endpoint.protected=false;},'endpoint_identity_mismatch'],
  ['server lacks root rollout',f=>{f.processes.get(90).files=[];},'native_owner_mismatch'],
  ['server is another UID',f=>{f.processes.get(90).uid=1009;},'native_owner_mismatch'],
  ['server lacks listener inode',f=>{f.processes.get(90).sockets=['999'];},'native_owner_mismatch'],
  ['unloaded saved thread',f=>{f.deps.thread=async()=>({id:THREAD,cwd:f.profile.session.cwd,path:f.profile.session.native_path,status:{type:'notLoaded'}});},'endpoint_thread_mismatch'],
])test(`daemon mode rejects ${name}`,async()=>{
  const f=fixture({daemon:true});if(name==='frontend does not name endpoint')mutate(f);const start=await f.begin();
  if(start.code!==0){assert.equal(start.reason,reason);return;}
  f.activate();mutate(f);
  const result=await observeRegistration({role:'writer',profile:f.profile,launchId:start.intent.launch_id},f.deps);
  assert.equal(result.code,75);assert.equal(result.reason,reason);
});

test('endpoint replacement during its read-only thread probe cannot publish a lease',async()=>{
  const f=fixture({daemon:true}), start=await f.begin();f.activate();const probe=f.deps.thread;
  f.deps.thread=async()=>{const value=await probe();f.endpoint.file_id='4:51';return value;};
  assert.equal((await observeRegistration({role:'writer',profile:f.profile,launchId:start.intent.launch_id},f.deps)).reason,'endpoint_changed');
});

test('an owning server restart after registration invalidates resolution',async()=>{
  const f=fixture({daemon:true}), start=await f.begin();f.activate();
  await observeRegistration({role:'writer',profile:f.profile,launchId:start.intent.launch_id},f.deps);
  f.processes.get(90).start='999';
  assert.equal((await resolveRegistration({role:'writer',profile:f.profile},f.deps)).code,75);
});

test('missing and malformed generation data remain unregistered and never start a process',async()=>{
  const f=fixture();assert.equal((await resolveRegistration({role:'writer',profile:f.profile},f.deps)).reason,'registration_missing');
  f.records.set('generation',{value:'broken'});assert.equal((await f.begin()).reason,'registration_state_invalid');
  assert.equal(f.records.has('intent'),false);
});

test('registration lease and intent contain digests rather than prompt bodies',async()=>{
  const f=fixture();f.argv.push('private prompt body');const start=await f.begin();f.activate();
  await observeRegistration({role:'writer',profile:f.profile,launchId:start.intent.launch_id},f.deps);
  const text=JSON.stringify([...f.records]);assert.ok(!text.includes('private prompt body'));
  assert.ok(!text.includes('configured-model'));assert.match(start.intent.argv_sha256,/^[a-f0-9]{64}$/);
});

test('an already-running native frontend cannot manufacture a new pre-launch intent',async()=>{
  const f=fixture();f.activate();
  const result=await f.begin();assert.equal(result.reason,'launcher_identity_mismatch');
  assert.equal(f.records.has('intent'),false);
});

test('slow resolution releases the state mutex and rejects a concurrently superseded intent',async()=>{
  const f=fixture(),one=await f.begin();f.activate();
  await observeRegistration({role:'writer',profile:f.profile,launchId:one.intent.launch_id},f.deps);
  const native=f.deps.native;
  f.deps.native=async()=>{
    f.deps.native=native;const current=await f.deps.process(20);f.processes.set(20,{...f.launcher});
    const next=await f.begin();f.processes.set(20,current);
    assert.equal(next.code,0,'new launcher intent must not be blocked by the read-only probe');
    return native();
  };
  assert.equal((await resolveRegistration({role:'writer',profile:f.profile},f.deps)).reason,'intent_superseded');
});
