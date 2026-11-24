[English](approval-plan-gate.en.md) | [한국어](approval-plan-gate.md)

# Approval plan gate usage (Approval Plan Gate)

Commands that change production servers or cloud resources cannot be executed
by AI directly. Every production change passes only through this order:
**write a plan → adversarial review → gate-issued approval codes
(preapprove) → ask a human for the codes → byte- and pinned-file SHA-256
comparison at execution**.

---

## 0. Instance extension config (`config/deploy-gate.json`)

Upstream (`naia-adk`) holds only the common gate skeleton; instance-specific
information such as company/server names, IPs, subscription IDs, and channel
IDs never goes in. Each instance repository registers its own production
service list and combination rules with `config/deploy-gate.json` (example:
`config/deploy-gate.example.json`) and optional plugin modules (`plugin`).

- **Default behavior (Fail-Closed)**: when `config/deploy-gate.json` is
  missing, or a command's production service key is not registered in the
  instance config or plugins, it is blocked immediately under the **"unknown
  production commands are blocked"** rule.
- **Skipping global options before commands, blocking unknown options**: the
  `gcloud` (`run deploy`, `run services update|replace`, `builds submit`,
  `app deploy`, `functions deploy`, `compute scp|ssh`), `kubectl`, `helm`,
  `terraform`, `fly`/`flyctl`, `wrangler`, `railway`, `supabase` classifiers
  skip known global options ahead of the subcommand (including the value
  token of value-taking options) to find the subcommand, and an unknown
  option ahead of the subcommand is judged approval-required
  (`*:unknown-option`) and blocked. Wrapped shell-script executions such as
  `bash release.sh` are classified recursively by body.
- **Old-approval (`approvals.json`) branch defense**: in environments where
  the approval plan gate (`config/deploy-gate.json`,
  `.agents/scripts/approval-plan.mjs`, `gates/deploy-plan.json`) is
  installed, a valid old `approvals.json` entry still does not take the old
  branch — it is checked by the new approval plan gate. The `approvals.json`
  flow is allowed only in pure old environments without gate files, and only
  for commands in the old `PROD_PATTERNS` scope; other production commands
  (`az`, `kubectl`, …) are always blocked. Old
  `.claude/deploy/config.json` dev-service (`dev_service` · `-dev`)
  exceptions apply only to the matching clause of compound commands.
- **Gate-root-based extension config loading**: `config/deploy-gate.json` is
  read from the gate root (repository root) found by the policy, even when a
  command runs in a subdirectory or after `cd <subdirectory>`.
- **Blocking on instance-extension errors**: on a `config/deploy-gate.json`
  `prodPatterns` regex error or `plugin` module load failure, the already
  collected `prodPatterns` hits are kept and an `unclassified` hit is raised
  to block immediately.
