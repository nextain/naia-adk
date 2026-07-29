<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# Harness Verification Checklist

A human-readable guide for `.agents/context/harness.yaml`.

## Purpose

A checklist for verifying harness correctness when adding or modifying hooks, rules, or workflows.

---

## Architecture (G-OC01: Tool-Independent Harness, 2026-05-18)

Refactor tool-specific monolithic hooks into a **tool-independent core + policies + host adapters** structure, and validate it on a second host (pi).

- **core** `.agents/hooks/core/harness-core.js` — host-neutral SoT (session/anti-compact + sanitizer). Zero host coupling.
- **policies** `.agents/hooks/policies/{bash,edit}.js` — host-neutral guard policies. No `process.exit` or host I/O envelope.
- **host adapters** — Claude (`.claude/hooks/_claude-{bash,edit}-*.js` + thin adapters, byte-identical to before refactoring) / **pi** (`.pi/extensions/naia-harness.ts` — reuses the same policies and core, with no core changes).
- **fail-mode invariant**: **hardcoded** per guard (not data) — pr-guard fail-CLOSED, the remaining 5 bash guards fail-OPEN. Preserved on both hosts (adversarial validation complete).

**Status**: part1+part2 **complete & adversarial 2-consecutive-clean (6 rounds)** — actual pi@0.74.1 runtime gates 20/20, Claude parity (golden 8/42/19 + E2E 64 + system 13) byte-identical. **The cross-tool goal (identical harness on Claude+pi, unchanged core) achieved and verified.** partB (declarative guard_policies) = 3-round design review → **DEFER recommended** (no sound integrity path for policy-as-SoT; only 2/9 guards suitable; cross-tool goal already achieved). Details = `.agents/progress/g-oc01-partB-forbidden-actions-plan.md`.

### Original Request Integrity Layer (Claude Code + Codex)

