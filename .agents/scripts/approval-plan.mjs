#!/usr/bin/env node
/**
 * 운영 배포 승인 보고 양식(계획서) 도구. 절차: docs/guides/approval-plan-gate.md
 *
 *   template                         빈 양식(JSON) 출력
 *   check <plan>                     양식 칸·적대 리뷰 기록 점검, 명령별 sha 출력
 *   report <plan>                    승인자에게 올릴 보고문 출력(리뷰 통과 시)
 *   review <plan> --author <argon|codex|muse|claude> [--out <file>] 차례(작성자 다음 모델) 1명 적대 리뷰(읽기 전용) → 결과 파일 + gates/deploy-plan-review.json. 고정 planReview 가 유효하면 그 리뷰어를 먼저 쓰고, 한도 실패 때만 차례대로 넘어간다(넘긴 리뷰어는 skipped 로 남긴다)
 *   review-prompt <plan>             리뷰 요청문만 출력
 *   preapprove <plan> --session <id>      사전승인 코드 발급(승인 아님: PLAN+전단계 코드, approval_mode 사전 계획만)
 *   step-ok <plan> <step> --evidence <file>   단계 성공 확인 증거 기록(gates/deploy-steps/<step>.json)
 *   judge <plan> --evidence <file>... --executor-session <id>   장애/개발 독립 판정(다른 세션: muse 헤드리스)
 *
 * 이름에 deploy 를 넣지 않는다: 배포 가드 분류기가 이름에 deploy 가 든 스크립트를 운영 배포로 본다.
 * 이 도구는 운영 서버에 아무 명령도 보내지 않는다.
 */
