import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { digestCanonical, validateBundleSemantics } from "../src/validate-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = path.join(root, "schemas");
const schemas = fs.readdirSync(schemaDir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(schemaDir, name), "utf8")));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
for (const schema of schemas.filter((item) => !item.$id.endsWith("benchmark-bundle.schema.json"))) ajv.addSchema(schema);
const validateSchema = ajv.compile(schemas.find((item) => item.$id.endsWith("benchmark-bundle.schema.json")));
const digest = (char) => char.repeat(64);
const contractDigest = "e9c49d676a606440029a58e9b8a83ca9eadb8cd1c386c57383f5d358910174b1";
const obs = (value, state = "measured") => ({ state, value, evidence_digest: digest("a"), reason: "captured" });
const cost = (input, output, monetary) => ({ cached_input_tokens:obs(0,"provider_proven_zero"), uncached_input_tokens:obs(input), output_tokens:obs(output), reasoning_tokens:obs(0,"provider_proven_zero"), retries:obs(0,"provider_proven_zero"), wall_time_ms:obs(100), fallbacks:obs(0,"provider_proven_zero"), escalations:obs(0,"provider_proven_zero"), terminal_failure_consumption:obs(0,"provider_proven_zero"), monetary:obs(monetary), quota_units:obs(input+output) });
const controls = { prompt_digest:digest("1"), context_digest:digest("2"), tool_set_digest:digest("3"), tool_schema_digest:digest("4"), platform_digest:digest("5"), scheduler_digest:digest("6"), scorer_set_digest:digest("7"), ordering_digest:digest("8") };
const kinds = ["directive","requirement","use_case","use_case_test","feature","feature_test","implementation","evidence"];
const edgeKinds = ["directives_to_requirements","requirements_to_use_cases","use_cases_to_use_case_tests","use_case_tests_to_features","features_to_feature_tests","feature_tests_to_implementations","implementations_to_evidence"];
const nodes = kinds.map((kind,index)=>({id:`NODE-${index+1}`,kind,semantic_scope:`benchmark/${kind}`,revision:1,content_digest:digest(String((index%9)+1)),status:"active",locator:`trace/${kind}.json`,incoming_edge_ids:index?[`EDGE-${index}`]:[],outgoing_edge_ids:index<7?[`EDGE-${index+1}`]:[]}));
const edges = edgeKinds.map((kind,index)=>({id:`EDGE-${index+1}`,kind,from:`NODE-${index+1}`,from_revision:1,from_digest:nodes[index].content_digest,to:`NODE-${index+2}`,to_revision:1,to_digest:nodes[index+1].content_digest,status:"active",evidence_locator:"evidence/trace.json",evidence_digest:digest("9")}));
const producer = {agent_principal:"producer",model_id:"gpt-5.6-sol",provider:"OpenAI",execution_id:"producer-exec",permission_scope:"workspace-write",prompt_digest:digest("b"),input_contract_digest:contractDigest,produced_snapshot_digest:contractDigest};
const reviewer = (sequence, model, execution) => ({agent_principal:`reviewer-${sequence}`,model_id:model,provider:"OpenAI",execution_id:execution,permission_scope:"read-only",reviewed_snapshot_digest:contractDigest,producer_context_isolated:true,identity_verified:true});
const attempt = (sequence, model, execution, receipt) => ({sequence,schema_revision:"v1",contract_digest:contractDigest,prompt_digest:digest("b"),reviewer:reviewer(sequence,model,execution),started_at:`2026-07-29T13:3${sequence}:00Z`,completed_at:`2026-07-29T13:3${sequence}:30Z`,status:"CLEAN",verdict:"CLEAN",blocking_count:0,material_count:0,non_material_count:0,findings_digest:digest("d"),receipt_digest:receipt});
const task = {id:"TASK-SMOKE-001",contract_version:"0.1.0",layer:"A_model_capability",suite:"harness-smoke",task_class:"governance",risk_class:"high",execution_kind:"deterministic",purpose:"Validate accounting",asset_id:"ASSET-SMOKE-001",fixture_digest:digest("c"),source_revision:"fixture-v1",platform_scope:["windows"],tool_schema_revision:"tools-v1",scorer:{kind:"deterministic_structural",revision:"scorer-v1",artifact_locator:"scorers/smoke-v1.json",digest:digest("2")},required_metrics:[{id:"METRIC-PASS",calculation_kind:"task_pass_rate",formula_revision:"v1",unit:"ratio",numerator_definition:"valid passes",denominator_definition:"scheduled tasks",required_for_acceptance:true}],hard_gate_ids:["HG-WINDOWS-001"],scheduled_runs:1,max_steps:8,time_limit_ms:10000,data_classification:"public",holdout_class:"development"};
const price = {digest:digest("4"),captured_at:"2026-07-29T00:00:00Z",effective_at:"2026-07-29T00:00:00Z",currency:"USD",plan:"subscription-v1",normalization_method:"none"};
const result = (money) => ({task_id:task.id,run_index:1,status:"valid_pass",outcome_class:"task_result",reason:"passed deterministic scorer",evidence_digest:digest("5"),cost:cost(10,2,money)});
const run = (id, routeId, modelId, configuration, money) => ({id,contract_digest:contractDigest,task_set_digest:digest("d"),product_revision:"commit-a",dirty_state_digest:digest("e"),adapter_revision:"provider-adapter-v1",agent_runtime_revision:"agent-v1",governance_harness_revision:"adk-v1",tool_adapter_revision:"tool-adapter-v1",route_id:routeId,model:{exact_id:modelId,provider:"OpenAI",configuration_digest:configuration},controls:structuredClone(controls),price_snapshot:structuredClone(price),cost_scope:"benchmark_execution",scheduled_task_ids:[task.id],task_results:[result(money)],metrics:[{id:"METRIC-PASS",suite_id:"harness-smoke",calculation_kind:"task_pass_rate",formula_revision:"v1",unit:"ratio",numerator_definition:"valid passes",denominator_definition:"scheduled tasks",numerator:1,denominator:1,required_for_acceptance:true,state:"measured",reason:"measured from scheduled tasks",input_digest:digest("9"),evidence_digest:digest("6")}],hard_gate_observations:[{id:"HG-WINDOWS-001",task_ids:[task.id],owning_layers:["A_model_capability"],status:"GREEN",evidence_digest:digest("7"),reason:"native Node"}],evidence_snapshot_digest:digest("8"),started_at:"2026-07-29T13:00:00Z",completed_at:"2026-07-29T13:00:01Z"});

