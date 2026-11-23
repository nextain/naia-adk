"use strict";
// Approval gate tests: reviewer-policy.
const { test, makeWorkspace, path, fs, assert, deployPlan, createValidPlan, writePassingReviewReceipt, spawnSync, approvedRunner, sha256, writeGateConfig } = require("./approval-plan-fixtures.cjs");

test("unapproved temporary reviewer selection uses the default", (t) => {
 const {root} = makeWorkspace(t);
 const configPath = path.join(root, ".claude/deploy/config.json");
 fs.mkdirSync(path.dirname(configPath), {recursive: true});
 fs.writeFileSync(configPath, JSON.stringify({planReview: {reviewer: "codex", until: new Date(Date.now()+60000).toISOString()}}));
 assert.deepEqual(deployPlan.reviewerIdsFor("muse", root), ["argon"]);
 fs.writeFileSync(configPath, "{");
 assert.deepEqual(deployPlan.reviewerIdsFor("muse", root), ["argon"]);
 assert.ok(!deployPlan.formProblems({schema: "deploy-plan/v1", author_model: "codex"}).some(p => p.includes("author_model")));
 assert.ok(deployPlan.formProblems({schema: "deploy-plan/v1", author_model: "gemini"}).some(p => p.includes("author_model")));
});

test("codex receipt remains valid after configuration changes", (t) => {
 const { root } = makeWorkspace(t);
 const { planFile, gatesDir } = createValidPlan(root);
 const { planSha } = writePassingReviewReceipt(root, planFile, { reviewer: "codex" });
 const result = deployPlan.reviewProblems(gatesDir, planSha, root);
 assert.equal(result.ok, true, result.problems.join("; "));
 const configPath = path.join(root, ".claude/deploy/config.json");
 fs.mkdirSync(path.dirname(configPath), { recursive: true });
 fs.writeFileSync(configPath, JSON.stringify({ planReview: { reviewer: "argon" } }));
 assert.equal(deployPlan.reviewProblems(gatesDir, planSha, root).ok, true);
});

test("same author and unregistered reviewer receipts are rejected", (t) => {
 const { root } = makeWorkspace(t);
 const { planFile, gatesDir } = createValidPlan(root);
 const { planSha } = writePassingReviewReceipt(root, planFile);
 const file = path.join(gatesDir, deployPlan.REVIEW_FILE);
 const record = JSON.parse(fs.readFileSync(file));
 for (const model of [deployPlan.REVIEW_MODELS.muse.model, "unregistered-model"]) {
  record.reviewers[0].model = model;
  record.reviewers[0].receipt.model = model;
  fs.writeFileSync(file, JSON.stringify(record));
  assert.equal(deployPlan.reviewProblems(gatesDir, planSha, root).ok, false);
 }
});

