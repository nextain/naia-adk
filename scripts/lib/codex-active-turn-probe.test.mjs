import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { probeRoleThread,steerActiveTurn } from './codex-active-turn.mjs';

async function fixture(t,status='idle'){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rpc-probe-')),socket=path.join(dir,'s');
  const server=createServer(),ws=new WebSocketServer({server}),calls=[];
  await new Promise(resolve=>server.listen(socket,resolve));await fs.chmod(socket,0o600);
  t.after(async()=>{ws.close();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
  const thread={id:'thread-a',cwd:dir,path:path.join(dir,'native.jsonl'),status:{type:status},private_body:'never return this'};
  ws.on('connection',client=>client.on('message',raw=>{
    const request=JSON.parse(raw);calls.push(request);
    if(request.method==='initialized')return;
    const value=request.method==='thread/read'?{thread}:request.method==='thread/turns/list'
      ?{data:[{id:'turn-a',status:'inProgress'}]}:{};
    client.send(JSON.stringify({id:request.id,result:value}));
  }));
  return {profile:{session:{thread_id:thread.id,cwd:dir,native_path:thread.path},
    active_mentions:{app_server:{socket_path:socket}}},thread,calls};
}

test('loaded idle owner probe reads only thread metadata and never starts or steers a turn',async t=>{
  const f=await fixture(t),answer=await probeRoleThread(f.profile);
  assert.deepEqual(answer,{id:f.thread.id,cwd:f.thread.cwd,path:f.thread.path,status:{type:'idle'}});
  assert.deepEqual(f.calls.map(call=>call.method),['initialize','initialized','thread/read']);
  assert.deepEqual(f.calls.at(-1).params,{threadId:'thread-a',includeTurns:false});
  assert.ok(!JSON.stringify(answer).includes('private_body'));
});

test('read-only owner probe supports an active loaded thread without changing active-turn inspection',async t=>{
  const f=await fixture(t,'active');assert.equal((await probeRoleThread(f.profile)).status.type,'active');
  assert.equal(await steerActiveTurn(f.profile,null),'turn-a');
  assert.equal(f.calls.some(call=>call.method==='turn/steer'),false);
});

for(const scenario of ['notLoaded','wrong id','wrong path','wrong cwd'])test(`owner probe rejects ${scenario} without loading a saved thread`,async t=>{
  const f=await fixture(t,scenario==='notLoaded'?scenario:'idle');
  if(scenario==='wrong id')f.thread.id='another-thread';
  if(scenario==='wrong path')f.thread.path='/private/another.jsonl';
  if(scenario==='wrong cwd')f.thread.cwd='/private/another';
  await assert.rejects(probeRoleThread(f.profile),error=>error.notSubmitted===true);
  assert.equal(f.calls.some(call=>['thread/resume','thread/start','turn/steer'].includes(call.method)),false);
});
