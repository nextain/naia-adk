# Issue #18 Gateway and recovery review

Stage: development, test, integration

Requirements: DSO-001 through DSO-006

Reviewers: independent code reviewer, independent contract reviewer, Sol High final reviewer

## Evidence ledger

| Claim | Primary evidence | Status | Action |
|---|---|---|---|
| Ingress acceptance could survive without a job | Separate transactions in the first draft | ACCEPTED | Replaced by `acceptIngressAndCreateJob` under one `BEGIN IMMEDIATE`; DSG-002 |
| An uncertain delivery could be resent with a new nonce | First draft allocated a nonce per call | ACCEPTED | One durable delivery per job attempt; started becomes unknown; DSG-003 |
| Gateway could stop permanently after a disconnect | First draft only closed the socket | ACCEPTED | Service reconnect loop, persisted resume state, fatal close handling, ACK test; DSG-004/005 |
| Configured approval-required writes could execute directly | Router initially checked only `allowedActions` | ACCEPTED | Approval-required mutations stay Codex read-only or Claude plan mode; DSG-010 |
| Reboot retry required plaintext prompt persistence | DSO-006 requires a new attempt but safe-event policy forbids raw content | ACCEPTED | AES-256-GCM recovery envelope with owner-only key; only opt-in read-only retry; DSG-007 |
| A second service could resume jobs before ownership validation | Recovery originally preceded service heartbeat ownership | ACCEPTED | Ownership heartbeat now precedes recovery and backend launch |
| Graceful systemd shutdown could delete recovery material | Generic abort originally produced `cancelled` | ACCEPTED | `abort("recovery")` records `recovered` and preserves the envelope; backend-runner recovery test |
| Discord visibility required more than a hidden background process | User contract and design operator projection | ACCEPTED | Scoped commands plus one durable create/pin/update status message per operator scope; DSG-009/011 |
| Workshop steps were not executable from a clean Discord bot setup | Reader test found missing intent, permission, binding, and systemd prerequisites | ACCEPTED | Korean workshop now states prerequisites, `canStartConversation`, Message Content Intent, login/boot behavior, and JSON completion view |

## Convergence

- Development reviewer: CLEAN after accepted fixes; 49/49 Discord-session tests passed.
- Contract reviewer: earlier findings were re-opened after the encrypted recovery and projection changes; all accepted high-risk findings were fixed and re-tested.
- Sol High: CLEAN; no concrete HIGH/CRITICAL defect in the final read-only diff review.
- Claude CLI reviewer degraded after reaching its turn limit without a verdict; it is not counted as clean evidence.

## Verification

- `pnpm build`: PASS
- `pnpm test`: PASS
- `pnpm test:discord-sessions`: PASS (49 tests)
- `pnpm test:entry-points`: PASS
- `git diff --check`: PASS
- conflict-marker scan: PASS

Actual machine reboot remains an operational receipt after a real private config and Discord credential are installed. The deterministic suite covers process restart, database reopen, same job ID/new attempt, encrypted payload non-disclosure, Gateway sequence ordering, systemd unit identity, and no resend of uncertain delivery.
