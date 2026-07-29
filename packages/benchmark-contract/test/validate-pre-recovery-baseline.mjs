import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { digestCanonical } from "../src/validate-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
const sha256File = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sameSet = (left, right) => left.length === right.length && left.every((item) => right.includes(item));
const insideRoot = (relative) => {
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
};

const FROZEN_CONTRACT_DIGEST = "e9c49d676a606440029a58e9b8a83ca9eadb8cd1c386c57383f5d358910174b1";
const FROZEN_CATALOG_DIGEST = "a8fb080f128cc3331af7c671e5cf4a568180748832e90e436f3083bfda668e35";
const FROZEN_CONTROLS_DIGEST = "29b0a1cd15e18603c1925c774d2f95c9ede0c0eeeeecaab79d3c1d0fe8f78729";
const FROZEN_ROUTING_DIGEST = "b1325caacd02d2699b258a35feb1f6a0ddb52667845518bc660e0bf0d58c70be";
const FROZEN_MANIFEST_DIGEST = "aabc44ba5ff0d0a98891c619f0ab1f52d51e7ee73c2d18dfde35bb9dcb5aff54";
const FROZEN_TASK_IDS = ["TASK-PRE-C-01","TASK-PRE-C-03","TASK-PRE-C-06","TASK-PRE-C-08","TASK-PRE-HONEST-FAILURE","TASK-PRE-NESTED-CONTEXT","TASK-PRE-COMPACTION-RESTORE","TASK-PRE-STALE-MIRROR","TASK-PRE-NATIVE-WINDOWS","TASK-PRE-TRACE-COMPLETE","TASK-PRE-TRACE-ORPHAN","TASK-PRE-REUSE-DECISION"];
const FROZEN_FIXTURE_DIGESTS = {
  "FIXTURE-PRE-C-01":"8233d8f7489475e1ce222c6083b5ce3ee5ed5d92bea8f7ee70b51eec0fdba759",
  "FIXTURE-PRE-C-03":"5c3ad0855f38c1481934b4191e49a2b760a7173b5669e47e61480f4f4d543dd8",
  "FIXTURE-PRE-C-06":"37b3536ae12f8f228e4db44e3de3297c2fb33a695fa1647e3781a3da1d284277",
  "FIXTURE-PRE-C-08":"62135e1a6ec941aa54c1e6ab34bbd15e6af7e5fc7eb3b1810d7924fbf82f495d",
  "FIXTURE-PRE-COMPACTION-RESTORE":"76bf4e196e7b24266859865a86774b2f902e64829597be804551e8bffeb7426a",
  "FIXTURE-PRE-HONEST-FAILURE":"3e8614d713d2e9cc9cfc98b75a6dbc80a226dcfde7d9f346a9ccf47cb3b72e04",
  "FIXTURE-PRE-NATIVE-WINDOWS":"afec5c496fd82c26af096b671a022a6f4d51a2d7f7b2dd63b654c1e03c04e7aa",
  "FIXTURE-PRE-NESTED-CONTEXT":"5a73699369f29ddca657ef36f6ee9dcb2dd3584b645410b5fb8c00d29d9fc323",
  "FIXTURE-PRE-REUSE-DECISION":"ecc667267d93ba393623b860adf7d0ad263ff0fedd668347b9c946a534e2d7d1",
  "FIXTURE-PRE-STALE-MIRROR":"2b39307b00bde5896b7359a8001ad09e70b1277a31a1f6311c645048fd9a9605",
  "FIXTURE-PRE-TRACE-COMPLETE":"f6fdfd77faa8aa63a85623f71f63ca74c2c6249e155de79cdd73c9a4070997d2",
  "FIXTURE-PRE-TRACE-ORPHAN":"3d76cbec0d4142a6f55585487523720eb261ed0158adfe38ba6b815824e5b3aa"
};
const FROZEN_SCORER_DIGESTS = {
  "legacy-js-function-v1":"71f241e04938a65fa8dfb9ba38e5557e4ee8adaa3e5badbe21314c51149ef5aa",
  "honest-failure-v1":"2d61e507502370c330b281f8d5f3e2ee3926be25f6f2d0593d0bd1223b0c7037",
  "nested-context-v1":"6ab3921080cf33a75ed9d26ec9602c58638a9ae7a26a68724b2a0dcddefce647",
  "context-restore-v1":"e7aa1419bdec68bd484d04c89b515e81dd66a67b20d8d6fcfa27841f74ff24da",
  "dual-context-stale-v1":"3425b3025bc51493ea061862e6e9aa6f2fe4f7b7ee88a991e8df9d837c07ec26",
  "native-platform-v1":"618fc85c513ea22d82adea782ca0cb1a3036953e298ac3f6e084c93f5a3ff337",
  "trace-validator-v1":"35a23d8b41bdc42551484b89a219357dc4dfbcb07eaa425484bd2dd333f8499c",
  "reuse-reservation-v1":"ada512bc7b1899dfad4a53fb32185fa15509d055b6919c63131360cd1eceb3f5"
};
const FROZEN_HARD_GATES = ["HG-PRIVACY-001","HG-CONTEXT-001","HG-CONTEXT-002","HG-TRACE-001","HG-TEST-001","HG-REUSE-001","HG-REVIEW-001","HG-REVIEW-002","HG-HONESTY-001","HG-MIRROR-001","HG-WINDOWS-001","HG-RECOVERY-001"];
const FROZEN_UNOBSERVED_GATES = ["HG-PRIVACY-001","HG-TEST-001","HG-REVIEW-001","HG-REVIEW-002","HG-RECOVERY-001"];
const FROZEN_ALLOWED_CLAIMS = ["measurement_pipeline_validity","mapped_gate_observations","per_task_consumption_completeness"];
const FROZEN_FORBIDDEN_CLAIMS = ["global_model_superiority","proven_cost_optimization","complete_product_quality","global_green_for_unobserved_gate","sota_status"];

