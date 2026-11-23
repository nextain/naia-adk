#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRegistration } from './lib/role-session-registration.mjs';
import { registrationHost } from './lib/role-session-registration-host.mjs';
import { steerActiveTurn,probeRoleThread } from './lib/codex-active-turn.mjs';
import { executeOwnerRequest,localOwnerProfile,ownerFailureReply } from './lib/role-owner-rpc.mjs';

const entry=fileURLToPath(import.meta.url);
export const ownerHostDependencies=()=>({uid:()=>process.getuid(),
  resolve:(role,profile)=>resolveRegistration({role,profile},registrationHost()),
  inspect:profile=>steerActiveTurn(profile,null),steer:steerActiveTurn,probe:probeRoleThread});

export async function readOwnerStdin(stream=process.stdin){
  const chunks=[];let size=0;
  for await(const chunk of stream){
    const bytes=Buffer.from(chunk);size+=bytes.length;
    if(size>1024*1024)throw new Error('owner_request_invalid');
    chunks.push(bytes);
  }
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}

export async function main(argv=process.argv.slice(2),deps=ownerHostDependencies(),read=readOwnerStdin){
  const value=name=>{const at=argv.indexOf(name);return at<0?null:argv[at+1];};
  const role=value('--role'),config=value('--config'),probe=argv[0]==='probe-thread';
  let request;
  try{request=await read();}catch{
    process.stdout.write(JSON.stringify({schema:'role-owner-rpc/v1',ok:false,reason:'owner_request_invalid',not_submitted:true})+'\n');
    return 75;
  }
  let profile;
  try{
    if(!role||!/^[a-zA-Z0-9_-]+$/.test(role)||!config||!path.isAbsolute(config))throw new Error();
    profile=JSON.parse(await fs.readFile(config,'utf8')).roles?.[role];
    if(!profile)throw new Error();
    profile={...profile,pane_id:profile.pane_id??profile.find?.pane_id};
  }catch{
    process.stdout.write(JSON.stringify(ownerFailureReply(role,request,'owner_configuration_unavailable'))+'\n');return 75;
  }
  if(probe){
    try{
      if(!profile.registration||deps.uid()!==profile.registration.uid)throw new Error('owner_uid_mismatch');
      const endpoint=profile.registration.backend;
      if(endpoint?.kind!=='unix'||request.socket_path!==endpoint.socket_path||request.thread_id!==profile.session.thread_id||
          request.cwd!==profile.session.cwd||request.native_path!==profile.session.native_path)throw new Error('owner_request_invalid');
      // Registration has not published a lease yet. This fixed mode reads an
      // already-loaded thread only, and cannot recurse into lease resolution.
      const local=localOwnerProfile(profile,{session:profile.session,lease:{endpoint:{path:endpoint.socket_path}}});
      const thread=await deps.probe(local);
      if(thread?.id!==profile.session.thread_id||thread.cwd!==profile.session.cwd||thread.path!==profile.session.native_path||
          !['idle','active'].includes(thread.status?.type))throw new Error('active_turn_changed');
      process.stdout.write(JSON.stringify({thread:{id:thread.id,cwd:thread.cwd,path:thread.path,status:{type:thread.status.type}}})+'\n');
      return 0;
    }catch(error){
      process.stdout.write(JSON.stringify(ownerFailureReply(role,request,error.message))+'\n');return 75;
    }
  }
  const answer=await executeOwnerRequest({role,profile,request},deps);
  process.stdout.write(JSON.stringify(answer)+'\n');return answer.ok?0:75;
}

if(process.argv[1]&&path.resolve(process.argv[1])===entry){
  main().then(code=>{process.exitCode=code;}).catch(()=>{
    process.stdout.write(JSON.stringify({schema:'role-owner-rpc/v1',ok:false,reason:'owner_rpc_unconfirmed'})+'\n');
    process.exitCode=75;
  });
}
