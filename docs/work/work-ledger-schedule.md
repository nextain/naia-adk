# Work and schedule ledger requirements and scenarios

Baseline: e105f0b7633a42a2bb070c5abd373dfbc48780fc. Extend the local observer
and preserve legacy workFiles, adapters, dry mode, notification receipts and
permission boundaries. Public examples use placeholders only; instance rollout
and remote publication remain separate acceptance work.

| Requirement | Scenario and expected result | Implementation / verification |
| --- | --- | --- |
| RQ-LEDGER-1 | Receive instruction, create complete row, finish with result and 끝; Markdown migration retains original evidence | work-ledger guide/example; ledger validation tests |
| RQ-LEDGER-2 | Matching role sees 진행 중 only; stale row stays stalled despite unrelated fresh progress | observeRole; health ledger tests with fake time |
| RQ-LEDGER-3 | Wrapper records execution result and timestamp for exact ID; missing ID, invalid input or concurrent writer preserves original | schedule-record; recording tests |
| RQ-LEDGER-4 | Latest daily/weekly due occurrence plus grace passes without actual execution: 안 돎; future/proposal/manual rows do not become missed executions | schedule evaluation tests including timezone and boundary |
| RQ-LEDGER-5 | First known signal is silent; nudge and owner escalation once each; restart retains receipts; unknown cannot clear episodes | runHealth fake API/time tests |
| RQ-LEDGER-6 | Onboarding creates both private ledgers and connects observer; indexes lead to common method | onboarding checklist and AGENTS index |

Design: one canonical YAML file for work and one for regular schedules per
instance. Work timestamps are per task. Schedule evaluation uses IANA local
calendar dates, daily or weekly:MON..SUN, and explicit nonnegative graceMinutes
(default 15). Only installed 있음 rows are monitored. A failed execution is an
execution; not-run is not. The latest due occurrence is checked after grace;
its identity gives every missed occurrence its own alert episode. Recording
updates last_result only, under an exclusive lock and atomic replacement.
Unsupported cadence on a monitored row is visible as unknown; it never silently
passes. No schedule is enabled by reading or recording a ledger.

Run the standalone tests with a caller-owned temporary root:

```sh
SESSION_HEALTH_TEST_TMP=<run-folder>/tmp LEDGER_TEST_TMP=<run-folder>/tmp node --test scripts/ledger.test.mjs scripts/session-health.test.mjs
```

The tests use fixture repositories, fake clock/adapter/API data and private
throwaway ledgers. They cover block YAML examples, validation and writer
preservation, daily/weekly/timezone/DST boundaries, role isolation, multiple
active rows, failed executions, unknown evidence, silent baselines, repeated
occurrences, per-stage receipts after restart and contiguous multi-role reports.
Local evidence does not replace each server's acceptance checklist.
