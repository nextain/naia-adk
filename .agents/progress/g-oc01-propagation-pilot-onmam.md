# G-OC01 Propagation — Pilot: onmam-adk (IDD)

**Decision**: user chose "pilot 1 fork first" (onmam-adk), prove the
verified procedure, then apply to naia-business-adk.
**Base**: nextain/naia-adk @ `4abd6fb` (G-OC01 part1+part2 COMPLETE,
tool-agnostic harness, adversarial 2-clean, pushed).
**Predecessor analysis**: naia-adk pre-part1 monolithic baseline =
`9a27640`.

## P0 — Divergence analysis (DONE — the critical safety gate)

onmam-adk's 11 common hooks vs naia-adk@`9a27640` (pre-part1 monolith):

| Result | Hooks |
|---|---|
| **9 PURE-REFACTOR** (onmam == naia-pre, byte-identical) → clean port, byte-identity guaranteed | cascade-check, commit-guard, deploy-guard, design-doc-guard, destructive-git-guard, email-send-guard, git-push-guard, pr-guard, prod-gateway-guard |
| **2 ONMAM-CUSTOM** (diverge from naia-pre) → MUST preserve, NOT blind-replace | `post-compact-context` (16 diff lines), **`session-inject` (272 diff lines — effectively a different implementation)** |

Also: onmam-adk lacks the part1 envelopes `_claude-bash-guard.js` /
`_claude-edit-hook.js` (introduced by the refactor — additive, no
conflict). settings.json registers 13 hooks (naia-adk 12).

**Why this matters:** because the 9 are byte-identical to naia-pre, and
naia-adk's part1/part2 adversarially proved the refactor is byte-identical
to naia-pre, the refactored shared policies are *provably* byte-equivalent
to onmam's current behavior for those 9 — a clean, low-risk port. The 2
custom hooks are the real work and the partial-merge-trap risk.

## Pilot scope & sequence (verified procedure to be proven here)

1. **B0 backup**: commit/copy onmam-adk working tree (incident lesson —
   pre-destructive backup, never git-restore to undo).
2. **Clean port (9 hooks)**: copy `.agents/hooks/core/harness-core.js` +
   `.agents/hooks/policies/{bash,edit}.js` + `.agents/hooks/package.json`
   + `.claude/hooks/_claude-{bash,edit}-*.js` + the 9 thin adapters from
   naia-adk@`4abd6fb`; re-point onmam's 9 hooks; pin onmam-specific opt
   paths (deployDir/unlockFile) per onmam's __dirname. Plus the pi adapter
   `.pi/extensions/naia-harness.ts` + e2e gates (adapted to onmam paths).
3. **Custom-hook resolution (the hard part — own sub-analysis each)**:
   - `post-compact-context` (16 lines): diff onmam vs naia-pre; decide
     carry-into-core (param) vs keep onmam override compatible with
     harness-core. Small.
   - **`session-inject` (272 lines)**: deep analysis — is onmam's a
     divergent fork of the SAME logic harness-core.buildSessionInject
     already generalizes (→ parameterize + adopt core), or genuinely
     onmam-bespoke session content (→ keep as onmam override that calls
     core where it can)? This is a mini-IDD on its own; do NOT clobber.
4. **Per-fork parity gate**: build/adapt a golden-parity harness for
   onmam (naia-adk's tmp/golden* are naia-specific) → prove the 9 ported
   hooks byte-identical to onmam's pre-port behavior; the 2 custom hooks
   behavior-preserved.
5. **Adversarial 2-consecutive-clean** (same rigor as part2): port-
   fidelity / security-non-weakening / custom-preservation / test-validity.
6. **Commit + push** onmam-adk (nextain internal = normal workflow);
   record the verified procedure.
7. Then: apply the proven procedure to naia-business-adk (its own P0
   divergence analysis first — likely similar but MUST be re-verified, not
   assumed; naia-business-adk also lacks agents-context-mirror.js).

## Status

P0 (divergence analysis) COMPLETE — pilot is now precisely scoped: 9
clean-port + 2 preserve. **`session-inject` 272-line onmam divergence is
the principal risk and needs its own careful sub-analysis before any
replacement.** Execution (B0→6) is the next deliberate workstream — NOT
rushed at session end on a production ADK security boundary (partial-
merge-trap class). Naia-adk base is pushed & ready as the port source.