test("approved reviewer aliases cannot review the author's original model", async (t) => {
 const pin = require("../lib/gate-config-pin.js");
 const {root} = makeWorkspace(t);
 const {planFile, gatesDir} = createValidPlan(root, {author_model: "muse"});
 const cfg = path.join(root, ".claude/deploy/config.json");
 fs.mkdirSync(path.dirname(cfg), {recursive: true});
 const id = "123456789012345678", channel = "234567890123456789", message = "345678901234567890";
 const run = async (models) => {
  fs.writeFileSync(cfg, JSON.stringify({review_models: models}));
  const code = pin.approvalCode(pin.snapshotGateConfig(root).hash);
  return deployPlan.withGateConfig({root, approverId: id, token: "test-only", refs: [{code, channelId: channel, messageId: message}],
   fetchImpl: async () => ({ok: true, json: async () => ({id: message, channel_id: channel, author: {id}, content: code})})}, () => {
    const {planSha} = writePassingReviewReceipt(root, planFile, {reviewer: "fable"});
    const file = path.join(gatesDir, deployPlan.REVIEW_FILE);
    const receipt = JSON.parse(fs.readFileSync(file));
    const at = new Date().toISOString();
    receipt.rotation = true; receipt.skipped = []; receipt.reviewedAt = at;
    receipt.reviewers[0].id = "fable";
    receipt.reviewers[0].receipt.started_at = at; receipt.reviewers[0].receipt.ended_at = at;
    fs.writeFileSync(file, JSON.stringify(receipt));
    return deployPlan.reviewProblems(gatesDir, planSha, root);
   });
 };
 const fable = (model) => ({model, effort: "xhigh", runner: "claude"});
 const original = deployPlan.REVIEW_MODELS.muse.model;
 const changedAuthor = {model: "muse-replacement", effort: "xhigh", runner: "muse"};
 const disguised = await run({muse: changedAuthor, fable: fable(original)});
 assert.equal(disguised.ok, false, "changing the muse entry must not allow its original model to review itself");
 assert.ok(disguised.problems.some((p) => p.includes("작성자와 같은 모델이 리뷰함")), disguised.problems.join("; "));
 const omitted = await run({fable: fable(original)});
 assert.equal(omitted.ok, false, "omitting the author entry must not remove the original model check");
 assert.ok(omitted.problems.some((p) => p.includes("작성자와 같은 모델이 리뷰함")), omitted.problems.join("; "));
 await assert.rejects(run({muse: changedAuthor, fable: fable(changedAuthor.model)}), /겹침/, "configured author model cannot be assigned to a second reviewer ID");
 const independent = await run({muse: changedAuthor, fable: fable("claude-fable-5-2")});
 assert.equal(independent.ok, true, independent.problems.join("; "));
});

