import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { digestCanonical } from "./validate-bundle.mjs";
import { packageRoot } from "./price-snapshot.mjs";
import { loadRouteConfiguration } from "./route-configurations.mjs";
import { frozenPromptFor, scoreExternally } from "./codex-cli-adapter.mjs";
import { SCORER_WORKER_DIGEST } from "./scorer-authority.mjs";

const unavailable=(reason)=>({state:"unavailable",reason});
const notApplicable=(reason)=>({state:"not_applicable",reason});
const measured=(value,reason,evidence)=>({state:"measured",value,evidence_digest:digestCanonical(evidence),reason});

// Claude ships as a native executable rather than a package .js, so this resolves
// the binary itself instead of an entrypoint to hand to node. PATH is searched
// natively and symlinks are followed; no shell is involved either way.
export function claudeExecutableCandidates(env=process.env) {
  const candidates=[env.CLAUDE_CODE_ENTRYPOINT_PATH].filter(Boolean);
  for(const dir of String(env.PATH||"").split(path.delimiter).filter(Boolean)){
    const executable=path.join(dir,process.platform==="win32"?"claude.exe":"claude");
    candidates.push(executable);
    try{candidates.push(fs.realpathSync(executable));}catch{/* not on this PATH entry */}
  }
  return [...new Set(candidates)];
}

export function resolveClaudeExecutable(env=process.env) {
  const candidates=claudeExecutableCandidates(env);
  for(const candidate of candidates){
    try{if(fs.statSync(candidate).isFile())return candidate;}catch{/* keep looking */}
  }
  throw Object.assign(new Error(`Claude executable was not found; searched ${candidates.length} candidate paths`),{code:"claude_executable_missing",searched:candidates});
}