const valid = {
  version:1,
  tasks:[task],
  runs:[run("RUN-REFERENCE-001","route-sol","gpt-5.6-sol",digest("f"),0.02),run("RUN-CANDIDATE-001","route-luna","gpt-5.6-luna",digest("a"),0.01)],
  routing_policy:{id:"ROUTING-1",revision:"v1",digest:digest("1"),frozen_at:"2026-07-29T00:00:00Z",task_classes:["governance"],routes:[{id:"route-sol",task_class:"governance",risk_class:"high",selection_features:["risk"],exact_model_id:"gpt-5.6-sol",provider:"OpenAI",configuration_digest:digest("f"),order:1},{id:"route-luna",task_class:"governance",risk_class:"low",selection_features:["risk"],exact_model_id:"gpt-5.6-luna",provider:"OpenAI",configuration_digest:digest("a"),order:2}],fallback_triggers:["tool failure"],escalation_triggers:["high risk"],abort_triggers:["budget exhausted"],budgets:{retry_max:1,quota_max:1000,latency_ms_max:10000,cost_max:1},reference_route_id:"route-sol",paired_comparison_unit:"task",statistical_plan:{id:"STAT-1",paired_task_min:1,deterministic_repetitions:1,stochastic_repetitions:5,confidence_level:0.95,alpha:0.05,quality_noninferiority_margin:0.05,minimum_cost_improvement:0.1,max_ci_width:0.5,multiple_comparison_family:"single",multiple_comparison_method:"none",bootstrap_resamples:10000}},
  comparisons:[{id:"COMPARE-A-001",layer:"A_model_capability",comparison_scope:"model_only",changed_variable:"model_configuration",reference_run_id:"RUN-REFERENCE-001",candidate_run_id:"RUN-CANDIDATE-001",routing_policy_id:"ROUTING-1",statistical_plan_id:"STAT-1",fixed_control_keys:[...Object.keys(controls),"task_set_digest","price_snapshot_digest"],paired_task_ids:[task.id],paired_observations:[{task_id:task.id,reference_quality:1,candidate_quality:1,reference_cost:0.02,candidate_cost:0.01}],calculation:{revision:"paired-bootstrap-v1",bootstrap_seed:42,input_digest:digest("1"),evidence_input_digest:digest("2")},quality:{metric_id:"METRIC-PASS",delta_definition:"candidate-reference",estimate:0,lower_bound:0,upper_bound:0,ci_width:0,task_clustered:true,method:"paired_bootstrap_10000"},cost:{metric_id:"monetary",delta_definition:"(candidate-reference)/reference",estimate:-0.5,lower_bound:-0.5,upper_bound:-0.5,ci_width:0,task_clustered:true,method:"paired_bootstrap_10000"},owning_gate_ids:["HG-WINDOWS-001"],claim_status:"accepted",claim_scope:"benchmark_execution"}],
  assets:[{id:"ASSET-SMOKE-001",asset_type:"fixture",version:"v1",source_revision:"fixture-v1",source_locator:"fixtures/smoke.json",fixture_digest:digest("c"),scorer_digest:digest("2"),producer_visible_input_digest:digest("3"),producer_visible_classification:"public",sealed_oracle_digest:digest("4"),hidden_scorer_digest:digest("5"),oracle_access_policy_digest:digest("6"),access_log_digest:digest("7"),contamination_check_digest:digest("8"),license:"Apache-2.0",access_classification:"public",task_check_mapping_digest:digest("9"),isolation_verification_digest:digest("a"),decision:"retained",decision_reason:"deterministic fixture",holdout_status:"development",lifecycle_digest:digest("b"),lifecycle_events:[{sequence:1,status:"development",at:"2026-07-29T11:00:00Z",product_revision:"commit-a",evidence_digest:digest("c")}],producer_snapshot_bound_at:"2026-07-29T12:00:00Z",oracle_access_state:"none"}],
  governance:{trace:{schema_digest:digest("7"),snapshot_digest:digest("8"),nodes,edges,validator_revision:"trace-v1",validator_result:"PASS"},reuse_decision:{id:"REUSE-1",receipt_digest:digest("8"),query_digest:digest("9"),semantic_scope_digest:digest("a"),index_revisions:["local@a","upstream@b"],candidates:[],comparison_method:"digest+semantic",comparison_result:"no match",decision:"new",rationale:"no match",actor_principal:"producer",execution_id:"producer-exec",trace_ids:["NODE-6"],implementation_ids:["NODE-7"],query_completed_at:"2026-07-29T11:59:00Z",decided_at:"2026-07-29T12:01:00Z",first_implementation_at:"2026-07-29T12:10:00Z",reservation:{id:"RES-1",scope_digest:digest("a"),trace_revision:1,status:"acquired",acquired_at:"2026-07-29T12:00:00Z",expires_at:"2026-07-30T12:00:00Z",conflict_result:"clear"},reservation_events:[{sequence:1,kind:"acquired",at:"2026-07-29T12:00:00Z",scope_digest:digest("a"),evidence_digest:digest("b")}]},dual_context:{mapping_revision:"v1",mapping_digest:digest("b"),acceptance_plan_revision:"v1",acceptance_plan_digest:digest("c"),source_path:".agents/context/example.yaml",source_digest:digest("d"),source_language:"en",target_language:"ko",context_atom_id:"example",context_atom_revision:"v1",mirror_path:".users/context/example.md",previous_mirror_digest:digest("e"),result_mirror_digest:digest("f"),stale:false,ordered_route_ids:["luna"],retry_limit:1,fallback_limit:1,route_attempts:[{sequence:1,attempt_kind:"primary",route_id:"luna",model_revision:"gpt-5.6-luna",provider:"OpenAI",status:"pass",tokens:20,cost:0.01,latency_ms:200,fallback_trigger:"",error_class:""}],structural_scorer_revision:"struct-v1",structural_result:"PASS",semantic_scorer_revision:"semantic-v1",semantic_result:"PASS",previous_mirror_preserved:true,accepted:true},canonical_structure:{manifest_id:"STRUCT-1",manifest_revision:"v1",manifest_digest:digest("f"),repository_visibility:"public",mirror_mode:"triple",required_paths_digest:digest("1"),entrypoint_equivalence_digest:digest("2"),context_schema_revision:"v1",trace_schema_revision:"v1",allowed_adapter_digest:digest("3"),normalization_rules_digest:digest("4"),platform:"windows",runtime:"node-22",native_command:"node test/validate-benchmark-contract.mjs",structural_oracle_digest:digest("5"),allowed_differences_digest:digest("6"),structural_result:"PASS",uses_wsl:false,uses_bash:false,requires_symlink:false}},
  review_freeze:{contract_digest:contractDigest,prompt_digest:digest("b"),producer,attempt_ledger_digest:digest("3"),attempts:[attempt(2,"gpt-5.6-terra","review-2",digest("1")),attempt(3,"gpt-5.6-luna","review-3",digest("2"))],freeze:{schema_revision:"v1",contract_digest:contractDigest,ordered_clean_receipt_digests:[digest("1"),digest("2")],ledger_digest:digest("3"),final_sequence:3,issue_scope_snapshot_digests:[digest("4")],validator_revision:"validator-v1",validator_result:"PASS",created_at:"2026-07-29T14:00:00Z",freezer_principal:"producer",manifest_digest:digest("5")}},
  baseline:{id:"BASELINE-PRE-RECOVERY",contract_digest:contractDigest,manifest_digest:digest("6"),frozen_at:"2026-07-29T00:00:00Z",tasks:[{task_id:task.id,fixture_digest:digest("c"),scorer_revision:"scorer-v1",scorer_digest:digest("2"),reference_route_id:"route-sol",candidate_route_id:"route-luna",control_digest:digest("7"),repetitions:1,hard_gate_observation_ids:["HG-WINDOWS-001"]}],reference_route_id:"route-sol",candidate_route_id:"route-luna",routing_policy_digest:digest("1"),controls:{model_config_digest:digest("2"),prompt_digest:digest("3"),context_digest:digest("4"),tool_digest:digest("5"),platform_digest:digest("6"),limits_digest:digest("7")},platform:{os:"windows",runtime:"node-22",native_command:"node test/validate-benchmark-contract.mjs",structural_oracle_digest:digest("8"),uses_wsl:false,uses_bash:false,requires_symlink:false},ordering_digest:digest("9"),repetitions:1,scheduled_denominator:1,declared_hard_gate_ids:["HG-WINDOWS-001","HG-UNOBSERVED-001"],unobserved_hard_gate_ids:["HG-UNOBSERVED-001"],claims_allowed:["measurement_pipeline_validity","mapped_gate_observations","per_task_consumption_completeness"],claims_forbidden:["global_model_superiority","proven_cost_optimization","complete_product_quality","global_green_for_unobserved_gate","sota_status"]}
};

