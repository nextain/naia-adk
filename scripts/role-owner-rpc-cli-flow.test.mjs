import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gatewayMention,originFile } from './lib/active-mention.mjs';
import { roleSessionFlowFixture } from './test/role-session-flow-fixture.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const human='100000000000000001',bot='200000000000000001',message='300000000000000001';
async function activeFixture(t,changes={}){
  const f=await roleSessionFlowFixture(t,'daemon',{ownerRpc:true});
  const origin=path.join(f.dir,'origins'),dispatcher=path.join(f.dir,'dispatcher');
  await fs.mkdir(path.join(origin,'writer'),{recursive:true,mode:0o700});
  await fs.mkdir(path.join(dispatcher,'submissions'),{recursive:true,mode:0o700});
  const proof=gatewayMention({id:'writer',botUserId:bot},{id:message,guild_id:'400000000000000001',
    channel_id:'500000000000000001',author:{id:human},mentions:[{id:bot}],content:`<@${bot}> literal request`},f.text);
  await fs.writeFile(originFile(origin,'writer',message),JSON.stringify(proof),{mode:0o600});
  await fs.writeFile(path.join(dispatcher,'submissions','writer.json'),JSON.stringify({attempt:'same-attempt',role:'writer',
    pane:f.profile.pane_id,sha256:hash(f.text),gateway_only:true,messageId:message,gateway_wake_sha256:proof.wake_sha256}));
  f.profile.bot_id=bot;
  Object.assign(f.profile.active_mentions,{origin_dir:origin,dispatcher_state_dir:dispatcher});
  f.registry.delivery={priority_user_ids:[human]};await f.save();
  const state=JSON.parse(await fs.readFile(f.serverState,'utf8'));
  await fs.writeFile(f.serverState,JSON.stringify({...state,status:'active',...changes}));
  await fs.appendFile(f.native,JSON.stringify({type:'event_msg',payload:{type:'task_started',turn_id:'turn-a'}})+'\n');
  f.ownerCount=async()=>{try{return (await fs.readFile(f.ownerAudit,'utf8')).trim().split('\n').length;}
    catch(error){if(error.code==='ENOENT')return 0;throw error;}};
  f.ack=(turn='turn-a',text=f.text)=>fs.appendFile(f.native,JSON.stringify({type:'event_msg',payload:{type:'item_completed',
    thread_id:f.profile.session.thread_id,turn_id:turn,item:{id:'late-user',type:'UserMessage',content:text}}})+'\n');
  return f;
}

test('actual helper and common CLI steer the registered daemon once and accept only same-turn native evidence',async t=>{
  const f=await activeFixture(t),answer=f.send();
  assert.equal(answer.code,0);assert.equal(answer.reason,'submitted_ack');
  assert.equal(answer.native_user_ack.turn_id,'turn-a');assert.equal(answer.active_transport.owner_rpc.schema,'role-owner-rpc/v1');
  assert.equal(f.verify().status,'accepted');assert.equal(f.send().code,0);
  assert.equal(await f.ownerCount(),1);assert.equal(await f.count(),0);
  assert.equal(await fs.readFile(f.input,'utf8'),f.text);
});

for(const dropReply of [false,true])test(`uncertain owner transport preserves the attempt without replay (dropped reply=${dropReply})`,async t=>{
  const f=await activeFixture(t,{ack:false,dropReply});
  assert.equal(f.send().code,75);assert.equal(await f.ownerCount(),1);assert.equal(await f.count(),0);
  assert.equal(f.verify().status,'unknown');assert.equal(f.send().code,75);assert.equal(await f.ownerCount(),1);
  await f.ack('other-turn');await f.ack('turn-a','other text');assert.equal(f.verify().status,'unknown');
  await f.ack();assert.equal(f.verify().status,'accepted');assert.equal(await f.ownerCount(),1);assert.equal(await f.count(),0);
});

test('a stalled-card input has no human grant: preserve while active, then native-ACK idle delivery once',async t=>{
  const f=await roleSessionFlowFixture(t,'daemon',{ownerRpc:true});
  const active={type:'event_msg',payload:{type:'task_started',turn_id:'turn-a'}};
  await fs.appendFile(f.native,JSON.stringify(active)+'\n');
  assert.equal(f.send().code,75);assert.equal(await f.count(),0);assert.equal(f.verify().status,'rejected');
  await fs.appendFile(f.native,JSON.stringify({type:'event_msg',payload:{type:'task_complete'}})+'\n');
  // A rejected canonical attempt is terminal. The dispatcher retries with a new
  // attempt rather than reversing its already-issued negative proof.
  assert.equal(f.send().code,75);assert.equal(await f.count(),0);
  assert.equal(f.send('idle-retry').code,0);assert.equal(f.verify('idle-retry').status,'accepted');
  assert.equal(await f.count(),1);
});
