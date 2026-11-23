import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main,readOwnerStdin } from './role-owner-rpc.mjs';
import { ownerBinding,rpcDigest } from './lib/role-owner-rpc.mjs';

async function capture(fn){const chunks=[],write=process.stdout.write;process.stdout.write=v=>{chunks.push(String(v));return true;};
  try{return {code:await fn(),result:JSON.parse(chunks.join(''))};}finally{process.stdout.write=write;}}
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'owner-cli-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const uid=process.getuid(),profile={role_id:'writer',pane_id:'w2:p7',session:{kind:'codex-jsonl',thread_id:'thread-a',
    pid:20,process_start:'200',cwd:dir,native_path:path.join(dir,'native.jsonl')},
    registration:{uid,backend:{kind:'unix',socket_path:path.join(dir,'s')}}};
  const lease={role:'writer',uid,generation:1,launch_id:'one',frontend:{pid:20,start:'200',uid},owner:{pid:30,start:'100',uid},
    native:{id:'thread-a',cwd:dir,path:profile.session.native_path,file_id:'4:70'},
    endpoint:{path:path.join(dir,'s'),target:path.join(dir,'s'),file_id:'4:50',inode:'600',uid}};
  profile.registration_lease=lease;const config=path.join(dir,'config.json');await fs.writeFile(config,JSON.stringify({roles:{writer:profile}}));
  const deps={uid:()=>uid,resolve:async()=>({code:0,lease,session:profile.session}),inspect:async()=> 'turn-a',
    steer:async(_p,turn)=>({method:'turn/steer',turn_id:turn}),probe:async()=>({id:'thread-a',cwd:dir,path:profile.session.native_path,status:{type:'idle'}})};
  const request={schema:'role-owner-rpc/v1',operation:'steer',role:'writer',binding:ownerBinding(profile),
    expected_turn_id:'turn-a',text:'private literal $(text)',payload_sha256:rpcDigest('private literal $(text)')};
  const args=['rpc','--config',config,'--role','writer'];return {dir,profile,lease,config,deps,request,args};
}

test('owner CLI reports only correlated metadata after the exact expected steer',async t=>{
  const f=await fixture(t),result=await capture(()=>main(f.args,f.deps,async()=>f.request));
  assert.equal(result.code,0);assert.equal(result.result.turn_id,'turn-a');assert.equal(result.result.payload_sha256,f.request.payload_sha256);
  assert.ok(!JSON.stringify(result).includes('private literal'));
});

test('startup read-only probe needs no lease and cannot invoke resolution or steer',async t=>{
  const f=await fixture(t);delete f.profile.registration_lease;
  await fs.writeFile(f.config,JSON.stringify({roles:{writer:f.profile}}));
  f.deps.resolve=()=>assert.fail('probe recursed into registration');f.deps.steer=()=>assert.fail('probe steered');
  const request={socket_path:f.profile.registration.backend.socket_path,thread_id:'thread-a',cwd:f.dir,native_path:f.profile.session.native_path};
  const result=await capture(()=>main(['probe-thread',...f.args.slice(1)],f.deps,async()=>request));
  assert.equal(result.code,0);assert.deepEqual(result.result.thread.status,{type:'idle'});
});

test('probe rejects a different configured endpoint before touching it',async t=>{
  const f=await fixture(t);f.deps.probe=()=>assert.fail('wrong endpoint probed');
  const result=await capture(()=>main(['probe-thread',...f.args.slice(1)],f.deps,async()=>({socket_path:'/other'})));
  assert.equal(result.code,75);assert.equal(result.result.not_submitted,true);
});

test('actual CLI wrong-UID request is explicit pre-steer metadata without private body or stderr',async t=>{
  const f=await fixture(t);f.profile.registration.uid++;
  await fs.writeFile(f.config,JSON.stringify({roles:{writer:f.profile}}));let error;
  try{execFileSync(process.execPath,[fileURLToPath(new URL('./role-owner-rpc.mjs',import.meta.url)),...f.args],
    {input:JSON.stringify(f.request),encoding:'utf8',timeout:5000});}catch(value){error=value;}
  assert.equal(error.status,75);assert.equal(error.stderr,'');
  const reply=JSON.parse(error.stdout);assert.equal(reply.reason,'owner_uid_mismatch');assert.equal(reply.not_submitted,true);
  assert.ok(!error.stdout.includes('private literal'));
});

test('RPC stdin is bounded and strictly UTF-8 decoded',async()=>{
  await assert.rejects(readOwnerStdin(Readable.from([Buffer.alloc(1024*1024+1)])),/owner_request_invalid/);
  await assert.rejects(readOwnerStdin(Readable.from([Buffer.from([0xff])])));
  assert.deepEqual(await readOwnerStdin(Readable.from([Buffer.from('{"role":"writer"}')])) ,{role:'writer'});
});