const ajv = new Ajv2020({ allErrors:true, strict:true, strictRequired:false });
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
const schemas = ["baseline-fixture.schema.json","task.schema.json","routing-policy.schema.json","baseline-manifest.schema.json"].map((name) => readJson(`schemas/${name}`));
for (const schema of schemas) ajv.addSchema(schema);
const validators = Object.fromEntries(schemas.map((schema) => [schema.title, ajv.getSchema(schema.$id)]));

const fixtureDir = path.join(root, "fixtures", "pre-recovery");
const fixtures = fs.readdirSync(fixtureDir).filter((name) => name.endsWith(".json")).sort().map((name) => ({name,file:path.join(fixtureDir,name),value:JSON.parse(fs.readFileSync(path.join(fixtureDir,name),"utf8"))}));
const catalog = readJson("baselines/pre-recovery.tasks.json");
const controls = readJson("baselines/pre-recovery.controls.json");
const routing = readJson("baselines/pre-recovery.routing-policy.json");
const routeConfigurations = readJson("baselines/pre-recovery.route-configurations.json");
const manifest = readJson("baselines/pre-recovery.manifest.json");
for (const fixture of fixtures) assert(validators["Pre-Recovery Baseline Fixture"](fixture.value), `${fixture.name}: ${ajv.errorsText(validators["Pre-Recovery Baseline Fixture"].errors)}`);
for (const task of catalog.tasks) assert(validators["Benchmark Task"](task), `${task.id}: ${ajv.errorsText(validators["Benchmark Task"].errors)}`);
assert(validators["Frozen Routing Policy"](routing), ajv.errorsText(validators["Frozen Routing Policy"].errors));
assert(validators["Frozen Baseline Manifest"](manifest), ajv.errorsText(validators["Frozen Baseline Manifest"].errors));

