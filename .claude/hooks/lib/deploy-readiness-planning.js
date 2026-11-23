"use strict";
// Read-only whole-plan preparation. This module never issues or consumes consent.
const fs=require("fs"),path=require("path");
const {sha256}=require("./deploy-plan-common.js");
const {formProblems}=require("./deploy-plan-schema.js");
const {targetPins,pinnedFileProblems,verifyTargetPreconditions}=require("./deploy-plan-targets.js");
const {loadDeployGateConfig,loadDeployGatePlugin,matchServiceRule}=require("./deploy-readiness-policy.js");
const {verifiedPlanBinding}=require("./deploy-readiness-plan-binding.js");
const {assessReadinessWithBinding}=require("./deploy-readiness-assessment.js");
const {planCommandEntries,referencedFiles,plansForCommand}=require("./deploy-plan-commands.js");
const {gateConfigView}=require("./deploy-plan-context.js");
const {commandHash}=require("./deploy-human-approval.js");
const {canonicalTargetPath}=require("./deploy-readiness-policy.js");
const {classifyProdMutations,isNonProd}=require("./deploy-command-classifier.js");

function preparationBinding(binding,candidate,kind,services,root){
 const no=why=>({ok:false,why:`Plan preparation: ${why}`});
 const {plan,entry,command,cwd,gatesDir}=binding;
 if(!entry.commands?.includes(command))return no("command bytes differ");
 const cfg=loadDeployGateConfig(root);if(!cfg)return no("service policy missing");
 const targets=targetPins(plan,root),files=new Map();let future=false;
 for(const [file,want]of Object.entries(entry.files||{})){
  const full=path.resolve(root,file),target=targets.get(full),expected=String(want).toLowerCase();
  if(target){
   if(![target.before,target.after].includes(expected))return no("target preimage is undeclared");
   if(target.current!==expected){if(!target.transitions.has(entry.id))return no("future target lacks a declared transition");future=true;}
   files.set(full,(expected===target.before?target.beforeBody:target.afterBody).toString("utf8"));
  }else{const bytes=fs.readFileSync(full);if(sha256(bytes)!==expected)return no("immutable bytes differ");files.set(full,bytes.toString("utf8"));}
 }
 for(const service of services){
  const rule=matchServiceRule(service,cfg);if(!rule)return no("unregistered service");
  if(!Array.isArray(rule.allowedCommands)||!rule.allowedCommands.length||!rule.allowedCommands.some(p=>new RegExp(p).test(command)))return no("command does not match the registered service policy");
  for(const required of rule.requiredFiles||[])if(!files.has(path.resolve(root,required)))return no("required immutable input missing");
 }
 const plugin=loadDeployGatePlugin(root,cfg);
 if(plugin){
  if(typeof plugin.verifyPlanPreparation==="function"){
   const result=plugin.verifyPlanPreparation({plan,entry,command,candidate,kind,services,cwd,root,gatesDir,config:cfg,files,targets});
   if(result!==undefined)return result?.ok===true?{ok:true,fact:result.fact||"Registered planning policy verified"}:no(result?.why||"planning policy did not confirm this step");
  }
  if(future)return no("policy plugin does not implement future-target preparation");
 }
 // Existing exact execution binding is usable only when all preimages are live.
 if(!future){verifyTargetPreconditions(plan,root,entry);return verifiedPlanBinding(binding,candidate,kind,services,root);}
 if(kind!=="plan"&&!services.every(s=>matchServiceRule(s,cfg)?.allowCustomCommands===true))return no("future custom command has no explicit planning rule");
 return{ok:true,fact:"Registered command, service, immutable files and declared target transition verified"};
}

function commandServices(command,cwd,root,plan){
 const hits=classifyProdMutations(command,cwd,0,false,root);
 if(!Array.isArray(hits)||hits.some(h=>!h||h.unclassified||h.error))throw new Error("Command classification is ambiguous");
 const services=[...new Set(hits.filter(h=>typeof h.service==="string"&&!isNonProd(h.service)).map(h=>h.service))];
 if(!services.length||services.some(s=>!plan.services.includes(s)))throw new Error("Command services are missing or outside the plan");
 const config=loadDeployGateConfig(root);
 if(plan.services.some(service=>!matchServiceRule(service,config)))throw new Error("Plan contains an unregistered service");
 return services;
}

