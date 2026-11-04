# Approved root runner

## Purpose and trust boundary

A person approves a reviewed plan on a mobile device; the AI submits the approved
request and receives an execution receipt. The person's authority stays with the
person. A workspace file or a short approval code alone never grants root access.
This Linux implementation uses only Node.js standard modules and the system shell.

The flow is: `.agents/progress/<work>/gates/deploy-plan.json` → adversarial review
of the exact plan → authenticated human approval → signed PLAN and STEP records →
AI submission → privileged verification → execution and protected audit receipt.
The human approval service must show the exact command, plan digest, review result,
caller UID and expiry before issuing signatures. It must enforce the authorized
human identity and require a clean review whose report names the exact plan digest.
The supplied offline signer is the signing primitive for that trusted service;
it does not provide a mobile UI, identity provider, or review adjudication.

At this revision `.agents/scripts/approval-plan.mjs` and
`docs/common/production-deploy-approval.md` are absent. The existing
`.claude/hooks/deploy-guard.js` delegates to
`.agents/hooks/policies/bash.js`: its project/expiry/single-use JSON is a local
workflow check. It remains unchanged. Its mutable records cannot authorize this
runner. PLAN-/STEP- prefixes are retained, with signatures added as the authority.
An instance with a different existing plan schema needs an explicit adapter that
preserves its reviewed bytes; it must not silently reinterpret old approval codes.

## Architecture and request format

The human installs a fixed `/usr/local/libexec/naia-approved-run` shell entrypoint
and `/usr/local/libexec/naia-approved-runner.mjs`, both owned by root and unwritable
by the AI account. A single sudoers rule grants only that entrypoint, with no
arguments, `NOPASSWD` and `NOSETENV`. The wrapper clears the environment before
starting the fixed `/usr/bin/node` interpreter. No privileged CLI option changes
keys, state paths, ownership rules, or validation functions.

The Ed25519 private key stays in a separate human-controlled approval service,
outside the AI account and its host-accessible secrets. The runner holds only
`/etc/naia-approved-runner/approval-public.pem`. Unlike a root HMAC issuer exposed
through the same sudo rule, this verifier cannot mint approvals. Compromise of
the signing service or its human authentication compromises this boundary.

A plan is UTF-8 JSON, for example (replace the digest with the command's real
SHA-256 before review):

```json
{
  "schema": 1,
  "steps": [{
    "id": "check",
    "command": "/usr/bin/id -u",
    "commandSha256": "<sha256-of-UTF8-command>"
  }]
}
```

The signer takes `PRIVATE_KEY PLAN_FILE REVIEW_FILE SUBJECT_UID STEP_ID` and emits
a JSON request with `planBase64`, `planSha256`, `stepId`, `command`, `planApproval`
and `stepApproval`. `planBase64` encodes the original file bytes, including spacing
and newlines. Each approval has `payload` and a base64 Ed25519 `signature`.
Payload fields are `schema: 1`, `kind`, `code`, `planSha256`, `subjectUid`,
`issuedAt`, `expiresAt`, and `reviewSha256`; STEP adds `stepId` and
`commandSha256`. Times are integer Unix milliseconds. `approvalBytes()` defines
the signed field order. Codes have `PLAN-` or `STEP-` plus 32 random hex digits.
The signer issues five-minute approvals; the verifier caps validity at 15 minutes.

Each invocation consumes both codes. For another step the approval service must
issue a fresh pair, after applying its human consent policy. Failed executions
and interrupted attempts consume their codes too; retry requires fresh approval.
The runner binds the signed UID to sudo's caller UID and binds both signatures
to the same plan and review digest.

The AI adapter sends the request on standard input to the installed entrypoint
through sudo. Input is capped at 1 MiB and ten seconds. It must never send the
private key, offer an arbitrary sudo command, or ask the person to paste a root
command. The adapter can relay the JSON exit receipt to the mobile approval UI.

## Verification, execution and records

The verifier hashes the original plan bytes, validates every step digest, finds
one unique step ID, compares the supplied command exactly and verifies both
signatures, caller binding and expiry. It reserves the two codes using exclusive
file creation under `/var/lib/naia-approved-runner/used/` before execution.
Concurrent replay therefore yields at most one execution; a partial reservation
fails closed. Used markers must survive restarts and backup/restore operations.
Deleting them or restoring an older ledger re-enables replay until token expiry.

The runner creates a private audit directory with `plan.json`, `request.json`,
`stdout`, `stderr` and `result.json`. It re-hashes the protected plan snapshot
before execution. The request contains the signed approval records. Output files
are opened before launch, and the result records timing, exit status, signal and
launch error. A crash can leave an incomplete audit directory and consumed codes;
operators investigate it rather than retrying the old request.

