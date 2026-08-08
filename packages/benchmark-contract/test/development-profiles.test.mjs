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
const roleIdentities={
  production:{session_id:"production-session",execution_id:"production-execution"},
  analysis:{session_id:"analysis-session",execution_id:"analysis-execution"},
  design:{session_id:"design-session",execution_id:"design-execution"},
  review:{session_id:"review-session",execution_id:"review-execution"},
};
assert.deepEqual(
  ["analysis","designer","adversarial_reviewer"].map(role=>selectDevelopmentBinding({role,roleIdentities,...(role==="adversarial_reviewer"?{producerBinding:"luna"}:{})})).map(selection=>[selection.binding_id,selection.reasoning_effort]),
  [["sol","medium"],["sol","medium"],["sol","medium"]],
);
assert.deepEqual(
  ["bounded_worker","tester","mechanical_worker","translation"].map(role=>selectDevelopmentBinding({role,boundedScope:true,exactValidator:true,risk:"low"})).map(selection=>[selection.binding_id,selection.reasoning_effort]),
  [["luna","medium"],["luna","medium"],["luna","medium"],["luna","low"]],
);
assert.throws(()=>selectDevelopmentBinding({role:"bounded_worker",boundedScope:true,exactValidator:true,risk:"medium",availableBindings:["sol","terra"]}),/Balanced requires luna for bounded_worker/);
assert.equal(selectDevelopmentBinding({role:"bounded_worker",boundedScope:true,exactValidator:true,risk:"medium",availableBindings:["sol","terra","luna"]}).binding_id,"luna");
assert.equal(selectDevelopmentBinding({role:"bounded_worker",boundedScope:true,exactValidator:false,risk:"medium"}).binding_id,"sol");
const unboundedWorker=selectDevelopmentBinding({role:"bounded_worker",boundedScope:false,risk:"low"});
assert.equal(unboundedWorker.binding_id,"sol");
assert.equal(unboundedWorker.fallback_reason,"bounded engineering guard");
assert.equal(unboundedWorker.total_cost_reduction_proven,false);
assert.equal(selectDevelopmentBinding({role:"bounded_worker",boundedScope:true,risk:"high"}).binding_id,"sol");
assert.equal(selectDevelopmentBinding({role:"tester",boundedScope:true,risk:"medium"}).binding_id,"luna");
assert.equal(selectDevelopmentBinding({role:"tester",boundedScope:false,risk:"low"}).binding_id,"sol");
assert.equal(selectDevelopmentBinding({profileId:"economy",role:"mechanical_worker",boundedScope:true,exactValidator:true,risk:"low"}).binding_id,"luna");
assert.equal(selectDevelopmentBinding({profileId:"economy",role:"mechanical_worker",boundedScope:true,exactValidator:true,risk:"low",availableBindings:["sol","terra","luna"]}).binding_id,"luna");
assert.equal(selectDevelopmentBinding({profileId:"economy",role:"mechanical_worker",boundedScope:true,exactValidator:false,risk:"low"}).binding_id,"sol");
assert.equal(selectDevelopmentBinding({profileId:"economy",role:"mechanical_worker",boundedScope:true,exactValidator:true,risk:"medium"}).binding_id,"sol");
assert.equal(selectDevelopmentBinding({profileId:"economy",role:"mechanical_worker",boundedScope:false,exactValidator:false,risk:"high"}).binding_id,"sol");
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
assert.equal(selectDevelopmentBinding({role:"adversarial_reviewer",producerBinding:"terra",roleIdentities}).binding_id,"sol");
assert.equal(selectDevelopmentBinding({role:"adversarial_reviewer",producerBinding:"sol",roleIdentities}).binding_id,"sol");
const controlReview=selectDevelopmentBinding({profileId:"control",role:"adversarial_reviewer",producerBinding:"sol",roleIdentities});
assert.equal(controlReview.binding_id,"sol");
assert.equal(controlReview.total_cost_reduction_proven,false);
for(const role of ["analysis","designer","translation"]){
  assert.equal(selectDevelopmentBinding({profileId:"control",role,...(role==="translation"?{}:{roleIdentities})}).binding_id,"sol");
}
assert.throws(()=>selectDevelopmentBinding({role:"adversarial_reviewer",producerBinding:"terra"}),/complete role-bound/);
const duplicateSessionIdentities=structuredClone(roleIdentities);
duplicateSessionIdentities.review.session_id=duplicateSessionIdentities.analysis.session_id;
assert.throws(()=>selectDevelopmentBinding({role:"adversarial_reviewer",producerBinding:"terra",roleIdentities:duplicateSessionIdentities}),/pairwise-distinct/);
const duplicateExecutionIdentities=structuredClone(roleIdentities);
duplicateExecutionIdentities.design.execution_id=duplicateExecutionIdentities.review.execution_id;
assert.throws(()=>selectDevelopmentBinding({role:"designer",roleIdentities:duplicateExecutionIdentities}),/pairwise-distinct/);
for(const role of ["analysis","designer"]){
  assert.throws(()=>selectDevelopmentBinding({role}),/complete role-bound/);
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
assert.throws(()=>selectDevelopmentBindingFromCatalog(changedGuards,{role:"bounded_worker",boundedScope:true,exactValidator:true,risk:"medium",availableBindings:["sol","terra","luna"]}),/fallback must remain Sol/);
changedGuards.guards.bounded_worker.fallback_binding="sol";
changedGuards.guards.review.prefer_different_binding_from_producer=false;
assert.equal(selectDevelopmentBindingFromCatalog(changedGuards,{role:"adversarial_reviewer",producerBinding:"terra",roleIdentities}).binding_id,"sol");
assert.throws(()=>resolveDevelopmentProfile("future-model-name"),/unknown development composition profile/);
assert.throws(()=>selectDevelopmentBinding({role:"bounded_worker",boundedScope:true,exactValidator:true,risk:"medium",availableBindings:[]}),/Balanced requires luna for bounded_worker/);
assert.throws(()=>selectDevelopmentBinding({role:"bounded_worker",boundedScope:false,risk:"low",availableBindings:["terra"]}),/Balanced requires sol for bounded_worker/);
assert.throws(()=>selectDevelopmentBinding({role:"bounded_worker",boundedScope:true,risk:"high",availableBindings:["terra"]}),/Balanced requires sol for bounded_worker/);
const previousAvailability=process.env.CODEX_AVAILABLE_BINDINGS;
process.env.CODEX_AVAILABLE_BINDINGS="";
assert.throws(()=>selectDevelopmentBinding({role:"bounded_worker",boundedScope:true,exactValidator:true,risk:"medium"}),/Balanced requires luna for bounded_worker/);
if(previousAvailability===undefined)delete process.env.CODEX_AVAILABLE_BINDINGS;else process.env.CODEX_AVAILABLE_BINDINGS=previousAvailability;
const selectorPath=path.join(packageRoot,"src","development-profiles.mjs");
const selectorArgs=[selectorPath,"select","--role","bounded_worker","--risk","medium","--bounded-scope","--exact-validator"];
const emptyEnvironment=cp.spawnSync(process.execPath,selectorArgs,{encoding:"utf8",env:{...process.env,CODEX_AVAILABLE_BINDINGS:"[]"}});
assert.equal(emptyEnvironment.status,1);
assert.match(emptyEnvironment.stderr,/Balanced requires luna for bounded_worker/);
const emptyFlag=cp.spawnSync(process.execPath,[...selectorArgs,"--available-bindings"],{encoding:"utf8",env:process.env});
assert.equal(emptyFlag.status,1);
assert.match(emptyFlag.stderr,/Balanced requires luna for bounded_worker/);
console.log("development profiles: PASS (4 role profiles, single-solution default, optional delegated worker, guarded fallback)");