const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
valid.routing_policy.digest = digestCanonical(without(valid.routing_policy, "digest"));
valid.comparisons[0].calculation.input_digest = digestCanonical(valid.comparisons[0].paired_observations);
valid.assets[0].lifecycle_digest = digestCanonical(valid.assets[0].lifecycle_events);
for (const item of valid.runs) {
  item.task_set_digest = digestCanonical(item.scheduled_task_ids.map((id) => valid.tasks.find((candidate) => candidate.id === id)));
  item.price_snapshot.digest = digestCanonical(without(item.price_snapshot, "digest"));
  item.metrics.forEach((metric) => { const suiteIds=item.scheduled_task_ids.filter((id)=>valid.tasks.find((candidate)=>candidate.id===id)?.suite===metric.suite_id); metric.input_digest=digestCanonical(item.task_results.filter((entry)=>suiteIds.includes(entry.task_id)).map(({task_id,run_index,status,outcome_class,evidence_digest})=>({task_id,run_index,status,outcome_class,evidence_digest}))); });
  item.evidence_snapshot_digest = digestCanonical({ task_results:item.task_results, metrics:item.metrics, hard_gate_observations:item.hard_gate_observations });
}
valid.comparisons[0].calculation.evidence_input_digest = digestCanonical(valid.runs.map((item) => ({ run_id:item.id, evidence_snapshot_digest:item.evidence_snapshot_digest })));
valid.governance.trace.snapshot_digest = digestCanonical({ schema_digest:valid.governance.trace.schema_digest, nodes:valid.governance.trace.nodes, edges:valid.governance.trace.edges });
valid.governance.reuse_decision.receipt_digest = digestCanonical(without(valid.governance.reuse_decision, "receipt_digest"));
for (const item of valid.review_freeze.attempts) item.receipt_digest = digestCanonical(without(item, "receipt_digest"));
valid.review_freeze.attempt_ledger_digest = digestCanonical({ contract_digest:valid.review_freeze.contract_digest, prompt_digest:valid.review_freeze.prompt_digest, attempts:valid.review_freeze.attempts });
valid.review_freeze.freeze.ledger_digest = valid.review_freeze.attempt_ledger_digest;
valid.review_freeze.freeze.ordered_clean_receipt_digests = valid.review_freeze.attempts.slice(-2).map((item) => item.receipt_digest);
valid.review_freeze.freeze.manifest_digest = digestCanonical(without(valid.review_freeze.freeze, "manifest_digest"));
valid.baseline.routing_policy_digest = valid.routing_policy.digest;
valid.baseline.tasks.forEach((slot) => { slot.control_digest = digestCanonical(valid.baseline.controls); });
valid.baseline.manifest_digest = digestCanonical(without(valid.baseline, "manifest_digest"));

