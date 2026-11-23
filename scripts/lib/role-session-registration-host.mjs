import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { acquireLock } from '../role-wake.mjs';
import { resolveRegistration } from './role-session-registration.mjs';

const failure = code => Object.assign(new Error(code),{code});
const fileId = stat => `${stat.dev}:${stat.ino}`;
const command = argv => Array.isArray(argv)&&argv.length&&path.isAbsolute(argv[0])&&argv.every(p=>typeof p==='string'&&p);

export async function ownerStore(role,profile,{uid=process.getuid(),create=false}={}) {
  if(profile.registration.uid!==uid)throw failure('registration_owner_unavailable');
  const root=profile.registration.state_dir, dir=path.join(root,role);
  for(const item of [root,dir]){
    if(create)await fs.mkdir(item,{recursive:true,mode:0o700});
    const stat=await fs.lstat(item).catch(error=>{if(error.code==='ENOENT')throw failure('registration_missing');throw error;});
    if(!stat.isDirectory()||stat.uid!==uid||(stat.mode&0o077)||await fs.realpath(item)!==item)
      throw failure('registration_state_unprotected');
  }
  return {
    async lock(fn){const release=acquireLock({stateDir:dir});if(!release)return null;try{return await fn();}finally{release();}},
    async read(name){
      const file=path.join(dir,name+'.json');
      try{
        const stat=await fs.lstat(file);
        if(!stat.isFile()||stat.uid!==uid||(stat.mode&0o077))throw failure('registration_state_unprotected');
        if(stat.size>64*1024)throw failure('registration_state_invalid');
        const bytes=await fs.readFile(file);
        if(bytes.length>64*1024)throw failure('registration_state_invalid');
        try{return JSON.parse(bytes);}catch{throw failure('registration_state_invalid');}
      }catch(error){if(error.code==='ENOENT')return null;throw error;}
    },
    async write(name,value){
      const file=path.join(dir,name+'.json'),temp=file+'.'+randomUUID()+'.tmp';
      try{await fs.writeFile(temp,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});await fs.rename(temp,file);}
      finally{await fs.unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    },
  };
}

