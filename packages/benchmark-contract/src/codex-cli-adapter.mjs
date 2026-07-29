import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestCanonical } from "./validate-bundle.mjs";
import { PRICE_SNAPSHOT_DIGEST, loadPriceSnapshot, packageRoot, priceSnapshot, priceSnapshotPath } from "./price-snapshot.mjs";
import { loadRouteConfiguration } from "./route-configurations.mjs";
import { SCORER_WORKER_DIGEST, assertScorerAuthority, scorerWorkerPath } from "./scorer-authority.mjs";

const scorerEntrypoint=scorerWorkerPath;
const tasks=JSON.parse(fs.readFileSync(path.join(packageRoot,"baselines","pre-recovery.tasks.json"),"utf8")).tasks;
const fixtureFiles=fs.readdirSync(path.join(packageRoot,"fixtures","pre-recovery")).filter((name)=>name.endsWith(".json"));
const loadAsset=(absolute)=>{const bytes=fs.readFileSync(absolute),value=JSON.parse(bytes);return {digest:createHash("sha256").update(bytes).digest("hex"),absolute,value};};
const fixtureByDigest=new Map(fixtureFiles.map((name)=>{const asset=loadAsset(path.join(packageRoot,"fixtures","pre-recovery",name));return [asset.digest,asset];}));
const scorerByDigest=new Map(fs.readdirSync(path.join(packageRoot,"scorers","pre-recovery")).filter((name)=>name.endsWith(".json")).map((name)=>{const asset=loadAsset(path.join(packageRoot,"scorers","pre-recovery",name));return [asset.digest,asset];}));
const DIGEST=/^[a-f0-9]{64}$/;
const unavailable=(reason)=>({state:"unavailable",reason});
const notApplicable=(reason)=>({state:"not_applicable",reason});
const measured=(value,reason,evidence)=>({state:"measured",value,evidence_digest:digestCanonical(evidence),reason});

export function resolveCodexEntrypoint(env=process.env) {
  const roots=[env.CODEX_MANAGED_PACKAGE_ROOT,env.APPDATA&&path.join(env.APPDATA,"npm","node_modules","@openai","codex")].filter(Boolean);
  for(const root of roots){const candidate=path.join(root,"bin","codex.js");if(fs.existsSync(candidate))return candidate;}
  throw Object.assign(new Error("native Codex JavaScript entrypoint was not found"),{code:"codex_entrypoint_missing"});
}

export function parseCodexJsonl(stdout,{requireMessage=true}={}) {
  const lines=stdout.split(/\r?\n/u).filter((line)=>line.trim());
  const events=lines.map((line,index)=>{try{return JSON.parse(line);}catch{throw Object.assign(new Error(`malformed Codex JSONL event ${index+1}`),{code:"codex_jsonl_malformed"});}});
  const messages=events.filter((event)=>event.type==="item.completed"&&event.item?.type==="agent_message").map((event)=>event.item.text).filter((text)=>typeof text==="string");
  const usage=events.filter((event)=>event.type==="turn.completed").at(-1)?.usage;
  if(requireMessage&&!messages.length)throw Object.assign(new Error("Codex receipt has no completed agent message"),{code:"codex_message_missing"});
  if(!usage)throw Object.assign(new Error("Codex receipt has no completed usage event"),{code:"codex_usage_missing"});
  for(const key of ["input_tokens","cached_input_tokens","output_tokens","reasoning_output_tokens"]){if(!Number.isSafeInteger(usage[key])||usage[key]<0)throw Object.assign(new Error(`invalid Codex usage field: ${key}`),{code:"codex_usage_invalid"});}
  if(usage.cached_input_tokens>usage.input_tokens||usage.reasoning_output_tokens>usage.output_tokens)throw Object.assign(new Error("Codex usage detail exceeds its parent total"),{code:"codex_usage_invalid"});
  return {events,messages,text:messages.at(-1),usage};
}

