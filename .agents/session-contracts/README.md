# Session Contracts

This directory separates per-session mutation authority from progress reporting.
Runtime contracts and `.session-map.json` are local and ignored. `schema.json` is
the shared contract shape. A session is bound only when the registry pointer,
contract digest, `session_bindings`, and referenced progress record all agree.
These runtime identities are host-local and are never portable across PCs. A
different PC starts a fresh local binding from a remote GitHub issue and
reachable branch or commit SHAs; it must not restore another host's session map,
registry pointer, runtime contract, progress handoff, or harness state from Git.
`target_ownership` accepts exact repository-relative paths or directory-prefix
patterns ending in `/**`; active contracts with overlapping prefixes are
ambiguous and cannot authorize mutation.
## Shell commands: allow by default, contract for the irreversible

The gate does not keep a list of permitted commands. It keeps a list of what
cannot be undone — deletion, privilege escalation, history rewriting, force
push, publication, deployment, remote transfer, writes outside the project or
into governance paths — and everything else runs, bound or unbound, without
being declared. Launching another model runtime (`claude -p`, `opencode run`,
`codex exec`) is ordinary work; so is `pip install`, `pkill`, `systemctl
--user`, `chmod +x`. The policy lives in `agents-rules.json` under
`unbound_routine_commands`, and a project whose rules file has no such section
gets the same built-in list rather than a locked shell.

Wrappers are read through rather than refused: `VAR=1 cmd`, `env cmd`,
`timeout 600 cmd`, `nohup cmd` and `bash -c "cmd"` are judged by the command
that actually runs. When the head really cannot be seen (`$(…)`, `eval`,
`xargs`, shell control flow) every token is checked instead. A bound
contract's `allowed_shell_commands` adds the contract-required forms it
deliberately authorizes; it never has to list routine work. A bound session's
shell mutations still stay inside the contract's `allowed_paths`, the same
boundary its file writes have. This lightweight classifier is a repository
hook, not an OS sandbox; post-run review must verify actual side effects
against ownership.

## Orphan recovery

Lifecycle hooks keep per-session leases under the ignored
`.agents/session-contracts/.recovery/` directory; each lease records the
nearest Codex/Claude/opencode ancestor PID and process start token. The owner's
liveness is the whole safety condition, and it is decided by the host process,
not by the session id.

- **Same host process, new session id** (`/clear`, a compaction restart): the
  lease of the old session names the very process that is starting the new
  session. That is the owner continuing, not a takeover. `SessionStart`
  rebinds the contract to the new session id automatically and records
  `session_continued` in `audit.jsonl`. Nothing needs to be typed.
- **Owner provably gone** (its recorded host process has exited, no fresh
  lease, no live session process): any unbound session may take the contract
  with `node .agents/harness/session-contract-recovery.cjs reclaim --contract
  <id> --session <its own session id>`. No approval is required; the audit
  records `granted: false`. A `/harness reclaim <id>` prompt is still accepted
  and, when present, consumed and audited, but its absence stops nothing.
- **Another live host process holds it**: the reclaim fails with
  `owner_session_live`. This is the only refusal, and it is the one that
  matters.

`node .agents/session-contracts/rebind-session.cjs <contract-id> <session-id>`
remains the direct rebind for an explicit restart; it accepts every host's
session id shape (OpenCode `ses_…`, Claude Code UUIDs, Codex ids). Both
helpers run only in their exact shape and only for the calling session.

Legacy progress or Markdown `session_id` fields are read-only migration evidence;
they never authorize mutation.
