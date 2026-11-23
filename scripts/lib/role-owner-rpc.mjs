import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { steerActiveTurn } from './codex-active-turn.mjs';

const schema='role-owner-rpc/v1';
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export const rpcDigest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(stable(value))).digest('hex');
const codes=new Set(['owner_request_invalid','owner_uid_mismatch','owner_registration_unavailable','owner_binding_changed',
  'owner_endpoint_mismatch','owner_payload_mismatch','owner_turn_unavailable','owner_rpc_unavailable','owner_rpc_unconfirmed',
  'owner_configuration_unavailable',
  'active_transport_unavailable','active_socket_unprotected','active_transport_unconfirmed','active_request_rejected','active_turn_changed']);
const reason=(error,fallback='owner_rpc_unconfirmed')=>codes.has(error?.code)?error.code:codes.has(error?.message)?error.message:fallback;
const failure=(code,notSubmitted)=>Object.assign(new Error(code),{code,notSubmitted});
const processIdentity=value=>({pid:value.pid,start:value.start,uid:value.uid});
const validProcess=value=>Number.isSafeInteger(value?.pid)&&value.pid>0&&typeof value.start==='string'&&value.start&&Number.isInteger(value.uid);
const replyBase=(role,request)=>({schema,operation:request?.operation??null,role,request_sha256:rpcDigest(request??null),
  binding_sha256:rpcDigest(request?.binding??null)});

export function ownerFailureReply(role,request,code){
  return {...replyBase(role,request),ok:false,not_submitted:true,reason:reason({code})};
}

export function ownerBinding(profile,lease=profile.registration_lease,role=profile.role_id){
  if(!role||!lease||lease.role!==role||lease.uid!==profile.registration?.uid||
      !validProcess(lease.frontend)||!validProcess(lease.owner)||lease.frontend.uid!==lease.uid||lease.owner.uid!==lease.uid||
      profile.session?.pid!==lease.frontend.pid||profile.session?.process_start!==lease.frontend.start||
      lease.native?.id!==profile.session.thread_id||lease.native?.cwd!==profile.session.cwd||lease.native?.path!==profile.session.native_path||
      !lease.native.file_id||!Number.isSafeInteger(lease.generation)||lease.generation<1||!lease.launch_id||
      lease.endpoint?.uid!==lease.uid||!lease.endpoint.path||!lease.endpoint.target||!lease.endpoint.file_id||!lease.endpoint.inode)
    throw failure('owner_binding_changed',true);
  return {role,thread_id:profile.session.thread_id,cwd:profile.session.cwd,native_path:profile.session.native_path,
    generation:lease.generation,launch_id:lease.launch_id,frontend:processIdentity(lease.frontend),owner:processIdentity(lease.owner),
    native_file_id:lease.native.file_id,endpoint:{path:lease.endpoint.path,target:lease.endpoint.target,
      file_id:lease.endpoint.file_id,inode:lease.endpoint.inode,uid:lease.endpoint.uid}};
}

export function localOwnerProfile(profile,resolution){
  const endpoint=profile.registration?.backend;
  if(endpoint?.kind!=='unix'||resolution.lease?.endpoint?.path!==endpoint.socket_path)
    throw failure('owner_endpoint_mismatch',true);
  return {...profile,session:{...profile.session,...resolution.session},
    active_mentions:{...profile.active_mentions,app_server:{socket_path:endpoint.socket_path}}};
}