export function costFromUsage(modelId,usage,wallTimeMs,{terminalFailure=false}={}) {
  const {digest}=loadPriceSnapshot();
  const rates=priceSnapshot.models[modelId];if(!rates)throw Object.assign(new Error(`price snapshot has no model: ${modelId}`),{code:"price_model_missing"});
  const cached=usage.cached_input_tokens,uncached=usage.input_tokens-cached,output=usage.output_tokens,reasoning=usage.reasoning_output_tokens;
  const basis={snapshot:priceSnapshot.id,snapshot_digest:digest,modelId,usage,wallTimeMs,terminalFailure};
  const usd=(uncached*rates.api_usd_per_million.uncached_input+cached*rates.api_usd_per_million.cached_input+output*rates.api_usd_per_million.output)/priceSnapshot.token_unit;
  const credits=(uncached*rates.codex_credits_per_million.uncached_input+cached*rates.codex_credits_per_million.cached_input+output*rates.codex_credits_per_million.output)/priceSnapshot.token_unit;
  const normalizationAllowed=usage.input_tokens<=priceSnapshot.applicability.maximum_input_tokens_without_frozen_long_context_rule;
  return {cached_input_tokens:measured(cached,"Codex CLI turn.completed usage",{...basis,metric:"cached_input_tokens"}),uncached_input_tokens:measured(uncached,"total input minus cached input",{...basis,metric:"uncached_input_tokens"}),output_tokens:measured(output,"Codex CLI output total; reasoning is a subset and is not billed twice",{...basis,metric:"output_tokens"}),reasoning_tokens:measured(reasoning,"Codex CLI reasoning output detail",{...basis,metric:"reasoning_output_tokens"}),retries:unavailable("Codex CLI receipt does not expose internal retry count"),wall_time_ms:measured(wallTimeMs,"native monotonic process wall time",{...basis,metric:"wall_time_ms"}),fallbacks:unavailable("Codex CLI receipt does not expose internal fallback count"),escalations:unavailable("Codex CLI receipt does not expose internal escalation count"),terminal_failure_consumption:measured(terminalFailure?usage.input_tokens+output:0,terminalFailure?"tokens observed on a terminally failed adapter invocation":"adapter invocation completed without terminal failure",{...basis,metric:"terminal_failure_consumption"}),monetary:normalizationAllowed?measured(usd,"API-equivalent USD from frozen public price snapshot; not invoiced spend",{...basis,metric:"monetary",usd}):unavailable("input exceeds the frozen snapshot's ordinary-context applicability"),quota_units:normalizationAllowed?measured(credits,"Codex credits estimated from frozen public rate card",{...basis,metric:"quota_units",credits}):unavailable("input exceeds the frozen snapshot's ordinary-context applicability")};
}

