# G-OC01 part B — Declarative `guard_policies` schema (IDD Plan v3)

**Issue**: nextain/naia-adk#6 (G-OC01) · umbrella nextain/naia-agent#37 (D-OC10)
**Status**: PLAN v3 (revised after design-review R1 (19) + R2 (1C/1H/1M/1L
design · 1C/2H/1M/1L security · 1C/2H/1M feasibility), all addressed).
Awaiting design-review convergence → **user approval (IDD Plan GATE)**. NOT a
pure refactor; behavior-surface. NO code until approved. B is explicitly a
user-decision: rigorous review has shown B delivers *less* (only 2 guards
truly qualify) at *real security cost* — §9 gives an honest recommendation.

## 0. What R1→R2→v3 changed

- R1: original "all 9 guards" unsound (procedural tails, security invariants
  as data). v2 narrowed to 3 + hardcoded invariants.
- R2 decisive findings → **v3**:
  - `design_doc` calls `fs.existsSync(unlockFile)` in its detection path
    (edit.js:25) → NOT stateless → **dropped from B1**. **B1 = exactly two
    guards: `destructive_git` + `email_send`** (regex+sanitizer only, zero
    fs/exec/state, one match-derived `{label}` var — byte-identity trivially
    & fully provable, no adapter-opt vars).
  - B-PROT bash-string detection is structurally leaky (Turing-complete
    shell) → v3 adds a **content-integrity gate** as the *actual* security
    barrier (bash detection demoted to best-effort advisory).
  - Shipped schema == DEFAULT ⇒ a dead loader passes every existing gate
    (the part2 ④ R4 "masking" trap) → v3 mandates a **canary liveness
    probe** that *gates* the regression bar.
  - Reason templates were `"...(verbatim)..."` placeholders → v3 inlines the
    **exact** content + explicit blank-line/trailing encoding.
  - Loader-throw into fail-OPEN `destructive_git`, non-empty-but-inert,
    ReDoS mid-session amplification, .users mirror, commit ordering — all
    specified below.

## 1. Problem / Why (unchanged)

Forks must edit JS in the public base ADK to change *rule data*. That data
belongs in the SoT (`agents-rules.json`). Policy *logic* and *security
invariants* must NOT become data.

## 2. Scope — v3

**B1 = exactly two guards** (the only genuinely stateless, side-effect-free,
single-static-var ones, verified against code):

| Guard | Detection path | Externalized data | Reason var |
|---|---|---|---|
| `destructive_git` (bash.js:21-40) | `core.stripQuotesBlank` + 3 regex; **zero fs/exec** | `patterns[{regex,flags,label}]` | `{label}` (matched pattern, schema) |
| `email_send` (bash.js:162-196) | `core.stripQuotesCollapse` + regex; **zero fs/exec** | `allow_rules[{regex,exclude_regex?}]`, `send_patterns[{regex,label}]` | `{label}` (matched send_pattern, schema) |

**Permanently hardcoded, never data (security invariants):** every guard's
`fail_mode` (NOT a schema field); the §5 self-protector; `prod_gateway`
credential literals (never in public git-tracked SoT).

**Deferred — each needs its OWN future IDD plan (NOT this one):**
`design_doc` (fs.existsSync unlock — R2 design F-3), `pr_guard` (execSync +
`github.com` hardcode), `deploy` (config.json + approval SM), `gitPush`
(marker SM), `commit` (progress discovery + computed `{remaining}`),
`prod_gateway` (content scan + credentials), `cascade` (message build).

## 3. Schema shape — v3 (exact, review-ready)

`agents-rules.json` → add:

```jsonc
"guard_policies": {
  "_meta": { "version": 1 },
  "destructive_git": {
    "patterns": [
      { "regex": "git\\s+checkout\\s+--\\s", "flags": "", "label": "git checkout -- <file>" },
      { "regex": "git\\s+reset\\s+--hard\\b", "flags": "", "label": "git reset --hard" },
      { "regex": "git\\s+clean\\s+.*-[fdxX]*f[fdxX]*\\b", "flags": "", "label": "git clean -f" }
    ],
    "reason_lines": [
      "[Harness] 파괴적 git 명령 차단: `{label}`",
      "이 명령은 변경사항을 영구 삭제합니다. 되돌릴 수 없습니다.",
      "실행 전 사용자에게 반드시 확인받으세요:",
      "  \"이 명령을 실행하면 X가 삭제됩니다. 진행할까요?\""
    ]
  },
  "email_send": {
    "allow_rules": [
      { "regex": "send\\.js\\s+preview" },
      { "regex": "send\\.js\\s+test", "exclude_regex": "send\\.js\\s+send" },
      { "regex": "send\\.js\\s+send\\s+.*--test-only" },
      { "regex": "send-cloud\\.js\\s+test" },
      { "regex": "send-cloud\\.js\\s+preview" },
      { "regex": "send-cloud\\.js\\s+send\\s+.*--test-only" },
      { "regex": "press-release-test", "exclude_regex": "press-release-send" },
      { "regex": "gcloud.*(?:describe|logs|list)" },
      { "regex": "gcloud.*scheduler.*(?:pause|delete|describe)" },
      { "regex": "check-replies\\.js" }
    ],
    "send_patterns": [
      { "regex": "send\\.js\\s+send", "label": "send.js send (실제 기자 발송)" },
      { "regex": "send-cloud\\.js\\s+send", "label": "send-cloud.js send (클라우드 발송)" },
      { "regex": "gcloud\\s+run\\s+jobs\\s+execute\\s+press-release-send", "label": "Cloud Run Job 실행 (실제 발송)" },
      { "regex": "gcloud\\s+scheduler\\s+jobs\\s+(?:create|run|resume)\\s+press-release", "label": "Cloud Scheduler 생성/실행 (예약 발송)" }
    ],
    "reason_lines": [
      "[Harness] 외부 이메일 발송 차단: `{label}`",
      "",
      "외부 수신자에게 이메일을 발송하려면 사용자의 명시적 승인이 필요합니다.",
      "",
      "허용된 명령:",
      "  - node send.js test (luke.yang@nextain.io로 테스트)",
      "  - node send.js preview (수신자 목록 확인)",
      "  - gcloud run jobs execute press-release-test (클라우드 테스트)",
      "",
      "실제 발송은 사용자가 직접 터미널에서 실행하거나,",
      "사용자가 '발송해' '보내' 등 명시적으로 지시한 경우에만 진행하세요."
    ]
  }
}
```

**Encoding (R2 feasibility HIGH):** `reason = reason_lines.join("\n")`. A
blank line = an empty-string array element. Neither B1 reason ends with a
trailing `\n` (verified: bash.js:35 destructiveGit ends `진행할까요?\`` (no
`\n`); bash.js:191 emailSend ends `…진행하세요.` (no `\n`)) — so NO trailing
empty element. (designDoc — the only reason with a trailing `\n` — is out of
B1, so the trailing-`\n` edge is moot here.) The §3 arrays above are the
EXACT bytes, decomposed from bash.js:31-35 and bash.js:184-191; the
adversarial review reviews THIS, not a placeholder.

**`interpolate`** (harness-core, pure): `line.replace(/\{(\w+)\}/g,(m,k)=> k
in vars ? String(vars[k]) : m)`. Non-recursive (substituted values are not
re-scanned). B1 vars: `{label}` only, for both guards, always a static
string from the matched schema entry — no computed/IO/adapter var. Byte-
identity is therefore fully provable from the schema alone.

**`exclude_regex`** models emailSend's two compound allow-conditions
(bash.js:165 `test AND NOT send`; bash.js:170 `press-release-test AND NOT
press-release-send`). Loader allow predicate: `allow = rule.regex.test(cmd)
&& !(rule.exclude_regex && new RegExp(rule.exclude_regex).test(cmd))`.
**Equivalence to the JS sequential early-returns is NOT assumed — it is a
gated acceptance item (§6.2 full matrix).**

`flags`: loader whitelists `imsu`, rejects `g`/`y` (lastIndex state traps).
B1 ships `flags:""` for all.

## 4. Loader + fail-safe — v3

`harness-core.loadGuardPolicies(cwd)` → resolved policy set. **Never throws**
(internally fully try/caught). **Additionally, the caller wraps the call**:
each B1 policy does `let P; try { P = core.loadGuardPolicies(cwd); } catch {
P = core.DEFAULT_GUARD_POLICIES; }` — so even a loader implementation defect
that escapes its internal guard still yields the built-in, never `null`,
never silent-skip (R2 sec #6 — closes the new fail-OPEN-via-loader path for
`destructive_git`). §6.3 adds a test that mocks the loader to throw and
asserts destructive_git STILL blocks.

