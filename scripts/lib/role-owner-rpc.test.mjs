import test from 'node:test';
import assert from 'node:assert/strict';
import { executeOwnerRequest, invokeOwnerRpc, ownerBinding, rpcDigest } from './role-owner-rpc.mjs';

function fixture(uid=1000){
  const profile={role_id:'writer',pane_id:'w2:p7',session:{kind:'codex-jsonl',pid:20,process_start:'200',
    thread_id:'thread-a',cwd:'/private/site/project',native_path:'/private/site/native.jsonl'},
    registration:{uid,backend:{kind:'unix',socket_path:'/private/site/socket'}},
    active_mentions:{app_server:{command:['/trusted/account-adapter','fixed-owner']}}};
  const lease={role:'writer',uid,generation:1,launch_id:'launch-a',frontend:{pid:20,start:'200',uid},
    owner:{pid:30,start:'100',uid},native:{id:'thread-a',cwd:profile.session.cwd,path:profile.session.native_path,file_id:'4:70'},
    endpoint:{path:'/private/site/socket',target:'/private/site/socket',file_id:'4:50',inode:'600',uid}};
  profile.registration_lease=lease;
  const calls=[],deps={uid:()=>uid,resolve:async()=>({code:0,lease,session:profile.session}),
    inspect:async local=>{calls.push(['inspect',local]);return 'turn-a';},
    steer:async(local,turn,text)=>{calls.push(['steer',local,turn,text]);return {method:'turn/steer',turn_id:turn};}};
  const request=(text)=>({schema:'role-owner-rpc/v1',operation:text===undefined?'inspect':'steer',role:'writer',
    binding:ownerBinding(profile),...(text!==undefined&&{expected_turn_id:'turn-a',text,payload_sha256:rpcDigest(text)})});
  return {profile,lease,calls,deps,request};
}
const answer=(request,extra={})=>({schema:'role-owner-rpc/v1',operation:request.operation,role:request.role,
  request_sha256:rpcDigest(request),binding_sha256:rpcDigest(request.binding),ok:true,turn_id:'turn-a',
  ...(request.operation==='steer'&&{method:'turn/steer',payload_sha256:request.payload_sha256}),...extra});

for(const uid of [1000,1001])test(`one common owner helper inspects without input and steers once for UID${uid}`,async()=>{
  const f=fixture(uid);
  const inspected=await executeOwnerRequest({role:'writer',profile:f.profile,request:f.request()},f.deps);
  assert.equal(inspected.ok,true);assert.equal(inspected.turn_id,'turn-a');assert.equal(f.calls.length,1);
  assert.equal(f.calls[0][0],'inspect');
  const text="literal $(no_shell) `quoted`\n원문",steered=await executeOwnerRequest({role:'writer',profile:f.profile,request:f.request(text)},f.deps);
  assert.equal(steered.ok,true);assert.equal(steered.payload_sha256,rpcDigest(text));
  assert.deepEqual(f.calls.map(call=>call[0]),['inspect','steer']);assert.equal(f.calls[1][3],text);
  assert.equal(f.calls[1][1].active_mentions.app_server.socket_path,f.lease.endpoint.path);
  assert.ok(!JSON.stringify(steered).includes(text));assert.ok(!JSON.stringify(steered).includes('no_shell'));
});

for(const [name,change] of [
  ['role',f=>({request:{...f.request('text'),role:'reader'}})],
  ['actual UID',f=>{f.deps.uid=()=>1009;return {};}],
  ['generation',f=>{f.deps.resolve=async()=>({code:0,lease:{...f.lease,generation:2},session:f.profile.session});return {};}],
  ['frontend',f=>{f.deps.resolve=async()=>({code:0,lease:{...f.lease,frontend:{...f.lease.frontend,pid:99}},session:f.profile.session});return {};}],
  ['native owner',f=>{f.deps.resolve=async()=>({code:0,lease:{...f.lease,owner:{...f.lease.owner,pid:99}},session:f.profile.session});return {};}],
  ['endpoint',f=>{f.deps.resolve=async()=>({code:0,lease:{...f.lease,endpoint:{...f.lease.endpoint,path:'/private/other'}},session:f.profile.session});return {};}],
  ['thread',f=>({request:{...f.request('text'),binding:{...ownerBinding(f.profile),thread_id:'other'}}})],
  ['payload digest',f=>({request:{...f.request('text'),payload_sha256:rpcDigest('other')}})],
  ['missing registration',f=>{f.deps.resolve=async()=>({code:75,reason:'registration_missing'});return {};}],
])test(`owner helper rejects wrong ${name} before any input`,async()=>{
  const f=fixture(),options=change(f);
  const result=await executeOwnerRequest({role:'writer',profile:f.profile,request:options.request??f.request('text')},f.deps);
  assert.equal(result.ok,false);assert.equal(result.not_submitted,true);assert.equal(f.calls.length,0);
});

