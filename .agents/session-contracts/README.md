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

## Session baseline gate — host adapters

The baseline gate (`.agents/harness/session-baseline.cjs`) is enforced wherever
a host lets the harness intercept a tool call. The core is shared; each host
adapter is thin.

| Host | Interception | Compaction signal | Notes |
|------|--------------|-------------------|-------|
| Claude Code | `.claude/settings.json` PreToolUse → `session-contract-gate.js` | `PostCompact` → `.claude/hooks/session-baseline.js` bumps the epoch | reference adapter |
| Codex | `.codex/hooks.json` PreToolUse → `session-contract-gate.cjs` | none; `reack_after_mutations` re-arms every N allowed mutations | |
| opencode | `.opencode/plugins/session-contract-gate.js` (`tool.execute.before` → `decide()`, block = throw) | `experimental.compaction.autocontinue` bumps the epoch | governs `bash`, `edit`, `multiedit`, `write`, `apply_patch`; `task` stays with the fan-out guard |
| Grok Build | reads `<project>/.claude/settings.json` hooks natively (`compat.claude.hooks`, on by default) and `.grok/hooks/adk-session-contract.json` (same commands, deduplicated) | `PostCompact` fires with the same payload | requires folder trust: run `/hooks-trust` (or launch with `--trust`) once per checkout, or project hooks are silently skipped |

Grok Build sends Claude-compatible fields (`session_id`, `cwd`, `tool_name`,
`tool_input`, `tool_use_id`, `CLAUDE_PROJECT_DIR`) under its own tool names;
the gate maps `run_terminal_command` to shell and `search_replace` to file
mutation. Because Grok also scans the Codex registry (`compat.codex.hooks`), a
single call can reach the gate twice; the mutation counter keys on
`tool_use_id`, so the re-ack threshold still means N distinct calls.

The ack records the digest of the contract it read. Editing or switching the
contract afterwards re-arms the gate (`reason: contract_changed`): the refusal
names the same ack command, and the re-ack binds to the new digest.
