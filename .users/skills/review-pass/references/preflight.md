# Preflight Gates

### Governed-mode preflight (before every stage)

When request-contract integrity is enabled (`REQUEST_CONTRACT=on` or the runtime marker exists):

1. Issue a one-time review challenge, load its mode-0600 private bundle, and recompute the canonical digest. Reject stale, partial, expired, or replayed input. Raw sources never cross stdout or command arguments.
2. Review every exact source prompt and its byte-exact partition of obligation atoms plus every current and prior directive, state, target, acceptance criterion, authority, tombstone, change occurrence, implementation mapping, and evidence mapping in the bundle. Every directive atom must appear verbatim in a mapped directive surface before review can start.
3. Treat the bundle as the scope floor. `files`, `req_ids`, and prose `context` may add focus but may not remove anything.
4. A deferred/superseded/abandoned requirement counts as disposed only when the bundle carries a valid signed user-presence authority and an immutable tombstone covering its directive, target, criterion, trace-artifact, and trace-edge IDs.
5. Launch only a configured SHA-256-allowlisted reviewer through the trusted platform runner. The Linux reference is `scripts/request-contract-review-runner.cjs`: it pins reviewer and bundle bytes, runs them through isolated `bubblewrap`, and accepts a receipt only while consuming the same-process, one-time run evidence whose semantic fields exactly equal actual reviewer stdout. There is no direct review-JSON ingestion command. It records the sandbox child kernel boot/start identity and rejects collision with every writer host identity. Reviewer and review-runner attestors are SHA-256-pinned snapshots that bind their executable digests and the exact review-payload digest. Reviewer time, stderr, and rejected fields never control public output. Never allowlist a generic blind signer.
6. Reviewer stdout must list only the complete opaque relationship projection: source and obligation-atom IDs, directive/target/criterion, authority/tombstone, trace, change, implementation/evidence, and every current/prior scope-version mapping. It must never contain text, paths, locators, summaries, or digests. The trusted runner injects issued binding fields only after sandbox exit. The final receipt must be signed by the configured reviewer credential from a context and kernel process identity distinct from every writer session/host. The core issues the opaque `run_id`; `CLEAN` has zero closed finding codes and `DIRTY` has at least one. Invocation fields, writer sessions, and writer process identities are digest-bound, and run/context/process/execution identities are compaction-persistent global claims.
7. Review issuance is denied while any mutation lease is active. At ingestion, recompute the complete bundle and source/contract/workspace/scope/work/config/binding values; reject the receipt instead of recording it if any post-launch drift exists. Any later revision restarts the Clean streak. The general floor is two consecutive Clean receipts. Preservation adds planning×4 and integration×4 stage-bound roles; one four-role streak without stage attestation is not equivalent.

### Product-preservation preflight (planning and integration)

This preflight applies to all feature work, including non-governed projects:

