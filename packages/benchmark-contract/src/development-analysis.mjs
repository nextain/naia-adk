import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createDevelopmentPlan} from "./development-plan.mjs";
import {loadDevelopmentCapabilitySuite} from "./development-capability-suite.mjs";
import {readJournal} from "./native-runner.mjs";
import {digestCanonical} from "./validate-bundle.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const percentile=(values,p)=>values[Math.min(values.length-1,Math.max(0,Math.floor(p*(values.length-1))))];
const mean=(values)=>values.reduce((sum,value)=>sum+value,0)/values.length;

function generator(seed){let state=seed>>>0||0x9e3779b9;return()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296;};}
function bound(values){const sorted=[...values].sort((a,b)=>a-b);return{estimate:mean(values),lower_bound:percentile(sorted,0.025),upper_bound:percentile(sorted,0.975),ci_width:percentile(sorted,0.975)-percentile(sorted,0.025)};}

export function loadVerifiedDevelopmentJournal(journalPath,integrityKey){
  const lines=fs.readFileSync(journalPath,"utf8").trimEnd().split(/\r?\n/u),untrusted=JSON.parse(lines[0]||"null");
  if(untrusted?.type!=="plan_bound")throw new Error("development journal has no plan binding");
  const taskCount=loadDevelopmentCapabilitySuite().catalog.tasks.length,repetitions=untrusted.scheduled_denominator/taskCount;
  if(!Number.isSafeInteger(repetitions)||repetitions<1)throw new Error("development journal denominator is invalid");
  const plan=createDevelopmentPlan({routeId:untrusted.route_id,repetitions}),records=readJournal(journalPath,plan.plan_digest,plan,integrityKey);
  const terminals=records.filter(record=>record.type==="terminal_result").map(record=>record.result);
  if(terminals.length!==plan.scheduled_denominator)throw new Error(`development journal is incomplete: ${terminals.length}/${plan.scheduled_denominator}`);
  return{plan,records,terminals,journal_digest:records.at(-1).record_digest};
}

function routeSummary(run,familyByTask){
  const states={valid_pass:0,valid_fail:0,invalid:0},families={};let monetary=0,monetaryComplete=true,quota=0,quotaComplete=true,wall=0,wallComplete=true;
  const counters={retries:0,fallbacks:0,escalations:0},counterComplete={retries:true,fallbacks:true,escalations:true};
  for(const result of run.terminals){states[result.status]+=1;const family=familyByTask.get(result.task_id);families[family]??={scheduled:0,valid_pass:0,valid_fail:0,invalid:0};families[family].scheduled+=1;families[family][result.status]+=1;for(const [metric,target] of [["monetary","monetary"],["quota_units","quota"]]){const observation=result.cost[metric];if(!["measured","provider_proven_zero"].includes(observation.state)){if(target==="monetary")monetaryComplete=false;else quotaComplete=false;}else if(target==="monetary")monetary+=observation.value;else quota+=observation.value;}for(const metric of Object.keys(counters)){const observation=result.cost[metric];if(!["measured","provider_proven_zero"].includes(observation.state))counterComplete[metric]=false;else counters[metric]+=observation.value;}const wallObservation=result.cost.wall_time_ms;if(!["measured","provider_proven_zero"].includes(wallObservation.state))wallComplete=false;else wall+=wallObservation.value;}
  const attemptRecords=run.records.filter(record=>record.type==="attempt_started"),attemptsBySlot=new Map();
  for(const record of attemptRecords)attemptsBySlot.set(record.slot_key,(attemptsBySlot.get(record.slot_key)||0)+1);
  const runnerRetryTurns=[...attemptsBySlot.values()].reduce((sum,count)=>sum+Math.max(0,count-1),0);
  return{route_id:run.plan.route.id,scheduled:run.terminals.length,...states,pass_rate:states.valid_pass/run.terminals.length,model_attempt_turns:attemptRecords.length,runner_retry_turns:runnerRetryTurns,provider_retry_turns:counterComplete.retries?counters.retries:null,fallback_count:counterComplete.fallbacks?counters.fallbacks:null,escalation_count:counterComplete.escalations?counters.escalations:null,monetary_usd_equivalent:monetaryComplete?monetary:null,quota_units:quotaComplete?quota:null,aggregate_worker_wall_time_ms:wallComplete?wall:null,mean_worker_wall_time_ms:wallComplete?wall/run.terminals.length:null,families,journal_digest:run.journal_digest};
}