export function registrationHost({procRoot='/proc',run=(bin,args,options)=>execFileSync(bin,args,{
  encoding:'utf8',timeout:5000,maxBuffer:64*1024,...options})}={}) {
  async function processInfo(pid,profile) {
    if(!Number.isSafeInteger(pid)||pid<1)return null;
    const base=path.join(procRoot,String(pid));
    try{
      const [raw,stat,cwd,exe,bytes]=await Promise.all([fs.readFile(path.join(base,'stat'),'utf8'),fs.stat(base),
        fs.readlink(path.join(base,'cwd')),fs.readlink(path.join(base,'exe')),fs.readFile(path.join(base,'cmdline'))]);
      if(bytes.length>1024*1024)throw failure('registration_probe_limit');
      const fields=raw.slice(raw.lastIndexOf(')')+2).split(/\s+/),argv=bytes.toString().split('\0');
      if(argv.at(-1)==='')argv.pop();
      const fdRoot=path.join(base,'fd'),fds=await fs.readdir(fdRoot),files=[],sockets=[];
      if(fds.length>4096)throw failure('registration_probe_limit');
      await Promise.all(fds.map(async name=>{
        try{
          const file=path.join(fdRoot,name),target=await fs.readlink(file),socket=/^socket:\[(\d+)\]$/.exec(target);
          if(socket)sockets.push(socket[1]);
          else{const metadata=await fs.stat(file);if(metadata.isFile())files.push(fileId(metadata));}
        }catch(error){if(!['ENOENT','EBADF'].includes(error.code))throw error;}
      }));
      let entry=null;
      if(['node','nodejs'].includes(path.basename(exe))&&argv[1]){
        try{entry=await fs.realpath(path.resolve(cwd,argv[1]));}catch{/* still starting */}
      }
      return {pid,ppid:Number(fields[1]),start:fields[19],uid:stat.uid,cwd,exe,argv,entry,files,sockets};
    }catch(error){if(['ENOENT','ESRCH'].includes(error.code))return null;throw error;}
  }
  async function endpointInfo(profile,ownerHint) {
    const requested=profile.registration.backend.socket_path;
    const target=await fs.realpath(requested),alias=await fs.lstat(requested),socket=await fs.lstat(target);
    const parents=await Promise.all([fs.stat(path.dirname(requested)),fs.stat(path.dirname(target))]);
    const uid=profile.registration.uid;
    const protectedSocket=socket.isSocket()&&(alias.isSocket()||alias.isSymbolicLink())&&
      alias.uid===uid&&socket.uid===uid&&parents.every(p=>p.uid===uid&&!(p.mode&0o022))&&
      (!(parents[1].mode&0o007)||!(socket.mode&0o007));
    const table=await fs.readFile(path.join(procRoot,'net/unix'),'utf8');
    if(table.length>4*1024*1024)throw failure('registration_probe_limit');
    const rows=table.split('\n').map(line=>/^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line))
      .filter(row=>row?.[8]===target&&row[5]==='0001'&&row[4]==='00010000');
    if(rows.length!==1)throw failure('registration_endpoint_unavailable');
    const inode=rows[0][7],owners=[];
    const candidates=ownerHint?[String(ownerHint.pid)]:(await fs.readdir(procRoot)).filter(name=>/^\d+$/.test(name));
    if(candidates.length>4096)throw failure('registration_probe_limit');
    let inspected=0;
    for(const candidate of candidates){
      const base=path.join(procRoot,candidate);
      try{
        if((await fs.stat(base)).uid!==uid)continue;
        const fds=await fs.readdir(path.join(base,'fd'));
        inspected+=fds.length;if(inspected>32768)throw failure('registration_probe_limit');
        const links=await Promise.all(fds.map(name=>fs.readlink(path.join(base,'fd',name)).catch(error=>{
          if(['ENOENT','EBADF'].includes(error.code))return null;throw error;
        })));
        if(links.includes(`socket:[${inode}]`)){
          const process=await processInfo(Number(candidate),profile);
          if(process)owners.push({pid:process.pid,start:process.start});
        }
      }catch(error){if(!['ENOENT','ESRCH','EACCES','EPERM'].includes(error.code))throw error;}
    }
    return {path:requested,target,file_id:fileId(socket),inode,uid:socket.uid,protected:protectedSocket,owners};
  }
  return {
    store:(role,profile,options)=>ownerStore(role,profile,options),process:processInfo,
    async children(pid,profile){
      const raw=await fs.readFile(path.join(procRoot,String(pid),'task',String(pid),'children'),'utf8');
      const pids=raw.trim().split(/\s+/).filter(Boolean).map(Number);
      if(pids.length>64)throw failure('registration_probe_limit');
      return (await Promise.all(pids.map(pid=>processInfo(pid,profile)))).filter(Boolean);
    },
    async native(profile){
      const file=await fs.open(profile.session.native_path,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        const stat=await file.stat();if(!stat.isFile())throw failure('registration_native_invalid');
        const bytes=Buffer.alloc(Math.min(64*1024,stat.size)),read=await file.read(bytes,0,bytes.length,0),end=bytes.indexOf(10);
        if(end<0||end>=read.bytesRead)throw failure('registration_native_invalid');
        const header=JSON.parse(bytes.subarray(0,end).toString());
        if(header.type!=='session_meta')throw failure('registration_native_invalid');
        return {id:header.payload?.id,cwd:header.payload?.cwd,path:profile.session.native_path,file_id:fileId(stat)};
      }finally{await file.close();}
    },
    endpoint:endpointInfo,
    async thread(profile){
      const argv=profile.registration.backend.probe_command;
      if(!command(argv))throw failure('registration_probe_command_invalid');
      const output=run(argv[0],argv.slice(1),{input:JSON.stringify({socket_path:profile.registration.backend.socket_path,
        thread_id:profile.session.thread_id,native_path:profile.session.native_path,cwd:profile.session.cwd})});
      return JSON.parse(output).thread;
    },
    bootId:()=>fs.readFile(path.join(procRoot,'sys/kernel/random/boot_id'),'utf8').then(value=>value.trim()),
    uuid:randomUUID,now:Date.now,
  };
}

export async function resolveRoleRegistration(role,profile,{run=(bin,args,options)=>execFileSync(bin,args,{
  encoding:'utf8',timeout:10_000,maxBuffer:64*1024,...options}),local=registrationHost()}={}) {
  if(!profile.registration)return {code:0,session:profile.session};
  const argv=profile.registration.resolve_command;
  if(argv!==undefined){
    if(!command(argv))return {code:75,reason:'registration_resolve_command_invalid'};
    try{
      let output,pendingExit=false;
      try{output=run(argv[0],argv.slice(1),{input:JSON.stringify({role,profile})});}
      catch(error){
        if(error.status!==75||!error.stdout||Buffer.byteLength(error.stdout)>64*1024)throw error;
        output=error.stdout;pendingExit=true;
      }
      const result=JSON.parse(output);
      if(pendingExit&&result.code!==75)return {code:75,reason:'registration_owner_unavailable'};
      if(result.code!==0)return {code:75,reason:/^[a-z_]{1,64}$/.test(result.reason??'')?result.reason:'registration_unavailable'};
      // Only the explicitly configured owner's resolver may return these values.
      if(!Number.isSafeInteger(result.session?.pid)||typeof result.session?.process_start!=='string'||
          result.session.thread_id!==profile.session.thread_id||result.session.cwd!==profile.session.cwd||
          result.session.native_path!==profile.session.native_path||result.lease?.uid!==profile.registration.uid)
        return {code:75,reason:'registration_resolver_mismatch'};
      return result;
    }catch{return {code:75,reason:'registration_owner_unavailable'};}
  }
  if(profile.registration.uid!==process.getuid())return {code:75,reason:'registration_owner_unavailable'};
  return resolveRegistration({role,profile},local);
}
