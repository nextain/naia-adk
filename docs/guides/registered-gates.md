# Registered deployment gates

The existing approval-plan engine can register multiple review and admission
profiles for one plan root. The installation record pins the complete common
execution graph, instance policy sources, review policy, provider binaries and
separate state directories. This adds no new approver or service permission.

The canonical entry is:

```
node <engine>/.agents/scripts/approval-plan.mjs hook --registration <file> --sha256 <digest> --profile <declared-id>
```

The same three registration arguments are used with prepare, review, ready,
preapprove and judge. The hook accepts only those closed arguments. Profile IDs
come from the SHA-pinned record; global/project are scopes, not fixed profile
names. prepare and ready are read-only. review always recomputes preparation
before launching a reviewer and checks the exact reviewed scope and manifest
again afterward. A caller-supplied readiness file or skip-ready argument cannot
replace these checks. PLAN and STEP still require genuine human consent through
the existing engine; separate profiles cannot reuse one another's state.

The registered-gate/v2 record contains planRoot; engine root/commit/files;
instance files; profiles with id/scope/root/policy/expectedPolicySha256/stateDir;
approverId; and muse/argon/codex provider file/digest pairs. The installer uses a
separate adk-registered-deploy-hooks/v1 envelope to bind the record and fixed
entry arguments to its existing settings slots. The installer does not decide
runtime approval or load company plugins.

The already-running, operator-trusted host and canonical bootstrap are the
trusted startup boundary. A child cannot undo a preload that already ran in its
parent. The loader executes only sealed application buffers, and registered
review/judge calls use pinned native provider snapshots and explicit child
environments. Caller hookup and trusted startup must be demonstrated separately.
The paired installer currently selects Claude settings; it does not imply a
native Codex PreToolUse registration. Unsupported or unverified caller rows stay
NOT_READY. Legacy unregistered behavior and unrelated projects reached through a
registered global hook retain the existing policy path.

Run pnpm test:registered-gate for retained approval/preparation behavior and the
registered source, provider, scope, consent and unrelated-project regressions.
Native fixture providers and synthetic human records exist only in disposable
unit-test projects; they are never operational evidence.


Registered preparation covers every scenario and incident-action command by
namespace, entry position and command position. The existing command lookup and
pin checks use the same pure enumeration. Scenario readiness retains its normal
feature requirements. Incident preparation checks classification, registered
service scope and declared/pinned inputs without substituting normal feature
ET/allowedCommands or current-state readiness for the separate incident contract.
At execution, actual target preimages, genuine PLAN consent and an independent
incident verdict remain mandatory. Preparation neither grants those authorities
nor consumes STEP consent. Legacy unregistered preparation remains unchanged.

Registered application imports require the synchronous Node module.registerHooks
API (Node22.15 or later). The canonical process snapshots every registered source,
then resolves both CommonJS and ESM imports to those verified buffers. A separate
registration-qualified ESM URL avoids a plain cached helper. Instance Discord
helpers and their executable imports must be present in the instance manifest.
Unlisted application dependencies fail closed; this does not seal provider or OS
libraries. A legacy unrelated-project scope is derived inside the common policy
from its actual command targets and is unavailable through hook JSON or env flags.
The registered instance remains sealed in that scope. Unsupported startup preload
options grant no registered authority; this cannot undo earlier host execution.

Registered scenario inputs receive the same referenced-file pin coverage as
incident inputs. Canonical recent-plan lookup rejects a command that would be
ambiguous at admission. This does not change lookup order or make an old plan
with different command bytes block a normal update.

The registered installer and runtime share one Git identity check. A declared
mixed-owner source checkout uses only its exact canonical safe.directory in the
child command, with no persistent setting or wildcard. Initial/final installation
and startup reject mismatched or dirty source in the same way.

A preparation plugin may return exactly undefined to retain existing binding.
Explicit failures or malformed results reject. Instance-specific supplements
should select their applicable command and registered service policy before
checking extra plan metadata; metadata omission must not disable a required
supplement. Existing commands outside that supplement keep their normal checks.


Native Codex installation uses the same descriptor, canonical command and paired
writer with explicit --target codex. It updates only user/project .codex/hooks.json
dedicated PreToolUse/Bash slots and preserves existing definitions. It does not
create SessionStart hooks or change native trust state. Official hooks/list and
exact-definition config/batchWrite are separate operator steps; no blanket trust
or provider protection bypass is implied. A native session must start in the
instance cwd. Read-only installer tests and rendered-command tests do not prove
native hook execution. The host startup environment remains a trusted prerequisite.


The POSIX registered installer requires a real native Node22.15+ executable at
`/usr/bin/node`; this fixed host prerequisite is not selected through PATH or
hook input. The Linux CI job installs the exact setup-node ELF there as root0755
and verifies equal SHA256 and version before running the registered installer
fixtures. A missing fixed runtime is an unsupported registered installation,
not a reason to skip its acceptance tests or render a different command.