function executeNode({entrypoint,args,input,cwd,env,timeoutMs,nodeArgs=[]}) {
  return new Promise((resolve,reject)=>{const started=process.hrtime.bigint();let timer,grace,settled=false,timedOut=false,stdout="",stderr="";const child=spawn(process.execPath,[...nodeArgs,entrypoint,...args],{cwd,env,stdio:["pipe","pipe","pipe"],shell:false,windowsHide:true});const receipt=()=>({code:child.exitCode,signal:child.signalCode,stdout,stderr,timedOut,wallTimeMs:Number((process.hrtime.bigint()-started)/1000000n)});const finish=(callback,value)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(grace);callback(value);};child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");child.stdout.on("data",(chunk)=>{stdout+=chunk;if(stdout.length>32*1024*1024){timedOut=true;child.kill();}});child.stderr.on("data",(chunk)=>{stderr+=chunk;if(stderr.length>8*1024*1024){timedOut=true;child.kill();}});child.on("error",(error)=>finish(reject,error));child.on("close",()=>finish(resolve,receipt()));timer=setTimeout(()=>{timedOut=true;child.kill();grace=setTimeout(()=>finish(resolve,receipt()),2000);},timeoutMs);child.stdin.end(input,"utf8");});
}

function assetsFor(slot){const fixture=fixtureByDigest.get(slot.fixture_digest),scorer=scorerByDigest.get(slot.scorer_digest);if(!fixture||!scorer)throw Object.assign(new Error(`slot assets are not digest-bound: ${slot.key}`),{code:"slot_asset_missing"});return {fixture,scorer};}
export function frozenPromptFor({slot}){const {fixture}=assetsFor(slot);const task=tasks.find((item)=>item.id===slot.task_id);if(!task)throw new Error(`unknown task ${slot.task_id}`);if(fixture.value.kind==="legacy_code")return `FROZEN BENCHMARK ${task.id}\n${fixture.value.input.prompt}\nFor the ordered argument lists ${JSON.stringify(fixture.value.input.cases.map((item)=>item.args))}, return only {"outputs":[...]} with one JSON result per case. Never return executable source and do not score yourself.`;return `FROZEN BENCHMARK ${task.id}\nReturn only one JSON object containing the requested observation fields. Do not score yourself.\nInput: ${JSON.stringify(fixture.value.input)}\nRequired observation fields: ${JSON.stringify(Object.keys(fixture.value.oracle))}`;}

async function scoreExternally({slot,candidate,timeoutMs}){assertScorerAuthority();const {fixture,scorer}=assetsFor(slot);const request={candidate,fixture_path:fixture.absolute,fixture_digest:slot.fixture_digest,scorer_path:scorer.absolute,scorer_digest:slot.scorer_digest};const receipt=await executeNode({entrypoint:scorerEntrypoint,args:[],nodeArgs:["--permission",`--allow-fs-read=${packageRoot}`],input:JSON.stringify(request),cwd:packageRoot,env:{NO_COLOR:"1"},timeoutMs:Math.min(timeoutMs,10000)});if(receipt.code!==0||receipt.timedOut)throw Object.assign(new Error(`deterministic scorer failed: ${receipt.stderr.trim()||"no diagnostic"}`),{code:"external_scorer_failure"});let result;try{result=JSON.parse(receipt.stdout);}catch{throw Object.assign(new Error("deterministic scorer emitted malformed JSON"),{code:"external_scorer_invalid"});}if(result.principal!=="native-deterministic-scorer"||result.provider!=="node:declarative"||result.model!==null||result.fixture_digest!==slot.fixture_digest||result.scorer_digest!==slot.scorer_digest||!/^score-\d+-\d+$/u.test(result.execution_id||"")||!["valid_pass","valid_fail"].includes(result.status)||result.outcome_class!=="task_result"||typeof result.reason!=="string"||!result.reason||!DIGEST.test(result.evidence_digest||""))throw Object.assign(new Error("deterministic scorer identity or envelope invalid"),{code:"external_scorer_invalid"});return result;}

export function createCodexCliAdapter({entrypoint=resolveCodexEntrypoint(),cwd=packageRoot,env=process.env,timeoutMs=120000}={}){return {revision:"codex-cli-jsonl-v2",price_snapshot_id:priceSnapshot.id,price_snapshot_digest:PRICE_SNAPSHOT_DIGEST,scorer_worker_digest:SCORER_WORKER_DIGEST,async invoke({plan,slot}){if(plan.price_snapshot_digest!==PRICE_SNAPSHOT_DIGEST)throw Object.assign(new Error("plan is not bound to the frozen price snapshot"),{code:"price_plan_mismatch"});if(plan.scorer_worker_digest!==SCORER_WORKER_DIGEST)throw Object.assign(new Error("plan is not bound to the deterministic scorer authority"),{code:"scorer_plan_mismatch"});const configuration=loadRouteConfiguration(plan.route);const prompt=frozenPromptFor({slot});const args=["exec","-m",configuration.model,"-c",`model_reasoning_effort=\"${configuration.model_reasoning_effort}\"`,"-c",`web_search=\"${configuration.web_search}\"`,"-c",`features.apps=${configuration.features.apps}`,"--ephemeral","--sandbox",configuration.sandbox,"--json","-"];const receipt=await executeNode({entrypoint,args,input:prompt,cwd,env:{...env,NO_COLOR:"1"},timeoutMs});let parsed;try{parsed=parseCodexJsonl(receipt.stdout,{requireMessage:!receipt.timedOut&&receipt.code===0});}catch(error){throw error;}let cost=costFromUsage(plan.route.exact_model_id,parsed.usage,receipt.wallTimeMs,{terminalFailure:receipt.timedOut||receipt.code!==0});if(receipt.timedOut||receipt.code!==0){throw Object.assign(new Error(receipt.timedOut?`Codex CLI exceeded ${timeoutMs} ms`:`Codex CLI failed (${receipt.code??receipt.signal}): ${receipt.stderr.trim()||"no diagnostic"}`),{code:receipt.timedOut?"codex_timeout":"codex_exit_nonzero",cost});}let scored;try{scored=await scoreExternally({slot,candidate:parsed.text,timeoutMs});}catch(error){cost=costFromUsage(plan.route.exact_model_id,parsed.usage,receipt.wallTimeMs,{terminalFailure:true});error.cost=cost;throw error;}return {model:{exact_id:plan.route.exact_model_id,provider:plan.route.provider,configuration_digest:plan.route.configuration_digest},status:scored.status,outcome_class:scored.outcome_class,reason:scored.reason,evidence_digest:scored.evidence_digest,cost};}};}

export {priceSnapshot,priceSnapshotPath};
export default {revision:"codex-cli-jsonl-v2-lazy",invoke:async(input)=>createCodexCliAdapter().invoke(input)};