1. Require `source_artifacts`, `baseline_ref`, `preservation_contract`, and an immutable `incident_history`. It must contain or securely resolve the original directives, later corrections, drift evidence, and current state in order; a meta-instruction to "review the whole history", selected excerpts, or AI prose summary cannot replace the history itself. Missing or mutable inputs produce `NOT_CLEAN`.
2. Verify that `baseline_ref` resolves to an immutable commit/tree. For imported third-party source, require an attested origin repository identity, immutable commit/tree, and digest computed from that origin tree; URL/commit syntax plus a local subtree digest is insufficient.
3. Load the project-specific preservation adapter and make it derive the exact complete baseline surface set independently of the proposed contract. Require every discovered surface to have a lowercase disposition plus `baseline_evidence_id` and `current_evidence_id`; reject missing, additional, renamed, or unreachable surfaces that lack an explicit disposition. UI routes/navigation, APIs, CLI commands, library exports, data schemas, jobs, package/deployment targets, and operations/handoff paths are examples; unsupported kinds require explicit N/A evidence rather than silent omission.
4. Treat `preserve` and `extend` as defaults. `replace|remove|disable|redirect|migrate` is valid only when that surface carries an exact `authority_id` and `expected_diff_digest`. Silence, an AI-authored issue/comment, or a derived REQ is not authority.
5. Reject requirements that omit source authority or immutable source references. A derived requirement may explain a human directive but may not narrow, supersede, or reverse it.
6. Treat capability reachability loss as deletion even when files remain: broken bindings/references, shadowed entry points, disconnected discovery paths, incompatible exports/schemas, changed package/deployment targets, and misleading handoff artifacts are in scope.
7. Require probes referenced by each surface's `baseline_evidence_id` and `current_evidence_id`. The probe must be a signed receipt emitted by an allowlisted project-adapter runner after executing the real entry, binding runner/command/exit/result/subject. Agent-authored probe JSON and shape/digest-only evidence are `NOT_CLEAN`. A new test that merely asserts an old entry is absent, redirected, or hidden is a false-green signal without valid destructive authority evidence.
8. Runtime stage binding and role-specific first-verdict views are implemented and adversarially tested. Treat real-entry probe execution semantics, named vendor-origin attestation, comparison/convergence rounds, and project-complete external-side-effect gating as **PENDING** until code and adversarial tests demonstrate them. Procedure text must not upgrade a pending control into an implemented guarantee.
9. If prior corrections or failed reviews exist, give reviewers the actual incident history and changed artifacts; do not provide only the orchestrator's conclusion.

### Deterministic complexity preflight (development, test, and integration)

Run the executable gate before model review. The repository root and immutable
review baseline are mandatory; partial-file and subtree enforcement are rejected:

```bash
node {skill_dir}/scripts/review-preflight.mjs --root {repo} --base {baseline_ref} --json
```

The gate measures every changed source file plus executable `.agents/skills/*/SKILL.md`
instruction surface and emits `NOT_CLEAN`,
`REVIEW_REQUIRED`, or `PREFLIGHT_CLEAN` around the complete complexity report.
Defaults are 500/800/1,200 lines and 80k/160k/300k bytes for
warning/refactor/critical, 250 added lines to an already-large file for mandatory
refactor, and 1,000/5,000 characters for long-line warning/refactor. Source paths
are not excluded merely because they are named vendor, build, coverage, or
minified; generated code requires the same exact reviewed exception as other
unavoidable complexity. The report binds repository root, baseline/HEAD commits,
changed-set digest, per-file hashes, and the waiver-document digest, and aborts
if the tree changes during measurement.

An optional `.agents/context/complexity-waivers.json` uses `schemaVersion: 1`
and exact `waivers` entries with `path`, current `sha256`, `maxLines`, `maxBytes`, a 20–500
character `reason`, `owner`, immutable `authorityRef`, and `expiresOn`. No globs
or permanent exceptions are allowed; expiry is at most 90 days. The canonical
waiver document must be a tracked regular file at that exact path. Any byte
change, invalid calendar date, exceeded line/byte ceiling, vague reason, unknown
key, or missing authority invalidates the exception. A valid exception remains
visible as `WAIVED_COMPLEXITY` and makes preflight `REVIEW_REQUIRED`, never
automatically Clean.

`authorityRef` is `source:USR-NNN#sha256:<digest>` and must resolve to exactly
one tracked regular human-source artifact under `.agents/requirements/sources/`.
The digest binds its exact bytes; mutable issue numbers and merely plausible REQ
names are not exception authority. Reviewers still decide whether the captured
human directive actually covers this exact deferral.

Give the complete machine report to every implementation/test reviewer. Reviewers
must echo its `complexitySha256` in their transcript so the named judgment is
bound to the exact executable report. A digest mismatch or newer tree restarts review.
Reviewers must compare each waiver reason with the actual code and report
`waiver_claim_mismatch` when the stated reason, code origin, responsibility, or
claimed indivisibility is false. A mismatch invalidates the waiver and blocks
Clean; do not fix it by merely inventing a more persuasive reason. Fix the code,
restore accurate evidence, or obtain exact authority. `WARN` requires a named
decomposition judgment. Unwaived `REFACTOR_REQUIRED` blocks Clean without a vote.

---
