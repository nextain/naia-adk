#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const root = path.resolve(__dirname, "..", "..", "..");
const policy = require(path.join(root, ".agents", "hooks", "policies", "bash.js"));
const harnessCore = require(path.join(root, ".agents", "hooks", "core", "harness-core.js"));
const sessionContract = require(path.join(root, ".agents", "hooks", "core", "session-contract.js"));

const { readAgentsRules } = require(path.join(root, ".agents", "hooks", "core", "agents-rules-load.js"));
const rules = readAgentsRules(root);
const authority = rules.ai_workflow.routine_execution_authority;
assert.ok(authority, "routine execution authority must be mandatory session context");
assert.match(authority.delegation_inheritance, /Every subagent, delegated agent, and nested delegate inherits/);
assert.ok(authority.routine_steps.some((step) => /non-force non-deleting push/i.test(step)));
assert.ok(authority.ask_only_for.some((step) => /force push/i.test(step)));
assert.ok(authority.ask_only_for.some((step) => /materially expand or change/i.test(step)));
assert.match(rules.ai_workflow.permission_model.bounded_recording_exception, /without another approval prompt/);
assert.match(rules.ai_workflow.permission_model.material_decision_boundary, /product, architecture, interface, policy/);

const workflow = fs.readFileSync(path.join(root, ".agents", "workflows", "issue-driven-development.yaml"), "utf8");
assert.match(workflow, /non-force-push is T1, not T3/);
for (const phase of ["understand", "scope", "plan"]) {
  assert.match(workflow, new RegExp(`\\n  ${phase}:\\n[\\s\\S]*?\\n    gate: true`), `${phase} material-decision gate must remain`);
}
assert.doesNotMatch(workflow, /must not proceed without user confirmation/);
assert.match(workflow, /internal checkpoint for bounded requests/);
assert.match(workflow, /ask only if a missing material choice changes the result/);
assert.match(workflow, /ask_when: "An unresolved assumption can materially change the result"/);

for (const command of [
  "git push",
  "git push origin main",
  "git push --set-upstream origin feature/routine",
  "git push origin HEAD:feature/routine",
  "git push origin refs/tags/v1.0.0",
  "git push origin 'feature/quoted'",
  "git -c push.default=current push origin main",
  "git --no-pager push origin main",
  "git -P push origin main",
  "git.exe push origin main",
  "git push --tags origin",
  "git fetch origin; git merge origin/main; git push origin main",
]) {
  assert.equal(policy.gitPush(command), null, `routine command must not ask again: ${command}`);
}

// Opt-in protected branches: the shipped list is empty, so routine push above stays open;
// `git push --all` is blocked regardless.
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".agents", "context", "push-protected-branches.json"), "utf8")).protected_branches, [], "protected branches must be opt-in (default empty)");
for (const command of ["git push --all", "git push --all origin", "git push origin --all", "git -c push.default=current push --all origin", "git push -u --all origin"]) {
  assert.match(policy.gitPush(command)?.reason || "", /PUSH --all/, `--all must be blocked: ${command}`);
}
const protectedOn = { protectedBranches: ["main", "master"], currentBranch: "feature/x" };
for (const command of ["git push origin main", "git push origin HEAD:main", "git push origin feature/x:refs/heads/master", "git push --set-upstream origin main", "git push origin 'main'", "git push -o ci.skip origin main"]) {
  assert.match(policy.gitPush(command, protectedOn)?.reason || "", /보호 가지/, `protected push must be blocked: ${command}`);
}
for (const command of ["git push", "git push origin", "git push origin HEAD"]) {
  assert.equal(policy.gitPush(command, protectedOn), null, `non-protected current branch push stays open: ${command}`);
  assert.match(policy.gitPush(command, { ...protectedOn, currentBranch: "main" })?.reason || "", /보호 가지/, `bare push from a protected branch must be blocked: ${command}`);
}
for (const command of ["git push origin feature/x", "git push origin HEAD:feature/y", "git push origin refs/tags/v1.0.0", "git push --tags origin", "git push origin main-fix"]) {
  assert.equal(policy.gitPush(command, protectedOn), null, `other targets stay open: ${command}`);
}
for (const command of ["git push --branches", "git push --branches origin", "git push origin --branches"]) {
  assert.match(policy.gitPush(command)?.reason || "", /PUSH --all/, `--branches (alias of --all) must be blocked: ${command}`);
}
// The branch checked is the one of the repository the command really pushes from (cd / -C / --git-dir), not the hook's cwd.
{
  const { execFileSync } = require("child_process");
  const os = require("os");
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "push-scope-"));
  const child = path.join(top, "child");
  fs.mkdirSync(child);
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
  git(top, "init", "-q", "-b", "work"); git(top, "commit", "-q", "--allow-empty", "-m", "i");
  git(child, "init", "-q", "-b", "main"); git(child, "commit", "-q", "--allow-empty", "-m", "i");
  const onTop = { protectedBranches: ["main"], cwd: top };
  for (const command of ["git -C child push origin HEAD", "git -C child push", "cd child && git push origin HEAD", "cd child; git push", "(cd child && git push origin HEAD)", "git --git-dir=child/.git push origin HEAD", "git -C . -C child push origin HEAD"]) {
    assert.match(policy.gitPush(command, onTop)?.reason || "", /보호 가지/, `push from the child repo on a protected branch must be blocked: ${command}`);
  }
  for (const command of ["git push origin HEAD", "git -C . push origin HEAD", "cd child && cd .. && git push origin HEAD"]) {
    assert.equal(policy.gitPush(command, onTop), null, `push from the unprotected top repo stays open: ${command}`);
  }
  assert.match(policy.gitPush("git push origin HEAD", { protectedBranches: ["main"], cwd: child })?.reason || "", /보호 가지/, "hook cwd inside the protected repo is still checked");
  fs.rmSync(top, { recursive: true, force: true });
}
assert.equal(policy.gitPush("git push origin main", { protectedBranches: [] }), null, "empty list keeps main open");
assert.match(policy.gitPush("git push --force origin main", protectedOn)?.reason || "", /FORCE PUSH/, "force wording is unchanged");

