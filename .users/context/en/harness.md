<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# Harness Verification Checklist

A human-readable guide for `.agents/context/harness.yaml`.

## Purpose

A checklist for verifying harness correctness when adding or modifying hooks, rules, and workflows.

---

## Architecture (G-OC01: Tool-Agnostic Harness, 2026-05-18)

Refactor tool-specific monolithic hooks into a **tool-agnostic core + policies + host adapters** structure, and validate it on a second host (pi).

- **core** `.agents/hooks/core/harness-core.js` — host-neutral SoT (session/anti-compact + sanitizer). Zero host coupling.
- **policies** `.agents/hooks/policies/{bash,edit}.js` — host-neutral guard policies. No `process.exit` or host I/O envelope.
- **host adapters** — Claude (`.claude/hooks/_claude-{bash,edit}-*.js` + thin adapters, byte-identical to before refactoring) / **pi** (`.pi/extensions/naia-harness.ts` — reuses the same policies and core, core unchanged).
- **fail-mode invariant**: **hardcoded** per guard (not data) — pr-guard fail-CLOSED, the remaining 5 bash guards fail-OPEN. Preserved on both hosts (adversarial validation complete).

**Status**: part1+part2 **complete & adversarial 2-consecutive-clean (6 rounds)** — real pi@0.74.1 runtime gate 20/20, Claude parity (golden 8/42/19 + E2E 64 + system 13) byte-identical. **cross-tool goal (identical harness on Claude+pi, core unchanged) achieved and verified.** partB (declarative guard_policies) = 3-round design review → **DEFER recommended** (no sound integrity path for policy as SoT; only 2/9 guards suitable; cross-tool goal already achieved). Details = `.agents/progress/g-oc01-partB-forbidden-actions-plan.md`.

### Original Request Integrity Layer (Claude Code + Codex)

