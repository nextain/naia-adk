import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { digestCanonical } from "./validate-bundle.mjs";

export const PROVIDER_RECEIPT_REVISION = "provider-receipt-v1";
export const USAGE_MAPPING_REVISION = "openai-compatible-usage-v1";
export const ADAPTER_REVISION = "provider-neutral-chat-v1";
export const ADAPTER_BUILD_DIGEST = createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex");

const unavailable = (reason) => ({ state:"unavailable",reason });
const count = (value, reason) => Number.isSafeInteger(value) && value >= 0 ? ({ state:value === 0 ? "provider_proven_zero" : "measured",value,reason }) : unavailable(reason);
const iso = (date) => date.toISOString();

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw Object.assign(new Error(`${label} is required`),{code:"provider_route_invalid"});
  return value.trim();
}

function resolveRouteValue(route, env, literalKey, envKey, label) {
  if (route[literalKey]) return requiredString(route[literalKey],label);
  const variable=requiredString(route[envKey],`${label} environment variable name`);
  return requiredString(env[variable],`${label} environment variable ${variable}`);
}

export function resolveDevelopmentRoute(route, env=process.env) {
  const endpoint=resolveRouteValue(route,env,"endpoint","endpoint_env","endpoint");
  let parsedEndpoint;
  try{parsedEndpoint=new URL(endpoint);}catch{throw Object.assign(new Error("endpoint must be an unsigned HTTP(S) URL"),{code:"provider_endpoint_invalid"});}
  if (!/^https?:$/u.test(parsedEndpoint.protocol) || parsedEndpoint.username || parsedEndpoint.password || parsedEndpoint.search || parsedEndpoint.hash) throw Object.assign(new Error("endpoint must be a query-free credential-free HTTP(S) URL"),{code:"provider_endpoint_invalid"});
  const apiKeyName=requiredString(route.api_key_env,"api_key_env"),apiKey=requiredString(env[apiKeyName],`credential ${apiKeyName}`);
  const apiVersion=resolveRouteValue(route,env,"api_version","api_version_env","api version");
  const deployedModel=resolveRouteValue(route,env,"deployment_or_route_model_id","deployment_env","deployment or route model");
  return {id:requiredString(route.id,"route id"),provider_id:requiredString(route.provider_id,"provider id"),endpoint,api_key_env:apiKeyName,apiKey,apiVersion,source_model_id:requiredString(route.source_model_id,"source model id"),deployment_or_route_model_id:deployedModel,unsupported_parameters:[...(route.unsupported_parameters||[])].sort(),cache_mode:route.cache_mode||"unknown",actual_upstream_provider_required:route.actual_upstream_provider_required===true};
}

export function normalizeOpenAICompatibleUsage(usage) {
  if (!usage || typeof usage !== "object") return {input_tokens:unavailable("provider response omitted prompt token usage"),cached_input_tokens:unavailable("provider response omitted cached token usage"),output_tokens:unavailable("provider response omitted completion token usage"),reasoning_tokens:unavailable("provider response omitted reasoning token usage")};
  const input=usage.prompt_tokens ?? usage.input_tokens;
  const output=usage.completion_tokens ?? usage.output_tokens;
  const cached=usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens;
  const reasoning=usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens;
  const normalized={input_tokens:count(input,"provider-reported total input tokens"),cached_input_tokens:cached===undefined?unavailable("provider did not report cached input tokens"):count(cached,"provider-reported cached input tokens"),output_tokens:count(output,"provider-reported total output tokens"),reasoning_tokens:reasoning===undefined?unavailable("provider did not report reasoning token detail"):count(reasoning,"provider-reported reasoning output subset")};
  if (normalized.input_tokens.value !== undefined && normalized.cached_input_tokens.value > normalized.input_tokens.value) throw Object.assign(new Error("cached input tokens exceed total input tokens"),{code:"provider_usage_invalid"});
  if (normalized.output_tokens.value !== undefined && normalized.reasoning_tokens.value > normalized.output_tokens.value) throw Object.assign(new Error("reasoning tokens exceed total output tokens"),{code:"provider_usage_invalid"});
  return normalized;
}

function redactText(text, secretValues) {
  let redacted=String(text);
  for (const secret of secretValues.filter((value)=>typeof value==="string"&&value)) redacted=redacted.split(secret).join("[REDACTED]");
  return redacted.replace(/([?&](?:sig|signature|token|key)=)[^&\s]+/giu,"$1[REDACTED]");
}