- **Config entries**:
  - `services`: per production service key
    (`azure:containerapp:<name>`, `gcp:cloudrun:<name>`,
    `vercel:deploy:prod`, …) — whether a readiness record
    (`gates/deploy.json`) is required, whether `ops`/`rollback` are allowed,
    command combination rules (`commandMustContain`, …)
  - `local:systemd:<unit>`: classifies a local system unit registered in
    `services` as a production service. Example:
    `"local:systemd:sample-web": { "requireDeployGate": false, "allowOps": true, "paths": ["/opt/sample-web"] }`.
    Recognizes `.service`/`.socket` suffixes, executable absolute paths, and
    shell wrappings like `sudo`·`env`·`sh -c`. The following changes require a
    plan and approval for the same service.
    - `systemctl` mutating verbs: `stop`, `start`, `restart`, `reload`,
      `enable`, `disable`, `mask`, `kill`, `daemon-reload`, `try-restart`,
      `reload-or-restart`, `reload-or-try-restart`, `reenable`, `unmask`,
      `revert`, `edit`, `set-property`, `preset`, `link`, `add-wants`,
      `add-requires`. `service <unit> <verb>` counts as the same mutating
      verb, and a `link` path argument is matched to the unit by file name.
    - A system-scope argument-less `systemctl daemon-reload` is treated as
      targeting all registered local services. `daemon-reload <unit>` is not
      real syntax, so tests use the argument-less form.
      `systemctl --user ...` is excluded from system-unit classification.
    - When at least one service is registered, if `$var`/`${var}`/command
      substitutions in the change target cannot be resolved exactly, or the
      target may be empty or arrive from stdin/`xargs`, the whole registered
      service set is treated as the target and blocked. Globs (`*`·`?`·`[`)
      are matched against registered units; an unresolvable target is
      blocked. Exactly resolved unregistered units and read verbs (`status`,
      `show`, `cat`, …) are handled as before.
    - Path changes under `/etc/systemd/system/<unit>.service`, `.socket`,
      each unit's `.d/`, and the optional `paths` (absolute-path array) —
      the paths themselves and files below — are classified as the same
      service. Covered tools: `install`, `cp`, `mv`, `tee`, `sed -i`, `rm`,
      `ln`, `dd`'s `of=`, `truncate`, `rsync` destinations, `chmod`, `chown`.
      `>`·`>>`·`>|`·`&>` redirects are included, so `echo`·`printf`·`cat`
      writes are checked too. Paths match on directory boundaries, so
      `/opt/sample-web2` does not belong to `/opt/sample-web`. With
      registered services present, an unresolvable variable/command
      substitution/glob left in a write target treats the whole registered
      service set as the target and blocks.
    - This classification is by unit and file path. `kill` with a raw PID or
      `pkill -f` looking up process strings does not query unit ownership,
      so it stays outside this local classification's guarantees.
      `systemctl kill <registered unit>` is included in the mutating verbs
      above.
  - `prodPatterns` / `sshAlwaysGated`: extra instance production-command and
    SSH-host classification patterns
  - `testHosts`: non-production (test) machine host/IP string list.
    Lowercase-normalized, trailing-dot (`.`) normalized, exact-name-only
    matching with no wildcards; a missing or broken config behaves as an
    empty list. Even when judged a non-production host, the `ssh` remote body
    is classified again, so production changes executed inside a test machine
    (`az vm delete`, …) and `-F`/`-o HostName` target overrides stay blocked.
  - `readOnlyScripts`: a
    `[{ "sha256": "<64-hex>", "path": "<repo-relative path>", "service": "<exact service key>", "note": "<description>" }]`
    array. When `gates/deploy.json` has `kind: "ops"` and a script of the
    allowed command shape below matches a registered `{sha256, path,
    service}` set exactly, the **gate directly verifies that
    `config/deploy-gate.json` and the script file are git-tracked with no
    symlinks and that worktree/index contents equal the HEAD blobs**, and
    after an adversarial review (PASS) skips the `PLAN`/`STEP` human code
    entry steps.
    - `service` wildcards forbidden: `service` must be exactly one service
      key with no `*`, `?`, `[`, `{` globs (a glob is a config-check error).
      Reusing the same `sha256` under a different `path` or `service` is not
      no-code.
    - Allowed command shapes (only the exact shapes count as no-code; when in
      doubt fall back to the approval-code/block paths):
      - `az vm run-command invoke -g|--resource-group <RG> -n|--name <VM> --command-id RunShellScript --scripts @<registered path>`
        (only allowed read/output options may be added: `--subscription`,
        `--query`, `-o|--output`
        [`tsv|json|jsonc|table|yaml|yamlc|none`], `--only-show-errors`; each
        option at most once, `--command-id` only `RunShellScript`,
        `--scripts` only one `@<registered path>`)
      - or exactly 2 tokens `bash <registered path>` / `sh <registered path>`
        (options, extra args, `sudo bash ...`, 3+ tokens like
        `bash <script> <step-id>` are not no-code)
      - `--parameters`, multiple `--scripts` or multi-arg `--scripts`,
        off-list options (`--ids`, …), shell operators (`;`, `&&`, `||`,
        `|`, backticks, `$( )`, `>`, `<`, `(`, `)`, newlines), and
        quote-split option tokens (`--scr"i"pts`, `--"parameters"`,
        `--scripts=""@...`, `'--query'`) are not accepted as no-code. Even a
        `readonly-no-code` verdict does not skip the existing `opsProblem`
        checks (version/image-change bans, length limits, external-command
        safety) or the `script:`/`package:` bans.
    - Review-time binding: the script path and SHA-256 are pinned in the plan
      step `files` so the script body rides in the adversarial-review
      request; the review receipt (`gates/deploy-plan-review.json`), the
      request text, and the input-list hash also bind the `readOnlyScripts`
      entries (`sha256`·`path`·`service`) and the script `sha256` as of
      review time. If current config/scripts differ from the reviewed bundle
      at execution (including newly added or edited `config/deploy-gate.json`
      entries committed after review), it is not no-code and falls back to
      the approval-code path.
    - Symlink/HEAD comparison: no symlinks on the script path or its parents
      (`lstat`); `realpath` must equal the registered in-repo `path`, and
      bytes must equal the git-tracked `HEAD` blob (writable untracked files
      and worktree modifications rejected).
    - Execution is left in the audit record (`audit.jsonl`) as
      `"readonly-no-code"` (`approved_by: "readonly-no-code"`), and may be
      repeated without approval codes while plan, script, and config match
      the reviewed state.
    - An unregistered `(sha256, path, service)` set, untracked/uncommitted
      changes to `config/deploy-gate.json` or the script, inline commands
      (`bash -c`·`--scripts "..."`), `kind !== "ops"`, or a failed
      adversarial review behave as before: blocked or requiring human codes.
    - **Remaining risks**: (1) the gate hook checks review-receipt/HEAD
      agreement at execution time but does not itself block `git commit`
      (out of scope), so commit control of the config file
      (`config/deploy-gate.json`) relies on PR review and branch protection.
      (2) A short TOCTOU window remains between the hook's `sha256`/HEAD
      check time and the actual `az`/`bash` process opening the script (a
      different body may run if the disk changes mid-execution).
  - `approver.discordUserId`: the approver's own Discord user ID (Snowflake)
    to compare on Discord approval
  - `plugin`: optional module path for per-service detailed combination
    verification (`assessService(service, ctx)`) or extra command
    classification (`classifyCommand(ctx)`)

