"use strict";
const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const context=require("../../.claude/hooks/lib/deploy-plan-context.js");
function createRegisteredGate(record,runtime,runCli){
 const {plan,policy,envelope}=runtime,selected=record.profiles.find(p=>p.id===record.selected);
 const options={root:record.planRoot,approverId:record.approverId,reviewProfiles:record.profiles.map(p=>({id:p.id,root:p.root,policy:p.policy})),executionRegistrationSha256:record.sha256};
 const check=()=>{for(const p of context.registeredReviewProfiles(record.planRoot)){if(p.hash!==record.profiles.find(w=>w.id===p.id)?.expectedPolicySha256)throw new Error("Registered policy SHA differs");}};
 async function scoped(profile,fn){return plan.withGateConfig({...options,admissionProfile:profile.id},()=>{check();return fn();});}
 async function hook(){
  const inside=(root,file)=>{const rel=path.relative(root,path.resolve(file));return!rel||rel!==".."&&!rel.startsWith(".."+path.sep)&&!path.isAbsolute(rel);};
  // Startup authority is the installed host, never a stdin/environment claim.
  await scoped(selected,()=>{});
  envelope.start(async(command,data)=>{
   if(selected.scope==="project"&&!inside(record.planRoot,data.cwd||process.cwd()))return{reason:"[Harness] Foreign project context for registered hook"};
   return context.withRegisteredPolicyData(record.planRoot,record.files,()=>policy.deploy(command,data,{deployDir:path.join(selected.root,".claude/deploy"),registeredRoot:record.planRoot,policyData:record.files,withPolicyRoot:(root,registered,fn)=>registered||inside(record.planRoot,root)?fn():context.withLegacyPolicyRoot(root,fn),withPlanScope:async(ctx,run)=>{
    if(path.resolve(ctx.root)!==record.planRoot){
     if(inside(record.planRoot,ctx.root))throw new Error("A nested registered workspace requires its own explicit source scope");
     return context.withLegacyPolicyRoot(ctx.root,()=>plan.withGateConfig({root:ctx.root},()=>run(ctx)));
    }
    return scoped(selected,()=>run({...ctx,approverId:record.approverId,env:{...process.env,DEPLOY_APPROVAL_STATE_DIR:selected.stateDir}}));
   }}));
  },{failClosed:true});
 }
 async function run(argv){
  if(argv[0]==="hook")return hook();
  if(argv[0]==="preapprove"){
   for(const profile of record.profiles)await scoped(profile,()=>runCli(argv));return;
  }
  return scoped(selected,()=>runCli(argv));
 }
 const wrapped=argv=>context.withRegisteredPolicyData(record.planRoot,record.files,()=>run(argv));
 return{run:wrapped};
}
module.exports={createRegisteredGate};
