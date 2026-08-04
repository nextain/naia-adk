# Reporting and Delivery

## Contents

- [Final report format](#12-final-report-format)
- [Finding classification](#13-finding-classification-auto-fix-vs-escalation)
- [Light mode](#14-light-mode---light)
- [Delivery gate](#15-delivery-gate)

## 12. Final Report Format

After convergence or budget exceeded:

```
## Review Pass Report

**Stage**: {stage}
**Rounds**: {total_rounds}
**Reviewers**: {reviewer_list} (R={R_actual})
**Result**: {CLEAN | NOT_CLEAN}
**Delivery state**: {RELEASE_ELIGIBLE | REVIEW_ONLY}
**Duration**: {elapsed_time}

### Summary
- CONFIRMED findings: {n} (all auto-fixed with diff)
- CONTESTED resolved: {n} ({via_arbiter} by arbiter, {via_user} by user)
- Remaining escalations: {n}
- Blocking vetoes: {n}
- Preservation probes: {passed}/{total}
- Complexity: {CLEAN | ATTENTION | REFACTOR_REQUIRED}; warnings={n}; waived={n}; invalid={n}

### Complexity Inventory
| File | Lines | Added | Script result | Waiver reason check | Required action |
|------|------:|------:|---------------|---------------------|-----------------|

### REQ-ID Coverage (if applicable)
- REQ-001: COVERED (src/file.ts:SymbolName)
- REQ-002: NOT FOUND — needs implementation
- REQ-003: DEFERRED (intentionally)

### Escalation List (unresolved CONTESTED from user prompts)
{numbered list, if any remain after user resolved inline during loop}

### Review Log
| Round | Lens | Result | Details |
|-------|------|--------|---------|
| 1 | correctness | FIXED | 3 findings (diff attached) |
| 2 | completeness | FIXED | 1 finding |
| 3 | — | CLEAN | — |
| 4 | — | CLEAN | Converged |

### Reviewer Health Scores
| Reviewer | Health | Notes |
|----------|--------|-------|
| gemini | 85 | Good specificity |
| opencode | 45 | Low — consider different model |
```

---

## 13. Finding Classification: Auto-fix vs. Escalation

**RULE: Spec/standard lookup test (apply first)**

If the conflict is answerable by reading an external spec, standard, or upstream
source code — it is **NOT** an escalation. Research it and fix directly.

**Auto-fix** (no user needed):
- Wrong logic, off-by-one, missing null check
- Convention violations (verifiable by reading project config)
- Missing error handling
- Test that doesn't actually test what it claims
- Unused imports, dead code
- Behavior-preserving decomposition of complexity introduced by the current change, with before/after tests and no public-contract change

**Escalate** (user decision needed):
- Business logic direction (A vs B approach)
- Design decisions with no objective right answer
- Scope questions (should this be done here or separately?)
- Requirements ambiguity (REQ says X but could mean Y)
- Changes that affect public API or user-facing behavior
- Any `replace|remove|disable|redirect|migrate` disposition or change to a primary entry, discovery/binding path, exported contract, package/deployment target, or handoff artifact
- Any request to dismiss a preservation, scope, authority, or release veto

---

## 14. Light Mode (`--light`)

Applied when the user explicitly specifies `--light`:

| Item | Standard | Light |
|------|----------|-------|
| Convergence | per-stage default | 1 clean round |
| Lenses | all stage lenses | first lens only |
| Max rounds | 8 | 4 |
| Applicable | feature work, major changes | development/test typo fixes and non-feature config only; never planning/integration |

The orchestrator must NOT choose light mode autonomously.

---

## 15. Delivery Gate

- `CLEAN` plus current, trusted preservation evidence yields `RELEASE_ELIGIBLE` only after every REQUIRED control is implemented and verified. A generic runtime Clean does not override a PENDING preservation control.
- Any missing input, unresolved finding, veto, failed probe, budget exhaustion, or insufficient
  reviewer-role separation yields `NOT_CLEAN` and `REVIEW_ONLY`.
- `REVIEW_ONLY` may be committed locally as a checkpoint. Remote review-branch push is publication
  and is forbidden until an exact signed checkpoint-publication operation is implemented and tested.
  It must not merge, deploy, publish a release, close the issue, or use completion language.
- Deployment and release automation must consume the delivery state and fail closed unless it is
  `RELEASE_ELIGIBLE`. Built-in release-command regexes are supplemental detection, not a complete
  security boundary; each project must provide a strict adapter declaration for every external-side-
  effect operation. A test-count summary is not a substitute for this state.
