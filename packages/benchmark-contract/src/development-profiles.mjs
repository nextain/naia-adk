import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestCanonical } from "./validate-bundle.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const catalogPath=path.join(root,"baselines","development-composition-profiles.json");
const riskRank={low:0,medium:1,high:2};
const balancedRoleExpectation={
	secretary:["luna","max"],issue_leader:["luna","max"],analysis:["sol","medium"],design:["sol","medium"],review:["sol","medium"],
	implementation:["luna","medium"],test:["luna","medium"],generic_worker:["luna","medium"],translation:["luna","low"],
};
const specialistPhases=["production","analysis","design","review"];

function canonicalJson(value){
	if(Array.isArray(value))return `[${value.map(canonicalJson).join(",")}]`;
	if(value&&typeof value==="object")return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}

function validateSpecialistIdentities(roleIdentities){
	const identities=specialistPhases.map(phase=>roleIdentities?.[phase]);
	if(identities.some(identity=>!identity||typeof identity.session_id!=="string"||!identity.session_id||typeof identity.execution_id!=="string"||!identity.execution_id))throw new Error("specialist phases require complete role-bound session and execution identities");
	if(new Set(identities.map(identity=>identity.session_id)).size!==identities.length||new Set(identities.map(identity=>identity.execution_id)).size!==identities.length)throw new Error("specialist phases require pairwise-distinct session and execution identities");
}

function verifyOptionalWorkerReceipt(definition,receipt,{now=Date.now(),catalogDigest,profileId}={}){
	try{
		const trustPath=path.join(process.env.CODEX_HOME||path.join(os.homedir(),".codex"),definition.trust_store_relative_path);
		const stat=fs.statSync(trustPath);
		if(!stat.isFile()||(stat.mode&0o022)!==0||(typeof process.getuid==="function"&&stat.uid!==process.getuid()))return false;
		const trust=JSON.parse(fs.readFileSync(trustPath,"utf8"));
		if(trust?.schema_revision!=="development-worker-trust-v1"||receipt?.schema_revision!=="development-worker-receipt-v1"||typeof receipt.signature!=="string")return false;
		const payload=receipt.payload,deployment=trust.deployments?.[payload?.deployment_id];
		if(!deployment||payload?.binding_id!=="implementation_worker"||payload?.profile_identity!==definition.profile_identity||payload?.rollback_binding!==definition.rollback_binding||payload?.catalog_digest!==catalogDigest||payload?.selected_profile_id!==profileId)return false;
		if(payload?.worker_identity!==deployment.worker_identity||payload?.runtime_model!==deployment.runtime_model||typeof deployment.public_key_pem!=="string")return false;
		const issued=Date.parse(payload.issued_at),expires=Date.parse(payload.expires_at);
		if(!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now||expires<now||expires<=issued||expires-issued>definition.max_receipt_validity_ms)return false;
		return crypto.verify(null,Buffer.from(canonicalJson(payload)),deployment.public_key_pem,Buffer.from(receipt.signature,"base64"));
	}catch{return false;}
}

