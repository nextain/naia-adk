import { createHash } from 'node:crypto';
import path from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const absolute = value => typeof value === 'string' && path.isAbsolute(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const pending = reason => ({ code:75, reason });
const error = code => Object.assign(new Error(code), { code });
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key,stable(value[key])])) : value;
const equal = (a,b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

export const argvDigest = argv => digest(JSON.stringify(argv.slice(1)));

function policy(role, profile) {
  const session=profile?.session, registration=profile?.registration, backend=registration?.backend;
  if (!/^[a-zA-Z0-9_-]+$/.test(role) || !profile?.pane_id || session?.kind!=='codex-jsonl' ||
      !uuid(session.thread_id) || !absolute(session.cwd) || !absolute(session.native_path) ||
      !absolute(registration?.state_dir) || !Number.isInteger(registration.uid) || registration.uid<0 ||
      !absolute(registration.frontend_executable) || !absolute(registration.launcher_executable) ||
      (registration.node_entry!==undefined && !absolute(registration.node_entry)) ||
      !['embedded','unix'].includes(backend?.kind)) throw error('registration_policy_invalid');
  if (backend.kind==='unix' && (!absolute(backend.socket_path) || !Array.isArray(backend.probe_command) ||
      !backend.probe_command.length || !absolute(backend.probe_command[0]) ||
      backend.probe_command.some(value=>typeof value!=='string'||!value) ||
      (backend.server_executable!==undefined && !absolute(backend.server_executable)))) throw error('registration_policy_invalid');
  return {role,pane:profile.pane_id,thread_id:session.thread_id,cwd:session.cwd,native_path:session.native_path,
    uid:registration.uid,state_dir:registration.state_dir,frontend_executable:registration.frontend_executable,
    launcher_executable:registration.launcher_executable,node_entry:registration.node_entry??null,backend};
}

function remoteArgument(argv) {
  const at=argv.indexOf('--remote');
  return at>=0 ? argv[at+1] : argv.find(value=>value.startsWith('--remote='))?.slice(9);
}

function argvProblem(argv,p) {
  if (!Array.isArray(argv) || !argv.length || argv.some(value=>typeof value!=='string') ||
      argv.filter(value=>value==='resume').length!==1 || argv[argv.indexOf('resume')+1]!==p.thread_id)
    return 'frontend_argv_mismatch';
  const remote=remoteArgument(argv);
  if (p.backend.kind==='unix' ? remote!=='unix://'+p.backend.socket_path : remote!==undefined)
    return 'frontend_endpoint_mismatch';
  return null;
}

function identity(process) {
  return {pid:process.pid,start:process.start,uid:process.uid,exe:process.exe,cwd:process.cwd};
}

async function state(store) {
  const generation=await store.read('generation'), intent=await store.read('intent');
  if (generation && (!Number.isSafeInteger(generation.value)||generation.value<1)) throw error('registration_state_invalid');
  if (intent && (intent.schema!=='role-launch-intent/v1'||!Number.isSafeInteger(intent.generation)||!intent.launch_id))
    throw error('registration_state_invalid');
  return {generation:generation?.value??0,intent};
}

async function guarded(fn) {
  try { return await fn(); }
  catch (failure) { return pending(/^[a-z_]{1,64}$/.test(failure.code??'')?failure.code:'registration_unavailable'); }
}

export async function beginRegistration({role,profile,launcherPid,argv},deps) {
  return guarded(async()=>{
    const p=policy(role,profile), invalid=argvProblem(argv,p);
    if(invalid)return pending(invalid);
    const launcher=await deps.process(launcherPid,profile);
    if(!launcher || launcher.uid!==p.uid || launcher.cwd!==p.cwd || launcher.exe!==p.launcher_executable)
      return pending('launcher_identity_mismatch');
    const store=await deps.store(role,profile,{create:true});
    return await store.lock(async()=>{
      const current=await state(store), generation=Math.max(current.generation,current.intent?.generation??0)+1;
      const intent={schema:'role-launch-intent/v1',role,generation,launch_id:deps.uuid(),
        policy_sha256:digest(JSON.stringify(stable(p))),boot_id:await deps.bootId(),uid:p.uid,
        launcher:identity(launcher),argv_sha256:argvDigest(argv),created_at:new Date(deps.now()).toISOString()};
      await store.write('generation',{value:generation});
      await store.write('intent',intent);
      return {code:0,reason:'launch_intent_recorded',intent};
    })??pending('registration_locked');
  });
}

async function binding(p,profile,intent,deps,expectedLease=null) {
  if(intent.boot_id!==await deps.bootId())return pending('launcher_changed');
  const launcher=await deps.process(intent.launcher.pid,profile);
  if(!launcher || launcher.start!==intent.launcher.start || launcher.uid!==p.uid)return pending('launcher_changed');
  let frontend=launcher;
  if(frontend.exe!==p.frontend_executable) {
    if(!p.node_entry || frontend.entry!==p.node_entry || !['node','nodejs'].includes(path.basename(frontend.exe)))
      return pending('frontend_not_ready');
    const children=(await deps.children(frontend.pid,profile)).filter(child=>child.exe===p.frontend_executable);
    if(children.length!==1)return pending('frontend_not_ready');
    frontend=children[0];
  }
  if(frontend.uid!==p.uid || frontend.cwd!==p.cwd || frontend.exe!==p.frontend_executable)
    return pending('frontend_identity_mismatch');
  const invalid=argvProblem(frontend.argv,p);
  if(invalid || argvDigest(frontend.argv)!==intent.argv_sha256)return pending(invalid??'frontend_argv_mismatch');
  const native=await deps.native(profile);
  if(native?.id!==p.thread_id || native.cwd!==p.cwd || native.path!==p.native_path || !native.file_id)
    return pending('native_metadata_mismatch');
  let owner=frontend, endpoint=null;
  if(p.backend.kind==='unix') {
    endpoint=await deps.endpoint(profile,expectedLease?.owner);
    if(endpoint?.path!==p.backend.socket_path || !absolute(endpoint.target) || endpoint.uid!==p.uid ||
        endpoint.protected!==true || !endpoint.file_id || !endpoint.inode)return pending('endpoint_identity_mismatch');
    const owners=[];
    for(const candidate of endpoint.owners??[]) {
      const process=await deps.process(candidate.pid,profile);
      if(process && process.start===candidate.start && process.uid===p.uid &&
          process.exe===(p.backend.server_executable??p.frontend_executable) &&
          process.sockets?.includes(endpoint.inode) && process.files?.includes(native.file_id))owners.push(process);
    }
    if(owners.length!==1)return pending('native_owner_mismatch');
    owner=owners[0];
    const thread=await deps.thread(profile);
    if(thread?.id!==p.thread_id || thread.cwd!==p.cwd || thread.path!==p.native_path ||
        !['idle','active'].includes(thread.status?.type))return pending('endpoint_thread_mismatch');
    const after=await deps.endpoint(profile,expectedLease?.owner);
    if(!equal(after,endpoint))return pending('endpoint_changed');
  } else if(!frontend.files?.includes(native.file_id))return pending('native_owner_mismatch');
  const currentFrontend=await deps.process(frontend.pid,profile), currentOwner=await deps.process(owner.pid,profile);
  if(!currentFrontend || !equal(identity(currentFrontend),identity(frontend)))return pending('frontend_changed');
  if(!currentOwner || !equal(identity(currentOwner),identity(owner)) || !currentOwner.files?.includes(native.file_id) ||
      (endpoint && !currentOwner.sockets?.includes(endpoint.inode)))return pending('native_owner_changed');
  const afterNative=await deps.native(profile);
  if(!equal(native,afterNative))return pending('native_metadata_changed');
  return {code:0,frontend:identity(frontend),owner:identity(owner),native,
    endpoint:endpoint?{path:endpoint.path,target:endpoint.target,file_id:endpoint.file_id,inode:endpoint.inode,uid:endpoint.uid}:null};
}

function checkIntent(current,p,intent) {
  if(!intent)return 'registration_missing';
  if(intent.policy_sha256!==digest(JSON.stringify(stable(p))))return 'registration_policy_changed';
  if(current.generation!==intent.generation)return 'registration_generation_mismatch';
  return null;
}

export async function observeRegistration({role,profile,launchId},deps) {
  return guarded(async()=>{
    const p=policy(role,profile),store=await deps.store(role,profile),current=await state(store);
    const invalid=checkIntent(current,p,current.intent);
    if(invalid)return pending(invalid);
    const intent=current.intent;
    if(intent.launch_id!==launchId)return pending('intent_superseded');
    const observed=await binding(p,profile,intent,deps);
    if(observed.code!==0)return observed;
    return await store.lock(async()=>{
      const latest=await state(store);
      if(latest.generation!==intent.generation || !equal(latest.intent,intent))return pending('intent_superseded');
      const lease={schema:'role-session-lease/v1',role,generation:intent.generation,launch_id:intent.launch_id,
        policy_sha256:intent.policy_sha256,boot_id:intent.boot_id,uid:p.uid,argv_sha256:intent.argv_sha256,
        frontend:observed.frontend,owner:observed.owner,native:observed.native,endpoint:observed.endpoint,
        registered_at:new Date(deps.now()).toISOString()};
      await store.write('lease',lease);
      return {code:0,reason:'session_registered',lease};
    })??pending('registration_locked');
  });
}

export async function resolveRegistration({role,profile},deps) {
  return guarded(async()=>{
    const p=policy(role,profile),store=await deps.store(role,profile);
    const snapshot=await store.lock(async()=>{
      const current=await state(store),invalid=checkIntent(current,p,current.intent);
      if(invalid)return pending(invalid);
      const lease=await store.read('lease'),intent=current.intent;
      if(!lease)return pending('registration_missing');
      if(lease.schema!=='role-session-lease/v1'||lease.role!==role||lease.generation!==intent.generation||
          lease.launch_id!==intent.launch_id)return pending('registration_generation_mismatch');
      if(lease.policy_sha256!==intent.policy_sha256 || lease.boot_id!==intent.boot_id || lease.uid!==p.uid ||
          lease.argv_sha256!==intent.argv_sha256)return pending('registration_policy_changed');
      return {code:0,intent,lease};
    })??pending('registration_locked');
    if(snapshot.code!==0)return snapshot;
    const {intent,lease}=snapshot;
    const observed=await binding(p,profile,intent,deps,lease);
    if(observed.code!==0)return observed;
    for(const key of ['frontend','owner','native','endpoint'])
      if(!equal(observed[key],lease[key]))return pending('registration_binding_changed');
    return await store.lock(async()=>{
      const latest=await state(store),currentLease=await store.read('lease');
      if(latest.generation!==intent.generation||!equal(latest.intent,intent)||!equal(currentLease,lease))
        return pending('intent_superseded');
      return {code:0,reason:'session_registered',lease,session:{kind:'codex-jsonl',thread_id:p.thread_id,
        cwd:p.cwd,native_path:p.native_path,pid:lease.frontend.pid,process_start:lease.frontend.start}};
    })??pending('registration_locked');
  });
}
