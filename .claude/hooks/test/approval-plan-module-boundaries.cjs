"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { makeWorkspace, createValidPlan, REPO_ROOT, deployPlan } = require("./approval-plan-fixtures.cjs");
const golden = require("./fixtures/approval-plan-public-api.json");

test("module extraction preserves the complete published plan API", () => {
 assert.deepEqual(Object.keys(deployPlan).sort(), [...Object.keys(golden.shape), "REVIEW_EXECUTOR_FILES"].sort());
 for (const [name, expected] of Object.entries(golden.shape)) {
  const value = deployPlan[name];
  if (expected.kind === "function") {
   assert.equal(typeof value, "function", name);
   assert.equal(value.length, expected.arity, name);
  } else {
   assert.equal(typeof value, expected.kind, name);
   assert.deepEqual(value instanceof RegExp ? String(value) : value, expected.value, name);
  }
 }
});

test("legacy scope and PLAN/STEP code vectors remain byte-identical", {
 skip: process.platform === "win32" || fs.realpathSync("/tmp") !== golden.scopeAnchor,
}, () => {
 const input = { root: golden.scopeAnchor, file: "/tmp/scope-golden/gates/deploy-plan.json",
  plan: { scenario: [{ id: "s1", commands: ["echo specimen"] }], incident: { actions: [] } },
  sha: "2".repeat(64), manifest: "3".repeat(64), sessionId: "legacy-characterization" };
 for (const [index, fixture] of golden.legacyScopes.entries()) {
  const actual = deployPlan.approvalScope(input, index ? input.plan.scenario[0] : null);
  assert.deepEqual(actual, fixture.scope);
  assert.equal(deployPlan.matchesIssuedApproval(fixture.row, actual), true);
  assert.equal(deployPlan.matchesIssuedApproval({ ...fixture.row, nonce: "5".repeat(32) }, actual), false);
 }
});

test("extracted context views cannot rewrite the private registered domain", async t => {
 const { tmp, root } = makeWorkspace(t), plan = createValidPlan(root);
 const site = path.join(tmp, "site"); fs.mkdirSync(site);
 const context = require("../lib/deploy-plan-context.js");
 assert.equal(context.gateConfigContext, undefined);
 assert.equal(context.gateConfigView.run, undefined);
 await deployPlan.withGateConfig({ root, reviewProfiles: [{ id: "site", root: site, policy: "strict-defaults" }], admissionProfile: "site" }, async () => {
  const input = { root, file: plan.planFile, plan: plan.plan, sha: "2".repeat(64), manifest: "3".repeat(64), sessionId: "context-test" };
  const before = deployPlan.approvalScope(input);
  const view = context.gateConfigView.getStore(); view.admissionDomain = "forged";
  context.registeredReviewProfiles(root)[0].hash = "forged";
  await Promise.resolve();
  assert.deepEqual(deployPlan.approvalScope(input), before);
  assert.deepEqual(deployPlan.registeredReviewProfileIds(root), ["site"]);
 });
 assert.equal(context.gateConfigView.getStore(), undefined);
});

test("registered contexts stay isolated across concurrent and nested awaits", async t => {
 const fixtures = [makeWorkspace(t), makeWorkspace(t)];
 const registrations = fixtures.map((item, index) => {
  const site = path.join(item.tmp, "site"); fs.mkdirSync(site);
  return { root: item.root, reviewProfiles: [{ id: "site" + index, root: site, policy: "strict-defaults" }], admissionProfile: "site" + index };
 });
 let entered = 0, release;
 const barrier = new Promise(resolve => { release = resolve; });
 await Promise.all(registrations.map(async (registration, index) => {
  const plan = createValidPlan(registration.root);
  const input = { root: registration.root, file: plan.planFile, plan: plan.plan,
   sha: "2".repeat(64), manifest: "3".repeat(64), sessionId: "concurrent-context" };
  const legacy = deployPlan.approvalScope(input);
  await deployPlan.withGateConfig(registration, async () => {
   const before = deployPlan.approvalScope(input);
   assert.notDeepEqual(before, legacy);
   if (++entered === 2) release();
   await barrier;
   assert.deepEqual(deployPlan.registeredReviewProfileIds(registration.root), ["site" + index]);
   await assert.rejects(deployPlan.withGateConfig(registrations[1 - index], async () => {
    await Promise.resolve();
    assert.deepEqual(deployPlan.registeredReviewProfileIds(registrations[1 - index].root), ["site" + (1 - index)]);
    throw new Error("nested completion");
   }), /nested completion/);
   assert.deepEqual(deployPlan.approvalScope(input), before);
  });
  assert.deepEqual(deployPlan.approvalScope(input), legacy);
 }));
});

test("a preloaded extracted executor is rejected by the real cold CLI", async t => {
 const { root } = makeWorkspace(t);
 const cli = pathToFileURL(path.join(root, ".agents/scripts/approval-plan.mjs")).href;
 for (const relative of [".claude/hooks/lib/deploy-plan-common.js", ".claude/hooks/lib/deploy-readiness-io.js", ".agents/scripts/approval-plan-files.cjs"]) {
  const code = `import {createRequire} from 'node:module'; const r=createRequire(import.meta.url); r(${JSON.stringify(path.join(root, relative))}); await import(${JSON.stringify(cli)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(result.status, 1, relative);
  assert.match(result.stderr, /require\.cache/);
 }
});

test("the official runtime returns one plan policy and readiness graph without executing the CLI", async t => {
 const { root } = makeWorkspace(t);
 const cli = pathToFileURL(path.join(root, ".agents/scripts/approval-plan.mjs")).href;
 const code = `import {createRequire} from 'node:module'; const m=await import(${JSON.stringify(cli)}); const r=createRequire(import.meta.url); const x=m.loadDeployGateRuntime();
 if(x!==m.loadDeployGateRuntime()||!Object.isFrozen(x))throw Error('runtime identity');
 for(const [key,file] of Object.entries({plan:'.claude/hooks/lib/deploy-plan.js',policy:'.agents/hooks/policies/bash.js',readiness:'.claude/hooks/lib/deploy-readiness.js'}))if(x[key]!==r(${JSON.stringify(root)}+'/'+file))throw Error('split '+key);
 console.log('ONE_GRAPH');`;
 const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
 assert.equal(result.status, 0, result.stderr);
 assert.equal(result.stdout.trim(), "ONE_GRAPH");
});

test("the cold CLI executes verified module bytes rather than reopening changed files", t => {
 const { root } = makeWorkspace(t);
 const cli = pathToFileURL(path.join(root, ".agents/scripts/approval-plan.mjs")).href;
 const target = path.join(root, ".claude/hooks/lib/deploy-plan-common.js");
 const code = `import fs from 'node:fs'; const original=fs.readFileSync; let changed=false;
 fs.readFileSync=function(file,...args){const bytes=original.call(this,file,...args);if(String(file)===${JSON.stringify(target)}&&!changed){changed=true;fs.appendFileSync(file,"\\nthrow new Error('UNVERIFIED_REOPEN');\\n");}return bytes;};
 const m=await import(${JSON.stringify(cli)}); if(!changed)throw Error('fixture did not change source'); await m.runApprovalPlan(['template']);`;
 const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
 assert.equal(result.status, 0, result.stderr);
 assert.equal(JSON.parse(result.stdout).schema, "deploy-plan/v1");
});