- Shared core: `.agents/hooks/core/request-contract.js`, `request-contract-adapter.js`
- Thin adapters: `.claude/hooks/request-contract.js`, `.codex/hooks/request-contract.cjs`
- Identical lifecycle: `PreToolUse`, `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreCompact`, `PostCompact`, `Stop`
- From the original prompt hash chain through instruction→REQ→UC/UC-test→FE/FE-test→implementation→evidence, all 8 entities and 7 edges are fully traced per required atom, and successful completion requires two externally signed Clean reviews bound to the current state.
- The review runner uses the host's native isolation. On Linux, a bundle whose allowlisted reviewer and issued digest match is fixed as an anonymous descriptor and executed in `bubblewrap`. On Windows, it creates a digest-verified snapshot in sealed staging outside the repository and user home, rejects re-analysis points, and inherits NTFS ACLs accessible only to the current user and SYSTEM. The sandbox executable must also match the digest allowlist in the configuration, and failure to delete the snapshot is not hidden as success. Within it, the exact root policy of the Codex elevated sandbox and the Node permission model are layered, allowing only reviewer/bundle reads and scratch writes. Network, repository, and user home are blocked, with no dependency on WSL, Cygwin, MSYS2, Linux VMs, or Linux containers. Intake consumes one-time runner evidence from the same process, and the semantic fields of actual reviewer stdout must exactly match the stored review; there is no command for directly ingesting arbitrary review JSON. The reviewer/runner attestor also executes only byte snapshots fixed in the configuration and signs the two executable digests and the review payload digest. PID and platform-native process identity collisions between the authoring host and reviewer are rejected. Linux uses kernel boot/start identity, while the Windows reviewer binds the execution-specific unique identity created by the runner. Review timestamps are overwritten with runner evidence, and rejected fields, values, and stderr are not reflected.
- Global run/context/process/execution ID claims, a digest-protected invocation manifest, a repository/lineage lock atomically published after owner completion with identity rechecked, and crash-recovery transactions including state+head prevent replay and partial commits after compaction, concurrent sessions, and interruption. Stale reclamation is also serialized by a separate reaper. Windows host process identity is newly created from process start time at SessionStart and lock reclamation; subsequent lifecycle hooks reuse the identity bound to the contract. No writable disk cache is used. An unreadable unit/quarantine store, invalid numeric configuration, Git command/parsing failure, or platform-native path key collision does not collapse into an empty state. Windows file mode uses Git index 0644/0755 instead of meaningless POSIX stat bits. Quarantine adoption cross-binds the departure chain's head/count/source ID to the destination unit and does not create duplicate records on retry.
- Initial contracts and scope changes require external user-presence signatures verified by a fixed public key. The core verifies signed presence/non-exportable claims, while actual hardware attributes are within the trust boundary of external signer provisioning.
- `authorize_contract` is permitted only once, and subsequent addition/correction/termination authority must precisely own the actual diff of each operation. Even when multiple operations are required simultaneously, they are presented as one pending transaction and closed after the entire presentation is consumed. Non-terminating progress-state transitions proceed without separate approval.
- A terminated directive cannot subsequently alter the complete canonical directive or be revived as active/done. The tombstone is also an immutable complete canonical record including description and authority. Isolated reviewer stdout exports only the verdict, fixed finding codes, and opaque projections of source/atom/directive/target/criterion/authority/tombstone/change/artifact/edge relationships; it does not export the original text, paths, locators, summaries, or digests. The exact canonical contract is reviewed inside a private bundle, and the trusted runner injects fields bound at issuance after sandbox termination. Clean means zero findings; Dirty means one or more. Complete opaque relationship projections for the current and all past scope versions are required. The two Clean reviews used for success must come from different reviewer contexts and processes.
- Lifecycle state and baseline digest are bound to the unit head, and the Git baseline and dirty submodule recursively hash actual files, index, and HEAD. Successful-preservation cleanup clears quarantine and private state only after final proof verification, journaling the exact receipt and atomically staging the unit. Interrupted staging is cleaned only after the next execution re-verifies the receipt's complete field bindings and private proof. A cancelled mutating tool lease can be rechecked and closed only by Stop from the client/session owning that lease. If even one lease from another session is running, Stop and review issuance are blocked.
- If there is no native stdin event or it conflicts with a command-line event, the system fails closed. Even if the prompt envelope is rejected, the original prompt is preserved in quarantine before the failure response. The same applies when a valid prompt is blocked by duplicate runtime binding. Each source is split into `obligation_atoms` that exactly reproduce the original when concatenated; directive, approval, and authority atoms must be declared verbatim in the mapped directive and linked by ID to the target, acceptance criterion, all trace artifacts, and 7 edges. Both Claude Code and Codex register `apply_patch` as a lease target before modification. Review intake recalculates the current bundle and all bindings and does not record post-issuance drift. Completion determination reruns the same verification inside the repository/lineage lock to create the success proof, and compaction re-verifies that proof and the consecutive Clean record hash.
- Three private pending inputs dedicated to the initial contract and one strictly parsed Node control command are allowed without a product mutation lease. Through this path, `authority-challenge|bind|resume` that has passed actual native `PreToolUse`, and the fixed reviewer runner, do not deadlock on their own lease before initial binding/review issuance. Shell chaining/substitution/redirection, incorrect unit/session/path, and unfixed reviewer/attestor are not recognized as control commands.
- The default is opt-in so existing projects are not suddenly locked down. Enable with `REQUEST_CONTRACT=on` or `node scripts/request-contract.cjs enable`.
- After any unit or unaccepted quarantine is created, it cannot be disabled midway by deleting the opt-in marker, setting `REQUEST_CONTRACT=off`, or using the `disable` command. A successfully terminated lineage also remains fixed until preservation cleanup is complete. Subsequent lifecycle actions in the same session re-verify the current proof; a new session hands off the workspace digest from the point at which the existing success proof was verified to a new genesis before starting a separate request. Incomplete state remains protected through signed resume.
- Honest limitation: hook deactivation/untrusted registration, an actor able to change all local records together, false attribute signatures from an external signer, changes fully executed and restored between hook boundaries, and external side effects cannot be fully observed by this local layer alone. Deterministic parity extends only to tracked native adapter processes; the installed host dispatcher is a separate smoke scope.
- The shared Windows/Linux regression bundle permits only Node entry points and executes them directly with `shell=false`, contaminating them so they cannot use WSL/Bash/MSYS environment values. This is evidence that the bundle itself does not invoke WSL/Bash; it does not mean that all child processes were observed at the operating-system level. Linux shell-based E2E is separate additional evidence and does not substitute for Windows passing.

---

## Requirement Review Trace (`requirement_review_trace`)

The request-contract runtime above is opt-in, but **this trace gate is always enabled**. RCI requirement files claim that they “received a 4-stage review,” and that claim must remain **falsifiable** even when the runtime is not enabled.

