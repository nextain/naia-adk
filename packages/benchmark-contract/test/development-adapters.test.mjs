import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createDevelopmentCodexAdapter} from "../src/development-adapters.mjs";
import {createDevelopmentPlan} from "../src/development-plan.mjs";

const temp=fs.mkdtempSync(path.join(os.tmpdir(),"naia-development-adapter-test-"));
try{
  const fake=path.join(temp,"fake-codex.mjs");
  fs.writeFileSync(fake,`if(!process.argv.includes('--skip-git-repo-check')||!process.argv.includes('--ephemeral')||!process.argv.includes('read-only')||process.env.UPSTAGE_KEY)process.exit(4);process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"outputs":[6,4,0,100]}'}})+'\\n');process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:0,output_tokens:20,reasoning_output_tokens:0}})+'\\n');`);
  const plan=createDevelopmentPlan({routeId:"worker-luna",repetitions:1});
  const adapter=createDevelopmentCodexAdapter({routeId:"worker-luna",entrypoint:fake,env:{...process.env,UPSTAGE_KEY:"must-not-reach-child"}});
  const result=await adapter.invoke({plan,slot:plan.slots[0]});
  assert.equal(result.status,"valid_pass");
  assert.equal(result.cost.uncached_input_tokens.value,100);
} finally { fs.rmSync(temp,{recursive:true,force:true}); }

console.log("development Codex adapter: PASS (untrusted scratch cwd, git bypass only for empty scratch, provider-secret scrub)");