function validateCatalog(catalog){
  if(catalog?.schema_revision!=="development-composition-profiles-v2"||catalog?.status!=="active_codex_default_no_total_cost_claim")throw new Error("development composition profile identity invalid");
  const profiles=catalog.profiles||[],ids=profiles.map(item=>item.id);
  if(ids.length!==4||new Set(ids).size!==4||!["control","balanced","economy","delegated"].every(id=>ids.includes(id)))throw new Error("development composition profiles must be control, balanced, economy, and delegated");
  if(catalog.default_profile!=="balanced"||catalog.fallback_profile!=="control")throw new Error("development composition default or fallback drift");
  const activation=catalog.activation?.codex_bound_sessions;
  if(activation?.mode!=="default_active"||activation?.override_env!=="CODEX_DEVELOPMENT_PROFILE"||activation?.available_bindings_env!=="CODEX_AVAILABLE_BINDINGS")throw new Error("Codex development profile activation invalid");
  if(!Array.isArray(catalog.availability?.default_available_bindings)||catalog.availability.default_available_bindings.length===0||catalog.availability.default_available_bindings.some(binding=>!catalog.bindings?.[binding]))throw new Error("development composition availability defaults invalid");
  const requiredBalancedRoles=["secretary","issue_leader","analysis","design","review","implementation","test","generic_worker","translation"];
  for(const role of requiredBalancedRoles){
    const policy=catalog.balanced_role_policy?.[role];
    const [expectedBinding,expectedEffort]=balancedRoleExpectation[role];
		if(!policy||policy.binding!==expectedBinding||policy.default_reasoning_effort!==expectedEffort||!catalog.bindings[policy.binding]||!policy.allowed_reasoning_efforts?.includes(policy.default_reasoning_effort)||!catalog.bindings[policy.binding].allowed_reasoning_efforts?.includes(policy.default_reasoning_effort))throw new Error(`balanced role policy invalid for ${role}`);
  }
	if(catalog.delegation_context?.brief_mode!=="isolated_bounded"||catalog.delegation_context?.fork_turns!=="none"||catalog.delegation_context?.fork_context!==false||catalog.delegation_context?.inherit_root_context!==false)throw new Error("delegation context must remain isolated and non-inheriting");
	const optionalWorker=catalog.bindings.implementation_worker;
	if(optionalWorker?.profile_identity!=="deployment_local_implementation_worker"||optionalWorker?.activation!=="explicit_available_binding_only"||optionalWorker?.qualification_evidence!=="signed_deployment_local_receipt_v1"||optionalWorker?.receipt_algorithm!=="ed25519"||optionalWorker?.trust_store_relative_path!=="adk-development-worker-trust.json"||optionalWorker?.max_receipt_validity_ms!==2_592_000_000||!catalog.bindings[optionalWorker?.rollback_binding])throw new Error("optional implementation worker activation or rollback identity invalid");
  for(const profile of profiles){
    for(const binding of [profile.assignments.orchestrator,profile.assignments.integrator,profile.assignments.bounded_worker,profile.assignments.mechanical_worker,profile.assignments.tester,...profile.assignments.reviewer_pool])if(!catalog.bindings[binding])throw new Error(`${profile.id}: unknown binding ${binding}`);
  }
	for(const profileId of ["balanced","economy"]){
		const assignments=profiles.find(profile=>profile.id===profileId)?.assignments;
		if(assignments?.orchestrator!==balancedRoleExpectation.secretary[0]||assignments?.integrator!==balancedRoleExpectation.issue_leader[0]||assignments?.bounded_worker!==balancedRoleExpectation.implementation[0]||assignments?.mechanical_worker!==balancedRoleExpectation.generic_worker[0]||assignments?.tester!==balancedRoleExpectation.test[0]||JSON.stringify(assignments?.reviewer_pool)!==JSON.stringify([balancedRoleExpectation.review[0]]))throw new Error(`${profileId}: assignments drift from exact role policy`);
	}
  for(const claim of ["proven_total_cost_reduction","production_optimal_profile","global_model_superiority"]){
    if(!catalog.claim_boundary.forbidden_until_phase_2.includes(claim))throw new Error(`phase-1 profile claim boundary missing ${claim}`);
  }
	const {bounded_worker:boundedGuard,mechanical_worker:mechanicalGuard,review:reviewGuard,sol_specialist:solSpecialistGuard}=catalog.guards||{};
	if(!boundedGuard||!(boundedGuard.maximum_risk in riskRank)||!catalog.bindings[boundedGuard.fallback_binding]||!catalog.bindings[boundedGuard.luna_fallback_binding])throw new Error("bounded worker guard invalid");
	if(!mechanicalGuard||!(mechanicalGuard.luna_maximum_risk in riskRank)||!catalog.bindings[mechanicalGuard.fallback_binding])throw new Error("mechanical worker guard invalid");
	if(boundedGuard.fallback_binding!=="sol"||boundedGuard.luna_fallback_binding!=="sol"||mechanicalGuard.fallback_binding!=="sol")throw new Error("Balanced guarded fallback must remain Sol");
	if(!reviewGuard||reviewGuard.different_session_required!==true||reviewGuard.different_execution_required!==true||reviewGuard.fail_closed_without_independent_execution_identity!==true)throw new Error("independent review guard invalid");
	if(!solSpecialistGuard||!Array.isArray(solSpecialistGuard.roles)||!solSpecialistGuard.roles.includes("analysis")||!solSpecialistGuard.roles.includes("designer")||solSpecialistGuard.different_session_required!==true||solSpecialistGuard.different_execution_required!==true||solSpecialistGuard.fail_closed_without_independent_execution_identity!==true)throw new Error("independent Sol specialist guard invalid");
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

export function selectDevelopmentBindingFromCatalog(catalog,{profileId,role,boundedScope=false,exactValidator=false,risk="medium",availableBindings=null,bindingEvidence={},roleIdentities={},producerBinding=null,env=process.env}={}){
	validateCatalog(catalog);
  if(!(risk in riskRank))throw new Error(`unknown development risk ${risk}`);
	const availabilityName=catalog.activation.codex_bound_sessions.available_bindings_env;
	const hasEnvironmentAvailability=Object.prototype.hasOwnProperty.call(env,availabilityName);
	const environmentAvailability=env[availabilityName]?.trim();
	const configuredAvailability=availableBindings??(hasEnvironmentAvailability?(environmentAvailability===""||environmentAvailability==="[]"||environmentAvailability?.toLowerCase()==="none"?[]:environmentAvailability.split(",").map(item=>item.trim()).filter(Boolean)):catalog.availability.default_available_bindings);
	if(!Array.isArray(configuredAvailability)||configuredAvailability.some(binding=>!catalog.bindings[binding]))throw new Error("available development bindings are invalid");
	const available=new Set(configuredAvailability);
	const {profile,activation_source}=resolveProfileSelection(catalog,{profileId,env});
	const boundedGuard=catalog.guards.bounded_worker,mechanicalGuard=catalog.guards.mechanical_worker,reviewGuard=catalog.guards.review,solSpecialistGuard=catalog.guards.sol_specialist;
  const balancedPolicyRole={orchestrator:"secretary",integrator:"issue_leader",bounded_worker:"implementation",tester:"test",mechanical_worker:"generic_worker",adversarial_reviewer:"review",analysis:"analysis",designer:"design",translation:"translation"}[role];
  let binding;
  if(role==="orchestrator"||role==="integrator")binding=profile.assignments[role];
  else if(role==="bounded_worker"||role==="tester")binding=profile.assignments[role];
  else if(role==="mechanical_worker")binding=profile.assignments.mechanical_worker;
  else if(role==="analysis"||role==="designer"||role==="translation"){
		if(["analysis","designer"].includes(role))validateSpecialistIdentities(roleIdentities);
		binding=profile.id==="control"?"sol":catalog.balanced_role_policy[balancedPolicyRole].binding;
	}
  else if(role==="adversarial_reviewer"){
		validateSpecialistIdentities(roleIdentities);
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
	const selectedDefinition=catalog.bindings[binding];
	if(selectedDefinition?.adapter==="optional_external_runtime"){
		const evidence=bindingEvidence?.[binding];
		const qualified=available.has(selectedDefinition.rollback_binding)&&verifyOptionalWorkerReceipt(selectedDefinition,evidence,{catalogDigest:digestCanonical(catalog),profileId:profile.id});
		if(!qualified){binding=selectedDefinition.rollback_binding;fallback_reason="optional worker qualification evidence missing";}
	}
	if(!available.has(binding)){
		if(profile.id==="balanced")throw new Error(`Balanced requires ${binding} for ${role}; no fallback is permitted`);
		const candidates=binding==="luna"
			?(role==="mechanical_worker"?[mechanicalGuard.fallback_binding,boundedGuard.fallback_binding]:[boundedGuard.luna_fallback_binding,boundedGuard.fallback_binding])
			:binding==="terra"&&["bounded_worker","tester","mechanical_worker"].includes(role)?[boundedGuard.fallback_binding]:[];
		const fallback=candidates.find(candidate=>available.has(candidate));
		if(!fallback)throw new Error(`no available development binding for ${role}`);
		binding=fallback;
		fallback_reason="selected binding unavailable";
	}
  const rolePolicy=["balanced","economy"].includes(profile.id)&&balancedPolicyRole?catalog.balanced_role_policy[balancedPolicyRole]:null;
  const reasoning_effort=rolePolicy?.binding===binding?rolePolicy.default_reasoning_effort:catalog.bindings[binding].default_reasoning_effort??null;
  return {profile_id:profile.id,activation_source,role,binding_id:binding,binding:catalog.bindings[binding],reasoning_effort,available_bindings:[...available].sort(),fallback_reason,profile_status:catalog.status,catalog_digest:digestCanonical(catalog),fallback_profile:catalog.fallback_profile,total_cost_reduction_proven:false};
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
		return selectDevelopmentBinding({profileId:flag("--profile"),role:flag("--role"),risk:flag("--risk")||"medium",boundedScope:rest.includes("--bounded-scope"),exactValidator:rest.includes("--exact-validator"),availableBindings,producerBinding:flag("--producer-binding")});
	}
  throw new Error("usage: development-profiles.mjs list|show|select [--profile balanced] [--role bounded_worker] [--risk medium] [--bounded-scope] [--exact-validator]");
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(value=>process.stdout.write(`${JSON.stringify(value,null,2)}\n`)).catch(error=>{process.stderr.write(`development_profiles_error: ${error.message}\n`);process.exitCode=1;});

export {catalogPath};