- Scripts: `scripts/request-contract-review-scope.cjs` (scope/digest) ·
  `scripts/validate-request-contract-requirements.cjs` (validation) · `scripts/issue-review-receipt.cjs` (receipt issuance)
- Store: `.agents/requirements/reviews/` — receipt JSON + reviewer verbatim transcripts (`logs/`)
- Binding method: Each stage records a **list of receipt IDs, not free-form strings**. Receipts must actually exist, must have a Clean finding-0 determination from **different** reviewers meeting the stage minimum, must preserve each reviewer's verbatim transcript and reproduce the matching hash from its bytes, must list only requirements the reviewer actually marked COVERED, and must match the `scope_digest` of the tree reviewed by that reviewer.
- The digest is derived from `git ls-files`, excluding the `reviews:` line and the receipt store itself — recording a determination must not invalidate that determination.
- Therefore, **fixing code after review changes the digest and invalidates the receipt**. The review-pass rule that “later modifications reset the consecutive Clean record” is mechanically enforced rather than a gentlemen's agreement.

**Honest limitations**

- The receipt store is an ordinary Git-tracked directory. An agent with write access can forge a receipt and matching fake transcript together, passing both hash checks. This gate blocks **cheap failures** — declaring review evidence that was never created, and continuing to use an old determination after modifying the reviewed code. **To prevent forgery itself, enable the opt-in runtime above** (the reviewer runs in `bubblewrap` isolation, and the receipt is signed with a process identity different from the author).
- The set of files under review is derived from three places — (1) tracked files whose paths contain the feature name, (2) **all code/test paths declared by the requirement file in its own trace**, and (3) a short explicit list for the governing skill and review apparatus. Files caught by none of the three paths remain outside the digest until added to the trace or explicitly listed. If declared/traced paths are not actually tracked, the system fails closed. It cannot infer intent, but it is not a structure where implementation growth depends on **remembering** to manually update the list.
- Reviewer identity = tool+model. Running the same model twice does not count as two people (by design). The quorum is filled only when the caller supplies different reviewers.

---

## Verification Items

### H1 — False Positive Test

Is the system blocking things it should not block?

- 5 test cases: 3 pass + 2 block
- Verify directly with `echo '<json>' | node .claude/hooks/<hook>.js`
- **Note**: false positives from patterns inside quoted strings, excessive path-pattern matching

### H2 — Root Cause vs. Symptom Suppression

Is the hook suppressing a symptom or addressing the root cause?

- “What behavior does this hook prevent?”
- “Can the same result occur through another path?” → If so, symptom suppression

| Category | Example |
|------|------|
| Symptom suppression | Block `git reset --hard` (an action that is difficult to undo) |
| Root cause | Add a user-confirmation checkpoint before an action that is difficult to undo |

### H3 — Scope Verification

Does the hook timing (PreToolUse vs PostToolUse) match the intent?

- **Hook preventing an irreversible action**: must be PreToolUse
- PostToolUse runs after execution → too late for irreversible actions

### H4 — Process Constraint + Behavior Constraint Pair

Does every “X must not be done” rule also specify “do Y instead”?

- Without it, the rule is incomplete

| Category | Example |
|------|------|
| Incomplete | “Never change a design decision.” |
| Complete | “Never change a design decision. If a design–implementation gap is found → follow the escalation path.” |

### H5 — Permission Model Coverage

Are the AI roles (implementer vs reviewer) clearly defined by file type?

- Check the `agents-rules.json` permission model
- Check that `design_doc_paths` is current
- Test whether `design-doc-guard.js` blocks edits to `docs/design/`

### H6 — Escalation Path Definition

Is an escalation path specified for every “stop and report” rule?

- Path: **discover → report → wait** (never discover → quietly fix)
- Coverage targets: `design_gap_found_during_build`, `design_flaw_found_during_review`

### H7 — Review Quality

Are repeated reviews run with the `/review-pass` skill and an adversarial framing?

- Check the IDD workflow review/post_test_review stages
- Check that the `/review-pass` skill file exists
- Check application of the consecutive two-clean-pass rule

### H8 — Original Request Integrity

Can a review or completion claim silently omit, reclassify, or reduce the initial or subsequent user instructions?