assert(validateSchema(valid), ajv.errorsText(validateSchema.errors, { separator:"\n" }));
assert.deepEqual(validateBundleSemantics(valid), { ok:true, errors:[] });

const composite=structuredClone(valid);
composite.comparisons[0].comparison_scope="model_provider_adapter";
composite.comparisons[0].changed_variable="model_provider_adapter";
composite.comparisons[0].fixed_control_keys=composite.comparisons[0].fixed_control_keys.filter((key)=>key!=="price_snapshot_digest");
composite.runs[1].model.provider="Upstage";
composite.routing_policy.routes[1].provider="Upstage";
composite.routing_policy.digest=digestCanonical(without(composite.routing_policy,"digest"));
composite.baseline.routing_policy_digest=composite.routing_policy.digest;
composite.baseline.manifest_digest=digestCanonical(without(composite.baseline,"manifest_digest"));
composite.runs[1].adapter_revision="provider-neutral-chat-v1";
composite.runs[1].price_snapshot.plan="upstage-private-beta";
composite.runs[1].price_snapshot.digest=digestCanonical(without(composite.runs[1].price_snapshot,"digest"));
assert(validateSchema(composite), ajv.errorsText(validateSchema.errors, { separator:"\n" }));
assert.deepEqual(validateBundleSemantics(composite), { ok:true, errors:[] },"provider+adapter composite comparison must be explicit and valid");
const falseModelClaim=structuredClone(composite);
falseModelClaim.comparisons[0].claim_scope="marginal_model_inference";
assert.equal(validateBundleSemantics(falseModelClaim).ok,false,"composite route evidence cannot claim marginal model causality");

