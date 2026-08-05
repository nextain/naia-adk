import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestCanonical } from "./validate-bundle.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const catalogPath=path.join(root,"baselines","development-composition-profiles.json");
const riskRank={low:0,medium:1,high:2};

function validateCatalog(catalog){
  if(catalog?.schema_revision!=="development-composition-profiles-v2"||catalog?.status!=="active_codex_default_no_total_cost_claim")throw new Error("development composition profile identity invalid");
  const profiles=catalog.profiles||[],ids=profiles.map(item=>item.id);
  if(ids.length!==4||new Set(ids).size!==4||!["control","balanced","economy","delegated"].every(id=>ids.includes(id)))throw new Error("development composition profiles must be control, balanced, economy, and delegated");
  if(catalog.default_profile!=="balanced"||catalog.fallback_profile!=="control")throw new Error("development composition default or fallback drift");
  const activation=catalog.activation?.codex_bound_sessions;
  if(activation?.mode!=="default_active"||activation?.override_env!=="CODEX_DEVELOPMENT_PROFILE"||activation?.available_bindings_env!=="CODEX_AVAILABLE_BINDINGS")throw new Error("Codex development profile activation invalid");
  if(!Array.isArray(catalog.availability?.default_available_bindings)||catalog.availability.default_available_bindings.length===0||catalog.availability.default_available_bindings.some(binding=>!catalog.bindings?.[binding]))throw new Error("development composition availability defaults invalid");
  for(const profile of profiles){
    for(const binding of [profile.assignments.orchestrator,profile.assignments.integrator,profile.assignments.bounded_worker,profile.assignments.mechanical_worker,profile.assignments.tester,...profile.assignments.reviewer_pool])if(!catalog.bindings[binding])throw new Error(`${profile.id}: unknown binding ${binding}`);
  }
  for(const claim of ["proven_total_cost_reduction","production_optimal_profile","global_model_superiority"]){
    if(!catalog.claim_boundary.forbidden_until_phase_2.includes(claim))throw new Error(`phase-1 profile claim boundary missing ${claim}`);
  }
	const {bounded_worker:boundedGuard,mechanical_worker:mechanicalGuard,review:reviewGuard}=catalog.guards||{};
	if(!boundedGuard||!(boundedGuard.maximum_risk in riskRank)||!catalog.bindings[boundedGuard.fallback_binding]||!catalog.bindings[boundedGuard.luna_fallback_binding])throw new Error("bounded worker guard invalid");
	if(!mechanicalGuard||!(mechanicalGuard.luna_maximum_risk in riskRank)||!catalog.bindings[mechanicalGuard.fallback_binding])throw new Error("mechanical worker guard invalid");
	if(!reviewGuard||reviewGuard.different_session_required!==true||reviewGuard.different_execution_required!==true||reviewGuard.fail_closed_without_independent_execution_identity!==true)throw new Error("independent review guard invalid");
  return catalog;
}

export function loadDevelopmentProfiles(){
  const catalog=validateCatalog(JSON.parse(fs.readFileSync(catalogPath,"utf8")));
  return {catalog,catalog_digest:digestCanonical(catalog)};
}

function resolveProfileSelection(catalog,{profileId,env=process.env}={}){
  const overrideName=catalog.activation.codex_bound_sessions.override_env;
  const hasOverride=Object.prototype.hasOwnProperty.call(env,overrideName)&&String(env[overrideName]).trim()!=="";
  const selectedId=profileId??(hasOverride?String(env[overrideName]).trim():catalog.default_profile);
  const source=profileId!==undefined?"explicit":hasOverride?"environment_override":"catalog_default";
  const profile=catalog.profiles.find(item=>item.id===selectedId);
  if(!profile)throw new Error(`unknown development composition profile ${selectedId}`);
  return {profile,activation_source:source};
}

export function resolveDevelopmentProfile(profileId,options={}){
  const {catalog,catalog_digest}=loadDevelopmentProfiles(),selection=resolveProfileSelection(catalog,{profileId,env:options.env});
  const {profile,activation_source}=selection;
  return {schema_revision:catalog.schema_revision,status:catalog.status,profile,catalog_digest,activation_source,claim_boundary:catalog.claim_boundary};
}