export function executeExecutable({entrypoint,args,input,cwd,env,timeoutMs}) {
  return new Promise((resolve,reject)=>{const started=process.hrtime.bigint();let timer,grace,settled=false,timedOut=false,stdout="",stderr="";const child=spawn(entrypoint,args,{cwd,env,stdio:["pipe","pipe","pipe"],shell:false,windowsHide:true});const receipt=()=>({code:child.exitCode,signal:child.signalCode,stdout,stderr,timedOut,wallTimeMs:Number((process.hrtime.bigint()-started)/1000000n)});const finish=(callback,value)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(grace);callback(value);};child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");child.stdout.on("data",(chunk)=>{stdout+=chunk;if(stdout.length>32*1024*1024){timedOut=true;child.kill();}});child.stderr.on("data",(chunk)=>{stderr+=chunk;if(stderr.length>8*1024*1024){timedOut=true;child.kill();}});child.on("error",(error)=>finish(reject,error));child.on("close",()=>finish(resolve,receipt()));timer=setTimeout(()=>{timedOut=true;child.kill();grace=setTimeout(()=>finish(resolve,receipt()),2000);},timeoutMs);child.stdin.end(input,"utf8");});
}

// Anthropic splits input into fresh, cache-written and cache-read counts, while
// the contract carries one cached and one uncached total. Cache reads are the
// cached half; fresh input and cache writes are both charged as new work, so
// they make up the uncached half.
export function parseClaudeJson(stdout,{requireMessage=true}={}) {
  let payload;
  try{payload=JSON.parse(stdout);}catch{throw Object.assign(new Error("Claude receipt is not JSON"),{code:"claude_json_malformed"});}
  if(!payload||typeof payload!=="object"||Array.isArray(payload))throw Object.assign(new Error("Claude receipt is not a JSON object"),{code:"claude_json_malformed"});
  const usage=payload.usage;
  if(!usage||typeof usage!=="object")throw Object.assign(new Error("Claude receipt has no usage"),{code:"claude_usage_missing"});
  const text=typeof payload.result==="string"?payload.result:undefined;
  if(requireMessage&&!text)throw Object.assign(new Error("Claude receipt has no result text"),{code:"claude_message_missing"});
  const count=(value)=>{if(value===undefined)return 0;if(!Number.isSafeInteger(value)||value<0)throw Object.assign(new Error("invalid Claude usage field"),{code:"claude_usage_invalid"});return value;};
  const cached=count(usage.cache_read_input_tokens);
  const uncached=count(usage.input_tokens)+count(usage.cache_creation_input_tokens);
  const output=count(usage.output_tokens);
  const reasoning=count(usage.output_tokens_details?.thinking_tokens);
  if(reasoning>output)throw Object.assign(new Error("Claude reasoning tokens exceed the output total"),{code:"claude_usage_invalid"});
  return {payload,text,usage:{cached_input_tokens:cached,uncached_input_tokens:uncached,output_tokens:output,reasoning_tokens:reasoning},is_error:payload.is_error===true};
}

// Claude runs on a subscription here, so actual spend is fixed and what a run
// consumes is quota, not money. The receipt's total_cost_usd is an API-equivalent
// estimate, not billed spend, so monetary and quota are not applicable rather
// than measured. Tokens and wall time stay measured, which is the comparison axis.
export function costFromClaudeUsage(modelId,usage,wallTimeMs,{terminalFailure=false}={}) {
  const basis={modelId,usage,wallTimeMs,terminalFailure,billing:"subscription"};
  return {
    cached_input_tokens:measured(usage.cached_input_tokens,"Claude CLI cache-read input tokens",{...basis,metric:"cached_input_tokens"}),
    uncached_input_tokens:measured(usage.uncached_input_tokens,"Claude CLI fresh input plus cache-write tokens",{...basis,metric:"uncached_input_tokens"}),
    output_tokens:measured(usage.output_tokens,"Claude CLI output total; thinking is a subset and is not counted twice",{...basis,metric:"output_tokens"}),
    reasoning_tokens:measured(usage.reasoning_tokens,"Claude CLI thinking output detail",{...basis,metric:"reasoning_tokens"}),
    retries:unavailable("Claude CLI receipt does not expose internal retry count"),
    wall_time_ms:measured(wallTimeMs,"native monotonic process wall time",{...basis,metric:"wall_time_ms"}),
    fallbacks:unavailable("Claude CLI receipt does not expose internal fallback count"),
    escalations:unavailable("Claude CLI receipt does not expose internal escalation count"),
    terminal_failure_consumption:measured(terminalFailure?usage.cached_input_tokens+usage.uncached_input_tokens+usage.output_tokens:0,terminalFailure?"tokens observed on a terminally failed adapter invocation":"adapter invocation completed without terminal failure",{...basis,metric:"terminal_failure_consumption"}),
    monetary:notApplicable("subscription-covered execution; the receipt's total_cost_usd is an API-equivalent estimate, not billed spend"),
    quota_units:notApplicable("subscription-covered execution exposes no credit unit; token counts above are the quota-consumption measure"),
  };
}

export function createClaudeCliAdapter({entrypoint=resolveClaudeExecutable(),cwd=packageRoot,env=process.env,timeoutMs=120000}={}){
  return {revision:"claude-cli-json-v1",billing_model:"subscription",scorer_worker_digest:SCORER_WORKER_DIGEST,async invoke({plan,slot}){
    // No price snapshot binding: this path is subscription-covered and records no
    // monetary figure, so there is nothing for a rate card to pin. The scorer
    // authority still binds, because the score is the result.
    if(plan.scorer_worker_digest!==SCORER_WORKER_DIGEST)throw Object.assign(new Error("plan is not bound to the deterministic scorer authority"),{code:"scorer_plan_mismatch"});
    const configuration=loadRouteConfiguration(plan.route);
    if(configuration.adapter_kind!=="claude_cli")throw Object.assign(new Error(`${plan.route.id} is not a Claude CLI route`),{code:"claude_route_mismatch"});
    const prompt=frozenPromptFor({slot});
    const args=["-p","--input-format","text","--output-format","json","--no-session-persistence","--permission-mode",configuration.permission_mode,"--allowedTools",configuration.allowed_tools,"--model",configuration.model];
    const receipt=await executeExecutable({entrypoint,args,input:prompt,cwd,env:{...env,NO_COLOR:"1"},timeoutMs});
    const parsed=parseClaudeJson(receipt.stdout,{requireMessage:!receipt.timedOut&&receipt.code===0});
    let cost=costFromClaudeUsage(plan.route.exact_model_id,parsed.usage,receipt.wallTimeMs,{terminalFailure:receipt.timedOut||receipt.code!==0||parsed.is_error});
    if(receipt.timedOut||receipt.code!==0||parsed.is_error){
      throw Object.assign(new Error(receipt.timedOut?`Claude CLI exceeded ${timeoutMs} ms`:`Claude CLI failed (${receipt.code??receipt.signal}): ${receipt.stderr.trim()||"no diagnostic"}`),{code:receipt.timedOut?"claude_timeout":"claude_exit_nonzero",cost});
    }
    let scored;
    try{scored=await scoreExternally({slot,candidate:parsed.text,timeoutMs});}catch(error){cost=costFromClaudeUsage(plan.route.exact_model_id,parsed.usage,receipt.wallTimeMs,{terminalFailure:true});error.cost=cost;throw error;}
    return {model:{exact_id:plan.route.exact_model_id,provider:plan.route.provider,configuration_digest:plan.route.configuration_digest},status:scored.status,outcome_class:scored.outcome_class,reason:scored.reason,evidence_digest:scored.evidence_digest,cost};
  }};
}

export default {revision:"claude-cli-json-v1-lazy",invoke:async(input)=>createClaudeCliAdapter().invoke(input)};