for (const command of [
  "git push --force origin main",
  "git push --force-with-lease origin main",
  "git push -f origin main",
  "git push -fu origin main",
  "git push -uf origin main",
  "git push \"--force\" origin main",
  "git -c push.default=current push --force origin main",
  "git --no-pager push --force origin main",
  "git -P push --force origin main",
  "git.exe push --force origin main",
  "git push origin +main",
]) {
  assert.match(policy.gitPush(command)?.reason || "", /FORCE PUSH/, `history rewrite must stay blocked: ${command}`);
}

for (const command of [
  "git push --delete origin obsolete",
  "git push '--delete' origin obsolete",
  "git -c push.default=current push --delete origin obsolete",
  "git --no-pager push --delete origin obsolete",
  "git.exe push origin :refs/heads/obsolete",
  "git push -d origin obsolete",
  "git push --mirror origin",
  "git push --prune origin",
  "git push origin :obsolete",
  "git push origin :refs/heads/obsolete",
  "git push origin :refs/tags/v0.9.0",
  "powershell -Command \"git push origin ':refs/tags/v0.9.0'\"",
]) {
  assert.match(policy.gitPush(command)?.reason || "", /REMOTE REF DELETE/, `remote ref deletion must stay blocked: ${command}`);
}

for (const command of [
  "git reset --hard HEAD~1",
  "git.exe reset --hard HEAD~1",
  "git -c advice.detachedHead=false reset --hard HEAD~1",
  "git --no-pager clean -fd",
  "git -P checkout -- tracked.txt",
]) {
  assert.match(policy.destructiveGit(command)?.reason || "", /파괴적 git/, `destructive Git variant must stay blocked: ${command}`);
}
for (const command of ["git status", "git.exe clean -n", "git --no-pager checkout feature/safe"]) {
  assert.equal(policy.destructiveGit(command), null, `non-destructive Git variant must pass: ${command}`);
}
assert.match(policy.emailSend("node send.js send")?.reason || "", /외부 이메일 발송/);
assert.match(policy.prGuard("gh issue create --repo third-party/project --title x --body y", {})?.reason || "", /외부 repo/);
for (const command of [
  "gh pr merge 5 --admin",
  "gh pr merge --admin 5 --squash",
  "gh pr merge 5 --squash --admin --repo nextain/naia-adk",
  "gh pr merge 5 --admin=true",
  "gh pr merge 5 --repo nextain/naia-adk --admin",
  "gh -R nextain/naia-adk pr merge 5 --admin",
  "cd x && gh pr merge 5 --admin",
  "gh pr merge 5 \"--admin\"",
  "gh api -X PUT repos/nextain/naia-adk/pulls/5/merge",
]) {
  assert.match(policy.prGuard(command, {})?.reason || "", /관리자 우회/, `admin merge must be blocked: ${command}`);
}
assert.equal(policy.prGuard("gh pr merge 5 --squash --repo nextain/naia-adk", {}) , null, "plain squash merge to nextain passes");
assert.equal(policy.prGuard("git push origin feature", {}), null, "feature push is not a gh write");
assert.equal(policy.prGuard("echo admin; gh pr view 5", {}), null);
// Force pushes (--force, --force-with-lease, +refspec) are blocked for every branch, main included.
for (const command of ["git push --force origin main", "git push origin --force-with-lease main", "git push origin +main", "git push origin +HEAD:main", "git push -f origin main"]) {
  assert.match(policy.gitPush(command)?.reason || "", /FORCE PUSH/, `force push must be blocked: ${command}`);
}
assert.equal(policy.gitPush("git push origin feature"), null);