function assistantText(payload) {
  const content=payload?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.length) return content;
  throw Object.assign(new Error("provider response has no assistant text"),{code:"provider_message_missing"});
}

export function createProviderNeutralChatAdapter({route,env=process.env,fetchImpl=globalThis.fetch,timeoutMs=120000,priceEvidence={state:"unavailable",reason:"no frozen provider price snapshot supplied"}}={}) {
  const resolved=resolveDevelopmentRoute(route,env);
  if (typeof fetchImpl !== "function") throw Object.assign(new Error("fetch implementation is required"),{code:"provider_fetch_missing"});
  const requestConfiguration={stream:false};
  const requestConfigurationDigest=digestCanonical(requestConfiguration);
  return {
    revision:ADAPTER_REVISION,
    descriptor:{...resolved,apiKey:undefined,adapter_revision:ADAPTER_REVISION,adapter_build_digest:ADAPTER_BUILD_DIGEST,request_configuration_digest:requestConfigurationDigest,usage_mapping_revision:USAGE_MAPPING_REVISION},
    async invokeText({prompt}) {
      requiredString(prompt,"prompt");
      const body={model:resolved.deployment_or_route_model_id,messages:[{role:"user",content:prompt}],...requestConfiguration};
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs),startedAt=new Date(),started=process.hrtime.bigint();
      let response,text,payload;
      try {
        response=await fetchImpl(resolved.endpoint,{method:"POST",headers:{Authorization:`Bearer ${resolved.apiKey}`,"Content-Type":"application/json"},body:JSON.stringify(body),signal:controller.signal});
        text=await response.text();
        if (text.length>8*1024*1024) throw Object.assign(new Error("provider response exceeds receipt limit"),{code:"provider_response_too_large"});
        try{payload=JSON.parse(text);}catch{throw Object.assign(new Error("provider response is not JSON"),{code:"provider_response_invalid"});}
        if(!response.ok)throw Object.assign(new Error(`provider HTTP ${response.status}`),{code:"provider_http_error"});
      } finally { clearTimeout(timer); }
      const completedAt=new Date(),latencyMs=Number((process.hrtime.bigint()-started)/1000000n),usage=normalizeOpenAICompatibleUsage(payload.usage);
      const actual=payload.provider ?? response.headers.get("x-openrouter-provider") ?? response.headers.get("x-provider");
      if(resolved.actual_upstream_provider_required&&!actual)throw Object.assign(new Error("actual upstream provider identity is required"),{code:"provider_upstream_missing"});
      const redactedRequest=redactText(JSON.stringify({endpoint:resolved.endpoint,body}),[resolved.apiKey]);
      const redactedResponse=redactText(text,[resolved.apiKey]);
      const receipt={schema_revision:PROVIDER_RECEIPT_REVISION,provider_id:resolved.provider_id,endpoint_id:resolved.endpoint,api_version:resolved.apiVersion,source_model_id:resolved.source_model_id,deployment_or_route_model_id:resolved.deployment_or_route_model_id,actual_upstream_provider:actual?{state:"measured",value:String(actual),reason:"provider response identity"}:{state:"unavailable",reason:"provider did not expose upstream identity"},adapter_revision:ADAPTER_REVISION,adapter_build_digest:ADAPTER_BUILD_DIGEST,request_configuration_digest:requestConfigurationDigest,usage_mapping_revision:USAGE_MAPPING_REVISION,unsupported_parameters:resolved.unsupported_parameters,redacted_request_digest:createHash("sha256").update(redactedRequest).digest("hex"),redacted_response_digest:createHash("sha256").update(redactedResponse).digest("hex"),normalized_usage_digest:digestCanonical(usage),cache_mode:resolved.cache_mode,session_isolated:true,started_at:iso(startedAt),completed_at:iso(completedAt),monotonic_latency_ms:latencyMs,usage,price_evidence:structuredClone(priceEvidence),secret_redaction:{revision:"secret-redaction-v1",excluded_fields:["authorization","api_key","signed_url","credential_value"],verified:true}};
      return {text:assistantText(payload),receipt,receipt_digest:digestCanonical(receipt)};
    }
  };
}