- Reproduce missing genesis, deletion/tampering of original text, subsequent instructions, scope removal, stale review, and Claude/Codex parity defects through fault injection
- Verify that every execution instruction connects REQ→UC/UC-test→FE/FE-test→implementation→evidence
- Verify that compound original text cannot be cited while omitting some atoms from the target, criterion, trace artifact, or edge
- Require user-presence signatures for initial binding and every scope epoch change
- Require two externally signed Clean reviews bound to a private review bundle and separated from the authoring session
- Verify complete mappings for current and past scope versions, different reviewer contexts/processes, and core-issued run IDs and fixed finding codes
- Verify rejection of partial target/acceptance-criterion deletion, subsequent genesis re-approval, metadata mixing between operations, and forgery of mutable quarantine-consumption markers
- Verify rejection of workspace tampering immediately before completion, missing native events, and compaction of a `success` state without review

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
- `cascade-check.js` H2 INFO: PostToolUse notification is not blocking — mirror updates are the AI's responsibility, not automated. Permitted design.
- `session-inject.js` H4: added warning output when the design-doc-unlock file is active (2026-03-22).
- `session-inject.js` behavior model redesign (2026-04-26): removed automatic binding, added an opt-out mechanism, and introduced the `/harness` slash command. See the section below.

---

## `session_inject` Behavior Model (Revised 2026-04-26)

**Resolution priority (no auto-bind):**

1. **P0** — A file whose `session_id` field in the progress file matches the current session ID (most authoritative and resilient to session-map corruption)
2. **P1** — The file pointed to by `.session-map.json[session_id]`
3. **If neither exists, inject only a SELECTION PROMPT** — never guess or bind automatically

**Active candidate definition:** `mtime ≤ 24h` AND `current_phase != "close"` — displayed as a candidate list in the notice.

**Opt-out (HARNESS off):**

- `CLAUDE_HARNESS=off` (or `0`/`false`/`no`) environment variable
- `<cwd>/.claude/no-harness` marker file (content irrelevant; existence alone opts out)
- If either applies, the hook exits quietly every turn

**Explicit control — `/harness` slash command:**

| Command | Action |
|------|------|
| `/harness status` | Display current binding state (P0/P1/UNBOUND) + opt-out status + active candidates |
| `/harness off` | Create `<cwd>/.claude/no-harness` → opt out |
| `/harness on` | Remove the `no-harness` marker → reactivate HARNESS |
| `/harness bind <file or issue#>` | Write `session_id` to the specified progress file (P0 anchor) |
| `/harness unbind` | Remove traces of the current session from both the session-map and progress file |

See `.claude/commands/harness.md` for the specification.

**Why automatic binding (P2-singleton) was removed:** In a multi-session workflow, a new session was automatically pulled into one active task, causing cross-session context drift. Even when a new session was for free-form work or intended to address another issue, `#N HARNESS` was forcibly injected. The model was changed to permit explicit binding only.

**Why atomic write:** If concurrent sessions update `.session-map.json` simultaneously, JSON corruption is possible. Atomicity is ensured by writing to a temporary file and then renaming it.

---

## Design/Proposal Review Questions (`design_review_questions`, A.8 Absorbed)

> Source: harness-books Book1 Appendix A.8 (8 proposal review questions). Absorption review = `.agents/progress/harness-books-integration-findings-2026-06-18.md` Section A.
> H1–H7 examine **the quality of our hooks**, while the questions below review **the agent/harness design proposal itself** (the subjects differ). H5 (permission model coverage) partially overlaps with SA2.
> Usage point: new harness/agent design PRs, IDD Plan gate, external harness absorption review.

| ID | Question |
|----|------|
| SA1 | Which behaviors are constrained by prompts, and which are enforced by the runtime? |
| SA2 | Who prevents tool misuse, and at which layer? |
| SA3 | When is context compacted, and how is the meaning of subsequent work (plan, skills, core files, tool state) restored? |
| SA4 | Are prompt-too-long and max-output-tokens recovered differently? |
| SA5 | How is consistency between the transcript and tool results maintained after an interruption? |
| SA6 | In a multi-agent flow, who owns synthesis and who owns verification? |
| SA7 | Are there a circuit breaker and infinite-loop prevention guard for failure recovery? |
| SA8 | How does the team audit what the agent did and why? |

**red flag:** If the answer frequently converges on “it can be added later,” the runtime is not yet properly designed.

---

## Update Method

1. Modify `.agents/context/harness.yaml`
2. Synchronize-update this file as well