**Call-site:** per policy invocation, inside the policy fn, `cwd = (data &&
data.cwd) || process.cwd()`. Never module-load (would bypass adapter
fail-CLOSED envelopes). **Caching:** memo keyed by abs path + mtimeMs;
re-parse only on mtime change.

**Per-guard WHOLESALE fallback** (no per-field hybrid). A guard uses its
schema block ONLY if ALL hold: present/typed; every rule array non-empty;
every regex/exclude_regex compiles; `flags ⊆ {i,m,s,u}`; `reason_lines`
non-empty string array. Else the ENTIRE guard → built-in `DEFAULT_GUARD_
POLICIES` + a surfaced warning line in `buildSessionInject` (`⚠ [HARNESS]
guard_policies.<g> invalid — built-in default`).

**Explicit limitation (R2 sec #1):** the non-empty check is necessary, NOT
sufficient — a non-empty but inert ruleset (`regex:"zzz_never_matches"`)
passes validation and would neuter the guard with no warning. **The loader
is NOT the defense against malicious neutering; §5's integrity gate is.**
This is stated so no future reviewer mistakes §4 for the security boundary.

## 5. Self-protection & threat model — v3

`guard_policies` in the editable git-tracked SoT ⇒ an AI could weaken its own
guard. Defense is **two-layer**, the second being the real barrier:

**Layer A — best-effort write detection (advisory).** Hardcoded,
non-externalizable clauses:
- `edit.js`: Edit/Write whose path == `.agents/context/agents-rules.json` →
  user-report block.
- `bash.js`: a dedicated hardcoded guard matching common write/redirect
  tokens to that path (`>`,`>>`,`tee`,`cp`,`mv`,`cat …<<`,`dd`,`sed -i`,
  `jq … >`,`node -e/-p`,`python/python3 -c`,`perl -i`,`install`,`truncate`).
  **Explicitly documented as best-effort detection, NOT a barrier** — shell
  is Turing-complete; enumeration cannot be exhaustive (R2 sec #4).

**Layer B — content-integrity gate (the actual barrier, R2 sec #4).**
`loadGuardPolicies` computes a hash of the on-disk `guard_policies` subtree.
A baseline hash is recorded (i) in a location an AI cannot edit via the same
class of action — concretely a hardcoded constant updated only by the
release/sync process, OR (ii) an `.agents/context/.guard-policies.lock`
whose own edits are themselves Layer-A protected. On hash mismatch WITHOUT a
user-approved unlock marker (`.claude`/`.pi` `guard-policies-unlock`, same
pattern as design-doc-unlock): **the loader ignores the on-disk schema and
uses built-in DEFAULT + a prominent persistent warning**. Net effect: a
successful *undetected* write CANNOT silently weaken the live guards — it
just reverts the system to safe built-ins until the user explicitly
approves. This makes Layer-A's leakiness non-security-critical. **This is
the core v3 security fix; B-PROT = Layer A + Layer B.**

The self-protector (both layers) is **hardcoded, never read from
guard_policies**, permanently OUT of scope (§2) — no circular self-disable.
**Ships as B-PROT, a separate merged+verified commit, BEFORE any B1 loader
code lands** (commit-ordering invariant, R2 sec #2; the initial `guard_
policies` population write itself goes through the Layer-A user-report flow /
unlock — documented operational step, R2 design F-4).

**ReDoS (R2 sec #7):** honest — fork-supplied regex runs in a hot path; Node
has no regex timeout; because patterns are re-read on mtime change, a
malicious/bad pattern introduced mid-session hangs *every subsequent* tool
call, not just the first. Mitigation: loader rejects patterns failing a
cheap nested-unbounded-quantifier heuristic (documented non-exhaustive) +
length cap; Layer-B integrity gate means an unapproved pattern change
reverts to built-in anyway. Shipped base patterns are the existing safe
ones. RE2/regex-timeout = explicitly future, out of B.

## 6. Acceptance bar — v3

**6.0 GATING PREREQUISITE — canary liveness (R2 feasibility CRITICAL).**
Before any other gate is considered valid: a test injects into a temp
`agents-rules.json` a `destructive_git` canary pattern absent from
`DEFAULT_GUARD_POLICIES` (e.g. `"NAIA_CANARY_BLOCK_ME"`); assert (a) a
command containing it is BLOCKED, and (b) the SAME command under
`DEFAULT_GUARD_POLICIES` alone is NOT blocked. This proves the loader is
actually consulted (not silently returning DEFAULT). §6.1 regression is
**INVALID unless 6.0 passes** — stated as a hard prerequisite so the
shipped-schema==DEFAULT masking trap (part2 ④ R4 recurrence) cannot hide a
dead loader.

**6.1 Regression byte-identical** (only meaningful after 6.0): golden
8/42/19 + E2E 64 + system 13 + pi 20 green with the shipped B1 schema.

**6.2 builtin↔schema parity — FULL matrix (spec'd, not "exists"):** for
each B1 guard: (a) each pattern → positive-match BLOCK; (b) a near-miss per
pattern → NOT blocked (boundary); (c) every `allow_rule` → ALLOW; (d) every
`exclude_regex` compound → its pass-path (`regex` matches, `exclude_regex`
matches ⇒ NOT allowed ⇒ falls through) AND its allow-path; (e) the JS-vs-
schema ordering cases incl. mandatory `node send.js test send` ⇒ BLOCK and
`node send.js send --test-only` ⇒ ALLOW. loaded-schema output == DEFAULT
output for every probe (proves faithful migration).

**6.3 fail-safe adversarial:** missing/truncated/absent/ malformed-one-guard
/ valid-but-empty `patterns:[]` / uncompilable regex / **loader-mock-throws**
→ that guard wholesale-reverts to built-in (still BLOCKS known-bad) + warning
surfaced; no per-field hybrid; other guard unaffected.

**6.4 fork-override:** added pattern changes behavior as declared; remove-all
→ invalid → built-in + warn (not silently disabled).

**6.5 B-PROT:** Layer A blocks Edit/Write + the enumerated bash tokens to
agents-rules.json (both hosts); **Layer B**: a direct out-of-band write
(simulating an undetected vector) → next load detects hash mismatch → built-
in + warning (proves Layer B is the real barrier); protector provably not
loaded from schema (stub schema → still protects).

**6.6 fail_mode invariant:** schema with any `fail_mode` key → IGNORED; pr
stays fail-CLOSED (re-assert part2 R5/R6; B1 doesn't touch pr_guard).

**6.7 .users mirror (R2 feasibility MEDIUM):** shipping `guard_policies`
into `agents-rules.json` triggers the cascade contract → `.users/context/
agents-rules.md` + `.users/context/en/agents-rules.md` updated to include it;
mirror parity tested (part1 cascade rule compliance).

**6.8 Adversarial cross-review to 2-consecutive-clean** — axes: schema-
fidelity (byte-identity via interpolate, the exact §3 arrays), fail-safe-
correctness (wholesale + inert-caveat + loader-throw), security-non-weakening
(fail_mode hardcoded, protector non-circular, Layer-B integrity barrier),
loader-robustness, test-validity (canary liveness genuinely gates).

## 7. Phasing — v3

- **B0**: this plan + design-review converged → user approval (GATE).
- **B-PROT** (separate merged+verified commit, FIRST): Layer A + Layer B
  hardcoded self-protector; own adversarial 2-clean; lands before any B1
  loader code (commit-ordering invariant).
- **B1**: harness-core `loadGuardPolicies`+`DEFAULT_GUARD_POLICIES`+
  `interpolate`+integrity hash; migrate ONLY destructive_git + email_send;
  6.0 canary FIRST, then 6.1-6.7; .users mirror; adversarial 2-clean.
- **future (separate plans, NOT here):** design_doc, pr_guard, deploy,
  gitPush, commit, prod_gateway, cascade.

## 8. Open decisions for user (Plan GATE)

1. **Scope v3:** B1 = only `destructive_git` + `email_send` (everything else
   deferred/hardcoded). OK?
2. **Fail-safe (§4):** per-guard wholesale fallback + non-empty mandatory +
   surfaced warning; loader is NOT the neuter defense (Layer B is). OK?
3. **Self-protection (§5):** ship B-PROT FIRST = Layer A (best-effort bash/
   edit detection) + **Layer B (content-integrity gate: unapproved
   guard_policies change ⇒ revert to built-in)**. This is the real barrier —
   acceptable, or do you want a different integrity mechanism?
4. **ReDoS (§5):** heuristic + cap + Layer-B revert; RE2 deferred. OK?
5. **Canary liveness (§6.0)** gating the regression bar. OK?

## 9. Honest recommendation (self-rigorous) — FIRM: DEFER

Three rounds of independent multi-reviewer adversarial **design** review
(R1 19 · R2 ~13 · R3 ~10) converged on a decisive conclusion. The R3
security reviewer found a **structural CRITICAL**: v3's Layer-B content-
integrity gate — introduced as "the core security fix" that makes the
inevitably-leaky bash write-vector non-critical — **has no sound integrity
root**:

- baseline = hardcoded JS constant → a legitimate fork must edit JS to
  re-baseline → **defeats B's entire purpose** (fork edits JSON, not JS); or
- baseline = `.guard-policies.lock` "protected" by Layer-A → Layer-A is, by
  the plan's own admission, best-effort/non-barrier → Layer-B **collapses to
  Layer-A strength** → not a real barrier.

This is not fixable by spec tweaks (the reviewer: "structural gap, not an
implementation defect; no code change to B1 fixes it"). A sound design
would need an out-of-band trust root (signing key outside the AI's write
surface, or a human review-required merge gate) — i.e. **more machinery
than B itself**, for 2 guards. The security reviewer explicitly:
"§9's … 'defer-until-needed' recommendation become**s** stronger in light
of this finding."

Honest cost/benefit, post-review:

- **Benefit:** forks tune destructive-git patterns + email send/allow lists
  via JSON instead of patching base JS. Modest; **no concrete fork demand
  exists today**.
- **Cost:** only 2 of 9 guards safely qualify; a new SoT attack surface
  whose only sound closure is heavier than B; a delicate loader; ~8+
  acceptance gates incl. per-guard canary liveness; ongoing dual-mirror
  maintenance — and the **cross-tool goal is ALREADY met by part2**
  (policies are tool-agnostic & host-portable; Claude+pi proven, 2-clean).

**FIRM RECOMMENDATION: DEFER B.** Do not implement now. Keep policies
hardcoded (tool-agnostic, host-portable — done in part2). Revisit declarative
externalization only if/when a concrete fork presents a real, recurring need
for it AND a sound out-of-band integrity root is available. This plan is
preserved as a complete, review-hardened design record so the analysis is
not lost when that day comes. This is a textbook "정직한 개선 / 과적합
경계 / defer-until-needed" call per the workspace self-improvement philosophy.

**Decision is the user's at the Plan gate.** Options: (1) **DEFER**
(recommended) — close B as designed-not-built; (2) approve a *minimal* B1
(2 guards) accepting Layer-B is only a bar-raiser not a guarantee, with the
risk documented; (3) redesign the integrity root (signing/review-gate) as a
separate larger effort first. The plan is implementation-ready for option
(2) if explicitly chosen; (1) is the self-rigorous default.

## 10. R3 residual findings (recorded for completeness; moot if DEFER)

If option (2)/(3) is ever chosen, these R3 items must be fixed first:
- **[design HIGH]** §6.2's mandated case `node send.js test send ⇒ BLOCK` is
  factually wrong — JS bash.js:165 yields ALLOW (the `\s+send` after
  `send.js` does not match `…test send`). Replace with valid exclude-path
  probes.
- **[sec CRITICAL]** Layer-B integrity root unsound (the deferral driver).
- **[sec HIGH / feas HIGH×2]** §6.5 doesn't test the both-files-updated
  attack; §6.0 canary is destructive_git-only (need per-guard canary, +
  a remove-one-DEFAULT-pattern probe to prove wholesale-not-hybrid).
- **[feas/sec MEDIUM]** hash canonicalization form unspecified; fail_mode
  loader merge-order; no-match-pass probe absent.
- **[feas LOW]** `en/agents-rules.md` doesn't exist → formally exempt
  guard_policies from the EN prose mirror (KO auto-mirror only).
Verified-clean by R3: §3 reason arrays are byte-exact vs bash.js:31-35 &
184-191; allow/exclude semantic equivalence holds for all probed inputs;
interpolate injection-safe; §2/§5/§7 internally consistent; §9 honest.
