import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { digestCanonical } from "./validate-bundle.mjs";

const stripFence = (text) => text.trim().replace(/^```(?:javascript|js|json)?\s*/iu,"").replace(/\s*```$/u,"");
const readStdin = async () => { let data=""; for await (const chunk of process.stdin) data+=chunk; return JSON.parse(data); };

function scoreCode(candidate,fixture) {
  const submission=JSON.parse(stripFence(candidate));
  if (!submission || !Array.isArray(submission.outputs) || submission.outputs.length!==fixture.input.cases.length) throw new Error("candidate output vector length does not match the retained cases");
  for (let index=0;index<fixture.input.cases.length;index++) if (digestCanonical(submission.outputs[index])!==digestCanonical(fixture.input.cases[index].expected)) throw new Error(`case ${index+1} output mismatch`);
  return {status:"valid_pass",reason:`all ${fixture.input.cases.length} declarative case outputs matched`};
}

function scoreStructural(candidate,fixture) {
  const observation=JSON.parse(stripFence(candidate));
  for (const [key,expected] of Object.entries(fixture.oracle)) assert.deepStrictEqual(observation[key],expected);
  return {status:"valid_pass",reason:`all ${Object.keys(fixture.oracle).length} structural oracle fields matched`};
}

try {
  const request=await readStdin();
  const fixtureBytes=fs.readFileSync(request.fixture_path),scorerBytes=fs.readFileSync(request.scorer_path);
  const fixture=JSON.parse(fixtureBytes),scorer=JSON.parse(scorerBytes);
  if (createHash("sha256").update(fixtureBytes).digest("hex") !== request.fixture_digest) throw new Error("fixture digest mismatch");
  if (createHash("sha256").update(scorerBytes).digest("hex") !== request.scorer_digest) throw new Error("scorer artifact digest mismatch");
  let decision;
  try { decision=fixture.kind === "legacy_code" ? scoreCode(request.candidate,fixture) : scoreStructural(request.candidate,fixture); }
  catch (error) { decision={status:"valid_fail",reason:error.message}; }
  const receipt={principal:"native-deterministic-scorer",provider:"node:declarative",model:null,execution_id:`score-${process.pid}-${Date.now()}`,fixture_digest:request.fixture_digest,scorer_digest:request.scorer_digest,status:decision.status,outcome_class:"task_result",reason:decision.reason};
  receipt.evidence_digest=digestCanonical({...receipt,candidate_digest:digestCanonical(request.candidate)});
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode=1;
}