function frozenErrors(snapshot) {
  const { fixtures:fixtureItems, catalog:taskCatalog, controls:fixedControls, routing:routingPolicy, routeConfigurations:fixedRouteConfigurations, manifest:baseline } = snapshot;
  const errors = [];
  const fixtureById = new Map(fixtureItems.map((item) => [item.value.id,item]));
  const taskById = new Map(taskCatalog.tasks.map((task) => [task.id,task]));
  const routeById = new Map(routingPolicy.routes.map((route) => [route.id,route]));
  if (taskCatalog.contract_digest !== FROZEN_CONTRACT_DIGEST || baseline.contract_digest !== FROZEN_CONTRACT_DIGEST) errors.push("contract anchor");
  if (digestCanonical(taskCatalog) !== FROZEN_CATALOG_DIGEST) errors.push("catalog anchor");
  if (digestCanonical(fixedControls) !== FROZEN_CONTROLS_DIGEST) errors.push("controls anchor");
  if (!sameSet(taskCatalog.tasks.map((task) => task.id), FROZEN_TASK_IDS) || taskCatalog.tasks.length !== FROZEN_TASK_IDS.length || taskById.size !== taskCatalog.tasks.length) errors.push("task identity set");
  if (fixtureItems.length !== Object.keys(FROZEN_FIXTURE_DIGESTS).length || fixtureById.size !== fixtureItems.length) errors.push("fixture identity set");
  for (const [fixtureId,digest] of Object.entries(FROZEN_FIXTURE_DIGESTS)) if (!fixtureById.has(fixtureId) || sha256File(fixtureById.get(fixtureId).file) !== digest) errors.push(`fixture anchor ${fixtureId}`);
  for (const task of taskCatalog.tasks) {
    const fixture = fixtureById.get(task.asset_id);
    const scorerPath = insideRoot(task.scorer.artifact_locator);
    if (!fixture || task.fixture_digest !== FROZEN_FIXTURE_DIGESTS[task.asset_id] || task.scorer.revision !== fixture.value.scorer.revision) errors.push(`task fixture ${task.id}`);
    if (!scorerPath || !fs.existsSync(scorerPath) || task.scorer.digest !== FROZEN_SCORER_DIGESTS[task.scorer.revision] || sha256File(scorerPath) !== task.scorer.digest) errors.push(`scorer anchor ${task.id}`);
    if (task.scheduled_runs !== 1) errors.push(`task denominator ${task.id}`);
  }
  const controlDigests = {model_config_digest:digestCanonical(fixedControls.model_config),prompt_digest:digestCanonical(fixedControls.prompt),context_digest:digestCanonical(fixedControls.context),tool_digest:digestCanonical(fixedControls.tools),platform_digest:digestCanonical(fixedControls.platform),limits_digest:digestCanonical(fixedControls.limits)};
  if (JSON.stringify(baseline.controls) !== JSON.stringify(controlDigests)) errors.push("control map");
  const controlMapDigest = digestCanonical(controlDigests);
  for (const route of routingPolicy.routes) {
    const configuration=fixedRouteConfigurations[route.id];
    if (!configuration || configuration.model !== route.exact_model_id || configuration.provider !== route.provider || route.configuration_digest !== digestCanonical(configuration)) errors.push(`route config ${route.id}`);
  }
  if (routingPolicy.digest !== FROZEN_ROUTING_DIGEST || routingPolicy.digest !== digestCanonical(without(routingPolicy,"digest"))) errors.push("routing anchor");
  if (baseline.routing_policy_digest !== routingPolicy.digest || baseline.reference_route_id !== routingPolicy.reference_route_id || !routeById.has(baseline.reference_route_id) || !routeById.has(baseline.candidate_route_id) || baseline.reference_route_id === baseline.candidate_route_id) errors.push("route resolution");
  if (!routeById.get(baseline.reference_route_id)?.selection_features.includes("reference_arm") || !routeById.get(baseline.candidate_route_id)?.selection_features.includes("candidate_arm")) errors.push("route role");
  if (baseline.tasks.length !== FROZEN_TASK_IDS.length || new Set(baseline.tasks.map((slot) => slot.task_id)).size !== baseline.tasks.length || !sameSet(baseline.tasks.map((slot) => slot.task_id),FROZEN_TASK_IDS)) errors.push("manifest task set");
  for (const slot of baseline.tasks) {
    const task = taskById.get(slot.task_id);
    if (!task || slot.fixture_digest !== task.fixture_digest || slot.scorer_revision !== task.scorer.revision || slot.scorer_digest !== task.scorer.digest || slot.control_digest !== controlMapDigest || slot.repetitions !== baseline.repetitions || !sameSet(slot.hard_gate_observation_ids,task.hard_gate_ids) || slot.reference_route_id !== baseline.reference_route_id || slot.candidate_route_id !== baseline.candidate_route_id) errors.push(`slot binding ${slot.task_id}`);
  }
  if (baseline.repetitions !== 1 || baseline.scheduled_denominator !== baseline.tasks.reduce((sum,slot) => sum + slot.repetitions,0)) errors.push("manifest denominator");
  if (baseline.ordering_digest !== digestCanonical(taskCatalog.tasks.map((task) => task.id))) errors.push("ordering");
  if (JSON.stringify(baseline.platform) !== JSON.stringify({os:fixedControls.platform.os,runtime:fixedControls.platform.runtime,native_command:"node packages/benchmark-contract/test/validate-pre-recovery-baseline.mjs",structural_oracle_digest:digestCanonical(fixedControls.platform),uses_wsl:fixedControls.platform.uses_wsl,uses_bash:fixedControls.platform.uses_bash,requires_symlink:fixedControls.platform.requires_symlink}) || !/^node(?:\.exe)?\b/i.test(baseline.platform.native_command) || /[\\]|\bwsl\b|\bbash\b/i.test(baseline.platform.native_command)) errors.push("native Windows");
  const mappedGates = [...new Set(taskCatalog.tasks.flatMap((task) => task.hard_gate_ids))];
  if (!sameSet(baseline.declared_hard_gate_ids,FROZEN_HARD_GATES) || !sameSet(baseline.unobserved_hard_gate_ids,FROZEN_UNOBSERVED_GATES) || mappedGates.some((gate) => baseline.unobserved_hard_gate_ids.includes(gate)) || !sameSet([...mappedGates,...baseline.unobserved_hard_gate_ids],baseline.declared_hard_gate_ids)) errors.push("gate partition");
  if (!sameSet(baseline.claims_allowed,FROZEN_ALLOWED_CLAIMS) || !sameSet(baseline.claims_forbidden,FROZEN_FORBIDDEN_CLAIMS)) errors.push("claim boundary");
  if (baseline.manifest_digest !== FROZEN_MANIFEST_DIGEST || baseline.manifest_digest !== digestCanonical(without(baseline,"manifest_digest"))) errors.push("manifest anchor");
  return errors;
}

