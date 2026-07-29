import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digestCanonical } from "./validate-bundle.mjs";
import { PRICE_SNAPSHOT_DIGEST, loadPriceSnapshot } from "./price-snapshot.mjs";
import { loadRouteConfiguration } from "./route-configurations.mjs";
import { SCORER_WORKER_DIGEST, assertScorerAuthority } from "./scorer-authority.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZERO_DIGEST = "0".repeat(64);
const COST_KEYS = ["cached_input_tokens","uncached_input_tokens","output_tokens","reasoning_tokens","retries","wall_time_ms","fallbacks","escalations","terminal_failure_consumption","monetary","quota_units"];
const DIGEST = /^[a-f0-9]{64}$/;
const readJson = (root, relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const canonicalRecord = (record) => digestCanonical(Object.fromEntries(Object.entries(record).filter(([key]) => key !== "record_digest")));
const recordDigest = (record, key) => createHmac("sha256", key).update(canonicalRecord(record), "utf8").digest("hex");
const unavailableCost = (reason) => Object.fromEntries(COST_KEYS.map((key) => [key,{state:"unavailable",reason}]));
const validObservation = (item) => {
  if (!item || !["measured","provider_proven_zero","not_applicable","unavailable","invalid"].includes(item.state) || typeof item.reason !== "string" || !item.reason) return false;
  if (["measured","provider_proven_zero"].includes(item.state)) return Number.isFinite(item.value) && item.value >= 0 && DIGEST.test(item.evidence_digest || "") && (item.state !== "provider_proven_zero" || item.value === 0);
  return item.value === undefined && item.evidence_digest === undefined;
};
const validCost = (cost) => cost && COST_KEYS.every((key) => validObservation(cost[key]));
const integrityKeyBytes = (key) => {
  const bytes = Buffer.isBuffer(key) ? key : Buffer.from(key || "", "utf8");
  if (bytes.length < 32) throw Object.assign(new Error("journal integrity key must be at least 32 bytes and supplied externally"), {code:"journal_key_invalid"});
  return bytes;
};
const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item); }
  return value;
};
const aggregateCosts = (costs) => Object.fromEntries(COST_KEYS.map((name) => {
  const observations=costs.map((cost) => cost?.[name]).filter(Boolean);
  if (observations.length !== costs.length || observations.some((item) => !validObservation(item) || ["unavailable","invalid"].includes(item.state))) return [name,{state:"unavailable",reason:`${name} unavailable in one or more attempts`}];
  if (observations.some((item) => item.state === "not_applicable")) return [name,{state:"not_applicable",reason:`${name} not applicable in one or more attempts`}];
  const value=observations.reduce((sum,item) => sum + item.value,0);
  if (!Number.isFinite(value)) return [name,{state:"invalid",reason:`${name} aggregate overflowed the finite numeric evidence domain`}];
  const reason=`${name} aggregated across ${observations.length} attempt receipt(s)`;
  const state=value === 0 && observations.every((item) => item.state === "provider_proven_zero") ? "provider_proven_zero" : "measured";
  return [name,{state,value,evidence_digest:digestCanonical(observations),reason}];
}));

export function assertFrozenBaseline(root = packageRoot) {
  const verifier = path.join(root, "test", "validate-pre-recovery-baseline.mjs");
  const result = spawnSync(process.execPath, [verifier], { cwd:root, encoding:"utf8", maxBuffer:16 * 1024 * 1024, shell:false });
  if (result.status !== 0) throw Object.assign(new Error(`frozen baseline validation failed: ${(result.stderr || result.stdout).trim()}`), { code:"baseline_invalid" });
  return result.stdout.trim();
}