const routing = fs.readFileSync(path.join(root, ".agents", "context", "development-model-routing.yaml"), "utf8");
assert.match(routing, /Every delegated or nested role inherits/);

const pushPolicy = fs.readFileSync(path.join(root, ".agents", "context", "push-policy.yaml"), "utf8");
assert.match(pushPolicy, /deprecated_bypasses/);
assert.match(pushPolicy, /MUST NOT be recommended or used/);
assert.doesNotMatch(pushPolicy, /recommended:\s*A/);

const editPolicy = fs.readFileSync(path.join(root, ".agents", "hooks", "policies", "edit.js"), "utf8");
assert.match(editPolicy, /재승인을 묻지 말고 임시 unlock을 활성화/);
assert.match(editPolicy, /설계 결정 변경/);

const behLedger = fs.readFileSync(path.join(root, ".agents", "hooks", "core", "beh-ledger.js"), "utf8");
assert.doesNotMatch(behLedger, /사용자 재승인/);
assert.match(behLedger, /동일한 bounded scope/);
assert.match(behLedger, /재승인 없이 계속/);
const superviseCore = fs.readFileSync(path.join(root, ".agents", "hooks", "core", "beh-supervise-core.js"), "utf8");
assert.doesNotMatch(superviseCore, /user-approved|사용자 미승인/);
assert.match(superviseCore, /not a conversational or per-turn approval gate/);

const researchWorkflow = fs.readFileSync(path.join(root, ".agents", "workflows", "research-driven-development.yaml"), "utf8");
assert.match(researchWorkflow, /authorized Charter is the active scope boundary/);
assert.match(researchWorkflow, /internal checkpoint inside an authorized Charter/);
assert.doesNotMatch(researchWorkflow, /User-confirmed research state|Gates \(user confirmation required\)/);
const verifySkill = fs.readFileSync(path.join(root, ".agents", "skills", "verify-implementation", "SKILL.md"), "utf8");
assert.match(verifySkill, /범위 내 구현·테스트·문서 정합성 결함은 반복 승인 없이 자동 수정/);
const reviewSkill = fs.readFileSync(path.join(root, ".agents", "skills", "review-pass", "SKILL.md"), "utf8");
const reviewConsensus = fs.readFileSync(path.join(root, ".agents", "skills", "review-pass", "references", "consensus-and-convergence.md"), "utf8");
assert.match(reviewConsensus, /Do not turn CONTESTED into an automatic user prompt/);
assert.match(reviewConsensus, /Only a remaining material\s+decision pauses for user input/);
const verifySkillMirror = fs.readFileSync(path.join(root, ".users", "skills", "verify-implementation", "SKILL.md"), "utf8");
assert.match(verifySkillMirror, /범위 내 구현·테스트·문서 정합성 결함은 반복 승인 없이 자동 수정/);
assert.match(verifySkillMirror, /AskUserQuestion.*대상이 아닙니다/s);
const reviewSkillMirror = fs.readFileSync(path.join(root, ".users", "skills", "review-pass", "SKILL.md"), "utf8");
assert.match(reviewSkillMirror, /CONTESTED.*즉시 사용자 질문으로 바꾸지 않습니다/s);
assert.match(reviewSkillMirror, /독립 중재자\(arbiter\)를 우선 실행/);