---

## 1. Writing the plan (`deploy-plan.json`)

Write the plan at `.agents/progress/<task-ID>/gates/deploy-plan.json` under
the work folder.

```bash
# 1) print a blank form
node .agents/scripts/approval-plan.mjs template > .agents/progress/<task-ID>/gates/deploy-plan.json

# 2) check form fields and per-command normalized SHA-256
node .agents/scripts/approval-plan.mjs check .agents/progress/<task-ID>/gates/deploy-plan.json
```

### Things to watch when writing

- `architecture_fit`: always fill the three fields — **original request,
  attached parent structure, acceptance rationale** (see
  [architecture-fit-before-fix.md](./architecture-fit-before-fix.md)).
  Existing plans created (`createdAt`) before the baseline
  (`2026-11-15T04:30:00Z`) that are not `version >= 2` are not blocked, only
  warned (`check`·`report`·gate guidance). The `version: 2` form the
  `template` generates, and plans from the baseline on, require it.
  - `original_request` (a): gist of the original request, who wanted what
    (min 10 chars).
  - `parent_structure` (b): the platform, ADK upstream, and product parent
    structure it attaches to (min 8 chars). Only a specific server name, IP,
    service key, or single file name is blocked, as are `<...>` sample
    placeholder phrases.
  - `acceptance_rationale` (c): whether it is an existing extension or a new
    layer, and why it is not a throwaway patch (min 10 chars).
- `services`: every production service key the gate classified, no omissions.
- `scenario`: the steps to run (`s1`, `s2`, …) and rollback branches
  (`branch: "rollback"`) in order.
- `scenario[].commands`: the **command strings to actually execute, copied
  character-for-character**. Execution compares byte-for-byte, so a different
  space or quote blocks.
- `scenario[].files`: scripts/configs a command reads or executes
  (`bash ./deploy.sh`, `--yaml app.yaml`, `@body.json`, …) must be pinned as
  `"path": "<sha256>"`. A single changed byte in a pinned file blocks
  execution (`sha256 mismatch of pinned file`). Recursive checks of
  `bash scripts/rollout.sh` do not move into the script folder — they keep the
  caller's working directory and only honor an explicit `cd` inside the
  script.