export function createPlan({ root = packageRoot, routeId } = {}) {
  assertFrozenBaseline(root);
  loadPriceSnapshot(path.join(root,"baselines","openai-price-snapshot-2026-07-29.json"));
  assertScorerAuthority(path.join(root,"src","deterministic-scorer-worker.mjs"));
  const manifest = readJson(root, "baselines/pre-recovery.manifest.json");
  const catalog = readJson(root, "baselines/pre-recovery.tasks.json");
  const routing = readJson(root, "baselines/pre-recovery.routing-policy.json");
  const route = routing.routes.find((candidate) => candidate.id === routeId);
  if (!route || ![manifest.reference_route_id,manifest.candidate_route_id].includes(route.id)) throw Object.assign(new Error(`undeclared baseline route: ${routeId}`), { code:"route_invalid" });
  loadRouteConfiguration(route,path.join(root,"baselines","pre-recovery.route-configurations.json"));
  const taskById = new Map(catalog.tasks.map((task) => [task.id,task]));
  const slots = manifest.tasks.flatMap((slot) => Array.from({length:slot.repetitions}, (_,index) => {
    const task = taskById.get(slot.task_id);
    return { key:`${slot.task_id}#${index + 1}`, task_id:slot.task_id, run_index:index + 1, fixture_digest:slot.fixture_digest, scorer_revision:slot.scorer_revision, scorer_digest:slot.scorer_digest, hard_gate_ids:[...slot.hard_gate_observation_ids], layer:task.layer };
  }));
  const plan = { version:1, contract_digest:manifest.contract_digest, baseline_manifest_digest:manifest.manifest_digest, routing_policy_digest:routing.digest, price_snapshot_digest:PRICE_SNAPSHOT_DIGEST, scorer_worker_digest:SCORER_WORKER_DIGEST, route:{id:route.id,exact_model_id:route.exact_model_id,provider:route.provider,configuration_digest:route.configuration_digest}, budgets:{...routing.budgets}, retry_max:routing.budgets.retry_max, slots, scheduled_denominator:manifest.scheduled_denominator, claims_allowed:[...manifest.claims_allowed], claims_forbidden:[...manifest.claims_forbidden], unobserved_hard_gate_ids:[...manifest.unobserved_hard_gate_ids], native_platform:{...manifest.platform} };
  return {...plan, plan_digest:digestCanonical(plan)};
}

function appendRecord(journalPath, body, previous, sequence, integrityKey) {
  const record = {...body, sequence, previous_record_digest:previous};
  const key = integrityKeyBytes(integrityKey);
  record.record_digest = recordDigest(record,key);
  const handle = fs.openSync(journalPath, "a");
  try { fs.writeSync(handle, `${JSON.stringify(record)}\n`, null, "utf8"); fs.fsyncSync(handle); }
  finally { fs.closeSync(handle); }
  return record;
}

