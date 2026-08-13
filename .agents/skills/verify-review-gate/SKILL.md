---
name: verify-review-gate
description: Validate that code commits fail closed unless repository-bound JSON progress records both development and post-test integration adversarial reviews as two consecutive clean passes. Run after changing commit guards, review workflows, progress schemas, or review enforcement tests, and before integration or commit.
---

# Verify Review Gate

## Purpose

1. Reject staged commits with no repository-bound active progress JSON.
2. Reject commits before `sync_verify` or unless exact `review` and `integration` records contain two timestamped clean reviewer rounds bound to the current staged-diff SHA-256.
3. Prevent unrelated-repository progress, Git global options, compound commands, implicit staging, and `git -C` from bypassing the gate.
4. Keep the workflow evidence names aligned with the executable policy.

## When to Run

- After editing commit guards, review workflows, or progress evidence fields.
- During Review, Post-test Review, and Integration for harness changes.
- Before committing changes to review enforcement.

## Related Files

| File | Purpose |
|------|---------|
| `.agents/hooks/policies/bash.js` | Tool-neutral commit policy |
| `.agents/hooks/policies/commit-review-gate.test.js` | Deterministic policy regression tests |
| `.claude/hooks/commit-guard.js` | Claude adapter for the shared policy |
| `.claude/hooks/e2e/run.sh` | Full hook regression suite |
| `.agents/workflows/issue-driven-development.yaml` | Review evidence contract |

## Workflow

### 1. Run the deterministic gate tests

```bash
node .agents/hooks/policies/commit-review-gate.test.js
```

If `node` is unavailable but Bun is installed, run the same file with `bun`.

PASS: deterministic tests cover missing/wrong-phase/stale/malformed-round evidence, staged mutation, progress-receipt self-reference, cross-repository records, global options, wrappers/substitutions, `git -C`, compound commands, interactive/implicit staging, dry-run, and valid evidence.

FAIL: any assertion fails or the process exits nonzero. Fix the policy and rerun.

### 2. Check the evidence contract

```bash
rg -n 'task_id|review_log|post_test_review_log|2_consecutive_clean|staged_diff_sha256|rounds|reviewer|reviewed_at|sync_verify' \
  .agents/hooks/policies/bash.js .agents/workflows/issue-driven-development.yaml
```

PASS: after the deterministic tests pass, both evidence fields, exact phases, staged-diff hash, repository binding, clean result, and minimum phase also align in policy and workflow. Text matching is only a secondary alignment check, not semantic proof.

FAIL: a name or result differs. Align the workflow and policy; do not add a permissive alias without a migration test.

### 3. Run the full hook suite when Node.js is available

```bash
bash .claude/hooks/e2e/run.sh
```

PASS: the commit-guard section and the overall suite pass. If an unrelated pre-existing suite failure remains, report it separately with the targeted gate test result.

## Output Format

| Check | Status | Evidence |
|-------|--------|----------|
| Deterministic gate tests | PASS/FAIL | Command output |
| Evidence contract | PASS/FAIL | Matching files/fields |
| Full hook suite | PASS/FAIL/BLOCKED | Pass count or blocker |

## Exceptions

1. Read-only Git commands and quoted examples containing `git commit` are not commit attempts.
2. Historical commits created before this gate are not retroactively blocked.
3. Incident restoration may run before review, but committing the restoration code still requires both review records.
4. `.agents/progress/**` is evidence metadata and is excluded from the staged-content digest to avoid a self-referential receipt; every other staged path remains digest-bound.