- Shared core: `.agents/hooks/core/request-contract.js`, `request-contract-adapter.js`
- Thin adapters: `.claude/hooks/request-contract.js`, `.codex/hooks/request-contract.cjs`
- Identical lifecycle: `PreToolUse`, `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreCompact`, `PostCompact`, `Stop`
- From the original prompt hash chain through instruction→REQ→UC/UC-test→FE/FE-test→implementation→evidence, all 8 entities and 7 edges must be fully traced per obligation atom, and successful termination requires two externally signed Clean reviews bound to the current state.
- The review runner uses the host’s native isolation. On Linux, a bundle whose allowlisted reviewer and issued digest match is fixed as an anonymous descriptor and run in `bubblewrap`. On Windows, it creates a digest-verified snapshot in sealed staging outside the repository and user home, rejects reanalysis points, and inherits NTFS ACLs accessible only to the current user and SYSTEM. The sandbox executable must also match the digest allowlist in the configuration, and snapshot deletion failures are not concealed as success. Within it, the exact root policy of the Codex elevated sandbox and the Node permission model are layered to allow only reviewer/bundle reads and scratch writes. Network, repository, and user home access are blocked, with no dependency on WSL, Cygwin, MSYS2, Linux VMs, or Linux containers. Intake consumes one-time runner evidence from the same process, and the semantic fields of actual reviewer stdout must exactly match the stored review; there is no command for directly accepting arbitrary review JSON. The reviewer/runner attestor also runs only byte snapshots fixed in the configuration and signs the two executable digests and the review payload digest. PID and platform-native process identity collisions between the authoring host and reviewer are rejected. Linux uses kernel boot/start identity, while the Windows reviewer binds an execution-specific unique identity created by the runner. Review time is overwritten with runner evidence, and rejected fields, values, and stderr are not reflected.
- Global run/context/process/execution ID claims, a digest-protected invocation manifest, and a repository/lineage lock that is atomically published after owner completion and rechecks identity, together with a crash-recovery transaction containing state+head, prevent replay and partial commits after compaction, concurrent sessions, and interruption. Stale reclamation is also serialized through a separate reaper. Windows host process identity is newly created from process start time at SessionStart and during lock reclamation; subsequent lifecycle hooks reuse the identity bound to the contract. No writable disk cache is used. Unreadable unit/quarantine storage, invalid numeric configuration, Git command/parsing failures, and platform-native path key collisions are not reduced to empty state. Windows file modes use 0644/0755 from the Git index instead of meaningless POSIX stat bits. Quarantine adoption cross-binds the source chain’s head/count/source ID to the destination unit and does not create duplicate records on retry.
- Initial contracts and scope changes require an external user-presence signature verified with a fixed public key. The core verifies signed presence/non-exportable claims, while actual hardware properties remain within the external signer provisioning trust boundary.
- `authorize_contract` is allowed only once; subsequent addition, correction, and termination authority must exactly own the actual changes of each operation. Even when multiple operations are simultaneously required, they are presented as one pending transaction and closed after consuming the complete presentation. Non-terminating progress-state transitions proceed without separate approval.
- A terminated directive can no longer change the complete canonical directive or be revived as active/done. The tombstone is also an immutable complete canonical record including explanation and authority. Isolated reviewer stdout emits only verdicts, fixed finding codes, and opaque projections of source/atom/directive/target/criterion/authority/tombstone/change/artifact/edge relationships; it does not emit original text, paths, locators, summaries, or digests. The exact canonical contract is reviewed inside the private bundle, and the trusted runner injects fields bound at issuance after sandbox termination. Clean means 0 findings; Dirty means 1 or more, and requires complete opaque relationship projections for the current and all historical scope-versions. The two Clean reviews used for success must come from different reviewer contexts and processes.
- Lifecycle state and baseline digest are bound to the unit head, while Git baselines and dirty submodules recursively hash actual files, index, and HEAD. Successful preservation cleanup journals the exact receipt and atomically stages the unit, then deletes quarantine and private state only afterward, following final proof verification. Interrupted staging is cleaned up only after the next run re-verifies all receipt field bindings and the private proof. A cancelled mutating tool lease can be rechecked and closed by Stop only from the client/session owning that lease. If even one lease from another session is running, Stop and review issuance are blocked.
- If there is no native stdin event or it conflicts with a command-line event, the system fails closed; even if the prompt envelope is rejected, the original prompt is preserved in quarantine before the failure response. The same applies when a valid prompt is blocked by duplicate runtime binding. Each source is divided into `obligation_atoms` that exactly reproduce the original when concatenated; directive, approval, and authority atoms must be declared verbatim in the mapped directive and connected by ID to the target, acceptance criterion, every trace artifact, and the 7 edges. Both Claude Code and Codex register `apply_patch` as a lease target before changes. Review intake recalculates the current bundle and all bindings and records no post-issuance drift. Completion judgment reruns the same verification inside the repository/lineage lock to create a success proof, and compaction re-verifies that proof and the consecutive Clean record hash.
- Three private pending input types dedicated to the initial contract and one strictly parsed Node control command are allowed without a product mutation lease. Through this path, `authority-challenge|bind|resume` that has passed the actual native `PreToolUse`, and the fixed reviewer runner, do not deadlock on their own leases before initial binding/review issuance. Shell chaining, substitution, redirection, incorrect unit/session/path, and non-fixed reviewers/attestors are not recognized as control commands.
- To avoid suddenly enclosing existing projects, the default is opt-in. Enable with `REQUEST_CONTRACT=on` or `node scripts/request-contract.cjs enable`.
- After any unit or unaccepted quarantine exists, intermediate disabling through deleting the opt-in marker, `REQUEST_CONTRACT=off`, or the `disable` command is prohibited. A successfully terminated lineage also remains fixed until preservation cleanup is complete. Subsequent lifecycle operations in the same session reverify the current proof; a new session starts a separate request after handing off the workspace digest from the point at which the existing success proof was verified to a new genesis. Incomplete states remain protected through signed resume.
- Honest limitations: hook deactivation/untrusted registration, actors able to alter all local records together, false attribute signatures from an external signer, changes fully executed and restored between hook boundaries, and external side effects cannot be completely observed by this local layer alone. Deterministic parity extends only to traced native adapter processes; the installed host dispatcher is covered separately by smoke tests.

---

## Requirement Review Trace (requirement_review_trace)

The request-contract runtime above is opt-in, but **this trace gate is always enabled**. RCI requirement files claim that they “received a four-stage review,” so that claim must remain **falsifiable** even when the runtime is not enabled.

- Scripts: `scripts/request-contract-review-scope.cjs` (scope·digest) ·
  `scripts/validate-request-contract-requirements.cjs` (validation) · `scripts/issue-review-receipt.cjs` (receipt issuance)
- Storage: `.agents/requirements/reviews/` — receipt JSON + reviewers’ original transcripts (`logs/`)
- Binding method: Each stage records a **list of receipt IDs rather than free-form strings**. Receipts must actually exist, have a Clean verdict with 0 findings from **different** reviewers meeting that stage’s minimum staffing, preserve each reviewer’s original transcript and match a rehash of its bytes, list only requirements the reviewer actually marked COVERED, and match that reviewer’s `scope_digest`.
- The digest is derived from `git ls-files`, excluding the `reviews:` line and the receipt storage itself — recording a verdict must not invalidate that verdict.
- Therefore, **fixing code after review changes the digest and invalidates the receipt**. The review-pass rule that “subsequent changes reset the consecutive Clean record” is mechanically enforced rather than being a gentleman’s agreement.