- For bulk pre-issued approval codes (`preapprove`), set
  `"approval_mode": "preapprove_steps"` at the top.

### Running several pinned fixed scripts

A script (e.g. `sudo bash <script absolute path> <step id>`) is written
verbatim into the plan step `commands`, and the script plus the body it
uploads remotely are pinned in `files` as `{path: sha256}`. Such scripts are
**not accepted as ops**. The gate classifier cannot fully read whether the
script body (variables, eval, here-docs, remote bodies, kubectl, …) changes
the board, so calling `deploy.json` with `kind: "ops"` and
`bash /…` scripts is blocked as "fixed plan scripts are not accepted as ops".
The exception is `config/deploy-gate.json` explicitly naming
`allowCustomCommands` for that service to take `PLAN`/`STEP` human approval,
or a git-committed `readOnlyScripts`-registered exactly-2-token
`bash <registered path>`/`sh <registered path>` or an allow-listed-option
`az vm run-command invoke ... --scripts @<registered path>` single read
script run after a review PASS; 3+ tokens like `sudo bash ...` or
`bash <script> <args>` are not `readOnlyScripts` no-code targets.

Pinned scripts run on plan-approval without a readiness record. The byte
identity of the review-passed plan's commands and the `files` fingerprints
must match at execution, or they are blocked as `pinned file sha256
mismatch`. The `config/deploy-gate.json` service rules (`allowedCommands`,
…) still apply separately; plan paths and fingerprints are read from the
plan, so no code change is needed per plan. When a `deploy.json` for the
same service within 12 hours exists, its kind decides, so leaving an ops
record blocks scripts. With `requireReadiness: true` in config, the plan
approval path cannot be used.

Limits: fingerprints are checked once at hook time while bash reads the
script at execution, so a process changing an in-plan-folder (agent-writable)
script mid-execution can run different content than approved (TOCTOU, same
nature as the existing `bash <file>` branch).

---

## 2. Adversarial review (`review`)

When the plan form and pinned-file SHA-256 both check out, the next model in
rotation (`argon`→`codex`→`muse`→`argon`) adversarially reviews it against
ten criteria (`correctness`, `disconnect`, `rerun`, `rollback`,
`irreversible`, `security`, `impact`, `honesty`, `incident_safety`,
`architecture_fit` — plans written before the criteria date stay compatible
with the old 9-criteria set). The author is one of `argon`, `codex`, `muse`,
`claude`; when the first candidate hits a limit, the remaining one takes
over and the skipped record is kept as `skipped`.

Muse reviewers run as-is with a read-only call
(`--disable-write --disable-shell`). Codex and Claude reviewers require
`bwrap` read-only isolation in **both normal and recovery modes** — without
`bwrap` the run is rejected. Argon (`agy`) reviewers require `bwrap`
read-only isolation in **recovery mode**; in **normal mode** they run under a
`bwrap` read-only bind (`bwrap-ro-bind`) when `bwrap` is installed and fall
back to snapshot-only (`--mode plan --sandbox`) when it is absent. Without a
fixed `planReview`, the next model in rotation reviews first. An approver
decision can pin a reviewer to be used first until a given time by adding
the following `planReview` to the approved instance config
`.claude/deploy/config.json`. A limit failure hands over to the remaining
one only. A limit failure is a nonzero integer exit code with a limit phrase
(rate limit, quota, usage limit, 429, `RESOURCE_EXHAUSTED`, exhausted) in the
runner stderr or execution error. Review bodies are not used for the
decision. Signal-terminated runs (no exit code) do not count as limits. Other
existing config entries are kept.

```json
"planReview": {
  "reviewer": "codex",
  "until": "2026-11-13T23:40:00Z",
  "reason": "temporary reassignment by approver decision"
}
```