test("fake codex reviewer runs through the complete review flow", (t) => {
 const { root, tmp, stateDir } = makeWorkspace(t);
 const { planFile, gatesDir } = createValidPlan(root);
 const init = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
 assert.equal(init.status, 0, init.stderr);
 const configPath = path.join(root, ".claude/deploy/config.json");
 fs.mkdirSync(path.dirname(configPath), { recursive: true });
 fs.writeFileSync(configPath, JSON.stringify({ planReview: { reviewer: "codex", until: new Date(Date.now() + 60000).toISOString(), reason: "temporary" } }));
 const binDir = path.join(tmp, "bin"), fakeHome = path.join(tmp, "home");
 fs.mkdirSync(binDir); fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
 const bwrap = path.join(binDir, "bwrap"), codex = path.join(binDir, "fake-codex");
 fs.writeFileSync(bwrap, '#!/bin/sh\nwhile [ "$1" != "--" ] && [ "$#" -gt 0 ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
 const body = ["판정: PASS", ...deployPlan.CRITERIA.map(([id]) => `${id}: PASS`), "남은 지적: 0"].join("\n");
 fs.writeFileSync(codex, `#!/bin/sh\n[ "$1" = exec ] || exit 19\nfor arg do last="$arg"; done\n[ "$last" = - ] || exit 20\ncat >/dev/null\nprintf 'codex\\n'\ncat <<'REVIEW_EOF'\n${body}\nREVIEW_EOF\nprintf 'tokens used\\n'\n`, { mode: 0o755 });
 const run = spawnSync(process.execPath, [approvedRunner(root, tmp, planFile)], {
  cwd: root, encoding: "utf8", timeout: 30000,
  env: { ...process.env, HOME: fakeHome, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, APPROVAL_PLAN_CODEX_BIN: codex, DEPLOY_APPROVAL_STATE_DIR: stateDir },
 });
 assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
 const record = JSON.parse(fs.readFileSync(path.join(gatesDir, deployPlan.REVIEW_FILE), "utf8"));
 assert.equal(record.reviewers[0].model, "gpt-6.1-terra");
 assert.equal(record.reviewers[0].receipt.isolation, "bwrap-ro-bind");
 assert.match(fs.readFileSync(path.join(gatesDir, record.reviewers[0].result), "utf8"), /review-run: .*\n$/);
});

test("reviewer selection uses only the approved configuration", async (t) => {
 const pin = require("../lib/gate-config-pin.js");
 const {root} = makeWorkspace(t);
 const now = Date.parse("2026-11-10T00:00:00Z");
 const file = path.join(root, ".claude/deploy/config.json");
 fs.mkdirSync(path.dirname(file), {recursive: true});
 const id = "123456789012345678", channel = "234567890123456789", message = "345678901234567890";
 const check = async (planReview) => {
  fs.writeFileSync(file, JSON.stringify({planReview}));
  const code = pin.approvalCode(pin.snapshotGateConfig(root).hash);
  return deployPlan.withGateConfig({root, approverId: id, token: "test-only", refs: [{code, channelId: channel, messageId: message}],
   fetchImpl: async () => ({ok: true, json: async () => ({id: message, channel_id: channel, author: {id}, content: code})})},
   () => deployPlan.reviewerIdsFor("muse", root, now));
 };
 assert.deepEqual(deployPlan.reviewerIdsFor("muse", root, now), ["argon"]);
 for (const until of ["2026-11-09T23:59:59Z", "2026-11-10T00:00:00Z", "invalid", "2026-02-30T23:40:00Z", "2025-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z", "2026-01-00T00:00:00Z", "2026-11-13", 123]) {
  assert.deepEqual(await check({reviewer: "codex", until}), ["argon"], String(until));
 }
 for (const reviewer of ["sol", "argon", "CODEX", " codex"]) assert.deepEqual(await check({reviewer, until: "2026-11-13T00:00:00Z"}), ["argon"], reviewer);
 for (const until of ["2026-11-13T23:40:00+09:00", "2026-11-13T23:40:00.123Z"]) assert.deepEqual(await check({reviewer: "codex", until}), ["codex"]);
 fs.writeFileSync(file, "{"); assert.deepEqual(deployPlan.reviewerIdsFor("muse", root, now), ["argon"]);
});

test("review models use only the Discord-approved configuration", async (t) => {
 const pin = require("../lib/gate-config-pin.js");
 const {root} = makeWorkspace(t);
 const {planFile, gatesDir} = createValidPlan(root);
 const file = path.join(gatesDir, deployPlan.REVIEW_FILE);
 const cfg = path.join(root, ".claude/deploy/config.json");
 fs.mkdirSync(path.dirname(cfg), {recursive: true});
 const set = (models) => fs.writeFileSync(cfg, JSON.stringify({review_models: models}));
 const id = "123456789012345678", channel = "234567890123456789", message = "345678901234567890";
 let calls = 0;
 const options = (code, author = id, extras = {}) => ({root, approverId: id, token: "test-only", refs: [{code, channelId: channel, messageId: message}],
  fetchImpl: async () => { calls++; return {ok: true, json: async () => ({id: message, channel_id: channel, author: {id: author}, content: `approve ${code}`, timestamp: "2000-01-01T00:00:00.000Z", ...extras})}; }});
 const currentCode = () => pin.approvalCode(pin.snapshotGateConfig(root).hash);
 assert.equal(pin.approvalCode("0".repeat(64)), "CFG-M2Q4VMRQV3", "formula uses standard base32 and the NUL separator");
 const {planSha, manifestSha: defaultManifest} = writePassingReviewReceipt(root, planFile, {reviewer: "argon"});
 const oldReceipt = JSON.parse(fs.readFileSync(file));
 const check = (receipt) => { fs.writeFileSync(file, JSON.stringify(receipt)); return deployPlan.reviewProblems(gatesDir, planSha, root); };
 assert.equal(check(oldReceipt).ok, true);
 const noEffort = structuredClone(oldReceipt); delete noEffort.reviewers[0].receipt.effort;
 assert.equal(check(noEffort).ok, false, "receipt.effort is required even for legacy records");
 set({argon: {model: "luna", effort: "medium", runner: "agy"}, muse: {model: "ember", effort: "medium", runner: "muse"}, codex: {model: "gpt-3.5", effort: "medium", runner: "codex"}});
 assert.deepEqual(deployPlan.reviewModelsFor(root), deployPlan.REVIEW_MODELS, "unapproved weaker models never replace defaults");
 await deployPlan.withGateConfig(options(currentCode(), "456789012345678901"), async () => assert.deepEqual(deployPlan.reviewModelsFor(root), deployPlan.REVIEW_MODELS, "another author cannot approve"));
 await deployPlan.withGateConfig(options(currentCode(), id, {webhook_id: "456789012345678901"}), async () => assert.deepEqual(deployPlan.reviewModelsFor(root), deployPlan.REVIEW_MODELS, "webhook cannot approve"));
 await deployPlan.withGateConfig(options(currentCode(), id, {author: {id, bot: true}}), async () => assert.deepEqual(deployPlan.reviewModelsFor(root), deployPlan.REVIEW_MODELS, "bot cannot approve"));
 set({argon: {model: "fable", effort: "high", runner: "claude"}});
 const approvedCode = currentCode();
 await deployPlan.withGateConfig(options(approvedCode), async () => {
  assert.deepEqual(deployPlan.reviewModelsFor(root).argon, {model: "fable", effort: "high", runner: "claude"});
  assert.deepEqual(Object.keys(deployPlan.reviewModelsFor(root)), ["argon"], "approved list does not silently include default reviewers");
  assert.notEqual(deployPlan.reviewInputManifest(planFile, root), defaultManifest);
  assert.equal(check(oldReceipt).ok, false, "previous receipt is invalid when the approved configuration changes");
  writePassingReviewReceipt(root, planFile, {reviewer: "argon"});
  const fableReceipt = JSON.parse(fs.readFileSync(file));
  assert.equal(check(fableReceipt).ok, true, "genuine approved Fable receipt accepted");
  fs.appendFileSync(cfg, " ");
  assert.deepEqual(deployPlan.reviewModelsFor(root), deployPlan.REVIEW_MODELS, "one byte change revokes the snapshot immediately");
 });
 await deployPlan.withGateConfig(options(approvedCode), async () => assert.deepEqual(deployPlan.reviewModelsFor(root), deployPlan.REVIEW_MODELS, "old approval does not approve changed content"));
 for (const model of ["-flag", "model\nflag"]) {
  set({argon: {model, effort: "high", runner: "claude"}});
  await deployPlan.withGateConfig(options(currentCode()), async () => assert.throws(() => deployPlan.reviewModelsFor(root), /model/));
 }
 assert.ok(calls >= 4, "all approval reads use the mock fetch");
});

test("approved Fable review invokes the Claude runner and accepts its receipt", async (t) => {
 const {root, tmp, stateDir} = makeWorkspace(t);
 const {planFile, gatesDir} = createValidPlan(root);
 const cfg = path.join(root, ".claude/deploy/config.json");
 fs.mkdirSync(path.dirname(cfg), {recursive: true});
 fs.writeFileSync(cfg, JSON.stringify({review_models: {fable: {model: "claude-fable-5-2", effort: "high", runner: "claude"}}, planReview: {reviewer: "fable", until: "2099-01-01T00:00:00Z"}}));
 assert.equal(spawnSync("git", ["init", "-q", root], {encoding: "utf8"}).status, 0);
 const binDir = path.join(tmp, "bin"), fakeHome = path.join(tmp, "home"), argvFile = path.join(tmp, "claude-argv.txt"), envFile = path.join(tmp, "claude-env.txt");
 fs.mkdirSync(binDir, {recursive: true}); fs.mkdirSync(fakeHome, {recursive: true});
 fs.writeFileSync(path.join(binDir, "bwrap"), '#!/bin/sh\nwhile [ "$1" != "--" ] && [ "$#" -gt 0 ]; do shift; done\nshift\nexec "$@"\n', {mode: 0o755});
 const body = ["판정: PASS", ...deployPlan.CRITERIA.map(([id]) => `${id}: PASS`), "참고 지적: 0", "남은 지적: 0"].join("\n");
 const fakeClaude = path.join(binDir, "fake-claude");
 fs.writeFileSync(fakeClaude, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\nif [ "\${CLAUDE_CODE_EFFORT_LEVEL+x}" = x ]; then printf present > "${envFile}"; else printf absent > "${envFile}"; fi\ncat >/dev/null\ncat <<'REVIEW_EOF'\n${body}\nREVIEW_EOF\n`, {mode: 0o755});
 const cli = path.join(root, ".agents/scripts/approval-plan.mjs");
 const runner = path.join(tmp, "run-approved.mjs");
 fs.writeFileSync(runner, `import {runApprovedApprovalPlan} from ${JSON.stringify(require("node:url").pathToFileURL(cli).href)};
` +
  `const {createRequire} = await import('node:module'); const req = createRequire(import.meta.url);
` +
  `const pin = req(${JSON.stringify(path.join(root, ".claude/hooks/lib/gate-config-pin.js"))});
` +
  `const root = ${JSON.stringify(root)}, plan = ${JSON.stringify(planFile)};
` +
  `const id='123456789012345678', channel='234567890123456789', message='345678901234567890';
` +
  `const code=pin.approvalCode(pin.snapshotGateConfig(root).hash);
` +
  `await runApprovedApprovalPlan({root, approverId:id, token:'test-only', refs:[{code,channelId:channel,messageId:message}], fetchImpl:async()=>({ok:true,json:async()=>({id:message,channel_id:channel,author:{id},content:code})})}, ['review',plan,'--author','muse']);
`);
 const result = spawnSync(process.execPath, [runner], {cwd: root, encoding: "utf8", timeout: 30000,
  env: {...process.env, HOME: fakeHome, XDG_STATE_HOME: path.join(tmp, "xdg-state"), PATH: `${binDir}${path.delimiter}${process.env.PATH}`, APPROVAL_PLAN_CLAUDE_BIN: fakeClaude, CLAUDE_CODE_EFFORT_LEVEL: "low", DEPLOY_APPROVAL_STATE_DIR: stateDir}});
 assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
 assert.deepEqual(fs.readFileSync(argvFile, "utf8").split("\n"), ["-p", "--model", "claude-fable-5-2", "--effort", "high", "--setting-sources", "", ""]);
 assert.equal(fs.readFileSync(envFile, "utf8"), "absent");
 const receipt = JSON.parse(fs.readFileSync(path.join(gatesDir, deployPlan.REVIEW_FILE)));
 assert.equal(receipt.reviewers[0].id, "fable");
 assert.equal(receipt.reviewers[0].receipt.effort, "high");
});

test("approved judge settings bind the incident verdict to the manifest", async (t) => {
 const pin = require("../lib/gate-config-pin.js");
 const {root, tmp, stateDir} = makeWorkspace(t);
 const {planFile, gatesDir} = createValidPlan(root);
 const cfg = path.join(root, ".claude/deploy/config.json");
 fs.mkdirSync(path.dirname(cfg), {recursive: true});
 const set = (effort) => fs.writeFileSync(cfg, JSON.stringify({review_models: {muse: {model: "muse-spark-2.0", effort, runner: "muse"}}}));
 set("high");
 const binDir = path.join(tmp, "bin"), fakeHome = path.join(tmp, "home"), argvFile = path.join(tmp, "judge-argv.txt");
 fs.mkdirSync(binDir, {recursive: true}); fs.mkdirSync(fakeHome, {recursive: true});
 const fakeMuse = path.join(binDir, "fake-muse"), evidence = path.join(tmp, "health.log");
 fs.writeFileSync(fakeMuse, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\nprintf '근거 요약\\nVERDICT: incident\\n'\n`, {mode: 0o755});
 fs.writeFileSync(evidence, "500 Internal Server Error x5\n");
 const runner = approvedRunner(root, tmp, planFile, ["judge", planFile, "--evidence", evidence, "--executor-session", "exec-sess-1"]);
 const result = spawnSync(process.execPath, [runner], {cwd: root, encoding: "utf8", timeout: 30000,
  env: {...process.env, HOME: fakeHome, XDG_STATE_HOME: path.join(tmp, "xdg-state"), APPROVAL_PLAN_MUSE_BIN: fakeMuse, DEPLOY_APPROVAL_STATE_DIR: stateDir}});
 assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
 const args = fs.readFileSync(argvFile, "utf8").trim().split("\n");
 assert.equal(args[args.indexOf("--model") + 1], "muse-spark-2.0");
 assert.equal(args[args.indexOf("--reasoning-effort") + 1], "high");
 const planSha = sha256(fs.readFileSync(planFile));
 const id = "123456789012345678", channel = "234567890123456789", message = "345678901234567890";
 const check = () => {
  const code = pin.approvalCode(pin.snapshotGateConfig(root).hash);
  return deployPlan.withGateConfig({root, approverId: id, token: "test-only", refs: [{code, channelId: channel, messageId: message}],
   fetchImpl: async () => ({ok: true, json: async () => ({id: message, channel_id: channel, author: {id}, content: code})})},
   () => deployPlan.incidentVerdict(gatesDir, planSha, "exec-sess-1", Date.now(), root));
 };
 assert.equal((await check()).ok, true);
 set("xhigh");
 assert.equal((await check()).ok, false, "newly approved effort invalidates the old verdict");
});

test("old fallback receipt cannot survive an approved reviewer change", async (t) => {
 const pin = require("../lib/gate-config-pin.js");
 const {root} = makeWorkspace(t);
 const {planFile, gatesDir} = createValidPlan(root);
 const cfg = path.join(root, ".claude/deploy/config.json"), file = path.join(gatesDir, deployPlan.REVIEW_FILE);
 const planSha = sha256(fs.readFileSync(planFile));
 const promptSha = sha256(deployPlan.reviewPrompt(JSON.parse(fs.readFileSync(planFile)), planSha, root));
 const body = ["판정: PASS", ...deployPlan.CRITERIA.map(([id]) => `${id}: PASS`), "참고 지적: 0", "남은 지적: 0", ""].join("\n");
 const text = `${body}review-run: target_sha256=${planSha} prompt_sha256=${promptSha} stdout_sha256=${sha256(body)}\n`;
 fs.writeFileSync(path.join(gatesDir, "codex-fallback.md"), text);
 const now = new Date().toISOString();
 const oldManifest = deployPlan.reviewInputManifest(planFile, root);
 const receipt = {plan_sha256: planSha, plan: path.relative(root, planFile), author_model: "muse", prompt_sha256: promptSha,
  rotation: true, skipped: [{id: "argon", reason: "limit", exit_code: 1, ended_at: now}], reviewedAt: now,
  reviewers: [{id: "codex", model: "gpt-6.1-terra", effort: "high", result: "codex-fallback.md", result_sha256: sha256(text), target_sha256: planSha,
   receipt: {model: "gpt-6.1-terra", effort: "high", started_at: now, ended_at: now, exit_code: 0, prompt_sha256: promptSha, stdout_sha256: sha256(body), input_manifest_sha256: oldManifest}}]};
 fs.writeFileSync(file, JSON.stringify(receipt));
 assert.equal(deployPlan.reviewProblems(gatesDir, planSha, root).ok, true, "fallback receipt passes before change");
 fs.mkdirSync(path.dirname(cfg), {recursive: true});
 fs.writeFileSync(cfg, JSON.stringify({review_models: {argon: {model: "fable", effort: "high", runner: "claude"}}}));
 const code = pin.approvalCode(pin.snapshotGateConfig(root).hash);
 const id = "123456789012345678", channel = "234567890123456789", message = "345678901234567890";
 await deployPlan.withGateConfig({root, approverId: id, token: "test-only", refs: [{code, channelId: channel, messageId: message}],
  fetchImpl: async () => ({ok: true, json: async () => ({id: message, channel_id: channel, author: {id}, content: code})})}, async () => {
   assert.notEqual(deployPlan.reviewInputManifest(planFile, root), oldManifest);
   const result = deployPlan.reviewProblems(gatesDir, planSha, root);
   assert.equal(result.ok, false, "old fallback receipt rejected after approval");
   assert.ok(result.problems.some((p) => p.includes("input manifest")), result.problems.join("; "));
  });
});

test("review gate enforces reviewer identity, count and effort", (t) => {
 const {root} = makeWorkspace(t);
 const {planFile, gatesDir} = createValidPlan(root);
 const file = path.join(gatesDir, deployPlan.REVIEW_FILE);
 for (const reviewer of ["argon", "codex"]) {
  const {planSha} = writePassingReviewReceipt(root, planFile, {reviewer});
  const valid = JSON.parse(fs.readFileSync(file));
  const check = (record, expected, label) => { fs.writeFileSync(file, JSON.stringify(record)); const result = deployPlan.reviewProblems(gatesDir, planSha, root); assert.equal(result.ok, expected, `${label}: ${result.problems.join('; ')}`); };
  check(valid, true, reviewer);
  for (const [label, change] of [
   ["zero", r => {r.reviewers=[];}],
   ["two", r => {r.reviewers.push(structuredClone(r.reviewers[0]));}],
   ["muse", r => {r.reviewers[0].model=deployPlan.REVIEW_MODELS.muse.model; r.reviewers[0].receipt.model=r.reviewers[0].model;}],
   ["sol", r => {r.reviewers[0].model=deployPlan.REVIEW_MODELS.sol.model; r.reviewers[0].receipt.model=r.reviewers[0].model;}],
   ["id mismatch", r => {r.reviewers[0].id=reviewer === "argon" ? "codex" : "argon";}],
   ["effort", r => {r.reviewers[0].effort="wrong";}],
  ]) { const rec=structuredClone(valid); change(rec); check(rec, false, `${reviewer} ${label}`); }
 }
});

test("legacy authors still require their two distinct reviewers", (t) => {
 for (const author of ["sol", "argon"]) {
  const {root} = makeWorkspace(t);
  const {planFile, gatesDir} = createValidPlan(root, {author_model:author});
  const file = path.join(gatesDir, deployPlan.REVIEW_FILE);
  const ids = deployPlan.reviewerIdsFor(author, root);
  const entries = [];
  let planSha;
  for (const reviewer of ids) {
   ({planSha} = writePassingReviewReceipt(root, planFile, {reviewer, bodyMarker:` ${reviewer}`}));
   entries.push(JSON.parse(fs.readFileSync(file)).reviewers[0]);
  }
  const record = JSON.parse(fs.readFileSync(file)); record.reviewers=entries;
  fs.writeFileSync(file, JSON.stringify(record));
  let result = deployPlan.reviewProblems(gatesDir, planSha, root);
  assert.equal(result.ok, true, `${author}: ${result.problems.join('; ')}`);
  record.reviewers.pop(); fs.writeFileSync(file, JSON.stringify(record));
  result = deployPlan.reviewProblems(gatesDir, planSha, root);
  assert.equal(result.ok, false, author);
 }
});

test("codex reviewer refuses to run without bwrap outside recovery mode", (t) => {
 const {root, tmp, stateDir} = makeWorkspace(t);
 const {planFile} = createValidPlan(root);
 assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
 const configPath = path.join(root, ".claude/deploy/config.json");
 fs.mkdirSync(path.dirname(configPath), {recursive:true});
 fs.writeFileSync(configPath, JSON.stringify({planReview:{reviewer:"codex", until:new Date(Date.now()+60000).toISOString()}}));
 const binDir=path.join(tmp,"bin"), fakeHome=path.join(tmp,"home"), marker=path.join(tmp,"ran"), codex=path.join(binDir,"fake-codex");
 fs.mkdirSync(binDir); fs.mkdirSync(fakeHome);
 fs.symlinkSync(process.platform === "win32" ? "git.exe" : "/usr/bin/git", path.join(binDir,"git"));
 fs.writeFileSync(codex, `#!/bin/sh\n : > "${marker}"\nexit 0\n`, {mode:0o755});
 const run=spawnSync(process.execPath,[approvedRunner(root, tmp, planFile)], {cwd:root, encoding:"utf8", timeout:30000, env:{...process.env, HOME:fakeHome, PATH:binDir, APPROVAL_PLAN_CODEX_BIN:codex, DEPLOY_APPROVAL_STATE_DIR:stateDir}});
 assert.notEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
 assert.match(`${run.stdout}\n${run.stderr}`, /sandbox-prepare/);
 assert.equal(fs.existsSync(marker), false);
});

test("위험 수용: security FAIL 하나만, 결정 글·같은 값·끝나는 날이 맞을 때만 리뷰 관문을 지남", (t) => {
	const goodRa = () => ({ criterion: "security", accepted_by: "approver", decision_url: "https://discord.com/channels/1/2/3", same_value_as: "앞 판 번들 같은 지문 0123456789ab", no_new_exposure: true, expires_at: new Date(Date.now() + 86400000).toISOString(), reason: "이미 공개된 같은 시연 값, 새 노출 없음" });
	const secLine = ["1. [차단: security] 공개 번들에 시연 값"];
	const cases = [
		{ desc: "맞는 위험 수용 + security FAIL 만", ra: goodRa(), fail: ["security"], open: 1, extra: secLine, pass: true },
		{ desc: "위험 수용 + correctness 도 FAIL", ra: goodRa(), fail: ["security", "correctness"], open: 1, extra: secLine, pass: false },
		{ desc: "위험 수용 + security 차단 지적 두 건(두 번째 새 비밀)", ra: goodRa(), fail: ["security"], open: 2, extra: [...secLine, "2. [차단: security] 새 열쇠가 번들에 들어감"], pass: false },
		{ desc: "위험 수용 + security 차단 지적 두 건, 남은 지적 1로 적음", ra: goodRa(), fail: ["security"], open: 1, extra: [...secLine, "2. [차단: security] 새 열쇠가 번들에 들어감"], pass: false },
		{ desc: "위험 수용 + security 아닌 차단 지적", ra: goodRa(), fail: ["security"], open: 2, extra: [...secLine, "2. [차단: 불일치] 명령이 다름"], pass: false },
		{ desc: "결정 글 주소 없음", ra: { ...goodRa(), decision_url: "" }, fail: ["security"], open: 1, extra: secLine, pass: false },
		{ desc: "새 노출", ra: { ...goodRa(), no_new_exposure: false }, fail: ["security"], open: 1, extra: secLine, pass: false },
		{ desc: "다른 기준 수용", ra: { ...goodRa(), criterion: "rollback" }, fail: ["rollback"], open: 0, extra: [], pass: false },
		{ desc: "끝나는 날 8일 뒤", ra: { ...goodRa(), expires_at: new Date(Date.now() + 8 * 86400000).toISOString() }, fail: ["security"], open: 1, extra: secLine, pass: false },
		{ desc: "끝나는 날 지남", ra: { ...goodRa(), expires_at: new Date(Date.now() - 1000).toISOString() }, fail: ["security"], open: 1, extra: secLine, pass: false, createdAt: new Date(Date.now() - 3600000).toISOString() },
		{ desc: "위험 수용 없음", ra: undefined, fail: ["security"], open: 1, extra: secLine, pass: false },
	];
	for (const c of cases) {
		const { root } = makeWorkspace(t);
		writeGateConfig(root);
		const overrides = {};
		if (c.ra) overrides.risk_acceptance = c.ra;
		if (c.createdAt) overrides.createdAt = c.createdAt;
		const { planFile, gatesDir } = createValidPlan(root, overrides);
		const { planSha } = writePassingReviewReceipt(root, planFile, { fail: c.fail, open: c.open, extra: c.extra });
		const review = deployPlan.reviewProblems(gatesDir, planSha, root);
		assert.equal(review.ok, c.pass, `${c.desc}: ${review.problems.join(" / ")}`);
	}
});
