# Security advisory propagation

A publishing server collects and selects security findings, then publishes one
reviewed advisory per stable ID to an instance-configured shared location. Each
server's daily consumer matches those advisories against its own inventory and
adds one `진행 중` entry to its private [work ledger](work-ledger.md). The
configured role investigates, applies the approved remedy, attaches a result
link, and marks the row `끝`. The publisher reviews each server's resulting
status using the receipt procedure below.

## Boundary and collection adapter

This upstream change provides the propagation layer. Feed collection and scan
implementations may live in descendant workspaces; they are deliberately not
copied here because their source lists, model commands, inventories, schedules
and notification policy are instance-specific. Keep their collection and grading
steps, then adapt selected results into the JSON contract below. Markdown feed
reports, model output and raw vulnerability API responses are not executable
input and are not automatically treated as approved advisories.

Copy [the configuration example](../../config/security-advisory.example.json)
to a private configuration file. Configure a local folder in a private Git
checkout, or a trusted HTTPS index for consumers. Git synchronization and HTTPS
hosting/authentication belong to the instance scheduler, outside these scripts.
The publisher writes only to a local folder; review and synchronize that folder
through the instance's approved publishing mechanism. No credentials, internal
URLs, server identities, customer names or private asset paths belong in an
advisory. Review free text before publication: schema validation cannot detect
every secret. Keep both configuration and inventories private.

## Advisory contract

Supply a single advisory or `{ "advisories": [ ... ] }` in a selected collection
JSON file. A minimal advisory looks like:

```json
{
  "schemaVersion": 1,
  "id": "ADV-2030-001",
  "sourceUrl": "https://example.org/security/ADV-2030-001",
  "affected": [{"ecosystem": "npm", "name": "example-package"}],
  "severity": "high",
  "action": "Review the vendor fix, test the update and record the result",
  "dueAt": "2030-01-08T00:00:00Z"
}
```

Use `critical`, `high`, `medium`, `low` or `unknown` for severity. Affected entries identify
an ecosystem and exact package/service name; optional `versions` lists exact
installed versions. Omitting versions conservatively matches every installed
version of that name. This layer does not interpret semver ranges, infer whether
a patched version is safe, or determine exploitability. Express a range in the
reviewed action text and investigate a name match. Exact version lists must be
complete if used. Unknown inventory or a collection failure requires repair,
not a claim that the server is unaffected.

IDs are immutable: publishing an existing ID preserves the original file;
changed content requires a new revision ID. Consumers also preserve existing
work rows, including completed rows. A revised deadline/action therefore needs
a new ID and explicit linkage in the action. Advisories never supply executable
commands; only the trusted local configuration can declare inventory commands.

## Run and inspect

```sh
node scripts/security-advisory-publish.mjs --config private-config.json --input selected.json
node scripts/security-advisory-consume.mjs --config private-config.json --dry
node scripts/security-advisory-consume.mjs --config private-config.json
```

Resolve relative configuration paths against the config directory. For HTTPS,
replace `shared` with `{ "url": "https://example.org/advisories/index.json" }`;
the index is `{ "advisories": ["ADV-2030-001.json"] }`, containing filenames
relative to the index. Hosting may apply instance-managed access controls; this
CLI does not accept credentials in the URL, redirects or query tokens. Source
URLs also require public HTTPS names. Inventory
inputs include configured JSON assets, npm `package-lock.json` or
`npm-shrinkwrap.json` lockfiles and bounded local OS
package-list commands (argument arrays, without a shell). Use read-only commands
such as a package database query; never put remote access or update commands
there. Other lockfile formats (including pnpm and Yarn) fail explicitly; export
their resolved packages to the configured JSON inventory before use. Asset files
use `{ "assets": [{ "ecosystem": "npm", "name": "example-package", "version": "1.0.0" }] }`;
use `os` for OS packages and `service` for services. OS listing commands must
write one `name<TAB>version` line per installed package. For example, configure
`{"command":"dpkg-query","args":["-W","-f=${binary:Package}\t${Version}\n"]}`
and ensure advisory names use the same architecture-qualified naming as the
local inventory. No shell expansion is involved. Run `--dry` before registering regular work: it reads inventories and
reports planned rows without changing the work ledger. Treat all collection and
validation errors as failed executions and preserve the previous ledger.

The consumer uses the existing ledger schema, with a stable advisory-derived ID,
configured responsible role, severity/action task, `진행 중`, source evidence,
deadline, null result and current request/update timestamps. An existing work
ledger is required; initialize it from the work-ledger example first. Back up
instance files and resolved symlink targets before any migration. Use the real
regular-file ledger path for transactional writes. Concurrent invocations must
respect the ledger lock; do not remove a lock without checking its owner.

## Results and publisher review

Remediation remains assigned work, not an automatic package update. The role
records actual progress in `updated_at`, follows the server's approval and
rollback process, and sets `status: 끝` only with a concrete `result` link.
Do not infer completion from a successful consumer run or timer exit code.

Each server keeps its work ledger and result evidence private. Its existing
approved reporting job exports a minimal server receipt to an access-controlled
status location: `{serverId, advisoryId, status, updatedAt, result}`. Include an
explicit `not-applicable` receipt after a successful full inventory comparison,
and a `failed` receipt for inventory/consumer failure; lack of a row alone is
not evidence of non-applicability. The publisher's coordinator compares an
instance-configured expected-server list to those receipts and presents a table
of advisory ID, server, state, deadline and result. Missing or stale receipts
remain unknown and require investigation. This PR defines that reporting
contract; it does not install receipt transport or a central polling service.
Keep receipt paths and internal result links out of the advisory distribution.

## Proposed schedule rows

The [schedule example](../../config/regular-schedule.example.yaml) includes a
weekly security review and daily advisory intake, both `제안`. Set timezone,
role, local command mapping and approval in the private instance ledger. Apply
the [reviewed conversion procedure](regular-schedule-ledger.md), record every
execution's actual artifact, and inspect both success and failure paths before
installation. Weekly review checks collector coverage, incoming advisories,
open remediation deadlines and per-server receipts. Daily intake synchronizes
the approved shared location, runs the consumer and records its result.

For local tests use `node --test scripts/security-advisory.test.mjs`; set
`TMPDIR` to your execution's private temporary directory.
