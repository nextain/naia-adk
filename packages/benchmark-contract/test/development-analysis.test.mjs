import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {analyzeDevelopmentJournals} from "../src/development-analysis.mjs";
import {createDevelopmentPlan} from "../src/development-plan.mjs";
import {runDevelopmentPlan} from "../src/development-runner.mjs";
import {digestCanonical} from "../src/validate-bundle.mjs";

const observed=(value)=>({state:value===0?"provider_proven_zero":"measured",value,evidence_digest:digestCanonical({value}),reason:"fake measured"});
const cost=(money)=>({cached_input_tokens:observed(0),uncached_input_tokens:observed(10),output_tokens:observed(2),reasoning_tokens:observed(0),retries:observed(0),wall_time_ms:observed(1),fallbacks:observed(0),escalations:observed(0),terminal_failure_consumption:observed(0),monetary:observed(money),quota_units:observed(12)});
const adapter=(money)=>({invoke:async({plan,slot})=>({model:{exact_id:plan.route.exact_model_id,provider:plan.route.provider,configuration_digest:plan.route.configuration_digest},status:"valid_pass",outcome_class:"task_result",reason:"fake",evidence_digest:digestCanonical(slot),cost:cost(money)})});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"naia-development-analysis-")),key="k".repeat(32);
try{const sol=path.join(temp,"sol.jsonl"),terra=path.join(temp,"terra.jsonl");await runDevelopmentPlan({plan:createDevelopmentPlan({routeId:"worker-sol-control",repetitions:1}),adapter:adapter(1),journalPath:sol,integrityKey:key});await runDevelopmentPlan({plan:createDevelopmentPlan({routeId:"worker-terra",repetitions:1}),adapter:adapter(0.5),journalPath:terra,integrityKey:key});const report=analyzeDevelopmentJournals({journalPaths:[sol,terra],integrityKey:key,resamples:100});assert.equal(report.route_summaries[0].valid_pass,24);assert.equal(report.comparisons[0].quality.development_signal,true);assert.equal(report.comparisons[0].cost.development_signal,true);assert.equal(report.comparisons[0].promotion_allowed,false);assert.throws(()=>analyzeDevelopmentJournals({journalPaths:[sol,terra],integrityKey:"x".repeat(32),resamples:10}),/hash chain invalid|different plan/);}finally{fs.rmSync(temp,{recursive:true,force:true});}
console.log("development analysis: PASS (verified HMAC journals, task-cluster bootstrap, development-only claims)");