export function readJournal(journalPath, expectedPlanDigest, plan, integrityKey) {
  if (!fs.existsSync(journalPath)) return [];
  const key = integrityKeyBytes(integrityKey);
  const raw = fs.readFileSync(journalPath, "utf8");
  if (raw && !raw.endsWith("\n")) throw Object.assign(new Error("partial journal record"), { code:"journal_partial" });
  const records = raw.trim() ? raw.trimEnd().split("\n").map((line,index) => {
    try { return JSON.parse(line); } catch { throw Object.assign(new Error(`malformed journal record ${index + 1}`), { code:"journal_malformed" }); }
  }) : [];
  let previous = ZERO_DIGEST;
  const terminals = new Set();
  const attempts = new Map();
  const activeAttempts = new Map(), observedAttempts = new Map(), failedCosts = new Map();
  const slotByKey = new Map((plan?.slots || []).map((slot) => [slot.key,slot]));
  records.forEach((record,index) => {
    if (record.sequence !== index + 1 || record.previous_record_digest !== previous || record.record_digest !== recordDigest(record,key)) throw Object.assign(new Error(`journal hash chain invalid at ${index + 1}`), { code:"journal_tampered" });
    if (!['plan_bound','attempt_started','attempt_failed','attempt_observed','terminal_result'].includes(record.type) || (record.type === 'plan_bound' && index !== 0)) throw Object.assign(new Error(`journal record type invalid at ${index + 1}`), { code:"journal_semantic_invalid" });
    if (record.type !== 'plan_bound' && plan && !slotByKey.has(record.slot_key)) throw Object.assign(new Error(`unknown journal slot ${record.slot_key}`), { code:"journal_semantic_invalid" });
    if (record.type === 'attempt_started') {
      const expected = (attempts.get(record.slot_key) || 0) + 1;
      if (terminals.has(record.slot_key) || activeAttempts.has(record.slot_key) || observedAttempts.has(record.slot_key) || record.attempt_index !== expected || (plan && (record.route_id !== plan.route.id || expected > plan.retry_max + 1))) throw Object.assign(new Error(`invalid attempt transition ${record.slot_key}`), { code:"journal_semantic_invalid" });
      attempts.set(record.slot_key,expected); activeAttempts.set(record.slot_key,expected);
    }
    if (record.type === 'attempt_failed') {
      if (activeAttempts.get(record.slot_key) !== record.attempt_index) throw Object.assign(new Error(`unbound failed attempt ${record.slot_key}`), { code:"journal_semantic_invalid" });
      if (!validCost(record.cost)) throw Object.assign(new Error(`invalid failed-attempt cost ${record.slot_key}`), {code:"journal_semantic_invalid"});
      if (!failedCosts.has(record.slot_key)) failedCosts.set(record.slot_key,[]);
      failedCosts.get(record.slot_key).push(record.cost);
      activeAttempts.delete(record.slot_key);
    }
    if (record.type === 'attempt_observed') {
      if (activeAttempts.get(record.slot_key) !== record.attempt_index || observedAttempts.has(record.slot_key)) throw Object.assign(new Error(`unbound observed attempt ${record.slot_key}`), {code:"journal_semantic_invalid"});
      const slot=slotByKey.get(record.slot_key),result=record.result;
      if (!result || !validCost(result.cost) || (slot && (result.task_id !== slot.task_id || result.run_index !== slot.run_index))) throw Object.assign(new Error(`invalid observed result ${record.slot_key}`), {code:"journal_semantic_invalid"});
      observedAttempts.set(record.slot_key,record); activeAttempts.delete(record.slot_key);
    }
    if (record.type === "terminal_result") {
      if (terminals.has(record.slot_key)) throw Object.assign(new Error(`duplicate terminal result ${record.slot_key}`), { code:"journal_duplicate_terminal" });
      const slot = slotByKey.get(record.slot_key);
      const result = record.result;
      const resultKeys = result && Object.keys(result).sort().join(',');
      const requiredKeys = ['cost','evidence_digest','outcome_class','reason','run_index','status','task_id'].sort().join(',');
      const costIsValid = validCost(result?.cost);
      const observedRecord=observedAttempts.get(record.slot_key);
      const transitionAllowed = Boolean(observedRecord) || ['retry budget exhausted before terminal result','execution budget exhausted after provider receipt','interrupted attempt with unknown consumption','adapter failure with unknown consumption'].includes(result?.reason);
      if (!transitionAllowed || resultKeys !== requiredKeys || !costIsValid || typeof result.reason !== 'string' || !result.reason || !DIGEST.test(result.evidence_digest || '') || (slot && (result.task_id !== slot.task_id || result.run_index !== slot.run_index)) || !['valid_pass','valid_fail','invalid'].includes(result.status) || !['task_result','timeout','infrastructure_failure','tool_incompatibility','scorer_failure'].includes(result.outcome_class) || (result.outcome_class !== 'task_result' && result.status !== 'invalid')) throw Object.assign(new Error(`invalid terminal result ${record.slot_key}`), { code:"journal_semantic_invalid" });
      if (observedRecord) {
        const expected=terminalWithCosts(observedRecord.result,[...(failedCosts.get(record.slot_key) || []),observedRecord.result.cost]);
        if (record.observed_record_digest !== observedRecord.record_digest || digestCanonical(result) !== digestCanonical(expected)) throw Object.assign(new Error(`terminal result diverges from durable observation ${record.slot_key}`), {code:"journal_semantic_invalid"});
      }
      observedAttempts.delete(record.slot_key); activeAttempts.delete(record.slot_key);
      terminals.add(record.slot_key);
    }
    previous = record.record_digest;
  });
  if (records.length && (records[0].type !== "plan_bound" || records[0].plan_digest !== expectedPlanDigest || records[0].key_id !== createHash("sha256").update(key).digest("hex") || (plan && (records[0].route_id !== plan.route.id || records[0].scheduled_denominator !== plan.scheduled_denominator)))) throw Object.assign(new Error("journal belongs to a different plan or integrity authority"), { code:"journal_plan_mismatch" });
  return records;
}