Execution uses `/bin/bash --noprofile --norc -c` with cwd `/`, closed stdin and an
explicit environment containing only fixed PATH, HOME, LANG and LC_ALL. A
five-minute timeout limits the direct shell. Approved commands must be foreground
operations: background processes and commands that daemonize can outlive the
shell and its receipt. Arbitrary approved root code has root authority, including
the ability to alter this runner; approval review must account for that fact.
Logs can contain command output secrets. Only root should read or export them;
capacity monitoring, retention and backups are operator responsibilities. Keep
used-code records at least until all corresponding approval windows have elapsed.

## Threat model

| Threat | Control and remaining review responsibility |
| --- | --- |
| AI invents a command or approval | Ed25519 signatures, UID binding, exact command equality and per-step SHA-256; private key isolated from AI |
| Plan replacement or changed whitespace | Signature binds SHA-256 of original bytes; protected snapshot rechecked before execution |
| Code reuse or concurrent requests | Exclusive durable used-code markers for both PLAN and STEP; consume before execution |
| Expired or future approval | Integer timestamps, future issue rejection, strict expiry and bounded lifetime |
| Path replacement, symlinks, hardlinks | Fixed production paths; check every protected ancestor's owner/mode; reject symlinks; no-follow open, file-descriptor checks and hardlink rejection |
| Environment or interpreter injection | Root-owned shell wrapper clears environment before Node; fixed interpreter; NOSETENV; fixed child environment and cwd; no shell startup files |
| Time-of-check/time-of-use (TOCTOU) | AI supplies bytes through stdin, never a plan pathname; all state ancestors protected from AI writes; exclusive creation and descriptor checks |
| Mutable command dependencies | Review must reject workspace scripts, user-writable executables/configuration/plugins and unpinned downloaded code; command-string hashing alone cannot freeze files read by an arbitrary shell command |
| Prompt injection in review/approval | Trusted human service enforces authenticated consent and digest-bound clean review; runner verifies the resulting attestation, not prose meaning |
| Compromised root or signing service | Outside this verifier's security boundary; revoke sudo access and signing trust, investigate audit and restore from trusted installation |

The runner cannot make `bash /writable/script`, package manager hooks or a command
reading attacker-controlled configuration safe merely by signing their text.
Use absolute executable paths and root-protected dependencies; include artifact
hashes and verification commands in the reviewed plan where necessary. A generic
shell runner is an authorization mechanism, not a sandbox for malicious approved
root commands. This limitation is a mandatory approval-service review rule.

## Human-only one-time installation and rollback

Review the scripts from a trusted checkout first. Provision an Ed25519 key pair
inside the human-controlled service using Node's `crypto.generateKeyPairSync`;
export SPKI PEM public key and keep PKCS8 private key private. Configure the
service's authorized human identity, caller UID, plan/review display and consent
policy before enabling the runner.

A human with existing sudo authority runs this installation once:

```sh
sudo /bin/bash scripts/install-approved-runner.sh ACCOUNT PUBLIC_KEY_FILE
```

`ACCOUNT` is the dedicated AI submission account; the signing key and human
identity must be independent of this account. This is installation documentation,
not a command the AI hands to a mobile approver for a routine operation. The
installer refuses existing destinations, including symlinks. For upgrades, first
back up every existing destination and a symlink's actual target, record those
backup paths, disable the sudoers rule, and have a human review replacement.
The installer is never invoked by tests or by this implementation task.

Rollback is a human root operation: remove the dedicated sudoers rule first,
stop any still-running approved processes after checking their effects, archive
the protected state and audit directory, then remove the entrypoint/module and
public key directory. Keep the ledger archive and private key secure. Removing
the runner does not undo commands already executed; each reviewed plan needs
its own rollback steps. Do not re-enable an older ledger while tokens remain
valid. Key rotation requires human replacement of the protected public key and
new approvals; old signatures then fail verification.

## Tests and acceptance

Run the non-root suite with the execution folder's `TMPDIR`:

```sh
node --test scripts/approved-root-runner.test.mjs
```

Tests generate ephemeral signing keys and protected temporary state, call the
real exported verification functions, and execute only harmless unprivileged
shell probes. Production CLI paths and privilege requirements stay fixed.
Negative cases cover changed commands/digests/signatures, expired approvals,
reused codes, unsafe paths and links. The suite also checks output, exit receipts
and clean environment. `pnpm test` includes it; `pnpm build` and the repository's
existing CI gates remain applicable.

A separate human-authorized staging acceptance must verify actual sudoers
matching, root ownership, reboot-persistent replay state, the mobile service's
human identity policy, approval display, and revocation. Root installation and
operational acceptance are deliberately separate from these non-root tests.
