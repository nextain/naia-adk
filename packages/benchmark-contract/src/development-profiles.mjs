import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestCanonical } from "./validate-bundle.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const catalogPath=path.join(root,"baselines","development-composition-profiles.json");
const riskRank={low:0,medium:1,high:2};
// Every profile derives its assignments from its posture's role policy and its
// host family's tier map, so a role's binding is data and never hard-coded here.
const requiredRoles=["secretary","issue_leader","explorer","analysis","design","review","implementation","test","generic_worker","translation"];
const slotRole={orchestrator:"secretary",integrator:"issue_leader",bounded_worker:"implementation",mechanical_worker:"generic_worker",tester:"test"};
// Tiers a bounded or mechanical guard applies to. The optional external worker
// keeps its own signed-receipt qualification instead of these conditions.
const guardedTiers=new Set(["workhorse","light"]);
const named=record=>Object.keys(record||{}).filter(key=>!key.startsWith("_"));

function tierMapFor(catalog,profile){
	const tiers=catalog.host_families?.[profile.host_family],policy=catalog.role_policies?.[profile.posture];
	if(!tiers||!policy)throw new Error(`${profile.id}: unknown host family or posture`);
	return {tiers,policy};
}

function derivedBinding(catalog,profile,role){
	const {tiers,policy}=tierMapFor(catalog,profile),rolePolicy=policy[role];
	if(!rolePolicy)throw new Error(`${profile.id}: ${profile.posture} declares no ${role} policy`);
	const binding=tiers[rolePolicy.tier];
	if(!binding)throw new Error(`${profile.id}: host family ${profile.host_family} has no ${rolePolicy.tier} tier for ${role}`);
	return binding;
}