When `until` is missing or past, or `reviewer` equals the author, rotation
applies. Unapproved or unreadable configs use the default rotation. Format
errors in an approved config (`reviewer` outside the approved list, `until`
not an ISO time) are rejected. The gate takes one reviewer receipt with the
rotation record (`rotation: true`). It rebuilds the rotation at the record
time (`reviewedAt`) and compares: the `skipped` list matches the skipped
candidates from the front (each with nonzero `exit_code`) and the actual
reviewer is the next candidate. `reviewedAt` must be a UTC ISO time within 90
minutes before the reviewer receipt's start time (`started_at`). Records that
shift time to fabricate a rotation are blocked. Same-model-as-author,
off-rotation, no-limit-record followers, and 2-person records are blocked.
Old-shape records (no `rotation` field) are accepted only when both
`reviewedAt` and the reviewer receipt start time predate the rotation
introduction (`2026-11-10T10:00:00Z`). Deleting the `rotation` field from new
records to skip rotation comparison is blocked. Changing `planReview` after
review may change the rotation and require re-review. Author and reviewer
must differ.

Per-reviewer default models and minimum strengths are pinned in code
(`argon`: `gemini-4-argon-medium`/`medium`, `codex`: `gpt-6.1-terra`/`high`,
`muse`: `muse-spark-1.3`/`xhigh`, `sol`: `gpt-6.1-sol`/`high` for old
records). An instance's `.claude/deploy/config.json` may set `review_models`
— the exact reviewer-id model name (`model`), minimum effort (`effort`), and
runner (`runner`: `agy`, `muse`, `codex`, `claude`) — for approved configs
only. Approved `review_models` is the complete reviewer list to use; list the
default reviewers too to keep using them. The Claude runner is invoked as
`claude -p --model <exact name> --effort <strength>`. Model family or word
choice is not used to judge approval. Unapproved configs use the code
defaults. The receipt's `receipt.effort` is also required and must match the
config.

The default rotation uses only the first two candidates after excluding the
author; other reviewers can be used first via a valid `planReview.reviewer`.
A Claude-authored plan is never reviewed by a `claude`-runner reviewer.

After changing gate configs, get approval in this order:

1. Change the config and run `node .claude/hooks/gate-config-approval.js` to
   check the config hash, approval code, the full unlocked reviewer list, and
   the actual reviewer rotation per author. With a separate directory of the
   previously approved config plus `--approved-root`, `--approver-id`,
   `--channel-id`, `--message-id` and the `DISCORD_BOT_TOKEN` environment
   variable, Discord approval is verified and reviewer diffs are shown too.
2. The approver reviews the change and leaves the approval code on their own
   Discord post. Bot/webhook posts do not count. The instance gate code must
   pass the approver number pinned outside the common code and that post
   reference into the approval check. The common repository has no approver
   number, so approved configs do not apply on the stock CLI. Wire the
   approval check into gate execution on the instance before use.
3. The gate recomputes the hash and the `CFG-` approval code from the current
   contents of the config file pinned in code and compares them against the
   author's own post. A single changed character needs a new approval code.
   Local issuance records and issuance times are not checked. Unverifiable or
   unapproved configs use the defaults.

Instance code wraps gate checks with `withGateConfig({root, approverId,
refs, token}, () => evaluate(ctx))` from `deploy-plan.js`, and the CLI calls
`runApprovedApprovalPlan(options, argv)` from `approval-plan.mjs`.
`approverId` is a constant of the instance gate code, and `refs` holds the
code to check plus the Discord `channelId`·`messageId`. Both paths must share
the same approval context for receipts written with approved reviewers to
verify at the gate.

```json
"review_models": {
  "argon": { "model": "gemini-4-argon-high", "effort": "high", "runner": "agy" },
  "codex": { "model": "gpt-6.1-terra", "effort": "high", "runner": "codex" },
  "muse": { "model": "muse-spark-1.3", "effort": "xhigh", "runner": "muse" }
}
```

The finalized reviewer list is bound into `input_manifest_sha256`. After
this change merges, runners and input lists differ, so **open plans must be
re-reviewed and re-judged**. Changing an approved config so the finalized
list changes also requires re-issuing prior review receipts, skipped-reviewer
records, and failure-judgment records.

```bash
node .agents/scripts/approval-plan.mjs review .agents/progress/<task-ID>/gates/deploy-plan.json --author muse
```

- Every criterion must be `PASS` with `remaining: 0` (zero blocking
  findings) to pass.