function taskClusters(run){const clusters=new Map();for(const result of run.terminals){if(!clusters.has(result.task_id))clusters.set(result.task_id,[]);clusters.get(result.task_id).push(result);}return clusters;}
function observedCost(results,metric){const observations=results.map(result=>result.cost[metric]);return observations.every(item=>["measured","provider_proven_zero"].includes(item.state))?observations.reduce((sum,item)=>sum+item.value,0):null;}

function compare(reference,candidate,{resamples=10000,seed}={}){
  const ref=taskClusters(reference),cand=taskClusters(candidate),ids=[...ref.keys()].sort();if(ids.join()!==[...cand.keys()].sort().join())throw new Error("paired development task clusters differ");
  const rows=ids.map(id=>{const r=ref.get(id),c=cand.get(id),referenceCost=observedCost(r,"monetary"),candidateCost=observedCost(c,"monetary");return{id,reference_quality:r.filter(x=>x.status==="valid_pass").length/r.length,candidate_quality:c.filter(x=>x.status==="valid_pass").length/c.length,reference_cost:referenceCost,candidate_cost:candidateCost};});
  const monetaryComplete=rows.every(row=>row.reference_cost!==null&&row.reference_cost>0&&row.candidate_cost!==null),random=generator(seed??parseInt(digestCanonical({reference:reference.plan.plan_digest,candidate:candidate.plan.plan_digest}).slice(0,8),16)),quality=[],cost=[];
  for(let iteration=0;iteration<resamples;iteration+=1){const sample=Array.from({length:rows.length},()=>rows[Math.floor(random()*rows.length)]);quality.push(mean(sample.map(row=>row.candidate_quality-row.reference_quality)));if(monetaryComplete){const referenceTotal=sample.reduce((sum,row)=>sum+row.reference_cost,0),candidateTotal=sample.reduce((sum,row)=>sum+row.candidate_cost,0);cost.push((candidateTotal-referenceTotal)/referenceTotal);}}
  const qualityBound=bound(quality),costBound=monetaryComplete?bound(cost):null;
  return{candidate_route_id:candidate.plan.route.id,task_clusters:rows.length,resamples,quality:{...qualityBound,noninferiority_margin:-0.05,development_signal:qualityBound.lower_bound>=-0.05},cost:costBound?{...costBound,required_improvement:-0.15,development_signal:costBound.upper_bound<=-0.15}:null,paired_input_digest:digestCanonical(rows),promotion_allowed:false};
}

export function analyzeDevelopmentJournals({journalPaths,integrityKey=process.env.NAIA_BENCHMARK_JOURNAL_KEY,resamples=10000}){
  if(!Array.isArray(journalPaths)||journalPaths.length<2)throw new Error("reference and at least one candidate journal are required");
  const runs=journalPaths.map(file=>loadVerifiedDevelopmentJournal(path.resolve(file),integrityKey)),reference=runs.find(run=>run.plan.route.id==="worker-sol-control");if(!reference)throw new Error("worker-sol-control reference journal is required");
  if(runs.some(run=>run.plan.task_set_digest!==reference.plan.task_set_digest||run.plan.repetitions!==reference.plan.repetitions))throw new Error("development journals do not share a task set and repetition count");
  const familyByTask=new Map(loadDevelopmentCapabilitySuite().catalog.tasks.map(task=>[task.id,task.family]));
  const report={schema_revision:"development-analysis-v1",status:"development_only_no_production_claim",task_set_digest:reference.plan.task_set_digest,repetitions:reference.plan.repetitions,route_summaries:runs.map(run=>routeSummary(run,familyByTask)),comparisons:runs.filter(run=>run!==reference).map(run=>compare(reference,run,{resamples})),multiple_comparison_status:runs.length===6?"five_candidate_family_ready":"family_incomplete",claims_forbidden:["production_routing_approval","global_model_superiority","proven_cost_optimization"]};
  return{...report,report_digest:digestCanonical(report)};
}

async function main(argv){const journals=argv.filter(value=>!value.startsWith("--"));return analyzeDevelopmentJournals({journalPaths:journals});}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(report=>process.stdout.write(`${JSON.stringify(report,null,2)}\n`)).catch(error=>{process.stderr.write(`${error.code||"development_analysis_error"}: ${error.message}\n`);process.exitCode=1;});