function canonicalJson(value){
	if(Array.isArray(value))return `[${value.map(canonicalJson).join(",")}]`;
	if(value&&typeof value==="object")return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
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
  if(catalog?.schema_revision!=="development-composition-profiles-v3"||catalog?.status!=="active_balanced_default_no_total_cost_claim")throw new Error("development composition profile identity invalid");
  const profiles=catalog.profiles||[],ids=profiles.map(item=>item.id);
  if(ids.length===0||new Set(ids).size!==ids.length)throw new Error("development composition profiles must be a non-empty set of unique ids");
  if(!ids.includes(catalog.default_profile)||!ids.includes(catalog.fallback_profile))throw new Error("development composition default or fallback drift");
  const activation=catalog.activation?.codex_bound_sessions;
  if(activation?.mode!=="default_active"||activation?.override_env!=="CODEX_DEVELOPMENT_PROFILE"||activation?.available_bindings_env!=="CODEX_AVAILABLE_BINDINGS")throw new Error("Codex development profile activation invalid");
  if(!Array.isArray(catalog.availability?.default_available_bindings)||catalog.availability.default_available_bindings.length===0||catalog.availability.default_available_bindings.some(binding=>!catalog.bindings?.[binding]))throw new Error("development composition availability defaults invalid");
	for(const id of named(catalog.bindings))if(typeof catalog.bindings[id].provider!=="string"||!catalog.bindings[id].provider)throw new Error(`binding ${id} must declare a provider`);
	for(const family of named(catalog.host_families))for(const tier of named(catalog.host_families[family]))if(!catalog.bindings[catalog.host_families[family][tier]])throw new Error(`host family ${family} maps ${tier} to unknown binding`);
	for(const posture of named(catalog.role_policies))for(const role of requiredRoles){
		const policy=catalog.role_policies[posture][role];
		if(!policy||typeof policy.tier!=="string"||!policy.allowed_reasoning_efforts?.includes(policy.default_reasoning_effort))throw new Error(`role policy invalid for ${posture}.${role}`);
	}
	const eligiblePostures=catalog.delegation_policy?.eligible_postures;
	if(!Array.isArray(eligiblePostures)||eligiblePostures.length===0||eligiblePostures.some(posture=>!catalog.role_policies?.[posture]))throw new Error("delegation eligible postures must name declared postures");
	if(catalog.delegation_context?.brief_mode!=="isolated_bounded"||catalog.delegation_context?.fork_turns!=="none"||catalog.delegation_context?.fork_context!==false||catalog.delegation_context?.inherit_root_context!==false)throw new Error("delegation context must remain isolated and non-inheriting");
	const optionalWorker=catalog.bindings.implementation_worker;
	if(optionalWorker?.profile_identity!=="deployment_local_implementation_worker"||optionalWorker?.activation!=="explicit_available_binding_only"||optionalWorker?.qualification_evidence!=="signed_deployment_local_receipt_v1"||optionalWorker?.receipt_algorithm!=="ed25519"||optionalWorker?.trust_store_relative_path!=="adk-development-worker-trust.json"||optionalWorker?.max_receipt_validity_ms!==2_592_000_000||!catalog.bindings[optionalWorker?.rollback_binding])throw new Error("optional implementation worker activation or rollback identity invalid");
	const crossProviderFamilies=new Set(catalog.guards?.cross_provider_review?.required_for_host_families||[]);
  for(const profile of profiles){
    for(const binding of [profile.assignments.orchestrator,profile.assignments.integrator,profile.assignments.bounded_worker,profile.assignments.mechanical_worker,profile.assignments.tester,...profile.assignments.reviewer_pool])if(!catalog.bindings[binding])throw new Error(`${profile.id}: unknown binding ${binding}`);
		const {policy}=tierMapFor(catalog,profile);
		for(const role of requiredRoles){
			const binding=derivedBinding(catalog,profile,role);
			if(!catalog.bindings[binding].allowed_reasoning_efforts?.includes(policy[role].default_reasoning_effort))throw new Error(`${profile.id}: ${binding} cannot serve ${role} at ${policy[role].default_reasoning_effort}`);
		}
		for(const slot of Object.keys(slotRole))if(profile.assignments[slot]!==derivedBinding(catalog,profile,slotRole[slot]))throw new Error(`${profile.id}: ${slot} drifts from ${profile.posture}.${slotRole[slot]}`);
		if(JSON.stringify(profile.assignments.reviewer_pool)!==JSON.stringify([derivedBinding(catalog,profile,"review")]))throw new Error(`${profile.id}: reviewer pool drifts from ${profile.posture}.review`);
		if(crossProviderFamilies.has(profile.host_family)&&catalog.bindings[profile.assignments.reviewer_pool[0]].provider===catalog.bindings[profile.assignments.bounded_worker].provider)throw new Error(`${profile.id}: cross-provider review is required but review shares the producer provider`);
  }
  for(const claim of ["proven_total_cost_reduction","production_optimal_profile","global_model_superiority"]){
    if(!catalog.claim_boundary.forbidden_until_phase_2.includes(claim))throw new Error(`phase-1 profile claim boundary missing ${claim}`);
  }
	const {bounded_worker:boundedGuard,mechanical_worker:mechanicalGuard,review:reviewGuard,flagship_specialist:flagshipSpecialistGuard}=catalog.guards||{};
	if(!boundedGuard||!(boundedGuard.maximum_risk in riskRank)||boundedGuard.fallback_binding!==null||boundedGuard.tier_fallback_binding!==null)throw new Error("bounded worker guard must fail closed without a model fallback");
	if(!mechanicalGuard||!(mechanicalGuard.maximum_risk in riskRank)||mechanicalGuard.fallback_binding!==null)throw new Error("mechanical worker guard must fail closed without a model fallback");
	const validatesFreshSessionGuard=guard=>guard?.different_session_required===true&&guard?.different_execution_required===true&&guard?.fail_closed_without_independent_execution_identity===true&&guard?.fresh_session_required===true&&guard?.followup_reuse_forbidden===true&&guard?.runtime_enforcer===".codex/hooks/subagent-spawn-guard.cjs";
	if(!validatesFreshSessionGuard(reviewGuard)||reviewGuard.prefer_different_binding_from_producer!==true||reviewGuard.prefer_different_provider_from_producer!==true)throw new Error("independent review guard invalid");
	if(!validatesFreshSessionGuard(flagshipSpecialistGuard)||JSON.stringify(flagshipSpecialistGuard.roles)!==JSON.stringify(["analysis","design","review"]))throw new Error("independent flagship specialist guard invalid");
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

export function selectDevelopmentBindingFromCatalog(catalog,{profileId,role,boundedScope=false,exactValidatorCommand=null,allowedShellCommands=[],risk="medium",availableBindings=null,bindingEvidence={},producerBinding=null,env=process.env}={}){
	validateCatalog(catalog);
  if(!(risk in riskRank))throw new Error(`unknown development risk ${risk}`);
	if(!Array.isArray(allowedShellCommands)||allowedShellCommands.some(command=>typeof command!=="string"))throw new Error("allowed shell commands are invalid");
	const exactValidatorBound=typeof exactValidatorCommand==="string"&&exactValidatorCommand.length>0&&exactValidatorCommand.trim()===exactValidatorCommand&&allowedShellCommands.includes(exactValidatorCommand);
	const availabilityName=catalog.activation.codex_bound_sessions.available_bindings_env;
	const hasEnvironmentAvailability=Object.prototype.hasOwnProperty.call(env,availabilityName);
	const environmentAvailability=env[availabilityName]?.trim();
	const configuredAvailability=availableBindings??(hasEnvironmentAvailability?(environmentAvailability===""||environmentAvailability==="[]"||environmentAvailability?.toLowerCase()==="none"?[]:environmentAvailability.split(",").map(item=>item.trim()).filter(Boolean)):catalog.availability.default_available_bindings);
	if(!Array.isArray(configuredAvailability)||configuredAvailability.some(binding=>!catalog.bindings[binding]))throw new Error("available development bindings are invalid");
	const available=new Set(configuredAvailability);
	const {profile,activation_source}=resolveProfileSelection(catalog,{profileId,env});
	const boundedGuard=catalog.guards.bounded_worker,mechanicalGuard=catalog.guards.mechanical_worker,reviewGuard=catalog.guards.review,flagshipSpecialistGuard=catalog.guards.flagship_specialist;
  const policyRole={orchestrator:"secretary",integrator:"issue_leader",explorer:"explorer",bounded_worker:"implementation",tester:"test",mechanical_worker:"generic_worker",adversarial_reviewer:"review",analysis:"analysis",designer:"design",translation:"translation"}[role];
  let binding;
  if(role==="orchestrator"||role==="integrator")binding=profile.assignments[role];
  else if(role==="bounded_worker"||role==="tester")binding=profile.assignments[role];
  else if(role==="mechanical_worker")binding=profile.assignments.mechanical_worker;
  else if(role==="explorer"||role==="analysis"||role==="designer"||role==="translation"){
		binding=derivedBinding(catalog,profile,policyRole);
	}
  else if(role==="adversarial_reviewer"){
		const reviewerPool=profile.assignments.reviewer_pool.filter(item=>available.has(item));
		const producerProvider=producerBinding?catalog.bindings[producerBinding]?.provider:null;
		binding=reviewGuard.prefer_different_provider_from_producer&&producerProvider
			? reviewerPool.find(item=>catalog.bindings[item].provider!==producerProvider)??reviewerPool.find(item=>item!==producerBinding)??reviewerPool[0]
			: reviewGuard.prefer_different_binding_from_producer
				? reviewerPool.find(item=>item!==producerBinding)??reviewerPool[0]
				: reviewerPool[0];
    if(!binding)throw new Error("no independent reviewer binding is available");
  } else throw new Error(`unknown development role ${role}`);

  let fallback_reason=null;
	// The bounded and mechanical guards follow the tier, not one provider's model
	// name, so a Claude workhorse is held to the same conditions Luna is.
	const guardedTier=guardedTiers.has(catalog.role_policies[profile.posture][policyRole]?.tier);
	if(["bounded_worker","tester","translation"].includes(role)&&guardedTier&&((boundedGuard.requires_bounded_scope&&!boundedScope)||riskRank[risk]>riskRank[boundedGuard.maximum_risk]))throw new Error(`${binding} ${role} requires bounded scope and risk at or below ${boundedGuard.maximum_risk}; no flagship fallback is permitted`);
	if(["bounded_worker","tester","translation"].includes(role)&&guardedTier&&boundedGuard.requires_exact_validator&&!exactValidatorBound)throw new Error(`${binding} ${role} requires an exact allowlisted validator command; no flagship fallback is permitted`);
	if(role==="mechanical_worker"&&guardedTier&&((mechanicalGuard.requires_bounded_scope&&!boundedScope)||(mechanicalGuard.requires_exact_validator&&!exactValidatorBound)||riskRank[risk]>riskRank[mechanicalGuard.maximum_risk]))throw new Error(`${binding} mechanical_worker requires bounded low-risk scope and an exact allowlisted validator command; no flagship fallback is permitted`);
	const selectedDefinition=catalog.bindings[binding];
	if(selectedDefinition?.adapter==="optional_external_runtime"){
		const evidence=bindingEvidence?.[binding];
		const qualified=available.has(selectedDefinition.rollback_binding)&&verifyOptionalWorkerReceipt(selectedDefinition,evidence,{catalogDigest:digestCanonical(catalog),profileId:profile.id});
		if(!qualified){binding=selectedDefinition.rollback_binding;fallback_reason="optional worker qualification evidence missing";}
	}
	if(!available.has(binding)){
		if(profile.id===catalog.default_profile)throw new Error(`${profile.id} requires ${binding} for ${role}; no fallback is permitted`);
		throw new Error(`no available development binding for ${role}; automatic model fallback is disabled`);
	}
  const rolePolicy=policyRole?catalog.role_policies[profile.posture][policyRole]:null;
  const reasoning_effort=rolePolicy&&catalog.host_families[profile.host_family][rolePolicy.tier]===binding?rolePolicy.default_reasoning_effort:catalog.bindings[binding].default_reasoning_effort??null;
  return {profile_id:profile.id,host_family:profile.host_family,posture:profile.posture,provider:catalog.bindings[binding].provider,activation_source,role,binding_id:binding,binding:catalog.bindings[binding],reasoning_effort,available_bindings:[...available].sort(),fallback_reason,profile_status:catalog.status,catalog_digest:digestCanonical(catalog),fallback_profile:catalog.fallback_profile,total_cost_reduction_proven:false};
}

export function selectDevelopmentBinding(options={}){
	return selectDevelopmentBindingFromCatalog(loadDevelopmentProfiles().catalog,options);
}

async function main(argv){
  const [command,...rest]=argv,flag=name=>{const index=rest.indexOf(name);return index<0?undefined:rest[index+1];},flags=name=>rest.flatMap((item,index)=>item===name&&rest[index+1]!==undefined?[rest[index+1]]:[]);
  if(command==="list")return loadDevelopmentProfiles();
  if(command==="show")return resolveDevelopmentProfile(flag("--profile"));
	if(command==="select"){
		const availabilityIndex=rest.indexOf("--available-bindings");
		const availableBindings=availabilityIndex<0?undefined:(rest[availabilityIndex+1]??"").split(",").map(item=>item.trim()).filter(Boolean);
		return selectDevelopmentBinding({profileId:flag("--profile"),role:flag("--role"),risk:flag("--risk")||"medium",boundedScope:rest.includes("--bounded-scope"),exactValidatorCommand:flag("--validator-command"),allowedShellCommands:flags("--allowed-shell-command"),availableBindings,producerBinding:flag("--producer-binding")});
	}
  throw new Error("usage: development-profiles.mjs list|show|select [--profile balanced] [--role bounded_worker] [--risk medium] [--bounded-scope] [--validator-command command] [--allowed-shell-command command]");
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(value=>process.stdout.write(`${JSON.stringify(value,null,2)}\n`)).catch(error=>{process.stderr.write(`development_profiles_error: ${error.message}\n`);process.exitCode=1;});

export {catalogPath};
