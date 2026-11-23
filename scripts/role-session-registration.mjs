#!/usr/bin/env node
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { beginRegistration, observeRegistration, resolveRegistration } from './lib/role-session-registration.mjs';
import { registrationHost } from './lib/role-session-registration-host.mjs';

const entry=fileURLToPath(import.meta.url);

// Start only the bounded registration observer. The caller still performs its
// original literal native exec; this helper never starts a TUI or a daemon.
export async function launchObserver({role,profile,config,launchId,timeoutMs}) {
  const directory=path.join(profile.registration.state_dir,role);
  const log=await fs.open(path.join(directory,`watch-${launchId}.json`),'wx',0o600);
  try{
    const child=spawn(process.execPath,[entry,'watch','--config',config,'--role',role,
      '--launch-id',launchId,'--timeout-ms',String(timeoutMs)],{detached:true,stdio:['ignore',log.fd,log.fd]});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    child.unref();
  }finally{await log.close();}
}

export async function main(argv=process.argv.slice(2),deps=registrationHost(),stdin=()=>readFileSync(0,'utf8')) {
  const value=key=>{const at=argv.indexOf(key);return at<0?null:argv[at+1];};
  const action=argv[0];
  let role,profile;
  if(action==='resolve-stdin'){
    ({role,profile}=JSON.parse(stdin()));
  }else{
    role=value('--role');const file=value('--config');
    if(!role||!file)throw Object.assign(new Error(),{code:'registration_arguments_invalid'});
    const config=JSON.parse(await fs.readFile(file,'utf8'));
    profile=config.roles?.[role];
    if(!profile)throw Object.assign(new Error(),{code:'registration_role_unknown'});
    profile={...profile,pane_id:profile.pane_id??profile.find?.pane_id};
  }
  let result;
  if(action==='intent'||action==='prepare'){
    const launcherPid=Number(value('--launcher-pid'));
    const boundary=argv.indexOf('--');
    const arguments_=action==='prepare'?(boundary<0?[]:argv.slice(boundary+1)):JSON.parse(stdin());
    for(let attempt=0;attempt<3;attempt++){
      result=await beginRegistration({role,profile,launcherPid,argv:arguments_},deps);
      if(result.reason!=='registration_locked'||attempt===2)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(action==='prepare'&&result.code===0){
      try{
        await (deps.observer??launchObserver)({role,profile,config:value('--config'),
          launchId:result.intent.launch_id,timeoutMs:30000});
        result={...result,reason:'launch_observer_started'};
      }catch{result={code:75,reason:'registration_observer_unavailable'};}
    }
  }else if(action==='observe'||action==='watch'){
    const launchId=value('--launch-id');
    const timeout=Number(value('--timeout-ms')??30000);
    if(!launchId||!Number.isSafeInteger(timeout)||timeout<0||timeout>30000)
      throw Object.assign(new Error(),{code:'registration_arguments_invalid'});
    const deadline=Date.now()+timeout;
    do{
      result=await observeRegistration({role,profile,launchId},deps);
      if(action==='observe'||result.code===0||['intent_superseded','registration_policy_changed'].includes(result.reason)||Date.now()>=deadline)break;
      await new Promise(resolve=>setTimeout(resolve,200));
    }while(true);
  }else if(action==='resolve-stdin'||action==='probe'){
    result=await resolveRegistration({role,profile},deps);
  }else throw Object.assign(new Error(),{code:'registration_arguments_invalid'});
  process.stdout.write(JSON.stringify(result)+'\n');
  return result.code;
}

if(process.argv[1]&&path.resolve(process.argv[1])===entry){
  main().then(code=>{process.exitCode=code;}).catch(error=>{
    process.stderr.write(JSON.stringify({reason:/^[a-z_]{1,64}$/.test(error.code??'')?error.code:'registration_error'})+'\n');
    process.exitCode=75;
  });
}
