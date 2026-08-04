# Issue #26 integration review — 2026-08-04

Stage: integration
Baseline: `dd20504f57548dd27cb0e7971905495091077d74`
Final reviewed scope digest: `sha256:40b57bd567c7b82dc58c7c9be7b890c1f8443ca99c5c5b8a2db70a2f954fed36`
Final complexity preflight: `PREFLIGHT_CLEAN`, `sha256:01eb92625e5a68ab51c9ce3283df904b2f6667874fdc80da56f62971c993eaa5`.

Four separated executions reviewed source/scope fidelity, architecture/privacy,
preservation/release truth, and test/evidence feasibility.

## Findings resolved

- Generic Codex MCP calls no longer claim network activity; they use `other`
  unless an explicit provider type proves a web operation.
- Shell execution now emits the safe `executing` enum without inspecting or
  retaining command content.
- Human job references changed from a collision-prone eight-character prefix
  to actionable `앞8~뒤4`; `job <reference>` resolves exact-first, bounds its
  indexed prefix range to 257 rows, and rejects collisions or broad prefixes.
- Skill requirement range, DSO code/test trace, full-suite counts, preservation
  intent/version/paths, and the current probe locator were corrected.
- The preservation contract explicitly declares `REVIEW_ONLY` rather than
  fabricating the trusted current probe-runner receipt that the generic harness
  does not yet implement.

## Verification

- Full Discord suite: 207 tests, 203 pass, 4 platform skips, 0 fail.
- Indexed/bounded short-reference plan, exact resolution, and ambiguity tests:
  PASS.
- Requirement trace, JSON syntax, diff whitespace, complexity preflight: PASS.

## Convergence

- Initial integration rounds found evidence-backed implementation and evidence
  defects; all in-scope defects were corrected.
- Final Round 1: all four roles CLEAN for implementation preservation; delivery
  separately `REVIEW_ONLY`.
- Final Round 2: all four roles CLEAN on the unchanged final artifact; delivery
  remains `REVIEW_ONLY` for the known trusted-receipt harness limitation.

Integration implementation verdict: CLEAN, two consecutive final rounds.
Delivery verdict: REVIEW_ONLY; no push, deploy, canary, or release-complete claim.
