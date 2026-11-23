import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn,execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const registration=fileURLToPath(new URL('../role-session-registration.mjs',import.meta.url));
const receiver=fileURLToPath(new URL('../role-session-input.mjs',import.meta.url));
const owner=fileURLToPath(new URL('../role-owner-rpc.mjs',import.meta.url));
const threadId='11111111-2222-4333-8444-555555555555';
const hash=value=>createHash('sha256').update(value).digest('hex');

function cli(file,args,options={}){
  try{return {code:0,...JSON.parse(execFileSync(process.execPath,[file,...args],{
    encoding:'utf8',timeout:15000,maxBuffer:65536,...options}))};}
  catch(error){if(error.status===75&&error.stdout)return JSON.parse(error.stdout);throw error;}
}
function ready(child){
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('model-free fixture startup timeout')),5000);
    child.stdout.once('data',()=>{clearTimeout(timeout);resolve();});
    child.once('error',error=>{clearTimeout(timeout);reject(error);});
  });
}
async function stop(child){
  if(child.exitCode!==null)return;
  const exited=once(child,'exit');child.stdin.end('\n');await exited;
}

export async function roleSessionFlowFixture(t,mode,{ownerRpc=false}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'registration-flow-')),children=[];
  t.after(async()=>{for(const child of children.reverse())await stop(child);await fs.rm(dir,{recursive:true,force:true});});
  const bash=await fs.realpath('/bin/bash'),node=await fs.realpath(process.execPath),native=path.join(dir,'native.jsonl');
  const session={kind:'codex-jsonl',thread_id:threadId,cwd:dir,native_path:native};
  await fs.writeFile(native,JSON.stringify({type:'session_meta',payload:{id:threadId,cwd:dir}})+'\n'+
    JSON.stringify({type:'event_msg',payload:{type:'task_complete'}})+'\n');
  const socket=path.join(dir,'endpoint'),frontendScript=path.join(dir,'frontend.sh'),launcherScript=path.join(dir,'launcher.sh');
  await fs.writeFile(frontendScript,'if [ "$FIXTURE_MODE" != daemon ]; then exec 3< "$FIXTURE_NATIVE"; fi\nprintf "READY\\n"\nIFS= read -r _done\n');
  await fs.writeFile(launcherScript,'IFS= read -r _gate\nexec "$@"\n');
  const nativeArgv=[bash,frontendScript,...(mode==='daemon'?['--remote','unix://'+socket]:[]),'resume',threadId];
  let server,serverState,ownerAudit;
  const backend={kind:'embedded'};
  if(mode==='daemon'){
    const serverScript=path.join(dir,'owner.mjs'),probe=path.join(dir,'probe.mjs');
    const loaded={id:threadId,cwd:dir,path:native,status:{type:'idle'}};
    await fs.writeFile(serverScript,`import fs from 'node:fs';import net from 'node:net';const fd=fs.openSync(${JSON.stringify(native)},'r');const server=net.createServer(client=>client.end(JSON.stringify({thread:${JSON.stringify(loaded)}})+'\\n'));server.listen(${JSON.stringify(socket)},()=>console.log('READY'));process.stdin.resume();process.stdin.on('end',()=>server.close(()=>{fs.closeSync(fd);}));`);
    await fs.writeFile(probe,"import net from 'node:net';import fs from 'node:fs';const request=JSON.parse(fs.readFileSync(0,'utf8'));let body='';const c=net.createConnection(request.socket_path);c.on('data',part=>body+=part);c.on('end',()=>process.stdout.write(body));c.on('error',()=>{process.exitCode=1;});");
    let serverArgs=[serverScript];
    if(ownerRpc){
      serverState=path.join(dir,'server-state.json');ownerAudit=path.join(dir,'owner-audit.jsonl');
      await fs.writeFile(serverState,JSON.stringify({thread:loaded,socket,status:'idle',turn:'turn-a',ack:true}));
      serverArgs=[fileURLToPath(new URL('./role-owner-flow-server.mjs',import.meta.url)),serverState,ownerAudit];
    }
    server=spawn(node,serverArgs,{cwd:dir,stdio:['pipe','pipe','pipe']});children.push(server);await ready(server);
    Object.assign(backend,{kind:'unix',socket_path:socket,server_executable:node,probe_command:[node,probe]});
  }
  const wrapper=path.join(dir,'codex.js');
  await fs.writeFile(wrapper,"const {spawn}=require('node:child_process');const child=spawn("+JSON.stringify(nativeArgv[0])+','+JSON.stringify(nativeArgv.slice(1))+",{stdio:'inherit'});child.on('exit',code=>process.exit(code??1));");
  const command=mode==='execve'?nativeArgv:[node,wrapper];
  const launcher=spawn(bash,[launcherScript,...command],{cwd:dir,stdio:['pipe','pipe','pipe'],
    env:{...process.env,FIXTURE_MODE:mode,FIXTURE_NATIVE:native}});children.push(launcher);
  await once(launcher,'spawn');
  const profile={pane_id:'fixture:p7',session,registration:{uid:process.getuid(),state_dir:path.join(dir,'registration'),
    launcher_executable:bash,frontend_executable:bash,node_entry:wrapper,backend,
    resolve_command:[node,registration,'resolve-stdin']}};
  const config=path.join(dir,'input.json');await fs.writeFile(config,JSON.stringify({state_dir:path.join(dir,'consumer'),roles:{writer:profile}}));
  if(ownerRpc){
    backend.probe_command=[node,owner,'probe-thread','--config',config,'--role','writer'];
    profile.active_mentions={app_server:{command:[node,owner,'rpc','--config',config,'--role','writer']}};
    await fs.writeFile(config,JSON.stringify({state_dir:path.join(dir,'consumer'),roles:{writer:profile}}));
  }
  const intent=cli(registration,['intent','--config',config,'--role','writer','--launcher-pid',String(launcher.pid)],{input:JSON.stringify(nativeArgv)});
  assert.equal(intent.code,0);const waiting=ready(launcher);launcher.stdin.write('start\n');await waiting;
  const observed=cli(registration,['observe','--config',config,'--role','writer','--launch-id',intent.intent.launch_id]);
  assert.equal(observed.code,0);const lease=observed.lease;
  if(mode==='execve')assert.equal(lease.frontend.pid,launcher.pid);else assert.notEqual(lease.frontend.pid,launcher.pid);
  if(server){assert.equal(lease.owner.pid,server.pid);assert.notEqual(lease.owner.pid,lease.frontend.pid);}
  else assert.equal(lease.owner.pid,lease.frontend.pid);
  const bin=path.join(dir,'bin');await fs.mkdir(bin);const meta=path.join(dir,'meta.json'),audit=path.join(dir,'audit.jsonl');
  const data={pane:profile.pane_id,front:lease.frontend.pid,wrapper:launcher.pid,mode,native,audit,nodeEntry:wrapper,ack:true};
  await fs.writeFile(meta,JSON.stringify(data));
  const herdr=path.join(bin,'herdr'),ps=path.join(bin,'ps');
  await fs.writeFile(herdr,`#!${node}\nconst fs=require('node:fs'),crypto=require('node:crypto');const m=JSON.parse(fs.readFileSync(process.env.FIXTURE_META));const a=process.argv.slice(2);if(a[1]==='process-info'){console.log(JSON.stringify({result:{process_info:{foreground_processes:[{pid:m.mode==='execve'?m.front:m.wrapper,args:m.mode==='execve'?'codex':'node '+m.nodeEntry}]}}}));}else if(a[1]==='read'){console.log('› Ask Codex to do anything');}else if(a[1]==='run'){fs.appendFileSync(m.audit,JSON.stringify({operation:'pane.run',sha256:crypto.createHash('sha256').update(a[3]).digest('hex')})+'\\n');if(m.ack)fs.appendFileSync(m.native,JSON.stringify({type:'response_item',payload:{role:'user',content:[{type:'input_text',text:a[3]}]}})+'\\n');console.log('{}');}else process.exitCode=1;`,{mode:0o700});
  await fs.writeFile(ps,`#!${node}\nconst fs=require('node:fs'),m=JSON.parse(fs.readFileSync(process.env.FIXTURE_META));console.log(m.wrapper+' 1 node '+m.nodeEntry);if(m.front!==m.wrapper)console.log(m.front+' '+m.wrapper+' codex resume fixture');`,{mode:0o700});
  const registry={state_dir:path.join(dir,'consumer'),pane:{bin:herdr},roles:{writer:profile}};
  const save=()=>fs.writeFile(config,JSON.stringify(registry));await save();
  const text='model-free exact request',input=path.join(dir,'payload.txt');await fs.writeFile(input,text);
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,FIXTURE_META:meta,
    ADK_WAKE_ROLE:'writer',ADK_WAKE_PANE:profile.pane_id,ADK_WAKE_ATTEMPT:'same-attempt',ADK_WAKE_PAYLOAD_SHA256:hash(text)};
  const send=(attempt='same-attempt')=>cli(receiver,['--config',config,'--role','writer','--file',input],
    {env:{...env,ADK_WAKE_ATTEMPT:attempt}});
  const verify=(attempt='same-attempt')=>cli(receiver,['verify','--config',config,'--role','writer'],
    {env:{...env,ADK_WAKE_ATTEMPT:attempt}});
  return {dir,lease,data,meta,native,text,input,audit,send,verify,profile,registry,save,serverState,ownerAudit,
    count:async()=>{try{return (await fs.readFile(audit,'utf8')).trim().split('\n').length;}catch(error){if(error.code==='ENOENT')return 0;throw error;}}};
}
