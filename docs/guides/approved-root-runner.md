# Approved root runner — offline primitive, installation blocked

## Delivery status

This PR provides an offline signing and verification primitive. The authenticated
Discord issuer is deferred to the next PR. **Do not install the runner before that
issuer is implemented, tested and accepted.** The installer unconditionally exits
before inspecting or modifying installation destinations, even if an issuer
configuration file is supplied. A configuration file alone cannot prove that an
issuer exists. The issuer PR must deliberately replace this gate with verified
configuration and acceptance checks; environment flags cannot bypass it.

The eventual flow is reviewed immutable plan → authenticated human consent →
signed PLAN and STEP → AI submission → protected execution and audit receipt.
A PLAN-/STEP- code alone grants no authority. Channel membership, channel roles
and a CLI approver ID do not authenticate a human. The offline signer is for a
human-controlled device; it is not a Discord bot or a mobile approval interface.

## Required key separation

The private Ed25519 key must stay on a separate human-controlled device, under a
separate UID from the AI submission account, or behind a human-side HSM/KMS.
Never put it on the execution server, in its containers, backups, environment,
repository, AI-readable secrets, or a colocated Discord bot. File mode 0600 does
not isolate a key from an AI running with its owner's UID.

The signer rejects a key unless it is a single-link regular non-symlink file,
owned by the signer UID with exactly 0400 or 0600 permissions and protected
ancestors. Plan, review and role files must be root-owned and unwritable by
non-root users throughout their ancestor chain; workspace copies are rejected.
Its mandatory pinned execution-host fingerprint must differ from the local
machine fingerprint; the signer UID must differ from the target caller UID.
Both signatures bind the execution-machine digest and the verifier compares it
to its protected local machine-id, so a fabricated target digest cannot authorize
execution. A human provisions the actual digest through a trusted channel.
Machine-id is a deployment check, not hardware attestation; cloned IDs must be
regenerated and a compromised root host can falsify them. No filesystem scan can
prove that a secret or a duplicate key is absent from a host.

Staging must attest: no private key or bot token on the runner host; no shared
UID, mounted home, backup, /proc access or container secret between AI and signer;
correct machine identity; public key matches the registered approver; revocation
and key rotation work. Installation stays blocked until this evidence exists.

## Plans and immutable file dependencies

Plans are original UTF-8 JSON bytes. The signed SHA-256 binds whitespace too.
Every executed or read script/configuration file must be declared on the step as
`artifacts: [{"path":"/absolute/source","sha256":"<digest>"}]`. Refer to a
snapshot using `{{artifact:0}}`, `{{artifact:1}}`, etc.; never execute the original
workspace path. A harmless command with no file dependencies uses an empty list:

```json
{
  "schema": 1,
  "steps": [{
    "id": "check",
    "command": "/usr/bin/id -u",
    "commandSha256": "<sha256-of-the-exact-command>",
    "artifacts": []
  }]
}
```

The current executable allowlist is exactly `/usr/bin/id`, `/usr/bin/printf`,
`/usr/bin/true`, `/usr/bin/false` and `/usr/bin/cat`. To inspect a reviewed file,
use `/usr/bin/cat {{artifact:0}}` and its path/hash artifact entry. Cat accepts
only snapshot references. The runner copies bounded source bytes into exclusive
files in its root-only audit directory, verifies hashes, and passes only copies
to the child. Original mutation before copying causes rejection; mutation after
copying cannot change the bytes consumed. Symlink/hardlink and oversized sources
are rejected. Copies remain in the protected audit record.

Commands use a limited argument grammar and direct process launch. Shells,
interpreters, package/build/download tools, relative executables, pipelines,
redirections, backticks, `$()` and other expansion syntax are rejected. Direct
file-path arguments are rejected. Executables are checked for protected ownership
at runtime. These restrictions invalidate unsafe old plans; re-review and issue
fresh approvals.

This is deliberately more restrictive than snapshotting arbitrary shell scripts:
a signed script can still source an unsigned workspace configuration or execute
a changed second script. Declaring the first script's hash cannot prevent that.
Arbitrary scripts and deployment commands therefore require a future audited
operation handler with an explicit complete dependency contract. Scripts can be
inspected as snapshot data but cannot be executed by this revision.

**External state consumed by a command (including networks and system identity
services) remains approval-review responsibility.** Snapshotting declared files
is not a sandbox or proof of all operating-system dependencies. Approved role
replacement retains root authority over the role table alone.

## Offline signing ceremony

The signer arguments are:

```text
PRIVATE_KEY PLAN_FILE REVIEW_FILE SUBJECT_UID STEP_ID APPROVER_ID ROLES_FILE
--expected-plan-sha256 SHA --expected-review-sha256 SHA
--expected-roles-sha256 SHA --execution-machine-id-sha256 SHA
```

Machine digest means SHA-256 of the exact `/etc/machine-id` file bytes, including
any final newline. The human obtains and checks expected plan, review and roles SHA-256
values before invocation. The signer reads protected files once, compares all
expected digests and signs those same in-memory bytes. Review JSON must contain
`verdict: "clean"` and the exact `planSha256`; the signer binds the complete
review-file digest. A matching JSON assertion is not independent review evidence:
the human must verify the review's provenance and findings.