**Honest limitations**

- The receipt storage is an ordinary Git-tracked directory. An agent with write access can forge a receipt together with matching fake transcripts, passing both hash checks. This gate blocks **cheap failures** — declaring review evidence that was never created and continuing to use an old verdict after modifying the reviewed code. **To prevent forgery itself, the opt-in runtime above must be enabled** (reviewers run in `bubblewrap` isolation, and receipts are signed with a process identity different from the author).
- The set of reviewed files is derived from three places — (1) tracked files whose paths contain the feature name, (2) **all code/test paths declared by the requirement file in its own trace**, and (3) a short explicit list for governing skills and the review apparatus. Files that match none of the three paths remain outside the digest until they are added to the trace or explicitly listed. If declared/traced paths are not actually tracked, the system fails closed. It cannot infer intent, but it is not structured so that manually updating the list as the implementation grows is the only thing one must **remember**.
- Reviewer identity = tool + model. Running the same model twice does not count as two reviewers (by design). The caller must supply different reviewers to satisfy the quorum.

---

## Verification Items

### H1 — False Positive Test

Is the system blocking things that should not be blocked?

- 5 test cases: 3 pass + 2 blocked
- Verify directly with `echo '<json>' | node .claude/hooks/<hook>.js`
- **Caution**: false positives from patterns inside quoted strings, excessive path-pattern matching

### H2 — Root Cause vs. Symptom Suppression

Is the hook suppressing a symptom or addressing the root cause?

- “What behavior does this hook prevent?”
- “Can the same result occur through another path?” → If yes, it is symptom suppression.

| Category | Example |
|------|------|
| Symptom suppression | Block `git reset --hard` (an action that is difficult to reverse) |
| Root cause | Add a user-confirmation checkpoint before an action that is difficult to reverse |

### H3 — Scope Confirmation

Does the hook timing (PreToolUse vs PostToolUse) match the intent?

- **Hook preventing an irreversible action**: must be PreToolUse
- PostToolUse runs after execution → too late for irreversible actions

### H4 — Pairing Process Constraints with Behavior Constraints

Does every “X must not be done” rule also state “do Y instead”?

- Without this, the rule is incomplete.

| Category | Example |
|------|------|
| Incomplete | “Never change a design decision.” |
| Complete | “Never change a design decision. If a design–implementation discrepancy is found → follow the escalation path.” |

### H5 — Permission Model Coverage

Are the AI roles (implementer vs. reviewer) clearly defined for each file type?

- Check the `agents-rules.json` permission_model
- Check that design_doc_paths is current
- Test whether design-doc-guard.js blocks edits to `docs/design/`

### H6 — Escalation Path Definition

Is an escalation path specified for every “stop and report” rule?

- Path: **discover → report → wait** (do not discover → silently fix)
- Coverage targets: `design_gap_found_during_build`, `design_flaw_found_during_review`

### H7 — Review Quality

Are repeated reviews executed with the `/review-pass` skill and an adversarial frame?

- Check the IDD workflow review/post_test_review stages
- Check that the `/review-pass` skill file exists
- Verify that the consecutive two-clean-pass rule is applied

### H8 — Original Request Integrity

Can a review or completion claim silently omit, reclassify, or reduce the initial or subsequent user instructions?

- Reproduce genesis omissions, original-text deletion/modification, subsequent instructions, scope removal, stale reviews, and Claude/Codex parity defects through fault injection
- Verify that every execution instruction connects through REQ→UC/UC-test→FE/FE-test→implementation→evidence
- Verify that a composite original text cannot be quoted while omitting some atoms from the target, criterion, trace artifact, or edges
- Require user-presence signatures for initial binding and every scope-epoch change
- Require two externally signed Clean reviews bound to a private review bundle and separated from the authoring session
- Verify complete mappings for current and historical scope-versions, different reviewer contexts/processes, the core-issued run ID, and fixed finding codes
- Verify rejection of partial target/acceptance-criterion deletion, subsequent-genesis reapproval, metadata mixing between operations, and forgery of mutable quarantine-consumption markers
- Verify rejection of workspace modification immediately before completion, missing native events, and compaction of a `success` state without review

---

## Retrospective Verification Results for Existing Hooks