- The only exception is one narrowly accepted risk: when the approver accepts
  it in a decision post, the plan carries a `risk_acceptance` field
  (`criterion: "security"`, `accepted_by`, `decision_url`, `same_value_as`,
  `no_new_exposure: true`, `reason`, `expires_at`) — then one `FAIL` of the
  `security` criterion and the one blocking finding tied to it are waived
  (`remaining` must still be 1). Any other `FAIL`, two or more blocking
  findings, a remaining blocking finding outside `security`, an expired
  `expires_at`, or past 7 days from `createdAt` still blocks. Unknown fields
  are rejected. Use only when emitting the same value already emitted;
  never for new exposure.
- The review receipt (`gates/deploy-plan-review.json`) binds the plan
  SHA-256, request-text SHA-256, pinned-file/runner/finalized-`review_models`
  (per-reviewer `model`·`effort`·`runner`) input-list hash
  (`input_manifest_sha256`), skipped reviewers (`skipped`) with model and
  effort, and the `readOnlyScripts` binding list at review time
  (`read_only_scripts`, per-entry `sha256`·`path`·`service`).
- **Editing the plan or pinned files after review immediately invalidates the
  prior review and approval codes** — re-review is required.

### 2.1 Repository write lock during review (`plan-review.lock` + `plan-review-write-guard`)

While an adversarial review runs, another session (layer-3 role session,
layer-2 worker, subagent, direct repository session) editing files in the
same instance repository would desync the input manifest and worktree
snapshot, invalidating the review or blocking the gate right after PASS. This
is blocked by a mechanism, not a prose rule (details:
`docs/guides/plan-review-write-guard.md`).

- **Lock file**: the `approval-plan.mjs review` runner exclusively creates
  `.agents/state/plan-review.lock` under the repository root of the plan at
  start (`schema: "plan-review-lock/v1"`, `pid`, `pidStartTicks`, `plan`,
  `repoRoot`, `startedAt`, `expiresAt`, default TTL 60 min, adjustable via
  `APPROVAL_PLAN_REVIEW_LOCK_TTL_MS`) and removes the lock file and the
  emptied `.agents/state` folder on normal exit, failure, and signal
  interruption (`SIGINT`/`SIGTERM`/`SIGHUP`) alike. A live existing lock
  rejects a duplicate review start.
- **PreToolUse blocking**: `.claude/hooks/plan-review-write-guard.js`
  (registered both in the repository `.claude/settings.json` and the user
  profile `templates/claude-user-profile/settings.json`) intercepts `Write`/
  `Edit`/`NotebookEdit`/`MultiEdit`/`apply_patch` and writing shell commands
  (redirection, `sed -i`, `rm/cp/mv/touch/mkdir`,
  `git add/commit/checkout/reset/stash`, inline Python/Node file writes,
  including symlink bypasses) inside the locked repository and blocks them
  with a `"under plan review (<plan path>, <start time>) — retry after it
  ends"` notice.
- **Pass-through scope**: read tools and read-only shell commands
  (`git status`, `git diff`, `ls`, `cat`, `rg`, `node --test`, …), writes to
  paths outside the locked repository, the review runner itself (PID
  lineage), and review records under `gates/` (`deploy-plan-review.json`,
  `deploy-plan-review-*.md`, `deploy-plan-review-findings.md` — but editing
  the `deploy-plan.json` original and deleting the lock file stay blocked)
  pass through.
- **Dead/expired locks and watchdog**: a lock whose previous process is dead
  (`pid` missing, zombie, PID reuse) or whose `expiresAt` passed does not
  block writes and emits a one-line notice (`additionalContext`). Conversely,
  on gate-input/lock JSON corruption, internal errors, or a stalled gate
  process, `lib/hook-watchdog.js` (default 15 s,
  `NAIA_PLAN_REVIEW_GUARD_WATCHDOG_MS`) kills the child and judges
  **blocked (fail-closed)**.

---

## 3. Issuing approval codes (`preapprove`)

For a plan that passed adversarial review, issue the whole-plan code
(`PLAN-xxxxxx`) and per-step codes (`STEP-xxxxxx`).

```bash
node .agents/scripts/approval-plan.mjs preapprove .agents/progress/<task-ID>/gates/deploy-plan.json --session <session-ID>
```

