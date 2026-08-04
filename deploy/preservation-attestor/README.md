# Protected preservation attestor

The attestor is intentionally unavailable until an operator provisions a
separate `naia-attestor` OS account. Running it as the repository owner is a
hard failure, not a development fallback.

Install the service source and the two core modules as root-owned, non-writable
files under `/usr/local/lib/naia-preservation/`. The root-owned policy pins all
three files independently. Install the policy at
`/etc/naia-preservation/attestor.json`, the Ed25519 private key at
`/etc/naia-preservation/signing-key.pem`, and the unit files under
`/etc/systemd/system/`. Install the matching root-owned public key at
`/etc/naia-preservation/public-key.pem`; repository files and environment
variables are never accepted as preservation verification keys. The policy
must pin the installed worker, project
adapter, Node executable, bubblewrap executable, and repository filesystem
identity. The private key and `/var/lib/naia-preservation` must be readable only
by the service identity.

Before the first baseline request, copy the exact unit registration into the
root-owned policy `registrations` array. First-use registration is forbidden:
the service will not trust a contract or binding merely because it arrived
first. Install `/etc/naia-preservation/verifier.json` from
`verifier.example.json`; it pins the credential epoch, exact policy digest,
installed worker/execution/snapshot digests, and allowed sandbox digests.

The dedicated identity needs read-only traversal to the declared repository
and to `.agents/harness`, whose normal owner-only modes must otherwise remain
unchanged. Provision narrow POSIX ACLs (`--x` on private parent directories,
`r-x` on repository directories, `r--` on the exact protected inputs), plus a
default read/traverse ACL on `.agents/harness` so later unit files inherit it.
Do not make the home, harness, key, or state store group/world-readable.
`ProtectHome=read-only` and the sealed runner still prevent repository writes.
Verify these ACLs as `naia-attestor` before enabling the socket; inaccessible
inputs fail closed rather than falling back to the repository owner.

Add only intended operators to the `naia-preservation` socket group. After an
operator verifies every digest and repository identity, enable the socket with
`systemctl enable --now naia-preservation-attestor.socket`. The repository-side
client accepts only repository, unit, stage, phase, and surface identifiers.
The service resolves all binding semantics and performs the sealed execution.
After all probes, a seal request carries only repository and unit identifiers;
the service evaluates its protected SQLite ledger and signs one short-lived
evidence-set decision. Repository receipt JSONL is audit output only.

At seal time the service independently rematerializes the current snapshot and
requires every current receipt to match its subject, repository, Git, adapter,
and inventory identity. It verifies workspace stability both before and after
signing. Changing the subject after current probes therefore makes the seal
fail; all current probes must be rerun on one stable snapshot.

Do not place the private key in an environment variable, the repository, or a
same-user service. If the socket, protected key, policy, installed worker,
sandbox, or dedicated identity is absent, request-contract remains
`REVIEW_ONLY`.

The signed decision proves the protected execution evidence; it does not make
arbitrary shell commands safe. Publication and deployment remain blocked until
their external-effect broker consumes this protected decision. Repository-owned
hook code is not itself a same-user security boundary.

At planning, invoke the repository client once per declared surface with a
private request file containing only `repository`, `unit_id`, `stage:
"planning"`, `phase: "baseline"`, and `surface_id`:

```bash
node scripts/preservation-execution-runner.cjs --request /path/to/request.json
```

At integration completion, repeat with `stage: "integration_completion"` and
`phase: "current"`. After every current probe succeeds, write a seal request
containing only `repository` and `unit_id`, then run:

```bash
node scripts/preservation-execution-runner.cjs --seal /path/to/seal.json
```

The client atomically stores the signed decision at the unit's
`preservation/decision.json`. Editing or replacing that file cannot change the
decision because request-contract verifies it with the fixed root-owned public
key and exact active binding. Re-run current probes and seal after any work
revision change or decision expiry.
