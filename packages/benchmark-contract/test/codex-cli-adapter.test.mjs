import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createCodexCliAdapter,costFromUsage,parseCodexJsonl,priceSnapshot,resolveCodexEntrypoint} from "../src/codex-cli-adapter.mjs";
import {loadPriceSnapshot,PRICE_SNAPSHOT_DIGEST} from "../src/price-snapshot.mjs";
import {createPlan} from "../src/native-runner.mjs";
import {digestCanonical} from "../src/validate-bundle.mjs";

const usage={input_tokens:18434,cached_input_tokens:8960,output_tokens:109,reasoning_output_tokens:100};
const events=[{type:"thread.started",thread_id:"test"},{type:"item.completed",item:{id:"item_1",type:"agent_message",text:'{"outputs":[6,4,0,100]}'}},{type:"turn.completed",usage}];
const parsed=parseCodexJsonl(events.map(JSON.stringify).join("\n")+"\n");assert.equal(parsed.usage.reasoning_output_tokens,100);
assert.throws(()=>parseCodexJsonl('{"type":"turn.completed","usage":{}}\n'),/no completed agent message/);assert.throws(()=>parseCodexJsonl('{bad}\n'),/malformed Codex JSONL/);
const cost=costFromUsage("gpt-5.6-luna",usage,25);assert.equal(cost.uncached_input_tokens.value,9474);assert.equal(cost.retries.state,"unavailable");assert.equal(cost.monetary.value,(9474+896+654)/1000000,"reasoning detail must not be billed in addition to output total");assert.equal(digestCanonical(priceSnapshot),PRICE_SNAPSHOT_DIGEST);
const longContextCost=costFromUsage("gpt-5.6-luna",{input_tokens:272001,cached_input_tokens:0,output_tokens:1,reasoning_output_tokens:0},25);assert.equal(longContextCost.monetary.state,"unavailable");assert.equal(longContextCost.quota_units.state,"unavailable");
assert.match(resolveCodexEntrypoint(),/codex\.js$/u);

const temp=fs.mkdtempSync(path.join(os.tmpdir(),"naia-codex-adapter-"));
try{
 const altered=path.join(temp,"price.json"),copy=structuredClone(priceSnapshot);copy.models["gpt-5.6-luna"].api_usd_per_million.output=999;fs.writeFileSync(altered,JSON.stringify(copy));assert.throws(()=>loadPriceSnapshot(altered),/digest mismatch/);
 const fake=path.join(temp,"fake-codex.mjs");fs.writeFileSync(fake,`let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(!process.argv.includes('--ephemeral')||!process.argv.includes('--json')||!process.argv.includes('read-only')||!process.argv.includes('model_reasoning_effort=\\"low\\"')||!input.includes('FROZEN BENCHMARK'))process.exit(3);const rows=${JSON.stringify(events)};for(const row of rows)process.stdout.write(JSON.stringify(row)+'\\n');});`);
 const plan=createPlan({routeId:"route-luna-economy"}),slot=plan.slots[0],adapter=createCodexCliAdapter({entrypoint:fake,cwd:temp});const result=await adapter.invoke({plan,slot,attempt:1});assert.equal(result.status,"valid_pass");assert.equal(result.cost.output_tokens.value,109);assert.equal(adapter.revision,"codex-cli-jsonl-v2");
 const structuralSlot=plan.slots.find((item)=>item.task_id==="TASK-PRE-NESTED-CONTEXT"),structuralEvents=structuredClone(events);structuralEvents[1].item.text='{"root_before_project":true,"project_before_action":true,"wrong_project_reads":0}';const structuralCli=path.join(temp,"structural.mjs");fs.writeFileSync(structuralCli,`for(const row of ${JSON.stringify(structuralEvents)})process.stdout.write(JSON.stringify(row)+'\\n');`);const structuralPass=await createCodexCliAdapter({entrypoint:structuralCli,cwd:temp}).invoke({plan,slot:structuralSlot});assert.equal(structuralPass.status,"valid_pass");structuralEvents[1].item.text='{"root_before_project":false,"project_before_action":true,"wrong_project_reads":0}';const structuralBadCli=path.join(temp,"structural-bad.mjs");fs.writeFileSync(structuralBadCli,`for(const row of ${JSON.stringify(structuralEvents)})process.stdout.write(JSON.stringify(row)+'\\n');`);const structuralFail=await createCodexCliAdapter({entrypoint:structuralBadCli,cwd:temp}).invoke({plan,slot:structuralSlot});assert.equal(structuralFail.status,"valid_fail");
 const badPlan=structuredClone(plan);badPlan.price_snapshot_digest="0".repeat(64);await assert.rejects(()=>adapter.invoke({plan:badPlan,slot}),/not bound/);
 const hang=path.join(temp,"hang.mjs");fs.writeFileSync(hang,`const rows=${JSON.stringify(events)};for(const row of rows)process.stdout.write(JSON.stringify(row)+'\\n');setInterval(()=>{},1000);`);const timeoutAdapter=createCodexCliAdapter({entrypoint:hang,cwd:temp,timeoutMs:500});await assert.rejects(()=>timeoutAdapter.invoke({plan,slot}),error=>error.code==="codex_timeout"&&error.cost?.monetary?.state==="measured");
 const badCandidate=path.join(temp,"bad-candidate.mjs");const badEvents=structuredClone(events);badEvents[1].item.text='process.exit(0)';fs.writeFileSync(badCandidate,`for(const row of ${JSON.stringify(badEvents)})process.stdout.write(JSON.stringify(row)+'\\n');`);const failed=await createCodexCliAdapter({entrypoint:badCandidate,cwd:temp}).invoke({plan,slot});assert.equal(failed.status,"valid_fail","model text must be parsed as data and never executed");
}finally{fs.rmSync(temp,{recursive:true,force:true});}
console.log("Codex CLI adapter: PASS (native Node, bound prices, no double billing, durable failure cost, external deterministic scorer)");
