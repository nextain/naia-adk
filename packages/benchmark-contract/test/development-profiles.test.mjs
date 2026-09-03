import assert from "node:assert/strict";
import cp from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {loadDevelopmentProfiles,resolveDevelopmentProfile,selectDevelopmentBinding,selectDevelopmentBindingFromCatalog} from "../src/development-profiles.mjs";

const {catalog,catalog_digest}=loadDevelopmentProfiles();
assert.match(catalog_digest,/^[a-f0-9]{64}$/u);
const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
assert(fs.readFileSync(path.join(packageRoot,"README.md"),"utf8").includes(`계약 SHA-256은 \`${catalog_digest}\``));
assert.equal(catalog.default_profile,"balanced");
assert.equal(resolveDevelopmentProfile().profile.id,"balanced");
assert.equal(resolveDevelopmentProfile().activation_source,"catalog_default");
assert.equal(resolveDevelopmentProfile(undefined,{env:{CODEX_DEVELOPMENT_PROFILE:"economy"}}).profile.id,"economy");
assert.equal(resolveDevelopmentProfile(undefined,{env:{CODEX_DEVELOPMENT_PROFILE:"economy"}}).activation_source,"environment_override");
assert.throws(()=>resolveDevelopmentProfile(undefined,{env:{CODEX_DEVELOPMENT_PROFILE:"future-model-name"}}),/unknown development composition profile/);
const defaultSelection=selectDevelopmentBinding({role:"orchestrator",env:{}});
assert.equal(defaultSelection.binding_id,"luna");
assert.equal(defaultSelection.reasoning_effort,"max");
assert.equal(defaultSelection.profile_id,"balanced");
assert.equal(defaultSelection.activation_source,"catalog_default");
assert.equal(defaultSelection.catalog_digest,catalog_digest);
assert.equal(defaultSelection.fallback_profile,"control");
const environmentSelection=selectDevelopmentBinding({role:"orchestrator",env:{CODEX_DEVELOPMENT_PROFILE:"control"}});
assert.equal(environmentSelection.profile_id,"control");
assert.equal(environmentSelection.activation_source,"environment_override");
assert.equal(environmentSelection.binding_id,"sol");
assert.equal(environmentSelection.reasoning_effort,"medium");
const validatorCommand="node test/exact-validator.mjs";
const exactValidatorEvidence={exactValidatorCommand:validatorCommand,allowedShellCommands:[validatorCommand]};
assert.deepEqual(
  ["analysis","designer","adversarial_reviewer"].map(role=>selectDevelopmentBinding({role,...(role==="adversarial_reviewer"?{producerBinding:"luna"}:{})})).map(selection=>[selection.binding_id,selection.reasoning_effort]),
  [["sol","medium"],["sol","medium"],["sol","medium"]],
);
assert.deepEqual(
  ["explorer","bounded_worker","tester","mechanical_worker","translation"].map(role=>selectDevelopmentBinding({role,boundedScope:true,...exactValidatorEvidence,risk:"low"})).map(selection=>[selection.binding_id,selection.reasoning_effort]),
  // tester runs at low effort per operator calibration (e08b176)
  [["luna","low"],["luna","medium"],["luna","low"],["luna","medium"],["luna","low"]],
);
assert.deepEqual(catalog.balanced_role_policy.translation.allowed_reasoning_efforts,["low"]);
const grokAvailability=["grok_flagship","grok_workhorse","grok_light"];
const grokRoles=["orchestrator","integrator","bounded_worker","tester","mechanical_worker","explorer","analysis","designer","translation","adversarial_reviewer"];
const grokBalanced=grokRoles.map(role=>selectDevelopmentBinding({profileId:"grok-balanced",role,availableBindings:grokAvailability,boundedScope:true,...exactValidatorEvidence,risk:"low",...(role==="adversarial_reviewer"?{producerBinding:"grok_workhorse"}:{})}));
assert.ok(grokBalanced.every(selection=>selection.binding.adapter==="grok"),"a Grok profile must never resolve a Codex binding");
assert.deepEqual(
	["orchestrator","bounded_worker","tester","analysis","designer","adversarial_reviewer","translation"].map(role=>{const selection=grokBalanced[grokRoles.indexOf(role)];return [selection.binding_id,selection.reasoning_effort];}),
	[["grok_workhorse","medium"],["grok_workhorse","medium"],["grok_light","low"],["grok_flagship","high"],["grok_flagship","high"],["grok_flagship","medium"],["grok_light","low"]],
);
assert.throws(()=>selectDevelopmentBinding({profileId:"grok-balanced",role:"bounded_worker",availableBindings:grokAvailability,boundedScope:false,risk:"low"}),/requires bounded scope/,"a Grok workhorse is held to the same bounded conditions Luna is");
assert.throws(()=>selectDevelopmentBinding({role:"orchestrator",availableBindings:grokAvailability}),/Balanced requires luna for orchestrator/,"declaring only Grok bindings must fail closed on a Codex profile rather than substituting a Grok model");
assert.throws(()=>selectDevelopmentBinding({profileId:"grok-balanced",role:"orchestrator",availableBindings:["sol","luna"]}),/no available development binding for orchestrator/,"declaring only Codex bindings must fail closed on a Grok profile");
assert.throws(()=>selectDevelopmentBinding({role:"bounded_worker",boundedScope:true,...exactValidatorEvidence,risk:"medium",availableBindings:["sol","terra"]}),/Balanced requires luna for bounded_worker/);
assert.equal(selectDevelopmentBinding({role:"bounded_worker",boundedScope:true,...exactValidatorEvidence,risk:"medium",availableBindings:["sol","terra","luna"]}).binding_id,"luna");
assert.throws(()=>selectDevelopmentBinding({role:"bounded_worker",boundedScope:true,exactValidatorCommand:validatorCommand,allowedShellCommands:["node test/other.mjs"],risk:"medium"}),/exact allowlisted validator command/,"the exact validator command must appear verbatim in allowed_shell_commands");
assert.throws(()=>selectDevelopmentBinding({role:"bounded_worker",boundedScope:true,exactValidator:true,risk:"medium"}),/exact allowlisted validator command/,"a legacy boolean must not qualify a Luna command role");
assert.throws(()=>selectDevelopmentBinding({role:"bounded_worker",boundedScope:false,risk:"low"}),/requires bounded scope/);
assert.throws(()=>selectDevelopmentBinding({role:"bounded_worker",boundedScope:true,risk:"high"}),/requires bounded scope/);
assert.equal(selectDevelopmentBinding({role:"tester",boundedScope:true,...exactValidatorEvidence,risk:"medium"}).binding_id,"luna");
assert.throws(()=>selectDevelopmentBinding({role:"tester",boundedScope:true,risk:"medium"}),/exact allowlisted validator command/);
assert.throws(()=>selectDevelopmentBinding({role:"tester",boundedScope:false,risk:"low"}),/requires bounded scope/);
assert.equal(selectDevelopmentBinding({role:"translation",boundedScope:true,...exactValidatorEvidence,risk:"low"}).binding_id,"luna");
assert.throws(()=>selectDevelopmentBinding({role:"translation",boundedScope:true,risk:"low"}),/exact allowlisted validator command/);
assert.throws(()=>selectDevelopmentBinding({role:"translation",boundedScope:false,...exactValidatorEvidence,risk:"low"}),/requires bounded scope/);
assert.equal(selectDevelopmentBinding({profileId:"economy",role:"mechanical_worker",boundedScope:true,...exactValidatorEvidence,risk:"low"}).binding_id,"luna");
assert.equal(selectDevelopmentBinding({profileId:"economy",role:"mechanical_worker",boundedScope:true,...exactValidatorEvidence,risk:"low",availableBindings:["sol","terra","luna"]}).binding_id,"luna");
assert.throws(()=>selectDevelopmentBinding({profileId:"economy",role:"mechanical_worker",boundedScope:true,risk:"low"}),/bounded low-risk scope/);
assert.throws(()=>selectDevelopmentBinding({profileId:"economy",role:"mechanical_worker",boundedScope:true,...exactValidatorEvidence,risk:"medium"}),/bounded low-risk scope/);
assert.throws(()=>selectDevelopmentBinding({profileId:"economy",role:"mechanical_worker",boundedScope:false,risk:"high"}),/bounded low-risk scope/);
assert.equal(selectDevelopmentBinding({profileId:"delegated",role:"orchestrator"}).binding_id,"sol");
assert.equal(selectDevelopmentBinding({profileId:"delegated",role:"integrator"}).binding_id,"sol");
assert.equal(selectDevelopmentBinding({profileId:"delegated",role:"bounded_worker",boundedScope:true,risk:"medium"}).binding_id,"sol");
const unqualifiedDelegated=selectDevelopmentBinding({profileId:"delegated",role:"bounded_worker",boundedScope:true,risk:"medium",availableBindings:["sol","terra","implementation_worker"]});
assert.equal(unqualifiedDelegated.binding_id,"sol");
assert.equal(unqualifiedDelegated.fallback_reason,"optional worker qualification evidence missing");
const previousCodexHome=process.env.CODEX_HOME;
const trustHome=fs.mkdtempSync(path.join(os.tmpdir(),"development-worker-trust-"));
process.env.CODEX_HOME=trustHome;
const {publicKey,privateKey}=crypto.generateKeyPairSync("ed25519");
fs.writeFileSync(path.join(trustHome,"adk-development-worker-trust.json"),JSON.stringify({schema_revision:"development-worker-trust-v1",deployments:{local:{public_key_pem:publicKey.export({type:"spki",format:"pem"}),worker_identity:"local-luna-worker",runtime_model:"gpt-5.6-luna"}}}),{mode:0o600});
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(",")}]`:value&&typeof value==="object"?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`:JSON.stringify(value);
const receiptPayload={binding_id:"implementation_worker",catalog_digest,deployment_id:"local",expires_at:new Date(Date.now()+3_600_000).toISOString(),issued_at:new Date(Date.now()-1_000).toISOString(),profile_identity:"deployment_local_implementation_worker",rollback_binding:"sol",runtime_model:"gpt-5.6-luna",selected_profile_id:"delegated",worker_identity:"local-luna-worker"};
const implementationWorkerEvidence={implementation_worker:{schema_revision:"development-worker-receipt-v1",payload:receiptPayload,signature:crypto.sign(null,Buffer.from(canonical(receiptPayload)),privateKey).toString("base64")}};
assert.equal(selectDevelopmentBinding({profileId:"delegated",role:"bounded_worker",boundedScope:true,risk:"medium",availableBindings:["sol","terra","implementation_worker"],bindingEvidence:implementationWorkerEvidence}).binding_id,"implementation_worker");
assert.throws(()=>selectDevelopmentBinding({profileId:"delegated",role:"bounded_worker",boundedScope:true,risk:"medium",availableBindings:["implementation_worker"],bindingEvidence:implementationWorkerEvidence}),/no available development binding/,"optional worker requires an available Sol rollback");
const forgedEvidence=structuredClone(implementationWorkerEvidence);
forgedEvidence.implementation_worker.payload.runtime_model="forged-model";
assert.equal(selectDevelopmentBinding({profileId:"delegated",role:"bounded_worker",boundedScope:true,risk:"medium",availableBindings:["sol","terra","implementation_worker"],bindingEvidence:forgedEvidence}).binding_id,"sol");
const staleCatalogEvidence=structuredClone(implementationWorkerEvidence);
staleCatalogEvidence.implementation_worker.payload.catalog_digest="0".repeat(64);
staleCatalogEvidence.implementation_worker.signature=crypto.sign(null,Buffer.from(canonical(staleCatalogEvidence.implementation_worker.payload)),privateKey).toString("base64");
assert.equal(selectDevelopmentBinding({profileId:"delegated",role:"bounded_worker",boundedScope:true,risk:"medium",availableBindings:["sol","implementation_worker"],bindingEvidence:staleCatalogEvidence}).binding_id,"sol");
if(previousCodexHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousCodexHome;
fs.rmSync(trustHome,{recursive:true,force:true});
assert.equal(selectDevelopmentBinding({profileId:"delegated",role:"bounded_worker",boundedScope:false,risk:"low"}).binding_id,"sol");
assert.equal(selectDevelopmentBinding({profileId:"delegated",role:"bounded_worker",boundedScope:true,risk:"high"}).binding_id,"sol");
assert.equal(selectDevelopmentBinding({role:"adversarial_reviewer",producerBinding:"terra"}).binding_id,"sol");
assert.equal(selectDevelopmentBinding({role:"adversarial_reviewer",producerBinding:"sol"}).binding_id,"sol");
const controlReview=selectDevelopmentBinding({profileId:"control",role:"adversarial_reviewer",producerBinding:"sol"});
assert.equal(controlReview.binding_id,"sol");
assert.equal(controlReview.total_cost_reduction_proven,false);
for(const role of ["explorer","analysis","designer","translation"]){
  assert.equal(selectDevelopmentBinding({profileId:"control",role}).binding_id,"sol");
}
const driftedRolePolicy=structuredClone(catalog);
driftedRolePolicy.balanced_role_policy.secretary.binding="sol";
assert.throws(()=>selectDevelopmentBindingFromCatalog(driftedRolePolicy,{role:"orchestrator"}),/balanced role policy invalid/);
const driftedAssignments=structuredClone(catalog);
driftedAssignments.profiles.find(profile=>profile.id==="balanced").assignments.orchestrator="sol";
assert.throws(()=>selectDevelopmentBindingFromCatalog(driftedAssignments,{role:"orchestrator"}),/assignments drift/);
const changedGuards=structuredClone(catalog);
changedGuards.guards.bounded_worker.maximum_risk="low";
changedGuards.guards.bounded_worker.fallback_binding="terra";
assert.throws(()=>selectDevelopmentBindingFromCatalog(changedGuards,{role:"bounded_worker",boundedScope:true,...exactValidatorEvidence,risk:"medium",availableBindings:["sol","terra","luna"]}),/fail closed without a model fallback/);
changedGuards.guards.bounded_worker.fallback_binding=null;
changedGuards.guards.review.prefer_different_binding_from_producer=false;
assert.throws(()=>selectDevelopmentBindingFromCatalog(changedGuards,{role:"adversarial_reviewer",producerBinding:"terra"}),/independent review guard invalid/);
const callerIdentityGuard=structuredClone(catalog);
callerIdentityGuard.guards.sol_specialist.fresh_session_required=false;
assert.throws(()=>selectDevelopmentBindingFromCatalog(callerIdentityGuard,{role:"analysis"}),/independent Sol specialist guard invalid/);
assert.throws(()=>resolveDevelopmentProfile("future-model-name"),/unknown development composition profile/);
assert.throws(()=>selectDevelopmentBinding({role:"bounded_worker",boundedScope:true,...exactValidatorEvidence,risk:"medium",availableBindings:[]}),/Balanced requires luna for bounded_worker/);
assert.throws(()=>selectDevelopmentBinding({role:"bounded_worker",boundedScope:false,risk:"low",availableBindings:["terra"]}),/requires bounded scope/);
assert.throws(()=>selectDevelopmentBinding({role:"bounded_worker",boundedScope:true,risk:"high",availableBindings:["terra"]}),/requires bounded scope/);
const previousAvailability=process.env.CODEX_AVAILABLE_BINDINGS;
process.env.CODEX_AVAILABLE_BINDINGS="";
assert.throws(()=>selectDevelopmentBinding({role:"bounded_worker",boundedScope:true,...exactValidatorEvidence,risk:"medium"}),/Balanced requires luna for bounded_worker/);
if(previousAvailability===undefined)delete process.env.CODEX_AVAILABLE_BINDINGS;else process.env.CODEX_AVAILABLE_BINDINGS=previousAvailability;
const selectorPath=path.join(packageRoot,"src","development-profiles.mjs");
const selectorArgs=[selectorPath,"select","--role","bounded_worker","--risk","medium","--bounded-scope","--validator-command",validatorCommand,"--allowed-shell-command",validatorCommand];
const emptyEnvironment=cp.spawnSync(process.execPath,selectorArgs,{encoding:"utf8",env:{...process.env,CODEX_AVAILABLE_BINDINGS:"[]"}});
assert.equal(emptyEnvironment.status,1);
assert.match(emptyEnvironment.stderr,/Balanced requires luna for bounded_worker/);
const emptyFlag=cp.spawnSync(process.execPath,[...selectorArgs,"--available-bindings"],{encoding:"utf8",env:process.env});
assert.equal(emptyFlag.status,1);
assert.match(emptyFlag.stderr,/Balanced requires luna for bounded_worker/);
console.log("development profiles: PASS (4 role profiles, Balanced fail-closed routing, optional delegated worker, explicit profile rollback)");
