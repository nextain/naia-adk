import path from "node:path";
import { fileURLToPath } from "node:url";
import {createDevelopmentAdapter} from "./development-adapters.mjs";
import {createDevelopmentPlan} from "./development-plan.mjs";
import {runBoundPlan} from "./native-runner.mjs";

export function runDevelopmentPlan({plan,adapter,journalPath,integrityKey,stopAfter=Infinity,recoverStaleLock=false,env=process.env}){
  return runBoundPlan({plan,adapter,journalPath,integrityKey,stopAfter,recoverStaleLock,expectedPlanFactory:(candidate)=>createDevelopmentPlan({routeId:candidate?.route?.id,repetitions:candidate?.repetitions,env})});
}

async function main(argv){const [command,...rest]=argv,flag=(name)=>{const index=rest.indexOf(name);return index<0?undefined:rest[index+1];},routeId=flag("--route"),repetitions=Number(flag("--repetitions")||3),plan=createDevelopmentPlan({routeId,repetitions});if(command==="plan")return plan;if(!["run","resume"].includes(command))throw new Error("usage: development-runner.mjs plan|run|resume --route <id> --journal <path> [--repetitions 3] [--stop-after N]");const journal=flag("--journal");if(!journal)throw new Error("run/resume require --journal");const stop=flag("--stop-after");return runDevelopmentPlan({plan,adapter:createDevelopmentAdapter({routeId}),journalPath:path.resolve(journal),integrityKey:process.env.NAIA_BENCHMARK_JOURNAL_KEY,stopAfter:stop===undefined?Infinity:Number(stop),recoverStaleLock:rest.includes("--recover-stale-lock")});}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(result=>process.stdout.write(`${JSON.stringify(result,null,2)}\n`)).catch(error=>{process.stderr.write(`${error.code||"development_runner_error"}: ${error.message}\n`);process.exitCode=1;});