assert.match(rules.ai_workflow.dead_code_safety.rules.join("\n"), /bounded recoverable deletion is already authorized/);
assert.match(rules.conventions.git_workflow.owned_repo_posting_authority, /does not require a second approval/);
assert.match(rules.conventions.external_repo_policy.rule, /third-party\/community repositories/);
assert.match(rules.conventions.workfile_lifecycle.handoff_documents.policy, /Never stage or commit/);
assert.match(rules.conventions.workfile_lifecycle.handoff_documents.location, /\.handoff\/ or \.handover\//);
assert.match(rules.conventions.workfile_lifecycle.handoff_documents.naming, /basename starts with handoff or handover/);

for (const fixture of [
  "tmp-fixtures/HANDOFF.md",
  "tmp-fixtures/handoff-notes.md",
  "tmp-fixtures/handoff-latest.txt",
  "tmp-fixtures/handover-session.yml",
  "tmp-fixtures/HANDOVER-20260730.yaml",
  "tmp-fixtures/.handoff/session.yml",
]) {
  const ignored = cp.spawnSync("git", ["check-ignore", "--no-index", "-q", fixture], { cwd: root, shell: false });
  assert.equal(ignored.status, 0, `handoff artifact must be ignored: ${fixture}`);
}
for (const fixture of [
  "docs/handoff-guide.md",
  "spec/handover-contract.txt",
  "design/HANDOFF-API-GUIDE.json",
  ".agents/context/handover-policy-contract.yaml",
  ".agents/decisions/HANDOFF-DECISION-GUIDE.yml",
  "docs/project-handoff-guide.md",
  "docs/team_handover_protocol.txt",
  "docs/api-handoff-contract.yaml",
  "docs/architecture.md",
]) {
  const ignored = cp.spawnSync("git", ["check-ignore", "--no-index", "-q", fixture], { cwd: root, shell: false });
  assert.equal(ignored.status, 1, `formal documentation must remain trackable: ${fixture}`);
}

const injectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "naia-routine-gate-"));
fs.mkdirSync(path.join(injectRoot, ".agents", "progress"), { recursive: true });
fs.mkdirSync(path.join(injectRoot, ".agents", "session-contracts"), { recursive: true });
fs.mkdirSync(path.join(injectRoot, ".agents", "context"), { recursive: true });
fs.writeFileSync(path.join(injectRoot, ".agents", "context", "agents-rules.json"), "{}\n");
const boundedProgress = {
  issue: "bounded-routine",
  current_phase: "issue",
  current_task: "execute the already bounded request",
  session_id: "S-BOUNDED",
  contract_id: "bounded-routine-contract",
};
const boundedContract = {
  schema_version: "1.0",
  id: boundedProgress.contract_id,
  status: "active",
  project_root: ".",
  goal: boundedProgress.current_task,
  scope: ["src/**"],
  non_goals: [],
  success_criteria: ["bounded request proceeds without redundant approval"],
  allowed_paths: ["src/**"],
  target_ownership: ["src/**"],
  audiences: ["developer"],
  source_refs: ["USR-ROUTINE:E01"],
  session_bindings: [{ session_id: "S-BOUNDED" }],
  progress_file: ".agents/progress/bounded.json",
};
const boundedDigest = sessionContract.contractDigest(boundedContract);
boundedContract.contract_digest = boundedDigest;
boundedContract.session_bindings[0].contract_digest = boundedDigest;
boundedProgress.contract_digest = boundedDigest;
fs.writeFileSync(path.join(injectRoot, ".agents", "progress", "bounded.json"), JSON.stringify(boundedProgress));
fs.writeFileSync(path.join(injectRoot, ".agents", "session-contracts", "bounded-routine-contract.json"), JSON.stringify(boundedContract));
fs.writeFileSync(path.join(injectRoot, ".agents", "session-contracts", ".session-map.json"), JSON.stringify({
  schema_version: "1.0",
  bindings: {
    "S-BOUNDED": {
      contract_id: boundedContract.id,
      contract_path: ".agents/session-contracts/bounded-routine-contract.json",
      contract_digest: boundedDigest,
    },
  },
}));
const injection = harnessCore.buildSessionInject({
  cwd: injectRoot,
  sessionId: "S-BOUNDED",
  hooksDir: path.join(root, ".claude", "hooks"),
  env: {},
  hostConfigDir: ".claude",
});
assert.ok(injection?.text);
assert.doesNotMatch(injection.text, /user confirmation required before proceeding/);
assert.match(injection.text, /internal checkpoint; ask only if an unresolved material choice remains/);
assert.match(injection.text, /bounded requests proceed internally/);
fs.rmSync(injectRoot, { recursive: true, force: true });

process.stdout.write("routine approval policy: PASS\n");