Before emitting a request, the signer displays the command, plan/review/roles
digests, caller UID, approver ID and issue/expiry times on stderr. Mandatory
expected digests provide the consent binding; this CLI has no implicit approval
of whichever bytes happen to occupy a workspace pathname.

The request contains `planBase64`, `planSha256`, `stepId`, `command`, `planApproval`
and `stepApproval`. Each approval has an Ed25519 signature and schema-2 payload:
`approverId`, `rolesSha256`, `kind`, `code`, `planSha256`, `subjectUid`,
`issuedAt`, `expiresAt`, `reviewSha256`, `executionMachineIdSha256`; STEP additionally binds `stepId` and
`commandSha256`. `approvalBytes()` defines the exact serialization order.
PLAN and STEP must have the same approver and review. Codes contain 128 random
bits, expire in five minutes, and are consumed before execution; verifier maximum
lifetime is fifteen minutes. Every invocation needs a fresh pair.

## Role policy and replacement

The execution server holds only public keys in protected root-owned
`/etc/naia-approved-runner/roles.json`, for example:

```json
{"schema":1,"minimumRole":"dev-lead","approvers":[
  {"id":"human-owner","role":"owner","publicKey":"<Ed25519 SPKI PEM>"}
]}
```

Order is developer < dev-lead < admin < owner. The minimum defaults to dev-lead
and may be raised to admin/owner. Duplicate IDs/keys and a table without an
allowed approver are rejected. Every signature binds the current table bytes.

Membership, key and minimum-role changes use only a schema-2 plan with
`action: "replace-roles"`, `rolesBase64` containing the complete new table, and
one step named `replace-roles` whose command is `replace-roles:<new-table-sha256>`
and whose `commandSha256` hashes that exact string. The current authorized key
must approve; a new key cannot approve its own addition. This branch never
launches a child process. A protected lock serializes verification and execution.
The runner rechecks current role bytes immediately before applying an action.
It saves `roles-before.json` and `roles-after.json` in the action's audit folder
before atomic replacement. Preserve the backup path in the operational receipt.

Review must reject commands or scripts modifying runner files, roles, used-code
ledger or audit, and role changes bypassing the dedicated action. Approved root
code can defeat this policy; the verifier does not sandbox approved root code.

## Runtime and recovery

The eventual fixed wrapper clears environment before `/usr/bin/node`, accepts no
arguments and receives a maximum 1 MiB request on stdin within ten seconds.
Sudo caller UID, exact plan bytes, step, command, signatures, role and expiry are
checked. Root-owned ancestor chains, no-follow descriptor reads, regular-file,
single-link and permission checks protect policy and state. An AI-writable plan
pathname is never accepted by the privileged CLI.

Used PLAN and STEP code hashes are exclusively and durably reserved under
`/var/lib/naia-approved-runner/used/`. Audit records live under
`/var/lib/naia-approved-runner/audit/<STEP-code-sha256>/` and include request,
plan, artifact copies, stdout/stderr and result. Closed stdin, cwd `/`, fixed
PATH/HOME/LANG/LC_ALL and a five-minute timeout apply to children. Background or
daemonized children may outlive the receipt and must be rejected during review.

Crashes consume codes and can leave `request.lock` or `roles.json.pending`.
A human first checks for a live operation and preserves those files and audit
records before recovery. Never auto-delete a lock or overwrite a pending table.
Never restore old ledger state while approvals are valid. Restoring identical
old role bytes can revive unused approvals: retain the ledger and wait beyond
all validity windows or use fresh role bytes. Replicate audit/ledger to a remote
append-only store and monitor capacity; outputs can contain secrets.

Upgrades require disabling sudo access, backing up every existing destination
(and each symlink's real target), recording backup paths and human review.
Rollback disables sudo access first, checks running children, archives audit and
ledger, then removes installation files. It does not undo executed commands.

## Discord issuer exit criteria (next PR)

Before installation can be enabled, implement and test authenticated immutable
Discord user-ID → approver-ID binding; human-side signing; mobile display of full
command, artifact hashes, plan/review/roles digests, caller UID and expiry;
explicit consent to those exact bytes; clean review bound to the plan; issuance
records retaining human approval message ID and approver ID in signed payloads;
replay, spoofed identity, bot-message and channel-role-only rejection. Retain
issuance records independently of the AI and verify revocation on staging.

Staging also needs actual sudoers no-argument matching; rejection of extra args,
`sudo -E`, environment assignment and forged SUDO_UID; NODE_OPTIONS/BASH_ENV/
LD_PRELOAD injection; protected executable ownership; reboot-persistent replay
state; key separation and revocation. CI success alone does not satisfy staging.

## Tests

Set TMPDIR to the task's tmp directory, then run `pnpm test` and `pnpm build`.
The runner, signer and installer suites are included. Tests use synthetic keys
and local temporary files, never an installed sudo entrypoint or production data.
The installer tests check that every invocation is rejected before privileged
work. Runtime tests cover signed mutation, replay, roles and immutable snapshots;
signer tests cover protected inputs, digest pins and key/deployment separation.