function normalizeResult(raw, plan, slot, attemptIndex) {
  const routeMatches = raw?.model?.exact_id === plan.route.exact_model_id && raw?.model?.provider === plan.route.provider && raw?.model?.configuration_digest === plan.route.configuration_digest;
  const allowedStatus = ["valid_pass","valid_fail","invalid"].includes(raw?.status);
  const allowedOutcome = ["task_result","timeout","infrastructure_failure","tool_incompatibility","scorer_failure"].includes(raw?.outcome_class);
  const forcedInvalid = raw?.outcome_class !== "task_result";
  const costComplete = validCost(raw?.cost);
  const reasonValid = typeof raw?.reason === 'string' && raw.reason.length > 0;
  const adapterEvidenceValid = DIGEST.test(raw?.evidence_digest || '');
  if (!routeMatches || !allowedStatus || !allowedOutcome || (forcedInvalid && raw.status !== "invalid") || !costComplete || !reasonValid || !adapterEvidenceValid) {
    const reason = !routeMatches ? "adapter route identity mismatch" : !costComplete ? "adapter cost vector incomplete" : "adapter result envelope invalid";
    return {task_id:slot.task_id,run_index:slot.run_index,status:"invalid",outcome_class:"tool_incompatibility",reason,evidence_digest:digestCanonical({slot:slot.key,attempt:attemptIndex,reason}),cost:raw?.cost && costComplete ? raw.cost : unavailableCost(reason)};
  }
  const evidence = {task_id:slot.task_id,run_index:slot.run_index,status:raw.status,outcome_class:raw.outcome_class,reason:raw.reason,cost:raw.cost,route:plan.route,attempt:attemptIndex,adapter_evidence_digest:raw.evidence_digest};
  return {task_id:slot.task_id,run_index:slot.run_index,status:raw.status,outcome_class:raw.outcome_class,reason:raw.reason,evidence_digest:digestCanonical(evidence),cost:raw.cost};
}

async function withJournalLock(journalPath, recoverStaleLock, operation) {
  const lockPath = `${journalPath}.lock`;
  if (fs.existsSync(lockPath)) {
    if (!recoverStaleLock) throw Object.assign(new Error(`journal lock is held: ${lockPath}`), {code:"journal_locked"});
    const age=Date.now() - fs.statSync(lockPath).mtimeMs;
    let ownerAlive=false;
    try { const owner=JSON.parse(fs.readFileSync(lockPath,"utf8")); process.kill(owner.pid,0); ownerAlive=true; } catch {}
    if (ownerAlive) throw Object.assign(new Error(`journal lock owner is still alive: ${lockPath}`), {code:"journal_lock_live"});
    if (age < 30000) throw Object.assign(new Error(`journal lock is not old enough to recover: ${lockPath}`), {code:"journal_lock_young"});
    fs.unlinkSync(lockPath);
  }
  const nonce=randomBytes(16).toString("hex"), owner={pid:process.pid,nonce,started_at:new Date().toISOString()};
  let handle;
  try { handle=fs.openSync(lockPath,"wx",0o600); fs.writeSync(handle,JSON.stringify(owner)); fs.fsyncSync(handle); }
  catch { if(handle !== undefined) fs.closeSync(handle); throw Object.assign(new Error(`journal lock is held: ${lockPath}`), {code:"journal_locked"}); }
  fs.closeSync(handle);
  try { return await operation(); }
  finally { try { const current=JSON.parse(fs.readFileSync(lockPath,"utf8")); if(current.nonce===nonce) fs.unlinkSync(lockPath); } catch {} }
}