| Hook | Type | H1 | H2 | H3 | H4 | Verification Date |
|----|------|----|----|----|----|--------|
| `destructive-git-guard.js` | PreToolUse | PASS | PASS | PASS | PASS | 2026-03-20 |
| `design-doc-guard.js` | PreToolUse | PASS | PASS | PASS | PASS | 2026-03-21 |
| `pr-guard.js` | PreToolUse | PASS | PASS | PASS | PASS | 2026-03-22 |
| `commit-guard.js` | PreToolUse | PASS | PASS | PASS | PASS | 2026-03-22 |
| `cascade-check.js` | PostToolUse | PASS | INFO | PASS | PASS | 2026-03-22 |
| `session-inject.js` | UserPromptSubmit | PASS | PASS | PASS | PASS | 2026-04-26 |

**Notes:**

- `pr-guard.js` H1: regex `(?:^|[;&|])\s*gh\s+pr\s+create\b` (2026-03-22). Catches chained commands and prevents false positives from text inside echo/body arguments. T6-T10 5/5 PASS.
- `commit-guard.js`: PostToolUse → PreToolUse transition (2026-03-22). regex `(?:^|[;&|])\s*git\s+commit\b`. Prevents false positives from text inside echo arguments. T1-T5 5/5 PASS.
- `cascade-check.js` H2 INFO: PostToolUse notification is not blocking — mirror updates are the AI’s responsibility, not automation. Permitted design.
- `session-inject.js` H4: Added warning output when the design-doc-unlock file is enabled (2026-03-22).
- `session-inject.js` behavior model redesign (2026-04-26): removed automatic binding, added opt-out mechanism, introduced the `/harness` slash command. See the section below.

---

## session_inject Behavior Model (Revised 2026-04-26)

**Resolution priority (no auto-bind):**

1. **P0** — A file whose `session_id` field in the progress file matches the current session ID (most authoritative, resilient to session-map corruption)
2. **P1** — The file pointed to by `.session-map.json[session_id]`
3. **If neither exists, inject only a SELECTION PROMPT** — never guess and auto-bind

**Active candidate definition:** `mtime ≤ 24h` AND `current_phase != "close"` — displayed as a candidate list in the notice.

**Opt-out (HARNESS off):**

- `CLAUDE_HARNESS=off` (or `0`/`false`/`no`) environment variable
- `<cwd>/.claude/no-harness` marker file (content irrelevant; existence alone opts out)
- If either applies, the hook exits quietly every turn

**Explicit control — `/harness` slash command:**

| Command | Behavior |
|------|------|
| `/harness status` | Display current binding status (P0/P1/UNBOUND) + opt-out status + active candidates |
| `/harness off` | Create `<cwd>/.claude/no-harness` → opt out |
| `/harness on` | Remove the `no-harness` marker → reactivate HARNESS |
| `/harness bind <file or issue#>` | Write `session_id` to the specified progress file (P0 anchor) |
| `/harness unbind` | Remove traces of the current session from both session-map and progress files |

See `.claude/commands/harness.md` for the specification.

**Why automatic binding (P2-singleton) was removed:** In multi-session workflows, a new session was automatically drawn into one active task, causing cross-session context drift. Even when a new session was for free-form work or a different issue, #N HARNESS was forcibly injected. The model was changed to allow only explicit binding.

**Why atomic writes:** If concurrent sessions update `.session-map.json` simultaneously, the JSON may become corrupted. Atomicity is ensured by writing to a temporary file and then renaming it.

---

## Design/Proposal Review Questions (design_review_questions, absorbed A.8)

> Source: harness-books Book1 Appendix A.8 (8 proposal-review questions). Absorption review = `.agents/progress/harness-books-integration-findings-2026-06-18.md` Section A.
> H1–H7 check **the quality of our hooks**, while the questions below review **the agent/harness design proposal itself** (different subjects). H5 (permission model coverage) partially overlaps with SA2.
> Usage: new harness/agent design PRs, IDD Plan gates, external harness absorption reviews.

| ID | Question |
|----|------|
| SA1 | Which actions are constrained by prompts, and which are enforced by the runtime? |
| SA2 | Who blocks tool misuse, and at which layer? |
| SA3 | When is context compacted, and how is the meaning of subsequent work (plan, skills, key files, tool state) restored? |
| SA4 | Are prompt-too-long and max-output-tokens recovered differently? |
| SA5 | How is consistency between the transcript and tool results maintained after an interruption? |
| SA6 | In a multi-agent flow, who owns synthesis and who owns verification? |
| SA7 | Does failure recovery have a circuit breaker and an infinite-loop prevention guard? |
| SA8 | How does the team audit what the agent did and why? |

**red flag:** If the answer often converges on “it can be added later,” the runtime is not yet properly designed.

---

## Update Method

1. Modify `.agents/context/harness.yaml`
2. Update this file in synchronization

---
