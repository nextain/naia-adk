import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createDevelopmentPlan} from "../src/development-plan.mjs";
import {runDevelopmentPlan} from "../src/development-runner.mjs";
import {digestCanonical} from "../src/validate-bundle.mjs";

const key=Buffer.alloc(32,7),temp=fs.mkdtempSync(path.join(os.tmpdir(),"naia-development-runner-"));
const obs=(value,reason="fake")=>({state:value===0?"provider_proven_zero":"measured",value,evidence_digest:digestCanonical({value,reason}),reason});
const cost=()=>({cached_input_tokens:obs(0),uncached_input_tokens:obs(2),output_tokens:obs(1),reasoning_tokens:obs(0),retries:obs(0),wall_time_ms:obs(1),fallbacks:obs(0),escalations:obs(0),terminal_failure_consumption:obs(0),monetary:obs(0.001),quota_units:obs(3)});
try{const plan=createDevelopmentPlan({routeId:"worker-luna",repetitions:3}),adapter={invoke:async({plan:bound,slot})=>({model:{exact_id:bound.route.exact_model_id,provider:bound.route.provider,configuration_digest:bound.route.configuration_digest},status:"valid_pass",outcome_class:"task_result",reason:"fake development pass",evidence_digest:digestCanonical(slot),cost:cost()})},journal=path.join(temp,"run.jsonl");assert.equal(plan.scheduled_denominator,72);const partial=await runDevelopmentPlan({plan,adapter,journalPath:journal,integrityKey:key,stopAfter:2});assert.equal(partial.terminal_count,2);const complete=await runDevelopmentPlan({plan,adapter,journalPath:journal,integrityKey:key});assert.equal(complete.status,"complete");assert.equal(complete.terminal_count,72);assert.throws(()=>createDevelopmentPlan({routeId:"worker-upstage-solar-open2",env:{},repetitions:3}),/UPSTAGE_KEY/);}finally{fs.rmSync(temp,{recursive:true,force:true});}
console.log("development runner: PASS (72 scheduled attempts, HMAC resume, frozen route, no fallback)");