const terminalWithCosts = (result,costs) => {
  const aggregated=aggregateCosts(costs);
  const evidence_digest=digestCanonical({prior_evidence_digest:result.evidence_digest,task_id:result.task_id,run_index:result.run_index,status:result.status,outcome_class:result.outcome_class,reason:result.reason,cost:aggregated});
  return {...result,cost:aggregated,evidence_digest};
};

function executionBudgetState(records,plan){
  const costs=records.flatMap((record)=>record.type==='attempt_failed'?[record.cost]:record.type==='attempt_observed'?[record.result.cost]:[]);
  for(const [metric,limit] of [['monetary',plan.budgets.cost_max],['quota_units',plan.budgets.quota_max]]){
    const observations=costs.map((cost)=>cost?.[metric]);
    if(observations.some((item)=>!item||!['measured','provider_proven_zero'].includes(item.state)))return {exhausted:true,reason:`${metric} budget accounting unavailable`,metric};
    const consumed=observations.reduce((sum,item)=>sum+item.value,0);
    if(!Number.isFinite(consumed)||consumed>=limit)return {exhausted:true,reason:`${metric} budget exhausted`,metric,consumed,limit};
  }
  return {exhausted:false};
}

export async function runPlan({ plan, adapter, journalPath, integrityKey, stopAfter = Infinity, afterInvoke, recoverStaleLock = false }) {
  const frozenPlan=createPlan({routeId:plan?.route?.id});
  if (!plan?.plan_digest || digestCanonical(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "plan_digest"))) !== plan.plan_digest || frozenPlan.plan_digest !== plan.plan_digest) throw Object.assign(new Error("plan is not the frozen baseline plan"), { code:"plan_tampered" });
  plan=deepFreeze(structuredClone(frozenPlan));
  if (!adapter || typeof adapter.invoke !== "function") throw Object.assign(new Error("adapter.invoke is required"), { code:"adapter_invalid" });
  const key=integrityKeyBytes(integrityKey);
  fs.mkdirSync(path.dirname(path.resolve(journalPath)), {recursive:true});
  return withJournalLock(journalPath, recoverStaleLock, async () => {
    let records = readJournal(journalPath, plan.plan_digest, plan,key);
    if (!records.length) records.push(appendRecord(journalPath, {type:"plan_bound",plan_digest:plan.plan_digest,route_id:plan.route.id,scheduled_denominator:plan.scheduled_denominator,key_id:createHash("sha256").update(key).digest("hex")}, ZERO_DIGEST, 1,key));
    const terminal = new Map(records.filter((record) => record.type === "terminal_result").map((record) => [record.slot_key,record.result]));
    let completedThisInvocation = 0,abortReason=null;
    for (const slot of plan.slots) {
      if (terminal.has(slot.key) || completedThisInvocation >= stopAfter) continue;
      const beforeSlotBudget=executionBudgetState(records,plan);
      if(beforeSlotBudget.exhausted){abortReason=beforeSlotBudget.reason;break;}
      let attempts = records.filter((record) => record.type === "attempt_started" && record.slot_key === slot.key).length;
      const observed=records.filter((record) => record.type === "attempt_observed" && record.slot_key === slot.key).at(-1);
      const failedIndexes=new Set(records.filter((record) => record.type === "attempt_failed" && record.slot_key === slot.key).map((record) => record.attempt_index));
      const observedIndexes=new Set(records.filter((record) => record.type === "attempt_observed" && record.slot_key === slot.key).map((record) => record.attempt_index));
      const dangling=records.filter((record) => record.type === "attempt_started" && record.slot_key === slot.key && !failedIndexes.has(record.attempt_index) && !observedIndexes.has(record.attempt_index)).at(-1);
      if (dangling) {
        const reason="interrupted before a durable provider receipt";
        const record=appendRecord(journalPath,{type:"attempt_failed",slot_key:slot.key,attempt_index:dangling.attempt_index,error_code:"interrupted_attempt",reason,cost:unavailableCost(reason)},records.at(-1).record_digest,records.length + 1,key); records.push(record);
        const danglingBudget=executionBudgetState(records,plan);
        const terminalReason='interrupted attempt with unknown consumption',attemptCosts=records.filter((item)=>item.slot_key===slot.key&&item.type==='attempt_failed').map((item)=>item.cost),cost=aggregateCosts(attemptCosts),result={task_id:slot.task_id,run_index:slot.run_index,status:'invalid',outcome_class:'infrastructure_failure',reason:terminalReason,evidence_digest:digestCanonical({slot:slot.key,reason:terminalReason,cost,budget:danglingBudget}),cost};
        const terminalRecord=appendRecord(journalPath,{type:'terminal_result',slot_key:slot.key,result},records.at(-1).record_digest,records.length+1,key);records.push(terminalRecord);terminal.set(slot.key,result);abortReason=danglingBudget.reason;completedThisInvocation+=1;break;
      }
      if (observed) {
        const priorCosts=records.filter((record) => record.slot_key === slot.key && record.type === "attempt_failed").map((record) => record.cost);
        const result=terminalWithCosts(observed.result,[...priorCosts,observed.result.cost]);
        const record=appendRecord(journalPath,{type:"terminal_result",slot_key:slot.key,result,observed_record_digest:observed.record_digest},records.at(-1).record_digest,records.length + 1,key); records.push(record); terminal.set(slot.key,result); completedThisInvocation += 1; continue;
      }
      while (!terminal.has(slot.key)) {
        if (attempts > plan.retry_max) {
          const reason = "retry budget exhausted before terminal result";
          const attemptCosts=records.filter((record) => record.slot_key === slot.key && record.type === "attempt_failed").map((record) => record.cost);
          const cost=aggregateCosts(attemptCosts.length ? attemptCosts : [unavailableCost(reason)]);
          const result = {task_id:slot.task_id,run_index:slot.run_index,status:"invalid",outcome_class:"infrastructure_failure",reason,evidence_digest:digestCanonical({slot:slot.key,attempts,reason,cost}),cost};
          const record = appendRecord(journalPath,{type:"terminal_result",slot_key:slot.key,result},records.at(-1).record_digest,records.length + 1,key); records.push(record); terminal.set(slot.key,result); break;
        }
        const attemptIndex = attempts + 1;
        let record = appendRecord(journalPath,{type:"attempt_started",slot_key:slot.key,attempt_index:attemptIndex,route_id:plan.route.id},records.at(-1).record_digest,records.length + 1,key); records.push(record); attempts += 1;
        let raw;
        try { raw = await adapter.invoke({plan,slot,attempt:attemptIndex}); }
        catch (error) {
          const failureCost=validCost(error?.cost) ? error.cost : unavailableCost("adapter failure consumption unavailable");
          record = appendRecord(journalPath,{type:"attempt_failed",slot_key:slot.key,attempt_index:attemptIndex,error_code:error?.code || "adapter_failure",reason:error?.message || "adapter failure",cost:failureCost},records.at(-1).record_digest,records.length + 1,key); records.push(record);
          const failedBudget=executionBudgetState(records,plan);
          if(failedBudget.exhausted){const reason=/accounting unavailable$/u.test(failedBudget.reason)?'adapter failure with unknown consumption':'execution budget exhausted after provider receipt',attemptCosts=records.filter((item)=>item.slot_key===slot.key&&item.type==='attempt_failed').map((item)=>item.cost),cost=aggregateCosts(attemptCosts),result={task_id:slot.task_id,run_index:slot.run_index,status:'invalid',outcome_class:'infrastructure_failure',reason,evidence_digest:digestCanonical({slot:slot.key,reason,cost,budget:failedBudget}),cost};record=appendRecord(journalPath,{type:'terminal_result',slot_key:slot.key,result},records.at(-1).record_digest,records.length+1,key);records.push(record);terminal.set(slot.key,result);abortReason=failedBudget.reason;}
          continue;
        }
        const normalized = normalizeResult(raw,plan,slot,attemptIndex);
        record=appendRecord(journalPath,{type:"attempt_observed",slot_key:slot.key,attempt_index:attemptIndex,result:normalized},records.at(-1).record_digest,records.length + 1,key); records.push(record);
        if (afterInvoke) await afterInvoke({plan,slot,attempt:attemptIndex,raw});
        const priorCosts=records.filter((item) => item.slot_key === slot.key && item.type === "attempt_failed").map((item) => item.cost);
        const result=terminalWithCosts(normalized,[...priorCosts,normalized.cost]);
        record = appendRecord(journalPath,{type:"terminal_result",slot_key:slot.key,result,observed_record_digest:record.record_digest},records.at(-1).record_digest,records.length + 1,key); records.push(record); terminal.set(slot.key,result);
      }
      completedThisInvocation += 1;
    }
    const results = plan.slots.map((slot) => terminal.get(slot.key)).filter(Boolean);
    const complete = results.length === plan.scheduled_denominator && new Set(results.map((result) => `${result.task_id}#${result.run_index}`)).size === plan.scheduled_denominator;
    return {status:complete ? "complete" : "incomplete",plan_digest:plan.plan_digest,route_id:plan.route.id,scheduled_denominator:plan.scheduled_denominator,terminal_count:results.length,remaining:plan.scheduled_denominator - results.length,abort_reason:abortReason,results,claims_allowed:complete ? plan.claims_allowed : [],claims_forbidden:plan.claims_forbidden,unobserved_hard_gate_ids:plan.unobserved_hard_gate_ids,journal_tail_digest:records.at(-1).record_digest};
  });
}

