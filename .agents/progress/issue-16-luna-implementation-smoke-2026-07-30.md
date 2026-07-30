# Issue #16 — Luna bounded-implementation smoke comparison

Date: 2026-07-30
Status: phase-1 routing evidence; not a full-composition cost claim

## Decision

Use Luna by default only for bounded implementation with an exact automated validator. Fall back to Terra when the implementation is bounded but lacks an exact validator. Use Sol for orchestration, final integration, unbounded work, and high-risk work.

## Native Codex comparison

The same nine deterministic algorithm-output tasks were run once through the existing development runner for Luna and the all-Sol control. Each output was scored by the hidden exact structural oracle.

| Route | Exact passes | Recorded monetary cost | Wall time |
|---|---:|---:|---:|
| `worker-luna` | 8/9 (88.9%) | $0.0545216 | 74.525 s |
| `worker-sol-control` | 8/9 (88.9%) | $0.3629880 | 53.401 s |

Within this narrow smoke, Luna matched Sol's pass count and used 84.98% less recorded monetary cost, but took 39.56% longer. Luna failed `DEV-ALG-09`; Sol failed `DEV-ALG-02`. Different failures mean this is not evidence of interchangeability.

## Evidence boundary

- One run per task is sufficient only to reject an obvious performance shortfall before opt-in use behind exact validation.
- This does not measure repository editing, tool use, orchestration, retries, review, rework, or total issue cost.
- The Microsoft Foundry leaderboard supplied by the user is candidate-selection context, not evidence produced by this repository.
- Terra remains the bounded fallback because the supplied coding-specific reference reports Terra at 0.82 and Sol at 0.81; that external result is not treated as local causal proof.

Local ignored journals:

- Luna SHA-256: `adc09e0d039b8e833b32a1cb6e75322f51b6d155ee213e756bd2bbbbbc01c923`
- Sol SHA-256: `33e8e360855325283ba9cd004cad13b2c6f7bf7d69f4be32ebcb601ba5e82a34`