export async function executeOwnerRequest({role,profile,request},deps){
  const base=replyBase(role,request);
  let steering=false;
  try{
    if(request?.schema!==schema||request.role!==role||!['inspect','steer'].includes(request.operation))
      throw failure('owner_request_invalid',true);
    if(!profile.registration||deps.uid()!==profile.registration.uid)throw failure('owner_uid_mismatch',true);
    if(request.operation==='inspect'&&request.text!==undefined)throw failure('owner_request_invalid',true);
    if(request.operation==='steer'&&(typeof request.text!=='string'||!request.expected_turn_id||
        request.payload_sha256!==rpcDigest(request.text)))throw failure('owner_payload_mismatch',true);
    const resolution=await deps.resolve(role,profile);
    if(resolution.code!==0)throw failure('owner_registration_unavailable',true);
    const local=localOwnerProfile(profile,resolution),binding=ownerBinding(local,resolution.lease,role);
    if(rpcDigest(binding)!==base.binding_sha256)throw failure('owner_binding_changed',true);
    if(request.operation==='inspect'){
      const turn=await deps.inspect(local);
      if(typeof turn!=='string'||!turn)throw failure('owner_turn_unavailable',true);
      return {...base,ok:true,not_submitted:true,turn_id:turn};
    }
    steering=true;
    const receipt=await deps.steer(local,request.expected_turn_id,request.text);
    if(receipt?.method!=='turn/steer'||receipt.turn_id!==request.expected_turn_id)
      throw failure('owner_rpc_unconfirmed',false);
    return {...base,ok:true,not_submitted:false,method:receipt.method,turn_id:receipt.turn_id,
      payload_sha256:request.payload_sha256};
  }catch(error){
    return {...base,ok:false,not_submitted:!steering||error.notSubmitted===true,reason:reason(error)};
  }
}

export async function invokeOwnerRpc(profile,expectedTurnId,text,{timeoutMs=6000,run=(bin,args,options)=>
  execFileSync(bin,args,{encoding:'utf8',timeout:timeoutMs,maxBuffer:64*1024,...options})}={}){
  const operation=text===undefined?'inspect':'steer',argv=profile.active_mentions?.app_server?.command;
  if(!Array.isArray(argv)||!argv.length||!path.isAbsolute(argv[0])||argv.some(value=>typeof value!=='string'||!value))
    throw failure('owner_rpc_unavailable',true);
  const request={schema,operation,role:profile.role_id,binding:ownerBinding(profile),
    ...(operation==='steer'&&{expected_turn_id:expectedTurnId,text,payload_sha256:rpcDigest(text)})};
  if(operation==='steer'&&(!expectedTurnId||typeof text!=='string'))throw failure('owner_request_invalid',true);
  const input=JSON.stringify(request);
  if(Buffer.byteLength(input)>1024*1024)throw failure('owner_request_invalid',true);
  let output,exit=0;
  try{output=run(argv[0],argv.slice(1),{input});}
  catch(error){
    if(error.code==='ENOENT')throw failure('owner_rpc_unavailable',true);
    if(error.status!==75||!error.stdout||Buffer.byteLength(error.stdout)>64*1024)
      throw failure('owner_rpc_unconfirmed',operation==='inspect');
    output=error.stdout;exit=75;
  }
  let reply;
  try{reply=JSON.parse(output);}catch{throw failure('owner_rpc_unconfirmed',operation==='inspect');}
  const matching=reply.schema===schema&&reply.operation===operation&&reply.role===request.role&&
    reply.request_sha256===rpcDigest(request)&&reply.binding_sha256===rpcDigest(request.binding);
  if(!matching)throw failure('owner_rpc_unconfirmed',operation==='inspect');
  if(reply.ok!==true){
    const before=reply.not_submitted===true&&(exit===0||exit===75);
    throw failure(reason({code:reply.reason}),operation==='inspect'||before);
  }
  if(exit!==0||typeof reply.turn_id!=='string'||!reply.turn_id)
    throw failure('owner_rpc_unconfirmed',operation==='inspect');
  if(operation==='inspect')return reply.turn_id;
  if(reply.method!=='turn/steer'||reply.turn_id!==expectedTurnId||reply.payload_sha256!==request.payload_sha256)
    throw failure('owner_rpc_unconfirmed',false);
  return {method:'turn/steer',turn_id:reply.turn_id,owner_rpc:{schema,role:request.role,
    request_sha256:reply.request_sha256,binding_sha256:reply.binding_sha256,payload_sha256:reply.payload_sha256}};
}

export async function routeActiveTurn(profile,expectedTurnId,text,options){
  return profile.active_mentions?.app_server?.command
    ?invokeOwnerRpc(profile,expectedTurnId,text,options):steerActiveTurn(profile,expectedTurnId,text);
}