import Module, { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
if(process.argv[2]==="hook"){
 const blocked=error=>{const bytes=Buffer.from(JSON.stringify({decision:"block",reason:"[Harness] Registered hook unavailable: "+String(error?.message||error).slice(0,1500)}));for(let offset=0;offset<bytes.length;)offset+=fs.writeSync(1,bytes,offset);process.exit(0);};
 process.on("uncaughtException",blocked);process.on("unhandledRejection",blocked);
}
// The installed host/bootstrap is the TCB. This does not undo parent preloads.
function registrationInvocation(argv) {
 const required=["--registration","--sha256","--profile"], values={},rest=[];
 const enabled=argv[0]==="hook"||argv[0]==="ready"||argv.some(a=>required.includes(a));
 if(!enabled)return null;
 for(let i=1;i<argv.length;i++){
  const key=argv[i];if(required.includes(key)){if(values[key]!==undefined||!argv[i+1]||argv[i+1].startsWith("--"))throw new Error("Duplicate or missing registration/profile argument");values[key]=argv[++i];}else rest.push(key);
 }
 if(required.some(k=>values[k]===undefined)||argv[0]==="hook"&&rest.length)throw new Error("Invalid closed registration hook arguments");
 if(!/^[a-f0-9]{64}$/.test(values["--sha256"]))throw new Error("Invalid registration sha256");
 return{file:values["--registration"],sha:values["--sha256"],profile:values["--profile"],argv:[argv[0],...rest]};
}
function regularBytes(file) {
 if(!path.isAbsolute(file)||path.resolve(file)!==file||fs.realpathSync(file)!==file)throw new Error("Registered input is not canonical");
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const before=fs.fstatSync(fd,{bigint:true});if(!before.isFile()||before.size>64n*1024n*1024n)throw new Error("Invalid registered file");const b=fs.readFileSync(fd),after=fs.fstatSync(fd,{bigint:true}),now=fs.lstatSync(file,{bigint:true});if(before.ino!==now.ino||before.dev!==now.dev||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==now.ctimeNs)throw new Error("Registered file changed while reading");return b;}finally{fs.closeSync(fd);}
}
function exactFields(value,keys){if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join()!==[...keys].sort().join())throw new Error("Invalid closed registration shape");}
function readRegistration(spec) {
 const bytes=regularBytes(spec.file);if(sha256(bytes)!==spec.sha)throw new Error("Registration digest differs");const r=JSON.parse(bytes);
 exactFields(r,["schema","planRoot","engine","instance","profiles","approverId","providers"]);
 exactFields(r.engine,["root","commit","files"]);exactFields(r.instance,["files"]);
 if(r.schema!=="registered-gate/v2"||r.engine.root!==ROOT||!/^\d{5,22}$/.test(r.approverId)||!/^[a-f0-9]{40}$/.test(r.engine.commit))throw new Error("Registration engine or authority identity differs");
 for(const root of[r.planRoot,...r.profiles.map(p=>p.root)])if(!path.isAbsolute(root)||path.resolve(root)!==root||fs.realpathSync(root)!==root||!fs.statSync(root).isDirectory())throw new Error("Registration root is not canonical");
 const ids=new Set(),roots=new Set(),states=new Set();
 if(!Array.isArray(r.profiles)||!r.profiles.length)throw new Error("Registration profile set missing");
 for(const p of r.profiles){exactFields(p,["id","scope","root","policy","expectedPolicySha256","stateDir"]);if(!/^[a-z][a-z0-9_-]{0,63}$/.test(p.id)||ids.has(p.id)||roots.has(p.root)||states.has(p.stateDir)||!["global","project"].includes(p.scope)||p.policy!=="strict-defaults"||!/^[a-f0-9]{64}$/.test(p.expectedPolicySha256)||!path.isAbsolute(p.stateDir)||path.resolve(p.stateDir)!==p.stateDir)throw new Error("Invalid registration profile identity");ids.add(p.id);roots.add(p.root);states.add(p.stateDir);}
 if(!ids.has(spec.profile))throw new Error("Unknown registered profile");
 if(Object.keys(r.providers).sort().join()!=="argon,codex,muse")throw new Error("Registered providers missing");
 for(const p of Object.values(r.providers)){exactFields(p,["file","sha256"]);if(!path.isAbsolute(p.file)||!/^[a-f0-9]{64}$/.test(p.sha256))throw new Error("Invalid registered provider");}
 return{...r,sha256:spec.sha,selected:spec.profile,argv:spec.argv,files:new Map()};
}
let invocation=null,registration=null;
try{invocation=registrationInvocation(process.argv.slice(2));if(invocation)registration=readRegistration(invocation);}
catch(error){if(process.argv[2]==="hook"){process.stdout.write(JSON.stringify({decision:"block",reason:"[Harness] Registered hook unavailable: "+error.message}));process.exit(0);}throw error;}
const PINNED_CJS_EXECUTORS = [
	".claude/hooks/lib/deploy-human-approval.js",
	".claude/hooks/lib/gate-config-pin.js",
	"scripts/lib/pid-lock.cjs",
	"scripts/lib/registered-git-identity.cjs",
	".claude/hooks/lib/deploy-plan-common.js",
	".claude/hooks/lib/deploy-plan-discord.js",
	".claude/hooks/lib/deploy-plan-readonly-policy.js",
	".claude/hooks/lib/deploy-plan-context.js",
	".claude/hooks/lib/deploy-plan-review-policy.js",
	".claude/hooks/lib/deploy-plan-schema.js",
	".claude/hooks/lib/deploy-plan-commands.js",
	".claude/hooks/lib/deploy-plan-targets.js",
	".claude/hooks/lib/deploy-plan-readonly-binding.js",
	".claude/hooks/lib/deploy-plan-review-input.js",
	".claude/hooks/lib/deploy-plan-review-results.js",
	".claude/hooks/lib/deploy-plan-approval-state.js",
	".claude/hooks/lib/deploy-plan-human-confirmation.js",
	".claude/hooks/lib/deploy-plan-evidence.js",
	".claude/hooks/lib/deploy-plan-flow.js",
	".claude/hooks/lib/deploy-plan-admission.js",
	".claude/hooks/lib/deploy-plan-review-lock.js",
	".claude/hooks/lib/deploy-plan.js",
	".claude/hooks/lib/deploy-readiness-io.js",
	".claude/hooks/lib/deploy-readiness-ops.js",
	".claude/hooks/lib/deploy-readiness-policy.js",
	".claude/hooks/lib/deploy-readiness-evidence.js",
	".claude/hooks/lib/deploy-readiness-script-binding.js",
	".claude/hooks/lib/deploy-readiness-plan-binding.js",
	".claude/hooks/lib/deploy-readiness-assessment.js",
	".claude/hooks/lib/deploy-readiness-planning.js",
	".claude/hooks/lib/deploy-readiness.js",
	".claude/hooks/lib/git-command-parser.js",
	".claude/hooks/lib/effective-argv.js",
	".claude/hooks/lib/deploy-command-classifier.js",
	".agents/hooks/core/delegation-contract.js",
	".agents/hooks/core/hook-project-root.js",
	".agents/hooks/core/subagent-failure-receipt.js",
	".agents/hooks/core/session-contract.js",
	".agents/harness/session-baseline.cjs",
	".agents/hooks/core/harness-core.js",
	".agents/hooks/policies/edit.js",
	".agents/hooks/policies/bash.js",
	".agents/hooks/policies/bash-git.cjs",
	".agents/hooks/policies/bash-external.cjs",
	".agents/hooks/policies/bash-deploy.cjs",
	".agents/hooks/policies/deploy-policy-roots.cjs",
	".agents/hooks/policies/bash-artifact-context.cjs",
	".agents/hooks/policies/bash-artifact-wrappers.cjs",
	".agents/hooks/policies/bash-artifact-scripts.cjs",
	".agents/hooks/policies/bash-artifact.cjs",
	".agents/scripts/approval-plan-files.cjs",
	".agents/scripts/approval-plan-snapshot.cjs",
	".agents/scripts/approval-plan-reviewer.cjs",
	".agents/scripts/approval-plan-cli.cjs",
	".agents/scripts/registered-gate-runtime.cjs",
	".agents/scripts/registered-gate-loader.cjs",
	".agents/scripts/registered-gate-environment.cjs",
	".claude/hooks/lib/hook-watchdog.js",
	".claude/hooks/_claude-bash-guard.js"
];
const preloadFlag = /(?:^|[\s"'])(?:--(?:require|import|(?:experimental-)?loader)(?=$|[\s="'])|-r)/;
if (preloadFlag.test(process.env.NODE_OPTIONS || "") || process.execArgv.some(arg => preloadFlag.test(arg))) {
 if(process.argv[2]==="hook")throw new Error("Unsupported caller startup preload options");
 console.error("기동 거부: NODE_OPTIONS/execArgv 선적재 옵션은 허용하지 않음"); process.exit(1);
}
const bootEntryAbs = (() => {
 const entry = fileURLToPath(import.meta.url);
 try { return fs.realpathSync(entry); }
 catch { return path.resolve(entry); }
})();
let BOOT_ENTRY_SHA = null;
try { BOOT_ENTRY_SHA = sha256(fs.readFileSync(bootEntryAbs)); }
catch { BOOT_ENTRY_SHA = null; }
const STARTUP_EXECUTOR_SHAS = new Map();
const aliases = new Map();
const expectedPins=new Map();
if(registration){
 for(const [root,pins]of[[ROOT,registration.engine.files],[registration.planRoot,registration.instance.files]]){
  if(!Array.isArray(pins))throw new Error("Registered source manifest missing");
  for(const pin of pins){exactFields(pin,["file","sha256"]);if(typeof pin.file!=="string"||path.isAbsolute(pin.file)||pin.file.startsWith("..")||path.normalize(pin.file)!==pin.file||!/^[a-f0-9]{64}$/.test(pin.sha256))throw new Error("Invalid registered source pin");const abs=path.resolve(root,pin.file);if(expectedPins.has(abs))throw new Error("Duplicate registered source pin");expectedPins.set(abs,pin.sha256);}
 }
 for(const rel of[".agents/scripts/approval-plan.mjs",...PINNED_CJS_EXECUTORS])if(!expectedPins.has(path.join(ROOT,rel)))throw new Error("Required registered execution source missing");
 for(const [file,want]of expectedPins){const bytes=regularBytes(file);if(sha256(bytes)!==want)throw new Error("Registered source differs: "+file);registration.files.set(file,bytes);}

}
const modulePaths=registration?[...new Set([...PINNED_CJS_EXECUTORS.map(p=>path.resolve(ROOT,p)),...registration.instance.files.filter(p=>/\.(?:cjs|js|json)$/.test(p.file)).map(p=>path.resolve(registration.planRoot,p.file))])]:PINNED_CJS_EXECUTORS.map(p=>path.resolve(ROOT,p));
const executors = modulePaths.map(requested => {
 const rel=path.relative(ROOT,requested);
 const filename = fs.realpathSync(requested);
 if (Object.hasOwn(require.cache, requested) || Object.hasOwn(require.cache, filename)) {
  console.error("기동 거부: 실행기 require.cache 선적재는 허용하지 않음"); process.exit(1);
 }
 const buffer = registration ? registration.files.get(filename) : fs.readFileSync(filename);
 if(!buffer)throw new Error("Module is outside registered source manifest");
 if(requested.startsWith(ROOT+path.sep))STARTUP_EXECUTOR_SHAS.set(rel, sha256(buffer));
 const record = { rel, filename, buffer, module: null, loading: false };
 aliases.set(requested, record); aliases.set(filename, record);
 return record;
});
STARTUP_EXECUTOR_SHAS.set(path.relative(fs.realpathSync(ROOT), bootEntryAbs), BOOT_ENTRY_SHA);
function compile(record) {
 if (record.loading) throw new Error("기동 거부: 고정 실행기 순환 의존");
 if (record.module) return record.module.exports;
 record.loading = true;
 const mod = new Module(record.filename);
 mod.filename = record.filename;
 mod.paths = Module._nodeModulePaths(path.dirname(record.filename));
 mod.require = function(request) {
  const target = path.isAbsolute(request) ? path.normalize(request)
   : request.startsWith(".") ? path.resolve(path.dirname(record.filename), request) : null;
  const dependency = target && (aliases.get(target) || aliases.get(target + ".js") || aliases.get(target + ".cjs"));
  if(dependency)return compile(dependency);
  if(registration&&!Module.isBuiltin(request)){
   const ctx=aliases.get(path.join(ROOT,".claude/hooks/lib/deploy-plan-context.js"))?.module?.exports?.gateConfigView?.getStore();
   const legacy=ctx?.legacyPolicyRoot,inside=(root,file)=>file===root||file?.startsWith(root+path.sep);
   if(record.filename.startsWith(registration.planRoot+path.sep)||!legacy||inside(ROOT,legacy)||inside(registration.planRoot,legacy)||target&&(inside(ROOT,target)||inside(registration.planRoot,target)))throw new Error("Unregistered local executable: "+request);
  }
  return Module.prototype.require.call(this,request);
 };
 record.module = mod;
 require.cache[record.filename] = mod;
 try {
  // Every protected require resolves to these own records. Compile the exact
  // bytes hashed above; never reopen a protected source through normal require.
  if(record.filename.endsWith(".json"))mod.exports=JSON.parse(record.buffer.toString());
  else mod._compile(record.buffer.toString(), record.filename);
  mod.loaded = true; record.loading = false;
  return mod.exports;
 } catch (error) {
  record.loading = false; record.module = null;
  if (require.cache[record.filename] === mod) delete require.cache[record.filename];
  throw error;
 }
}
if(registration){
 compile(aliases.get(path.join(ROOT,"scripts/lib/registered-git-identity.cjs"))).assertRegisteredGitIdentity(registration.engine);
 compile(aliases.get(path.join(ROOT,".agents/scripts/registered-gate-loader.cjs"))).installRegisteredModuleHooks({
  files:registration.files,registrationSha:registration.sha256,entry:bootEntryAbs,roots:[ROOT,registration.planRoot],
  currentContext:()=>aliases.get(path.join(ROOT,".claude/hooks/lib/deploy-plan-context.js"))?.module?.exports?.gateConfigView?.getStore()
 });
}
if(registration){
 const environment=compile(aliases.get(path.join(ROOT,".agents/scripts/registered-gate-environment.cjs")));
 const isChild=invocation.argv[0]==="hook"&&environment.isRegisteredWatchdogChild(bootEntryAbs,registration.sha256);
 if(["LD_PRELOAD","LD_LIBRARY_PATH","DYLD_INSERT_LIBRARIES","BASH_ENV","ENV"].some(name=>process.env[name]))throw new Error("Unsupported caller startup environment; clean installed host required");
 const clean=environment.childEnvironment(true);
 if(isChild){clean.NAIA_HOOK_WATCHDOG_CHILD="1";clean.NAIA_REGISTERED_WATCHDOG_PARENT=String(process.ppid);}
 for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,clean);
 if(invocation.argv[0]==="hook"){
  const watchdog=compile(aliases.get(path.join(ROOT,".claude/hooks/lib/hook-watchdog.js")));
  if(watchdog.runWithWatchdog({script:bootEntryAbs,args:process.argv.slice(2),env:{...environment.childEnvironment(true),NAIA_REGISTERED_WATCHDOG_PARENT:String(process.pid)},replaceEnvironment:true,childCheck:()=>isChild}))await new Promise(()=>{});
 }
}

try { for (const executor of executors.filter(e=>e.filename.startsWith(ROOT+path.sep))) compile(executor); }
catch (error) {
 for (const executor of executors) if (require.cache[executor.filename] === executor.module) delete require.cache[executor.filename];
 throw error;
}
const exportsAt = rel => compile(aliases.get(path.resolve(ROOT, rel)));
const lib = exportsAt(".claude/hooks/lib/deploy-plan.js");
const runtime = Object.freeze({ plan: lib, policy: exportsAt(".agents/hooks/policies/bash.js"),
 readiness: exportsAt(".claude/hooks/lib/deploy-readiness.js") });
const runCli = exportsAt(".agents/scripts/approval-plan-cli.cjs").createApprovalPlanCli({ STARTUP_EXECUTOR_SHAS, BOOT_ENTRY_SHA, registration });
const registered=registration?exportsAt(".agents/scripts/registered-gate-runtime.cjs").createRegisteredGate(registration,{...runtime,envelope:exportsAt(".claude/hooks/_claude-bash-guard.js")},runCli):null;

export function loadDeployGateRuntime() { return runtime; }
export async function runApprovalPlan(argv = process.argv.slice(2)) { return runCli(argv); }
export async function runApprovedApprovalPlan(options, argv = process.argv.slice(2)) {
 return lib.withGateConfig(options, () => runApprovalPlan(argv));
}
const invokedDirectly = (() => {
 try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === bootEntryAbs; }
 catch { return false; }
})();
if (invokedDirectly) {
 if(registered)await registered.run(invocation.argv);
 else await runApprovalPlan();
}