const snapshot = {fixtures,catalog,controls,routing,routeConfigurations,manifest};
assert.deepEqual(frozenErrors(snapshot), []);
const negativeMutations = [
  (copy) => { copy.catalog.contract_digest = "f".repeat(64); copy.manifest.contract_digest = "f".repeat(64); },
  (copy) => { copy.catalog.tasks[0].purpose = "silently changed"; },
  (copy) => { copy.manifest.tasks[1].task_id = copy.manifest.tasks[0].task_id; },
  (copy) => { copy.manifest.tasks[0].repetitions = 2; },
  (copy) => { copy.manifest.candidate_route_id = "ghost-route"; copy.manifest.tasks.forEach((slot) => { slot.candidate_route_id = "ghost-route"; }); },
  (copy) => { copy.manifest.unobserved_hard_gate_ids.push("HG-CONTEXT-001"); },
  (copy) => { copy.manifest.claims_forbidden.pop(); },
  (copy) => { copy.manifest.platform.uses_wsl = true; },
  (copy) => { copy.catalog.tasks[0].scorer.digest = "f".repeat(64); copy.manifest.tasks[0].scorer_digest = "f".repeat(64); },
  (copy) => { copy.routing.routes[0].exact_model_id = "changed-after-freeze"; },
  (copy) => { copy.routeConfigurations["route-luna-economy"].model_reasoning_effort = "high"; },
  (copy) => { copy.controls.prompt.revision = "changed-after-freeze"; },
  (copy) => { copy.manifest.tasks[0].fixture_digest = "f".repeat(64); }
];
for (const mutate of negativeMutations) {
  const copy = structuredClone(snapshot);
  copy.fixtures = fixtures;
  mutate(copy);
  assert(frozenErrors(copy).length > 0, "frozen baseline mutation must fail closed");
}
console.log("pre-recovery baseline: PASS (12 anchored tasks, 8 anchored scorers, native Windows, 13 mutation negatives)");