async function main(argv) {
  const [command,...rest] = argv;
  const flag = (name) => { const index=rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
  const routeId = flag("--route");
  const plan = createPlan({routeId});
  if (command === "plan") return plan;
  if (!["run","resume"].includes(command)) throw new Error("usage: native-runner.mjs plan|run|resume --route <id> --journal <path> [--test-adapter <module>]");
  const testAdapterPath = flag("--test-adapter"), journalPath = flag("--journal");
  if (!journalPath) throw new Error("run/resume require --journal; the frozen Codex adapter is the default");
  if (testAdapterPath && process.env.NAIA_BENCHMARK_ALLOW_TEST_ADAPTER !== "1") throw new Error("--test-adapter is disabled outside an explicit test process");
  const loaded = testAdapterPath ? await import(pathToFileURL(path.resolve(testAdapterPath)).href) : await import("./codex-cli-adapter.mjs");
  return runPlan({plan,adapter:loaded.default || loaded,journalPath:path.resolve(journalPath),integrityKey:process.env.NAIA_BENCHMARK_JOURNAL_KEY,recoverStaleLock:rest.includes("--recover-stale-lock")});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((result) => process.stdout.write(`${JSON.stringify(result,null,2)}\n`)).catch((error) => { process.stderr.write(`${error.code || "runner_error"}: ${error.message}\n`); process.exitCode=1; });
}