test('changed expected turn carries the raw client definitive-before-steer result',async()=>{
  const f=fixture();f.deps.steer=async()=>{throw Object.assign(new Error('active_turn_changed'),{notSubmitted:true});};
  const result=await executeOwnerRequest({role:'writer',profile:f.profile,request:f.request('text')},f.deps);
  assert.equal(result.ok,false);assert.equal(result.not_submitted,true);assert.equal(result.reason,'active_turn_changed');
});

test('possible queue failure is uncertain and neither payload nor raw error escapes the helper',async()=>{
  const f=fixture(),text='private text should not escape';
  f.deps.steer=async()=>{throw new Error('token=private-token '+text);};
  const result=await executeOwnerRequest({role:'writer',profile:f.profile,request:f.request(text)},f.deps);
  assert.equal(result.ok,false);assert.equal(result.not_submitted,false);
  assert.ok(!JSON.stringify(result).includes('private'));assert.ok(!JSON.stringify(result).includes('token='));
});

test('fixed command transports literal JSON and returns a body-free receipt',async()=>{
  const f=fixture(),text="literal $(touch nope)\n'quote'",calls=[];
  const run=(bin,args,options)=>{
    calls.push({bin,args,input:JSON.parse(options.input)});assert.equal(bin,'/trusted/account-adapter');
    assert.deepEqual(args,['fixed-owner']);return JSON.stringify(answer(JSON.parse(options.input),{extra_private_body:text}));
  };
  const receipt=await invokeOwnerRpc(f.profile,'turn-a',text,{run});
  assert.equal(receipt.method,'turn/steer');assert.equal(receipt.turn_id,'turn-a');assert.equal(calls.length,1);
  assert.equal(calls[0].input.text,text);assert.equal(calls[0].input.role,'writer');assert.ok(!JSON.stringify(receipt).includes('touch nope'));
});

test('inspect returns only an active turn and never includes payload in its request',async()=>{
  const f=fixture();let calls=0;
  const turn=await invokeOwnerRpc(f.profile,null,undefined,{run:(_bin,_args,options)=>{
    calls++;const request=JSON.parse(options.input);assert.equal(request.operation,'inspect');assert.equal(Object.hasOwn(request,'text'),false);
    return JSON.stringify(answer(request));
  }});
  assert.equal(turn,'turn-a');assert.equal(calls,1);
});

for(const name of ['timeout','crash','malformed reply','generic nonzero'])test(`spawned steer ${name} cannot become negative proof`,async()=>{
  const f=fixture();const run=(_bin,_args,options)=>{
    if(name==='malformed reply')return 'not JSON';
    if(name==='generic nonzero')throw Object.assign(new Error('private stderr'),{status:1,
      stdout:JSON.stringify(answer(JSON.parse(options.input),{ok:false,not_submitted:true,reason:'owner_uid_mismatch'}))});
    throw Object.assign(new Error('private stderr'),name==='timeout'?{code:'ETIMEDOUT'}:{status:1});
  };
  await assert.rejects(invokeOwnerRpc(f.profile,'turn-a','text',{run}),error=>error.notSubmitted===false&&!error.message.includes('private'));
});

test('only a matching structured helper pre-steer report proves no input',async()=>{
  const f=fixture();const run=(_bin,_args,options)=>{throw Object.assign(new Error(),{status:75,
    stdout:JSON.stringify(answer(JSON.parse(options.input),{ok:false,not_submitted:true,reason:'owner_uid_mismatch'}))});};
  await assert.rejects(invokeOwnerRpc(f.profile,'turn-a','text',{run}),error=>error.notSubmitted===true&&error.message==='owner_uid_mismatch');
});

test('a missing executable and unregistered binding fail before launch',async()=>{
  const f=fixture();await assert.rejects(invokeOwnerRpc(f.profile,'turn-a','text',{run:()=>{throw Object.assign(new Error(),{code:'ENOENT'});}}),
    error=>error.notSubmitted===true);
  delete f.profile.registration_lease;
  await assert.rejects(invokeOwnerRpc(f.profile,'turn-a','text',{run:()=>assert.fail('launched without registration')}),error=>error.notSubmitted===true);
});
