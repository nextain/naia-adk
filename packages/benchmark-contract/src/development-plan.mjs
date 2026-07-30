import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {digestCanonical} from "./validate-bundle.mjs";
import {loadDevelopmentCapabilitySuite} from "./development-capability-suite.mjs";
import {resolveDevelopmentRoute} from "./provider-neutral-adapter.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const routePath=path.join(root,"baselines","development-provider-routes.json");
const routeCatalog=JSON.parse(fs.readFileSync(routePath,"utf8"));

export function loadDevelopmentRoute(routeId,{env=process.env}={}) {
  const raw=routeCatalog.routes.find(item=>item.id===routeId);
  if(!raw)throw Object.assign(new Error(`unknown development route ${routeId}`),{code:"development_route_invalid"});
  if(raw.adapter_kind==="codex_cli"){
    const descriptor={id:raw.id,adapter_kind:raw.adapter_kind,provider_id:raw.provider_id,source_model_id:raw.source_model_id,deployment_or_route_model_id:raw.deployment_or_route_model_id,model_reasoning_effort:raw.model_reasoning_effort,unsupported_parameters:[...raw.unsupported_parameters],cache_mode:raw.cache_mode};
    return {...descriptor,configuration_digest:digestCanonical(descriptor),monetary_budget_enforced:true};
  }
  if(raw.adapter_kind!=="openai_compatible_http")throw Object.assign(new Error(`unsupported development adapter kind ${raw.adapter_kind}`),{code:"development_route_invalid"});
  const resolved=resolveDevelopmentRoute(raw,env);
  const descriptor={id:raw.id,adapter_kind:raw.adapter_kind,provider_id:resolved.provider_id,endpoint:resolved.endpoint,api_version:resolved.apiVersion,source_model_id:resolved.source_model_id,deployment_or_route_model_id:resolved.deployment_or_route_model_id,api_key_env:resolved.api_key_env,unsupported_parameters:resolved.unsupported_parameters,cache_mode:resolved.cache_mode,actual_upstream_provider_required:resolved.actual_upstream_provider_required,production_routing_prohibited:raw.production_routing_prohibited===true};
  return {...descriptor,configuration_digest:digestCanonical(descriptor),monetary_budget_enforced:false};
}

export function createDevelopmentPlan({routeId,env=process.env,repetitions=3}={}) {
  if(!Number.isSafeInteger(repetitions)||repetitions<1)throw new Error("development repetitions must be a positive integer");
  const {catalog,public_digest,oracle_digest}=loadDevelopmentCapabilitySuite(),route=loadDevelopmentRoute(routeId,{env});
  const slots=catalog.tasks.flatMap(task=>Array.from({length:repetitions},(_,index)=>({key:`${task.id}#${index+1}`,task_id:task.id,run_index:index+1,fixture_digest:public_digest,scorer_revision:"development-exact-structural-v1",scorer_digest:oracle_digest,hard_gate_ids:[],layer:"A_model_capability",family:task.family})));
  const plan={version:2,suite_revision:catalog.schema_revision,task_set_digest:public_digest,hidden_oracle_digest:oracle_digest,comparison_scope:"model_provider_adapter",profile:catalog.profile,route:{id:route.id,exact_model_id:route.deployment_or_route_model_id,source_model_id:route.source_model_id,provider:route.provider_id,adapter_kind:route.adapter_kind,configuration_digest:route.configuration_digest},budgets:{retry_max:0,quota_max:2000000,cost_max:50,latency_ms_max:120000,enforced_metrics:route.monetary_budget_enforced?["monetary","quota_units"]:["quota_units"]},retry_max:0,slots,scheduled_denominator:slots.length,claims_allowed:["development_pipeline_validity","descriptive_quality_and_usage"],claims_forbidden:["production_routing_approval","global_model_superiority","proven_cost_optimization"],unobserved_hard_gate_ids:[],native_platform:{os:process.platform,runtime:process.version,uses_wsl:false,uses_bash:false,requires_symlink:false},repetitions};
  return {...plan,plan_digest:digestCanonical(plan)};
}

export {routeCatalog,routePath};
