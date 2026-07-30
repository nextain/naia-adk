import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {analyzeDevelopmentJournals} from "../src/development-analysis.mjs";
import {createDevelopmentPlan} from "../src/development-plan.mjs";
import {runDevelopmentPlan} from "../src/development-runner.mjs";
import {digestCanonical} from "../src/validate-bundle.mjs";

const observed=(value)=>({state:value===0?"provider_proven_zero":"measured",value,evidence_digest:digestCanonical({value}),reason:"fake measured"});
const unavailable=(reason)=>({state:"unavailable",reason});
const cost=(money,{wall=observed(1)}={})=>({cached_input_tokens:observed(0),uncached_input_tokens:observed(10),output_tokens:observed(2),reasoning_tokens:observed(0),retries:observed(0),wall_time_ms:wall,fallbacks:observed(0),escalations:observed(0),terminal_failure_consumption:observed(0),monetary:observed(money),quota_units:observed(12)});
const adapter=(money,options)=>({invoke:async({plan,slot})=>({model:{exact_id:plan.route.exact_model_id,provider:plan.route.provider,configuration_digest:plan.route.configuration_digest},status:"valid_pass",outcome_class:"task_result",reason:"fake",evidence_digest:digestCanonical(slot),cost:cost(money,options)})});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"naia-development-analysis-")),key="k".repeat(32);
try{const sol=path.join(temp,"sol.jsonl"),terra=path.join(temp,"terra.jsonl");await runDevelopmentPlan({plan:createDevelopmentPlan({routeId:"worker-sol-control",repetitions:1}),adapter:adapter(1),journalPath:sol,integrityKey:key});await runDevelopmentPlan({plan:createDevelopmentPlan({routeId:"worker-terra",repetitions:1}),adapter:adapter(0.5,{wall:unavailable("fake missing wall time")}),journalPath:terra,integrityKey:key});const report=analyzeDevelopmentJournals({journalPaths:[sol,terra],integrityKey:key,resamples:100});const summary=report.route_summaries[0],incompleteTime=report.route_summaries[1];assert.equal(summary.valid_pass,24);assert.equal(summary.model_attempt_turns,24);assert.equal(summary.runner_retry_turns,0);assert.equal(summary.provider_retry_turns,0);assert.equal(summary.fallback_count,0);assert.equal(summary.escalation_count,0);assert.equal(summary.aggregate_worker_wall_time_ms,24);assert.equal(summary.mean_worker_wall_time_ms,1);assert.equal(incompleteTime.aggregate_worker_wall_time_ms,null);assert.equal(incompleteTime.mean_worker_wall_time_ms,null);assert.equal(report.comparisons[0].quality.development_signal,true);assert.equal(report.comparisons[0].cost.development_signal,true);assert.equal(report.comparisons[0].promotion_allowed,false);assert.throws(()=>analyzeDevelopmentJournals({journalPaths:[sol,terra],integrityKey:"x".repeat(32),resamples:10}),/hash chain invalid|different plan/);}finally{fs.rmSync(temp,{recursive:true,force:true});}
console.log("development analysis: PASS (verified HMAC journals, cost/time/turn counters, task-cluster bootstrap, development-only claims)");