const judgeCalibration = () => ({judge_model_id:"judge-v1",judge_provider:"Independent",judge_execution_id:"judge-exec",producer_identity_blinded:true,pair_order_seed_digest:digest("1"),rubric_digest:digest("2"),tie_policy:"tie",abstain_policy:"abstain",labeled_cases:80,cases_per_expected_class_min:20,human_labelers:2,human_kappa:0.9,judge_kappa:0.8,exact_agreement:0.9,bootstrap_lower_bound:0.8,strata_digest:digest("3"),strata:[{dimension:"expected_class",value:"pass",sample_count:20,agreement:0.9,agreement_floor:0.8,disagreement_count:2,passed:true,failure_reason:""},{dimension:"language",value:"ko",sample_count:20,agreement:0.9,agreement_floor:0.8,disagreement_count:2,passed:true,failure_reason:""},{dimension:"task_difficulty",value:"medium",sample_count:20,agreement:0.9,agreement_floor:0.8,disagreement_count:2,passed:true,failure_reason:""},{dimension:"sensitivity_class",value:"public",sample_count:20,agreement:0.9,agreement_floor:0.8,disagreement_count:2,passed:true,failure_reason:""}],required_strata_pass:true,calibrated_at:"2026-07-29T12:00:00Z"});

const semanticMutations = [
  (x)=>x.runs[0].task_results[0].run_index=2,
  (x)=>x.runs[0].hard_gate_observations.splice(0),
  (x)=>x.comparisons[0].fixed_control_keys.pop(),
  (x)=>x.runs[1].controls.prompt_digest=digest("f"),
  (x)=>x.runs[1].adapter_revision="provider-adapter-v2",
  (x)=>{x.runs[1].model.provider="OtherProvider";x.routing_policy.routes[1].provider="OtherProvider";},
  (x)=>x.runs[1].product_revision="unrelated-product-v2",
  (x)=>x.runs[1].hard_gate_observations[0].owning_layers=["B_agent_runtime"],
  (x)=>{x.runs[0].task_results[0].status="valid_fail";x.runs[0].task_results[0].outcome_class="timeout";},
  (x)=>x.runs[0].metrics.splice(0),
  (x)=>x.runs[0].metrics[0].formula_revision="fabricated-v2",
  (x)=>x.runs[0].metrics[0].numerator=0,
  (x)=>x.governance.trace.nodes.push(structuredClone(x.governance.trace.nodes[0])),
  (x)=>x.governance.trace.edges[0].from_digest=digest("f"),
  (x)=>x.governance.reuse_decision.decided_at="2026-07-29T12:20:00Z",
  (x)=>{x.governance.dual_context.accepted=false;x.governance.dual_context.stale=true;x.governance.dual_context.previous_mirror_preserved=false;},
  (x)=>x.review_freeze.attempts[1].sequence=4,
  (x)=>x.review_freeze.attempts[1].reviewer.agent_principal="producer",
  (x)=>x.assets[0].oracle_first_access_at="2026-07-29T11:00:00Z",
  (x)=>x.comparisons[0].cost.upper_bound=0,
  (x)=>x.runs[0].metrics[0].state="not_applicable",
  (x)=>x.runs[0].task_results[0].cost.uncached_input_tokens.state="not_applicable",
  (x)=>x.comparisons[0].cost.metric_id="local_compute_seconds",
  (x)=>x.comparisons[0].paired_observations[0].candidate_cost=0.001,
  (x)=>{x.governance.dual_context.ordered_route_ids.push("terra");x.governance.dual_context.route_attempts.push({...x.governance.dual_context.route_attempts[0],sequence:2,attempt_kind:"retry",route_id:"terra",status:"fail"});},
  (x)=>{x.governance.dual_context.ordered_route_ids.push("terra");x.governance.dual_context.route_attempts.push({...x.governance.dual_context.route_attempts[0],sequence:2,attempt_kind:"fallback",route_id:"terra",status:"fail",fallback_trigger:"primary failed"});},
  (x)=>x.governance.reuse_decision.reservation_events.push({sequence:2,kind:"released",at:"2026-07-29T12:05:00Z",scope_digest:digest("a"),evidence_digest:digest("c")}),
  (x)=>x.governance.trace.nodes[1].status="superseded",
  (x)=>x.governance.trace.nodes[0].locator="../outside.json",
  (x)=>{const duplicate=structuredClone(x.governance.trace.nodes[1]);duplicate.id="NODE-DUPLICATE";duplicate.incoming_edge_ids=[];duplicate.outgoing_edge_ids=[];x.governance.trace.nodes.push(duplicate);},
  (x)=>x.tasks[0].execution_kind="stochastic",
  (x)=>{x.tasks[0].scorer={kind:"calibrated_model_judge",revision:"judge-v1",artifact_locator:"scorers/judge-v1.json",digest:x.assets[0].scorer_digest,calibration_digest:x.assets[0].scorer_digest};x.assets[0].judge_calibration=judgeCalibration();x.assets[0].judge_calibration.strata[3].passed=false;},
  (x)=>{x.assets[0].holdout_status="consumed";x.assets[0].lifecycle_events.push({sequence:2,status:"consumed",at:"2026-07-29T13:00:00Z",product_revision:"commit-a",evidence_digest:digest("d")});},
  (x)=>{x.tasks[0].hard_gate_ids.push("HG-OMITTED-001");x.runs.forEach((item)=>item.hard_gate_observations.push({id:"HG-OMITTED-001",task_ids:[task.id],owning_layers:["A_model_capability"],status:"RED",evidence_digest:digest("e"),reason:"failed"}));},
  (x)=>x.baseline.tasks[0].hard_gate_observation_ids=["HG-OTHER"],
  (x)=>x.baseline.platform.uses_wsl=true
];

