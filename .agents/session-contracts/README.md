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
Non-read-only shell execution is allowed only when its trimmed command exactly
matches an `allowed_shell_commands` entry covered by the contract digest.
That entry authorizes the whole command; the lightweight gate is not a process
sandbox, so post-run review must verify actual side effects against ownership.

Legacy progress or Markdown `session_id` fields are read-only migration evidence;
they never authorize mutation.
