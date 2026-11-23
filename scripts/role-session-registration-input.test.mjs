import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main,nativeSnapshot } from './role-session-input.mjs';

async function capture(fn){
  const chunks=[],write=process.stdout.write;
  process.stdout.write=value=>{chunks.push(String(value));return true;};
  try{return {code:await fn(),answer:JSON.parse(chunks.join(''))};}finally{process.stdout.write=write;}
}
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'registered-input-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const stat=await fs.readFile(`/proc/${process.pid}/stat`,'utf8'),cwd=await fs.readlink(`/proc/${process.pid}/cwd`);
  const session={kind:'codex-jsonl',pid:process.pid,process_start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],
    thread_id:'same-thread',native_path:path.join(dir,'native.jsonl'),cwd};
  await fs.writeFile(session.native_path,JSON.stringify({type:'session_meta',payload:{id:session.thread_id,cwd}})+'\n'+
    JSON.stringify({type:'event_msg',payload:{type:'task_complete'}})+'\n');
  const profile={pane_id:'w2:p7',session:{...session,pid:12345,process_start:'old-start'},registration:{uid:process.getuid()}};
  const config=path.join(dir,'config.json'),input=path.join(dir,'wake.txt');await fs.writeFile(input,'exact payload');
  const save=()=>fs.writeFile(config,JSON.stringify({state_dir:dir,roles:{writer:profile}}));await save();
  let submits=0,clock=0;
  const deps={now:()=>clock+=10000,sleep:async()=>{},
    registration:async()=>({code:0,session,lease:{uid:process.getuid()}}),
    inspect:async()=>({foreground:[{pid:process.pid,args:'codex'}],processes:[],screen:'› Ask Codex to do anything'}),
    native:(session,hash,agent,query)=>nativeSnapshot(session,hash,query),
    submit:async(p,text)=>{submits++;await fs.appendFile(session.native_path,JSON.stringify({type:'response_item',payload:{role:'user',content:[{type:'input_text',text}]}})+'\n');}};
  const env={ADK_WAKE_ATTEMPT:'canonical-one',ADK_WAKE_ROLE:'writer',ADK_WAKE_PANE:profile.pane_id};
  // The canonical transport digest is independent of a potentially changed host rendering.
  const {payloadHash}=await import('./lib/role-session-input.mjs');env.ADK_WAKE_PAYLOAD_SHA256=payloadHash('exact payload');
  const call=(action=[],extra={})=>capture(()=>main([...action,'--config',config,'--role','writer',
    ...(action[0]==='verify'?[]:['--file',input])],deps,{...env,...extra}));
  return {dir,session,profile,deps,save,call,submits:()=>submits};
}

test('opted-in receiver uses a fresh registered PID after normal startup and accepts native ACK once',async t=>{
  const f=await fixture(t);let resolutions=0;
  f.deps.registration=async(role,profile)=>{resolutions++;assert.equal(role,'writer');assert.equal(profile.session.pid,12345);return {code:0,session:f.session};};
  const delivered=await f.call();assert.equal(delivered.code,0);assert.equal(delivered.answer.reason,'submitted_ack');
  assert.equal((await f.call(['verify'])).answer.status,'accepted');assert.equal(f.submits(),1);assert.equal(resolutions,2);
});

test('missing lease defers before input; canonical rejection allows a fresh attempt after registration',async t=>{
  const f=await fixture(t);f.deps.registration=async()=>({code:75,reason:'registration_missing'});
  const pending=await f.call();assert.equal(pending.code,75);assert.equal(pending.answer.reason,'registration_missing');
  assert.equal(f.submits(),0);assert.equal((await f.call(['verify'])).answer.status,'rejected');
  f.deps.registration=async()=>({code:0,session:f.session});
  assert.equal((await f.call()).answer.reason,'attempt_terminal');
  assert.equal((await f.call([],{ADK_WAKE_ATTEMPT:'canonical-two'})).code,0);assert.equal(f.submits(),1);
});

test('uncertain native submission is preserved when owner registration later becomes unavailable',async t=>{
  const f=await fixture(t);let sends=0;f.deps.submit=async()=>{sends++;};
  assert.equal((await f.call()).code,75);assert.equal(sends,1);
  f.deps.registration=async()=>({code:75,reason:'registration_owner_unavailable'});
  assert.equal((await f.call()).code,75);const verified=await f.call(['verify']);
  assert.equal(verified.answer.status,'unknown');assert.equal(verified.code,75);assert.equal(sends,1);
  const files=await fs.readdir(path.join(f.dir,'role-input'));
  const record=JSON.parse(await fs.readFile(path.join(f.dir,'role-input',files.find(file=>file.endsWith('.json'))),'utf8'));
  assert.equal(record.status,'submitted_unconfirmed');
});

test('existing fixed session profiles do not consult registration or change provider routing',async t=>{
  const f=await fixture(t);delete f.profile.registration;f.profile.session=f.session;await f.save();
  f.deps.registration=()=>assert.fail('legacy fixed binding changed');
  assert.equal((await f.call()).code,0);assert.equal(f.submits(),1);
});

test('registered native child is selected under its actual Node Codex foreground wrapper',async t=>{
  const f=await fixture(t),wrapper=process.pid+100000;
  f.deps.inspect=async()=>({foreground:[{pid:wrapper,argv:['/usr/bin/node','/fixture/codex.js']}],
    processes:[{pid:f.session.pid,ppid:wrapper,argv:['/fixture/codex','resume',f.session.thread_id]}],
    screen:'› Ask Codex to do anything'});
  const answer=await f.call();assert.equal(answer.code,0);assert.equal(f.submits(),1);
  assert.equal((await f.call(['verify'])).answer.status,'accepted');assert.equal(f.submits(),1);
});

test('registered PID outside the current foreground ancestry cannot be selected from the global process list',async t=>{
  const f=await fixture(t);
  f.deps.inspect=async()=>({foreground:[{pid:process.pid+100000,args:'codex'}],
    processes:[{pid:f.session.pid,ppid:1,args:'codex'}],screen:'› Ask Codex to do anything'});
  assert.equal((await f.call()).answer.reason,'process_mismatch');assert.equal(f.submits(),0);
});

test('a different Node provider cannot authorize its Codex worker as the role frontend',async t=>{
  const f=await fixture(t),wrapper=process.pid+100000;
  f.deps.inspect=async()=>({foreground:[{pid:wrapper,argv:['node','/fixture/muse.js']}],
    processes:[{pid:f.session.pid,ppid:wrapper,args:'codex'}],screen:'› Ask Codex to do anything'});
  assert.equal((await f.call()).answer.reason,'unsupported');assert.equal(f.submits(),0);
});