export function selectDevelopmentBindingFromCatalog(catalog,{profileId,role,boundedScope=false,exactValidator=false,risk="medium",availableBindings=null,producerBinding=null,producerSessionId=null,reviewerSessionId=null,producerExecutionId=null,reviewerExecutionId=null,env=process.env}={}){
	validateCatalog(catalog);
  if(!(risk in riskRank))throw new Error(`unknown development risk ${risk}`);
	const availabilityName=catalog.activation.codex_bound_sessions.available_bindings_env;
	const hasEnvironmentAvailability=Object.prototype.hasOwnProperty.call(env,availabilityName);
	const environmentAvailability=env[availabilityName]?.trim();
	const configuredAvailability=availableBindings??(hasEnvironmentAvailability?(environmentAvailability===""||environmentAvailability==="[]"||environmentAvailability?.toLowerCase()==="none"?[]:environmentAvailability.split(",").map(item=>item.trim()).filter(Boolean)):catalog.availability.default_available_bindings);
	if(!Array.isArray(configuredAvailability)||configuredAvailability.some(binding=>!catalog.bindings[binding]))throw new Error("available development bindings are invalid");
	const available=new Set(configuredAvailability);
	const {profile,activation_source}=resolveProfileSelection(catalog,{profileId,env});
	const boundedGuard=catalog.guards.bounded_worker,mechanicalGuard=catalog.guards.mechanical_worker,reviewGuard=catalog.guards.review;
  let binding;
  if(role==="orchestrator"||role==="integrator")binding=profile.assignments[role];
  else if(role==="bounded_worker"||role==="tester")binding=profile.assignments[role];
  else if(role==="mechanical_worker")binding=profile.assignments.mechanical_worker;
  else if(role==="adversarial_reviewer"){
		const sessionIndependent=Boolean(producerSessionId&&reviewerSessionId&&producerSessionId!==reviewerSessionId);
		const executionIndependent=Boolean(producerExecutionId&&reviewerExecutionId&&producerExecutionId!==reviewerExecutionId);
		if((reviewGuard.different_session_required&&!sessionIndependent)||(reviewGuard.different_execution_required&&!executionIndependent))throw new Error("independent review requires distinct session and execution identities");
		const reviewerPool=profile.assignments.reviewer_pool.filter(item=>available.has(item));
		binding=reviewGuard.prefer_different_binding_from_producer
			? reviewerPool.find(item=>item!==producerBinding)??reviewerPool[0]
			: reviewerPool[0];
    if(!binding)throw new Error("no independent reviewer binding is available");
  } else throw new Error(`unknown development role ${role}`);

  let fallback_reason=null;
	if(["bounded_worker","tester"].includes(role)&&((boundedGuard.requires_bounded_scope&&!boundedScope)||riskRank[risk]>riskRank[boundedGuard.maximum_risk])){binding=boundedGuard.fallback_binding;fallback_reason="bounded engineering guard";}
	if(role==="bounded_worker"&&binding==="luna"&&boundedGuard.luna_requires_exact_validator&&!exactValidator){binding=boundedGuard.luna_fallback_binding;fallback_reason="Luna implementation validator guard";}
	if(role==="mechanical_worker"&&binding==="luna"&&((mechanicalGuard.luna_requires_bounded_scope&&!boundedScope)||(mechanicalGuard.luna_requires_exact_validator&&!exactValidator)||riskRank[risk]>riskRank[mechanicalGuard.luna_maximum_risk])){binding=mechanicalGuard.fallback_binding;fallback_reason="Luna exact-validation guard";}
	if(role==="mechanical_worker"&&binding===mechanicalGuard.fallback_binding&&((boundedGuard.requires_bounded_scope&&!boundedScope)||riskRank[risk]>riskRank[boundedGuard.maximum_risk])){binding=boundedGuard.fallback_binding;fallback_reason="mechanical task boundary guard";}
	if(!available.has(binding)){
		const candidates=binding==="luna"
			?(role==="mechanical_worker"?[mechanicalGuard.fallback_binding,boundedGuard.fallback_binding]:[boundedGuard.luna_fallback_binding,boundedGuard.fallback_binding])
			:binding==="terra"&&["bounded_worker","tester","mechanical_worker"].includes(role)?[boundedGuard.fallback_binding]:[];
		const fallback=candidates.find(candidate=>available.has(candidate));
		if(!fallback)throw new Error(`no available development binding for ${role}`);
		binding=fallback;
		fallback_reason="selected binding unavailable";
	}
  return {profile_id:profile.id,activation_source,role,binding_id:binding,binding:catalog.bindings[binding],available_bindings:[...available].sort(),fallback_reason,profile_status:catalog.status,catalog_digest:digestCanonical(catalog),fallback_profile:catalog.fallback_profile,total_cost_reduction_proven:false};
}

export function selectDevelopmentBinding(options={}){
	return selectDevelopmentBindingFromCatalog(loadDevelopmentProfiles().catalog,options);
}

async function main(argv){
  const [command,...rest]=argv,flag=name=>{const index=rest.indexOf(name);return index<0?undefined:rest[index+1];};
  if(command==="list")return loadDevelopmentProfiles();
  if(command==="show")return resolveDevelopmentProfile(flag("--profile"));
	if(command==="select"){
		const availabilityIndex=rest.indexOf("--available-bindings");
		const availableBindings=availabilityIndex<0?undefined:(rest[availabilityIndex+1]??"").split(",").map(item=>item.trim()).filter(Boolean);
		return selectDevelopmentBinding({profileId:flag("--profile"),role:flag("--role"),risk:flag("--risk")||"medium",boundedScope:rest.includes("--bounded-scope"),exactValidator:rest.includes("--exact-validator"),availableBindings,producerBinding:flag("--producer-binding"),producerSessionId:flag("--producer-session-id"),reviewerSessionId:flag("--reviewer-session-id"),producerExecutionId:flag("--producer-execution-id"),reviewerExecutionId:flag("--reviewer-execution-id")});
	}
  throw new Error("usage: development-profiles.mjs list|show|select [--profile balanced] [--role bounded_worker] [--risk medium] [--bounded-scope] [--exact-validator] [--producer-session-id ID --reviewer-session-id ID --producer-execution-id ID --reviewer-execution-id ID]");
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(value=>process.stdout.write(`${JSON.stringify(value,null,2)}\n`)).catch(error=>{process.stderr.write(`development_profiles_error: ${error.message}\n`);process.exitCode=1;});

export {catalogPath};
