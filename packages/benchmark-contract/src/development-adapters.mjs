import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {costFromUsage,executeNode,parseCodexJsonl,resolveCodexEntrypoint} from "./codex-cli-adapter.mjs";
import {loadDevelopmentCapabilitySuite,promptForDevelopmentTask,scoreDevelopmentCandidate} from "./development-capability-suite.mjs";
import {loadDevelopmentRoute} from "./development-plan.mjs";
import {createProviderNeutralChatAdapter} from "./provider-neutral-adapter.mjs";
import {digestCanonical} from "./validate-bundle.mjs";

const DIGEST=/^[a-f0-9]{64}$/u;
const unavailable=(reason)=>({state:"unavailable",reason});
const observed=(value,reason,evidence)=>({state:value===0?"provider_proven_zero":"measured",value,evidence_digest:digestCanonical(evidence),reason});
const taskMap=new Map(loadDevelopmentCapabilitySuite().catalog.tasks.map(task=>[task.id,task]));

function score(slot,text){const result=scoreDevelopmentCandidate(slot.task_id,text);if(!DIGEST.test(result.evidence_digest))throw new Error("development scorer evidence invalid");return result;}

function costFromProviderReceipt(receipt,receiptDigest){
  const metric=(name)=>{const item=receipt.usage[name];return item.value===undefined?unavailable(item.reason):observed(item.value,item.reason,{receiptDigest,name,value:item.value});};
  const input=receipt.usage.input_tokens.value,cached=receipt.usage.cached_input_tokens.value,output=receipt.usage.output_tokens.value;
  const uncached=Number.isSafeInteger(input)&&Number.isSafeInteger(cached)?observed(input-cached,"provider total input minus cached input",{receiptDigest,input,cached}):unavailable("uncached input unavailable because total or cached input detail is missing");
  const quota=Number.isSafeInteger(input)&&Number.isSafeInteger(output)?observed(input+output,"normalized provider input plus output tokens",{receiptDigest,input,output}):unavailable("provider token totals unavailable");
  return {cached_input_tokens:metric("cached_input_tokens"),uncached_input_tokens:uncached,output_tokens:metric("output_tokens"),reasoning_tokens:metric("reasoning_tokens"),retries:observed(0,"development wrapper performs no retry",{receiptDigest,metric:"retries"}),wall_time_ms:observed(receipt.monotonic_latency_ms,"native monotonic HTTP wall time",{receiptDigest,metric:"wall_time_ms"}),fallbacks:observed(0,"capability profile forbids fallback",{receiptDigest,metric:"fallbacks"}),escalations:observed(0,"capability profile forbids escalation",{receiptDigest,metric:"escalations"}),terminal_failure_consumption:observed(0,"provider request completed successfully",{receiptDigest,metric:"terminal_failure_consumption"}),monetary:unavailable(receipt.price_evidence.reason),quota_units:quota};
}

export function createDevelopmentHttpAdapter({routeId,env=process.env,fetchImpl=globalThis.fetch,timeoutMs=120000}={}){
  const route=loadDevelopmentRoute(routeId,{env}),rawRoute=(awaitRouteCatalog()).find(item=>item.id===routeId);
  const underlying=createProviderNeutralChatAdapter({route:rawRoute,env,fetchImpl,timeoutMs});
  return {revision:"development-http-adapter-v1",async invoke({plan,slot}){const task=taskMap.get(slot.task_id);if(!task)throw new Error(`unknown development task ${slot.task_id}`);const response=await underlying.invokeText({prompt:promptForDevelopmentTask(task)}),scored=score(slot,response.text);return {model:{exact_id:plan.route.exact_model_id,provider:plan.route.provider,configuration_digest:plan.route.configuration_digest},status:scored.status,outcome_class:"task_result",reason:scored.reason,evidence_digest:digestCanonical({score:scored.evidence_digest,provider_receipt:response.receipt_digest}),cost:costFromProviderReceipt(response.receipt,response.receipt_digest)};}};
}

let routes;
function awaitRouteCatalog(){if(!routes){const file=new URL("../baselines/development-provider-routes.json",import.meta.url);routes=JSON.parse(fs.readFileSync(file,"utf8")).routes;}return routes;}

export function createDevelopmentCodexAdapter({routeId,env=process.env,entrypoint=resolveCodexEntrypoint(env),timeoutMs=120000}={}){
  const route=loadDevelopmentRoute(routeId,{env});if(route.adapter_kind!=="codex_cli")throw new Error(`${routeId} is not a Codex CLI route`);
  const childEnv=Object.fromEntries(Object.entries(env).filter(([name])=>!/UPSTAGE|OPENROUTER|AZURE.*(?:KEY|TOKEN|SECRET)|DEEPSEEK.*(?:KEY|TOKEN|SECRET)/iu.test(name)));
  return {revision:"development-codex-adapter-v1",async invoke({plan,slot}){const task=taskMap.get(slot.task_id);if(!task)throw new Error(`unknown development task ${slot.task_id}`);const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"naia-bench-worker-"));try{const args=["exec","-m",route.deployment_or_route_model_id,"-c",`model_reasoning_effort=\"${route.model_reasoning_effort}\"`,"-c","web_search=\"disabled\"","-c","features.apps=false","--ephemeral","--sandbox","read-only","--skip-git-repo-check","--json","-"];const receipt=await executeNode({entrypoint,args,input:promptForDevelopmentTask(task),cwd:scratch,env:{...childEnv,NO_COLOR:"1"},timeoutMs});const parsed=parseCodexJsonl(receipt.stdout,{requireMessage:!receipt.timedOut&&receipt.code===0}),cost=costFromUsage(route.deployment_or_route_model_id,parsed.usage,receipt.wallTimeMs,{terminalFailure:receipt.timedOut||receipt.code!==0});if(receipt.timedOut||receipt.code!==0)throw Object.assign(new Error(receipt.timedOut?"Codex development worker timed out":`Codex development worker failed (${receipt.code})`),{code:receipt.timedOut?"codex_timeout":"codex_exit_nonzero",cost});const scored=score(slot,parsed.text);return {model:{exact_id:plan.route.exact_model_id,provider:plan.route.provider,configuration_digest:plan.route.configuration_digest},status:scored.status,outcome_class:"task_result",reason:scored.reason,evidence_digest:digestCanonical({score:scored.evidence_digest,codex_events:digestCanonical(parsed.events)}),cost};}finally{fs.rmSync(scratch,{recursive:true,force:true});}}};
}

export function createDevelopmentAdapter(options={}){const route=loadDevelopmentRoute(options.routeId,{env:options.env});return route.adapter_kind==="codex_cli"?createDevelopmentCodexAdapter(options):createDevelopmentHttpAdapter(options);}
