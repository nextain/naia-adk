import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPlan, readJournal, runPlan } from "../src/native-runner.mjs";
import { digestCanonical } from "../src/validate-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "naia-baseline-native-"));
const KEY = "0123456789abcdef0123456789abcdef";
const observation = (value, reason="fake adapter evidence") => ({state:value === 0 ? "provider_proven_zero" : "measured",value,evidence_digest:digestCanonical({value,reason}),reason});
const cost = () => ({cached_input_tokens:observation(0),uncached_input_tokens:observation(10),output_tokens:observation(2),reasoning_tokens:observation(0),retries:observation(0),wall_time_ms:observation(20),fallbacks:observation(0),escalations:observation(0),terminal_failure_consumption:observation(0),monetary:observation(0.001),quota_units:observation(12)});
const adapterFor = (plan, overrides={}) => ({invoke:async ({slot,attempt}) => ({model:{exact_id:plan.route.exact_model_id,provider:plan.route.provider,configuration_digest:plan.route.configuration_digest},status:"valid_pass",outcome_class:"task_result",reason:`fake pass ${slot.key}/${attempt}`,evidence_digest:digestCanonical({slot:slot.key,attempt}),cost:cost(),...overrides})});

try {
  const plan = createPlan({routeId:"route-luna-economy"});
  assert.equal(plan.slots.length,12);
  assert.equal(plan.scheduled_denominator,12);
  assert.equal(new Set(plan.slots.map((slot) => slot.key)).size,12);
  assert.throws(() => createPlan({routeId:"ghost-route"}), /undeclared baseline route/);

  const partialJournal = path.join(temp,"partial.jsonl");
  const partial = await runPlan({plan,adapter:adapterFor(plan),journalPath:partialJournal,integrityKey:KEY,stopAfter:5});
  assert.equal(partial.status,"incomplete");
  assert.equal(partial.terminal_count,5);
  assert.equal(partial.remaining,7);
  assert.deepEqual(partial.claims_allowed,[]);
  const resumed = await runPlan({plan,adapter:adapterFor(plan),journalPath:partialJournal,integrityKey:KEY});
  assert.equal(resumed.status,"complete");
  assert.equal(resumed.terminal_count,12);
  assert.equal(new Set(resumed.results.map((result) => `${result.task_id}#${result.run_index}`)).size,12);
  assert.equal(readJournal(partialJournal,plan.plan_digest,plan,KEY).filter((record) => record.type === "terminal_result").length,12);
  assert.equal(fs.existsSync(`${partialJournal}.key`),false,"integrity key must never be stored beside evidence");
  assert.throws(() => readJournal(partialJournal,plan.plan_digest,plan,"fedcba9876543210fedcba9876543210"), /hash chain invalid|integrity authority/);

  const forged=structuredClone(plan); forged.slots=[forged.slots[0]]; forged.scheduled_denominator=1; delete forged.plan_digest; forged.plan_digest=digestCanonical(forged);
  await assert.rejects(() => runPlan({plan:forged,adapter:adapterFor(forged),journalPath:path.join(temp,"forged.jsonl"),integrityKey:KEY}), /not the frozen baseline plan/);

  const mutatingJournal=path.join(temp,"mutating-adapter.jsonl");
  const safeAdapter=adapterFor(plan);
  const mutating=await runPlan({plan,integrityKey:KEY,journalPath:mutatingJournal,adapter:{invoke:async (input)=>{assert.throws(()=>input.plan.slots.splice(1));assert.throws(()=>{input.plan.scheduled_denominator=1;});assert.throws(()=>{input.plan.claims_allowed=["global_model_superiority"];});return safeAdapter.invoke(input);}}});
  assert.equal(mutating.terminal_count,12);
  assert.equal(mutating.claims_allowed.includes("global_model_superiority"),false);
  assert.equal(mutating.claims_forbidden.includes("global_model_superiority"),true);

  const tamperedJournal = path.join(temp,"tampered.jsonl");
  fs.copyFileSync(partialJournal,tamperedJournal);
  const lines = fs.readFileSync(tamperedJournal,"utf8").trimEnd().split("\n");
  const tampered = JSON.parse(lines[2]); tampered.result.reason="rewritten history"; lines[2]=JSON.stringify(tampered);
  fs.writeFileSync(tamperedJournal,`${lines.join("\n")}\n`);
  assert.throws(() => readJournal(tamperedJournal,plan.plan_digest,plan,KEY), /hash chain invalid/);

  const partialLineJournal = path.join(temp,"partial-line.jsonl");
  fs.copyFileSync(partialJournal,partialLineJournal); fs.appendFileSync(partialLineJournal,"{");
  assert.throws(() => readJournal(partialLineJournal,plan.plan_digest,plan,KEY), /partial journal record/);

  const ghostJournal = path.join(temp,"ghost.jsonl");
  fs.copyFileSync(partialJournal,ghostJournal);
  const ghostRecords=readJournal(ghostJournal,plan.plan_digest,plan,KEY);
  const ghost={type:"attempt_started",slot_key:"TASK-GHOST#1",attempt_index:1,route_id:plan.route.id,sequence:ghostRecords.length+1,previous_record_digest:ghostRecords.at(-1).record_digest};
  const canonical=digestCanonical(ghost); ghost.record_digest=createHmac("sha256",Buffer.from(KEY)).update(canonical,"utf8").digest("hex");
  fs.appendFileSync(ghostJournal,`${JSON.stringify(ghost)}\n`);
  await assert.rejects(() => runPlan({plan,adapter:adapterFor(plan),journalPath:ghostJournal,integrityKey:KEY}), /unknown journal slot/);

  const crashJournal = path.join(temp,"crash.jsonl");
  let crashOnce=true;
  await assert.rejects(() => runPlan({plan,adapter:adapterFor(plan),journalPath:crashJournal,integrityKey:KEY,afterInvoke:() => {if(crashOnce){crashOnce=false;const error=new Error("simulated crash");error.code="SIMULATED_CRASH";throw error;}}}), /simulated crash/);
  const crashRecovered = await runPlan({plan,adapter:adapterFor(plan),journalPath:crashJournal,integrityKey:KEY});
  assert.equal(crashRecovered.status,"complete");
  const crashRecords = readJournal(crashJournal,plan.plan_digest,plan,KEY);
  assert.equal(crashRecords.filter((record) => record.type === "attempt_started" && record.slot_key === plan.slots[0].key).length,1);
  assert.equal(crashRecords.filter((record) => record.type === "attempt_observed" && record.slot_key === plan.slots[0].key).length,1);
  assert.equal(crashRecords.filter((record) => record.type === "terminal_result" && record.slot_key === plan.slots[0].key).length,1);

  const ordinaryHookJournal=path.join(temp,"ordinary-hook.jsonl"); let ordinaryOnce=true;
  await assert.rejects(() => runPlan({plan,adapter:adapterFor(plan),journalPath:ordinaryHookJournal,integrityKey:KEY,afterInvoke:()=>{if(ordinaryOnce){ordinaryOnce=false;throw new Error("post-observation interruption");}}}),/post-observation interruption/);
  const ordinaryRecovered=await runPlan({plan,adapter:adapterFor(plan),journalPath:ordinaryHookJournal,integrityKey:KEY});
  assert.equal(ordinaryRecovered.status,"complete");
  assert.equal(readJournal(ordinaryHookJournal,plan.plan_digest,plan,KEY).filter((record)=>record.type==="attempt_started"&&record.slot_key===plan.slots[0].key).length,1);

  const wrongRouteJournal = path.join(temp,"wrong-route.jsonl");
  const wrongRoute = await runPlan({plan,adapter:adapterFor(plan,{model:{exact_id:"other",provider:plan.route.provider,configuration_digest:plan.route.configuration_digest}}),journalPath:wrongRouteJournal,integrityKey:KEY});
  assert.equal(wrongRoute.status,"complete");
  assert.equal(wrongRoute.results.every((result) => result.status === "invalid" && result.outcome_class === "tool_incompatibility"),true);

  const infiniteJournal=path.join(temp,"infinite.jsonl"),infiniteCost=cost(); infiniteCost.monetary={...infiniteCost.monetary,value:Infinity};
  const infinite=await runPlan({plan,adapter:adapterFor(plan,{cost:infiniteCost}),journalPath:infiniteJournal,integrityKey:KEY});
  assert.equal(infinite.results.every((result) => result.status === "invalid" && result.cost.monetary.state === "unavailable"),true);

  const overflowJournal=path.join(temp,"overflow.jsonl"),maxCost=cost(); for(const name of Object.keys(maxCost)) maxCost[name]=observation(Number.MAX_VALUE);
  let overflowCalls=0; const successWithMax=adapterFor(plan,{cost:maxCost});
  const overflow=await runPlan({plan,journalPath:overflowJournal,integrityKey:KEY,adapter:{invoke:async (input)=>{overflowCalls+=1;if(overflowCalls===1){const error=new Error("retry with recorded maximum cost");error.cost=maxCost;throw error;}return successWithMax.invoke(input);}}});
  assert.equal(overflow.status,"incomplete");
  assert.equal(overflow.terminal_count,1);
  assert.match(overflow.abort_reason,/budget exhausted/);

  const measuredZeroJournal=path.join(temp,"measured-zero.jsonl"),measuredZero=cost(); for(const name of Object.keys(measuredZero)) measuredZero[name]={state:"measured",value:0,evidence_digest:"c".repeat(64),reason:"measured zero"};
  const measuredZeroResult=await runPlan({plan,adapter:adapterFor(plan,{cost:measuredZero}),journalPath:measuredZeroJournal,integrityKey:KEY,stopAfter:1});
  assert.equal(measuredZeroResult.results[0].cost.monetary.state,"measured","aggregation must not fabricate provider-zero provenance");

  const budgetJournal=path.join(temp,"budget.jsonl"),budgetCost=cost();budgetCost.monetary=observation(plan.budgets.cost_max);
  const budgetResult=await runPlan({plan,adapter:adapterFor(plan,{cost:budgetCost}),journalPath:budgetJournal,integrityKey:KEY});
  assert.equal(budgetResult.status,"incomplete");assert.equal(budgetResult.terminal_count,1);assert.match(budgetResult.abort_reason,/budget exhausted/);assert.deepEqual(budgetResult.claims_allowed,[]);

  const failureJournal = path.join(temp,"failure.jsonl");
  let failureCalls=0;
  const failure = await runPlan({plan,adapter:{invoke:async () => {failureCalls += 1; const error=new Error("provider unavailable");error.code="provider_unavailable";throw error;}},journalPath:failureJournal,integrityKey:KEY});
  assert.equal(failure.status,"incomplete");
  assert.equal(failure.terminal_count,1);
  assert.match(failure.abort_reason,/accounting unavailable/);
  assert.equal(failure.results.every((result) => result.status === "invalid"),true);
  assert.equal(failure.results.every((result) => result.cost.monetary.state === "unavailable"),true,"unknown failed-attempt consumption must block cost claims");
  assert.equal(failureCalls,1,"unknown consumption must fail closed before retrying or scheduling more work");
  assert.equal(failure.results[0].reason,"adapter failure with unknown consumption");

  const danglingJournal=path.join(temp,"dangling.jsonl"),keyId=createHash("sha256").update(Buffer.from(KEY)).digest("hex");
  const sign=(body,previous,sequence)=>{const record={...body,sequence,previous_record_digest:previous};record.record_digest=createHmac("sha256",Buffer.from(KEY)).update(digestCanonical(record),"utf8").digest("hex");return record;};
  const bound=sign({type:"plan_bound",plan_digest:plan.plan_digest,route_id:plan.route.id,scheduled_denominator:plan.scheduled_denominator,key_id:keyId},"0".repeat(64),1),started=sign({type:"attempt_started",slot_key:plan.slots[0].key,attempt_index:1,route_id:plan.route.id},bound.record_digest,2);fs.writeFileSync(danglingJournal,`${JSON.stringify(bound)}\n${JSON.stringify(started)}\n`);
  let resumedAdapterCalls=0;const danglingResult=await runPlan({plan,journalPath:danglingJournal,integrityKey:KEY,adapter:{invoke:async()=>{resumedAdapterCalls+=1;return adapterFor(plan).invoke({slot:plan.slots[0],attempt:2});}}});
  assert.equal(resumedAdapterCalls,0,"unknown interrupted consumption must never be retried");assert.equal(danglingResult.status,"incomplete");assert.equal(danglingResult.terminal_count,1);assert.match(danglingResult.abort_reason,/accounting unavailable/);assert.equal(danglingResult.results[0].reason,"interrupted attempt with unknown consumption");

  const lockedJournal = path.join(temp,"locked.jsonl");
  fs.writeFileSync(`${lockedJournal}.lock`,JSON.stringify({pid:2147483647,nonce:"stale"})); const old=new Date(Date.now()-60000);fs.utimesSync(`${lockedJournal}.lock`,old,old);
  await assert.rejects(() => runPlan({plan,adapter:adapterFor(plan),journalPath:lockedJournal,integrityKey:KEY}), /journal lock is held/);
  const unlocked = await runPlan({plan,adapter:adapterFor(plan),journalPath:lockedJournal,integrityKey:KEY,recoverStaleLock:true,stopAfter:1});
  assert.equal(unlocked.terminal_count,1);

  const liveLockedJournal=path.join(temp,"live-locked.jsonl");
  fs.writeFileSync(`${liveLockedJournal}.lock`,JSON.stringify({pid:process.pid,nonce:"live"}));
  await assert.rejects(() => runPlan({plan,adapter:adapterFor(plan),journalPath:liveLockedJournal,integrityKey:KEY,recoverStaleLock:true}), /owner is still alive/);

  const cli = spawnSync(process.execPath,[path.join(root,"src","native-runner.mjs"),"plan","--route","route-luna-economy"],{cwd:root,encoding:"utf8",shell:false,env:{...process.env,WSL_INTEROP:"poisoned",BASH_ENV:"poisoned"}});
  assert.equal(cli.status,0,cli.stderr);
  const cliPlan=JSON.parse(cli.stdout);
  assert.equal(cliPlan.native_platform.uses_wsl,false);
  assert.equal(cliPlan.native_platform.uses_bash,false);
  assert.equal(cliPlan.native_platform.requires_symlink,false);
  assert.equal(cliPlan.scheduled_denominator,12);

  const cliAdapter=path.join(temp,"fake-adapter.mjs"),cliJournal=path.join(temp,"cli.jsonl");
  fs.writeFileSync(cliAdapter,`const obs=(v)=>({state:v===0?'provider_proven_zero':'measured',value:v,evidence_digest:'a'.repeat(64),reason:'fake'});export async function invoke({plan,slot}){return {model:{exact_id:plan.route.exact_model_id,provider:plan.route.provider,configuration_digest:plan.route.configuration_digest},status:'valid_pass',outcome_class:'task_result',reason:'fake cli pass '+slot.key,evidence_digest:'b'.repeat(64),cost:{cached_input_tokens:obs(0),uncached_input_tokens:obs(1),output_tokens:obs(1),reasoning_tokens:obs(0),retries:obs(0),wall_time_ms:obs(1),fallbacks:obs(0),escalations:obs(0),terminal_failure_consumption:obs(0),monetary:obs(0),quota_units:obs(2)}}}`);
  const cliRun=spawnSync(process.execPath,[path.join(root,"src","native-runner.mjs"),"run","--route","route-luna-economy","--test-adapter",cliAdapter,"--journal",cliJournal],{cwd:root,encoding:"utf8",shell:false,env:{...process.env,NAIA_BENCHMARK_JOURNAL_KEY:KEY,NAIA_BENCHMARK_ALLOW_TEST_ADAPTER:"1"}});
  assert.equal(cliRun.status,0,cliRun.stderr);
  assert.equal(JSON.parse(cliRun.stdout).terminal_count,12);
  const blockedTestAdapter=spawnSync(process.execPath,[path.join(root,"src","native-runner.mjs"),"run","--route","route-luna-economy","--test-adapter",cliAdapter,"--journal",path.join(temp,"blocked.jsonl")],{cwd:root,encoding:"utf8",shell:false,env:{...process.env,NAIA_BENCHMARK_JOURNAL_KEY:KEY,NAIA_BENCHMARK_ALLOW_TEST_ADAPTER:"0"}});assert.notEqual(blockedTestAdapter.status,0);assert.match(blockedTestAdapter.stderr,/disabled outside an explicit test process/);
  const fakeCodexRoot=path.join(temp,"fake-codex-package"),fakeCodexBin=path.join(fakeCodexRoot,"bin");fs.mkdirSync(fakeCodexBin,{recursive:true});fs.writeFileSync(path.join(fakeCodexBin,"codex.js"),`for(const row of [{type:'item.completed',item:{type:'agent_message',text:'{"outputs":[6,4,0,100]}'}},{type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,output_tokens:2,reasoning_output_tokens:0}}])process.stdout.write(JSON.stringify(row)+'\\n');`);const defaultJournal=path.join(temp,"default-adapter.jsonl"),defaultCliRun=spawnSync(process.execPath,[path.join(root,"src","native-runner.mjs"),"run","--route","route-luna-economy","--journal",defaultJournal],{cwd:root,encoding:"utf8",shell:false,env:{...process.env,CODEX_MANAGED_PACKAGE_ROOT:fakeCodexRoot,NAIA_BENCHMARK_JOURNAL_KEY:KEY}});assert.equal(defaultCliRun.status,0,defaultCliRun.stderr);assert.equal(JSON.parse(defaultCliRun.stdout).terminal_count,12,"default CLI path must load the frozen lazy Codex adapter");

  console.log("native baseline runner: PASS (plan/run/resume, hash chain, route isolation, retry accounting, native Node)");
} finally {
  fs.rmSync(temp,{recursive:true,force:true});
}