- This command prints `PLAN-xxxxxx` and per-step `STEP-xxxxxx` codes with a
  report.
- Issued codes are not approvals by themselves. They take effect only when
  the approver (a human) types them in directly.
- To approve each step separately without `preapprove`, post the report
  (`node .agents/scripts/approval-plan.mjs report <plan>`) directly, and at
  the first execution attempt enter the gate-issued `PLAN-xxxxxx` /
  `STEP-xxxxxx` codes in order when prompted.

---

## 4. Asking a human for codes (`report` → human input)

Post the plan summary report and approval codes to the approver.

```bash
node .agents/scripts/approval-plan.mjs report .agents/progress/<task-ID>/gates/deploy-plan.json
```

- **Do not hand the approver commands or scripts to copy and paste.**
- The approver reviews the report and approves one of two ways:
  1. **Direct chat input**: the human types `PLAN-xxxxxx` and the allowed
     steps' `STEP-xxxxxx` codes directly into the current session chat
     (tool output, system notifications, and AI messages do not count).
  2. **Own Discord message**: the approver themself leaves the codes on
     Discord, and with the channel/message IDs recorded in
     `gates/deploy-approval-discord.json` the gate compares the author ID
     (`approver.discordUserId`) and time directly via the Discord REST API.

---

## 5. Execution and per-step success confirmation (`step-ok`)

Once the approver enters the codes, the plan's step commands run in order.

1. **Run step 1**: the gate (`deploy-guard.js`) intercepts the command and
   compares all of the following:
   - Plan exists and is within its validity period (24 hours)
   - **Exact byte match** of the plan `commands` vs the executed command,
     plus normalized SHA-256 match
   - Appended forms (`… 2>&1 | tail`, `cd … && …`, `timeout …`, `> file`,
     `bash -c "…"`) are not the approved command and are blocked. Read-only
     steps are the same. Appending leaves no step approval or execution
     record, blocking the next step — so run the plan text verbatim even
     when output is long.
   - **Current on-disk SHA-256 match** of pinned files (`files`) and every
     file the commands reference
   - Adversarial review receipt (`deploy-plan-review.json`) and input
     manifest hash match
   - Instance service readiness (`config/deploy-gate.json` and
     `gates/deploy.json`)
   - Human `PLAN-xxxxxx` and that step's `STEP-xxxxxx` approval confirmation
     (single-use, consumed on execution). Exception: when `gates/deploy.json`
     has `kind: "ops"` and `config/deploy-gate.json`'s (git-tracked,
     HEAD-matching, no-wildcard) `readOnlyScripts` binds `{sha256, path,
     service}` identically to the review-time receipt, the script file is
     git-tracked and HEAD-matching with no symlinks, and the command is an
     allowed exact shape (`az vm run-command invoke ... --scripts
     @<registered path>` or 2-token `bash`/`sh <registered path>`) as a
     pinned read script, only the code steps are skipped after an adversarial
     review PASS and it may run repeatedly, recorded in `audit.jsonl` as
     `"readonly-no-code"` (`approved_by: "readonly-no-code"`).
2. **Record step success (`step-ok`)**: before moving to the next main step
   (`s2`), every command of the preceding step (`s1`) must have actually run
   (`status === "executed"`) with its success-confirmation output file
   recorded via `step-ok` (calling `step-ok` for `s1` first and then running
   `s2` without running `s1` — step skipping — is blocked).
   ```bash
   node .agents/scripts/approval-plan.mjs step-ok .agents/progress/<task-ID>/gates/deploy-plan.json s1 --evidence /tmp/s1-check.txt
   ```
3. **On failure/trouble**:
   - On a failed step check, follow the plan's `on_failure` branch (e.g.
     rollback step `r1`) and report.
   - When the operations-incident criteria (`incident.criteria`) call for
     immediate action (`incident.actions`), an independent-session judgment
     (`node .agents/scripts/approval-plan.mjs judge <plan> --evidence <log>
     --executor-session <session-ID>`) is required (passes only when the
     judge model/effort `review_models.muse` and `input_manifest_sha256`
     match the current config), and a `gates/deploy-incident-report-*.md`
     report must be written right after the immediate action before the next
     step proceeds.
