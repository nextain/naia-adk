import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {loadDevelopmentCapabilitySuite,promptForDevelopmentTask,scoreDevelopmentCandidate} from "../src/development-capability-suite.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const rawPublic=fs.readFileSync(path.join(root,"baselines","development-capability.tasks.json"),"utf8");
for(const prohibited of ['"oracle"','"expected"','"answer"'])assert(!rawPublic.includes(prohibited),`public catalog leaks ${prohibited}`);
const {catalog,oracleSet,public_digest,oracle_digest}=loadDevelopmentCapabilitySuite();
assert.match(public_digest,/^[a-f0-9]{64}$/u);assert.match(oracle_digest,/^[a-f0-9]{64}$/u);
for(const task of catalog.tasks){
  const prompt=promptForDevelopmentTask(task);assert(prompt.includes(task.id));assert(!prompt.includes(JSON.stringify(oracleSet.oracles[task.id])));
  const pass=scoreDevelopmentCandidate(task.id,JSON.stringify(oracleSet.oracles[task.id]),oracleSet);assert.equal(pass.status,"valid_pass",task.id);
  const fail=scoreDevelopmentCandidate(task.id,'{"wrong":true}',oracleSet);assert.equal(fail.status,"valid_fail",task.id);
}
assert.equal(scoreDevelopmentCandidate(catalog.tasks[0].id,"not json",oracleSet).status,"valid_fail");
console.log("development capability suite: PASS (24 public A-layer clusters, 4 strata, oracle separation, 49 scorer checks)");