function declaredInputs(entry,command,root,cwd,targets){
 const pins=new Map(Object.entries(entry.files||{}).map(([file,digest])=>[path.resolve(root,file),String(digest).toLowerCase()]));
 for(const ref of referencedFiles(command,cwd)){
  const absolute=path.resolve(ref.path),canonical=canonicalTargetPath(absolute,cwd),target=targets.get(canonical),wanted=pins.get(absolute)??pins.get(canonical);
  if(!wanted||(target?(absolute!==canonical||![target.before,target.after].includes(wanted)):wanted!==ref.sha))throw new Error("Command input is outside its declared pins");
 }
}

function inspectPlanPreparation({plan,root,cwd=root,gatesDir,planFile=null}){
 const result={purpose:"plan-preparation/v1",ok:false,problems:[],steps:[]};
 const registered=Boolean(gateConfigView.getStore()?.executionRegistrationSha256);
 if(registered)result.coverage=[];
 try{
  if(typeof root!=="string"||path.resolve(root)!==root||fs.realpathSync(root)!==root)throw new Error("Preparation root is not canonical");
  if(!gatesDir||fs.realpathSync(gatesDir)!==gatesDir)throw new Error("Preparation gates directory is not canonical");
  result.problems.push(...formProblems(plan),...pinnedFileProblems(plan,root));
  if(result.problems.length)return result;
  const targets=targetPins(plan,root),ids=new Set(),coveredServices=new Set();
  for(const {kind,entry,position}of planCommandEntries(plan)){
   if(kind==="incident"&&!registered)continue;
   if(kind==="scenario"){if(ids.has(entry.id))throw new Error("Duplicate scenario step");ids.add(entry.id);}
   const requiredTargets=[];
   for(const [name,want]of Object.entries(entry.files||{})){
    const file=path.resolve(root,name),target=targets.get(file);if(!target)continue;
    if(kind==="scenario"&&target.current!==String(want).toLowerCase()&&!target.transitions.has(entry.id))throw new Error("Future target lacks a declared transition");
    requiredTargets.push({path:file,preimage:String(want).toLowerCase(),postimage:target.transitions.get(entry.id)?.to||String(want).toLowerCase(),current:target.current});
   }
   for(const [command_index,command]of entry.commands.entries()){
    const services=commandServices(command,cwd,root,plan);
    for(const service of services)coveredServices.add(service);
    if(registered){
     const matches=plansForCommand(command,root),locations=new Set([...matches.map(row=>path.resolve(row.file)),path.resolve(planFile||path.join(gatesDir,"deploy-plan.json"))]);
     if(locations.size>1)throw new Error("Command is ambiguous across recent plans");
     declaredInputs(entry,command,root,cwd,targets);
    }
    if(kind!=="incident"){
     const ready=assessReadinessWithBinding(services,{root,cwd,command,planBinding:{plan,entry,command,cwd,gatesDir}},preparationBinding);
     if(!ready?.ok)result.problems.push(...(ready?.problems||["Unknown preparation readiness result"]));
    }
    if(registered)result.coverage.push({kind,id:entry.id,position,command_index,command_sha256:commandHash(command)});
   }
   if(kind==="scenario")result.steps.push({id:entry.id,status:requiredTargets.some(t=>t.current!==t.preimage)?"READY_DECLARED_TRANSITION":"READY_CURRENT",requiredTargets});
  }
  if(plan.services.some(service=>!coveredServices.has(service)))result.problems.push("Plan service has no corresponding command");
  result.ok=result.problems.length===0;
 }catch(error){result.problems.push(String(error.message||error));}
 return result;
}
module.exports={inspectPlanPreparation};
