import nodeTest from 'node:test';
const test=(name,fn)=>nodeTest(name,{skip:process.platform!=='linux'},fn);
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { ownerStore, registrationHost, resolveRoleRegistration } from './role-session-registration-host.mjs';

async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'role-registration-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  return {dir,profile:{session:{kind:'codex-jsonl',thread_id:'thread-a',native_path:path.join(dir,'native.jsonl'),cwd:dir},
    registration:{uid:process.getuid(),state_dir:path.join(dir,'state'),backend:{kind:'embedded'}}}};
}

test('private owner records, bounded reads and recoverable role mutex',async t=>{
  const {profile}=await fixture(t),store=await ownerStore('writer',profile,{create:true});
  assert.equal((await fs.stat(profile.registration.state_dir)).mode&0o777,0o700);
  await store.lock(async()=>{await store.write('intent',{schema:'test'});});
  const file=path.join(profile.registration.state_dir,'writer','intent.json');
  assert.equal((await fs.stat(file)).mode&0o777,0o600);
  assert.deepEqual(await store.read('intent'),{schema:'test'});
  assert.equal(await store.lock(async()=>store.lock(()=>assert.fail('nested mutex entered'))),null);
  await fs.writeFile(file,'x'.repeat(65537));
  await assert.rejects(store.read('intent'),{code:'registration_state_invalid'});
});

test('resolution does not create an absent role directory or infer access from native read prefix',async t=>{
  const {profile}=await fixture(t);
  await assert.rejects(ownerStore('writer',profile),{code:'registration_missing'});
  await assert.rejects(fs.stat(profile.registration.state_dir),{code:'ENOENT'});
  profile.registration.uid=process.getuid()+1;
  profile.session.read_prefix=['/trusted/native-reader'];
  const result=await resolveRoleRegistration('writer',profile,{run:()=>assert.fail('inferred owner command')});
  assert.equal(result.reason,'registration_owner_unavailable');
});

test('role record symlinks and permission widening are rejected',async t=>{
  const {dir,profile}=await fixture(t),store=await ownerStore('writer',profile,{create:true});
  await fs.writeFile(path.join(dir,'elsewhere'),'{}',{mode:0o600});
  await fs.symlink(path.join(dir,'elsewhere'),path.join(profile.registration.state_dir,'writer','lease.json'));
  await assert.rejects(store.read('lease'),{code:'registration_state_unprotected'});
  await fs.chmod(profile.registration.state_dir,0o750);
  await assert.rejects(ownerStore('writer',profile),{code:'registration_state_unprotected'});
});

test('host snapshot reads the exact open file identity and separates a configured listener',async t=>{
  const {dir,profile}=await fixture(t);
  await fs.writeFile(profile.session.native_path,JSON.stringify({type:'session_meta',payload:{id:'thread-a',cwd:dir}})+'\n');
  const handle=await fs.open(profile.session.native_path,'r');t.after(()=>handle.close());
  const socket=path.join(dir,'endpoint'),server=net.createServer();
  await new Promise(resolve=>server.listen(socket,resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  profile.registration.backend={kind:'unix',socket_path:socket};
  const host=registrationHost(),snapshot=await host.process(process.pid,profile),native=await host.native(profile);
  assert.ok(snapshot.files.includes(native.file_id));
  assert.equal(snapshot.uid,process.getuid());assert.ok(snapshot.start);
  const endpoint=await host.endpoint(profile,{pid:process.pid});
  assert.equal(endpoint.protected,true);assert.deepEqual(endpoint.owners,[{pid:process.pid,start:snapshot.start}]);
  assert.ok(snapshot.sockets.includes(endpoint.inode));
});

test('bounded native metadata rejects a missing complete header and a symlink',async t=>{
  const {dir,profile}=await fixture(t),host=registrationHost();
  await fs.writeFile(profile.session.native_path,'x'.repeat(65537));
  await assert.rejects(host.native(profile),{code:'registration_native_invalid'});
  const link=path.join(dir,'link');await fs.symlink(profile.session.native_path,link);profile.session.native_path=link;
  await assert.rejects(host.native(profile),{code:'ELOOP'});
});

test('explicit owner command gets only policy metadata and cannot substitute another thread',async t=>{
  const {profile}=await fixture(t);profile.registration.uid=process.getuid()+1;
  profile.registration.resolve_command=['/trusted/owner-adapter','resolve-stdin'];
  const calls=[];const run=(bin,args,options)=>{
    assert.equal(bin,'/trusted/owner-adapter');assert.deepEqual(args,['resolve-stdin']);
    const input=JSON.parse(options.input);assert.deepEqual(Object.keys(input),['role','profile']);
    assert.equal(input.role,'writer');calls.push(input);
    return JSON.stringify({code:0,session:{...profile.session,pid:90,process_start:'700'},lease:{uid:profile.registration.uid}});
  };
  const result=await resolveRoleRegistration('writer',profile,{run});
  assert.equal(result.code,0);assert.equal(result.session.pid,90);assert.equal(calls.length,1);
  const wrong=await resolveRoleRegistration('writer',profile,{run:()=>JSON.stringify({code:0,
    session:{...profile.session,thread_id:'other',pid:90,process_start:'700'},lease:{uid:profile.registration.uid}})});
  assert.equal(wrong.reason,'registration_resolver_mismatch');
});

test('trusted endpoint probe uses a literal fixed argv and body-free stdin',async t=>{
  const {profile}=await fixture(t);
  profile.registration.backend={kind:'unix',socket_path:'/private/endpoint',probe_command:['/trusted/reader','--literal=$(x)']};
  const host=registrationHost({run:(bin,args,options)=>{
    assert.equal(bin,'/trusted/reader');assert.deepEqual(args,['--literal=$(x)']);
    assert.deepEqual(JSON.parse(options.input),{socket_path:'/private/endpoint',thread_id:'thread-a',
      native_path:profile.session.native_path,cwd:profile.session.cwd});
    return JSON.stringify({thread:{id:'thread-a'}});
  }});
  assert.deepEqual(await host.thread(profile),{id:'thread-a'});
});

test('process argv observation preserves a real empty argument',()=>{
  const module=new URL('./role-session-registration-host.mjs',import.meta.url).href;
  const script=`import {registrationHost} from ${JSON.stringify(module)}; console.log(JSON.stringify((await registrationHost().process(process.pid,{})).argv));`;
  const argv=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script,'','literal'],{encoding:'utf8',timeout:5000}));
  assert.deepEqual(argv.slice(-2),['','literal']);
});

test('owner resolver pending exit preserves its bounded reason without exposing stderr',async t=>{
  const {profile}=await fixture(t);profile.registration.uid=process.getuid()+1;
  profile.registration.resolve_command=['/trusted/owner-adapter'];
  const result=await resolveRoleRegistration('writer',profile,{run:()=>{throw Object.assign(new Error('private stderr'),{
    status:75,stdout:JSON.stringify({code:75,reason:'registration_missing'}),stderr:'private stderr'});}});
  assert.deepEqual(result,{code:75,reason:'registration_missing'});
});