function refreshDigests(bundle) {
  bundle.routing_policy.digest = digestCanonical(without(bundle.routing_policy, "digest"));
  bundle.comparisons.forEach((item) => { item.calculation.input_digest = digestCanonical(item.paired_observations); });
  bundle.assets.forEach((item) => { item.lifecycle_digest = digestCanonical(item.lifecycle_events); if (item.judge_calibration) item.judge_calibration.strata_digest = digestCanonical(item.judge_calibration.strata); });
  for (const item of bundle.runs) {
    item.task_set_digest = digestCanonical(item.scheduled_task_ids.map((id) => bundle.tasks.find((candidate) => candidate.id === id)));
    item.price_snapshot.digest = digestCanonical(without(item.price_snapshot, "digest"));
    item.metrics.forEach((metric) => { const suiteIds=item.scheduled_task_ids.filter((id)=>bundle.tasks.find((candidate)=>candidate.id===id)?.suite===metric.suite_id); metric.input_digest=digestCanonical(item.task_results.filter((entry)=>suiteIds.includes(entry.task_id)).map(({task_id,run_index,status,outcome_class,evidence_digest})=>({task_id,run_index,status,outcome_class,evidence_digest}))); });
    item.evidence_snapshot_digest = digestCanonical({ task_results:item.task_results, metrics:item.metrics, hard_gate_observations:item.hard_gate_observations });
  }
  bundle.comparisons.forEach((item) => {
    const reference = bundle.runs.find((runItem) => runItem.id === item.reference_run_id);
    const candidate = bundle.runs.find((runItem) => runItem.id === item.candidate_run_id);
    item.calculation.evidence_input_digest = digestCanonical([{ run_id:reference.id, evidence_snapshot_digest:reference.evidence_snapshot_digest },{ run_id:candidate.id, evidence_snapshot_digest:candidate.evidence_snapshot_digest }]);
  });
  bundle.governance.trace.snapshot_digest = digestCanonical({ schema_digest:bundle.governance.trace.schema_digest, nodes:bundle.governance.trace.nodes, edges:bundle.governance.trace.edges });
  bundle.governance.reuse_decision.receipt_digest = digestCanonical(without(bundle.governance.reuse_decision, "receipt_digest"));
  for (const item of bundle.review_freeze.attempts) item.receipt_digest = digestCanonical(without(item, "receipt_digest"));
  bundle.review_freeze.attempt_ledger_digest = digestCanonical({ contract_digest:bundle.review_freeze.contract_digest, prompt_digest:bundle.review_freeze.prompt_digest, attempts:bundle.review_freeze.attempts });
  bundle.review_freeze.freeze.ledger_digest = bundle.review_freeze.attempt_ledger_digest;
  bundle.review_freeze.freeze.ordered_clean_receipt_digests = bundle.review_freeze.attempts.slice(-2).map((item) => item.receipt_digest);
  bundle.review_freeze.freeze.manifest_digest = digestCanonical(without(bundle.review_freeze.freeze, "manifest_digest"));
  bundle.baseline.routing_policy_digest = bundle.routing_policy.digest;
  bundle.baseline.tasks.forEach((slot) => { slot.control_digest = digestCanonical(bundle.baseline.controls); });
  bundle.baseline.manifest_digest = digestCanonical(without(bundle.baseline, "manifest_digest"));
}
for (const mutate of semanticMutations) {
  const copy=structuredClone(valid); mutate(copy);
  refreshDigests(copy);
  assert.equal(validateBundleSemantics(copy).ok,false,"semantic validator must reject adversarial fixture");
}

