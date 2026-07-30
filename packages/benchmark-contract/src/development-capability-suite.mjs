import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestCanonical } from "./validate-bundle.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const publicPath=path.join(root,"baselines","development-capability.tasks.json");
const oraclePath=path.join(root,"scorers","development-capability.oracles.json");
const read=(file)=>JSON.parse(fs.readFileSync(file,"utf8"));

export function loadDevelopmentCapabilitySuite() {
  const catalog=read(publicPath),oracleSet=read(oraclePath);
  if(catalog.schema_revision!=="development-capability-v1"||catalog.status!=="development_only_no_production_claim"||catalog.execution_owner!=="candidate-model-provider-adapter"||catalog.profile!=="common-no-tool-json")throw new Error("development capability catalog identity invalid");
  if(catalog.tasks.length!==24||new Set(catalog.tasks.map(item=>item.id)).size!==24)throw new Error("development capability catalog must contain 24 unique tasks");
  const familyCounts=Object.fromEntries([...new Set(catalog.tasks.map(item=>item.family))].map(family=>[family,catalog.tasks.filter(item=>item.family===family).length]));
  if(JSON.stringify(familyCounts)!==JSON.stringify({algorithmic_output:9,review_detection:5,contract_reasoning:5,structured_extraction:5}))throw new Error("development capability family strata invalid");
  if(catalog.tasks.some(item=>!oracleSet.oracles[item.id])||Object.keys(oracleSet.oracles).some(id=>!catalog.tasks.find(item=>item.id===id)))throw new Error("development oracle binding incomplete");
  return {catalog,public_digest:digestCanonical(catalog),oracle_digest:digestCanonical(oracleSet),oracleSet};
}

export function promptForDevelopmentTask(task) {
  if(!task||typeof task.prompt!=="string")throw new Error("development task invalid");
  return `NAIA DEVELOPMENT PILOT ${task.id}\nNo tools. Return exactly one JSON object and no prose. Do not score yourself.\n${task.prompt}`;
}

export function scoreDevelopmentCandidate(taskId,candidate,oracleSet=loadDevelopmentCapabilitySuite().oracleSet) {
  let parsed;
  try{parsed=JSON.parse(candidate);}catch{return {status:"valid_fail",reason:"candidate output is not one JSON value",evidence_digest:digestCanonical({taskId,candidate_digest:digestCanonical(candidate),reason:"json_parse"})};}
  const expected=oracleSet.oracles[taskId];
  if(!expected)throw new Error(`unknown development task ${taskId}`);
  const pass=digestCanonical(parsed)===digestCanonical(expected);
  return {status:pass?"valid_pass":"valid_fail",reason:pass?"exact structural oracle match":"structural oracle mismatch",evidence_digest:digestCanonical({taskId,candidate:parsed,expected_digest:digestCanonical(expected)})};
}