const digestMutations = [
  (x)=>x.review_freeze.freeze.ledger_digest=digest("f"),
  (x)=>x.routing_policy.routes[0].exact_model_id="changed-after-freeze",
  (x)=>x.governance.trace.edges[0].evidence_digest=digest("f"),
  (x)=>x.baseline.controls.prompt_digest=digest("f"),
  (x)=>x.baseline.tasks[0].control_digest=digest("f")
];
for (const mutate of digestMutations) {
  const copy=structuredClone(valid); mutate(copy);
  assert.equal(validateBundleSemantics(copy).ok,false,"digest drift must be rejected");
}

const schemaMutations = [
  (x)=>delete x.runs[0].task_results[0].cost.uncached_input_tokens.evidence_digest,
  (x)=>{x.runs[0].task_results[0].cost.output_tokens.state="provider_proven_zero";x.runs[0].task_results[0].cost.output_tokens.value=1;},
  (x)=>x.review_freeze.attempts[0].reviewer.permission_scope="workspace-write",
  (x)=>delete x.routing_policy.statistical_plan.bootstrap_resamples,
  (x)=>delete x.governance.dual_context.acceptance_plan_digest,
  (x)=>x.governance.trace.nodes[0].locator="C:\\absolute\\path.json",
  (x)=>delete x.comparisons[0].calculation.evidence_input_digest,
  (x)=>x.runs[0].task_results[0].reason="",
  (x)=>{x.runs[0].task_results[0].outcome_class="timeout";x.runs[0].task_results[0].status="valid_fail";},
  (x)=>{x.assets[0].judge_calibration=judgeCalibration();delete x.assets[0].judge_calibration.strata;}
];
for (const mutate of schemaMutations) {
  const copy=structuredClone(valid); mutate(copy);
  assert.equal(validateSchema(copy),false,"JSON Schema must reject malformed fixture");
}
console.log(`benchmark-contract schema+semantics: PASS (${semanticMutations.length} semantic, ${digestMutations.length} digest, ${schemaMutations.length} schema negatives)`);
