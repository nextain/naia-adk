# Semantic ledger reminders

Status: approved implementation boundary; source validation in progress and production start blocked. Base: main38146b7757b1622ecf8088a6d1974cab02625b74.

## Original request and architecture fit

An unchanged overdue or unperformed report must create one pending input, whether a consumer has read it or remains busy. Real changes must remain visible. The shared ledger watcher already owns card observations, `cardWakePublisher` owns semantic versions and a staged outbox, and the shared dispatcher owns original-file receipts. Extend those existing boundaries; do not add another queue, ACK system or host-specific timer policy. Candidate REQ-WAKE-001 and `docs/common/work-ledger.md` describe the existing wake workflow; this request determines the behavior change.

The isolated main381 reproduction emits 20/6/6/6/15 files at +0/+31/+61/+180/+360 minutes, including 24 exact-body duplicate copies. A real dispatcher with a fake receiver accepts all 53 distinct filenames despite earlier receipts. Its current semantic-event regressions cover escalation and unread worker results, not ordinary deadlines or unperformed reports.

## Proposed implementation boundary

1. Extend `card-wake.mjs` accepted event reasons/body detection with ordinary overdue and periodic report reminders. Reuse the existing observe/signature/event chain, legacy adoption, commit-before-flush outbox and stable event filename. Preserve per-card IDs; a periodic report uses the existing role/report identity.
2. The overdue semantic revision contains card status, due, source channel/message, title and actual result identity. Wall-clock observation, age and last-wake timestamp are not revision fields. `open` and `waiting_human` use this observation. A due/status/result change publishes one version, including a later return to a previous status/version. Existing closed-worker exclusion remains unchanged.
3. Remove watcher-driven `waiting_human` due advancement. It currently creates a next-day notification solely from elapsed observation time. The original due remains authoritative until an actual command/source update changes it. Keep intake's existing initial human-wait classification and mention limits.
4. A report revision contains configured channel/period and the last actual report marker (`last_msg_id`, `last_at`). Its owed slot is first-report or `last_at + every_min`; elapsed unperformed slots are not new work. An actual report completion advances the next owed slot once. Do not create a version on each scan or cooldown.
5. Keep due-timer receipts and lock ordering. Test both timer-disabled and timer-enabled observation. Timer publication already has a due-specific receipt: adopt an existing successful receipt for that exact role/card/due, preserve failed/unknown receipt retry semantics, and ensure a watcher-published deadline cannot be emitted again by `fire`. The reviewed internal watcher callback stages the existing outbox under ledger→receipt locks; `claimed` precedes emission and `sent` follows it. No additional queue or transaction mechanism is introduced. Five interrupted boundary fixtures cover recovery, including a timer publication before its sent receipt.
6. Legacy adoption uses exact historical pending content or an existing matching producer record, never synthetic consumer/native ACKs. Seed the semantic head and preserve all old filenames/receipts. A legacy record is not authority to swallow a later changed due/result. No ledger/status reset or global pending removal.

Owned source candidates: `scripts/work-ledger/{card-wake,ledger-watch,due-timer}.mjs`, corresponding focused tests, existing ledger guide and per-change doc-impact receipt. No dispatcher behavior change is expected: it already preserves stable event filenames and excludes ledger bodies from Discord-message grouping.

## Acceptance cases

- UC1 Pending deadline: isolated copied ledger at +0/+31/+61/+180/+360; ordinary overdue/human/report facts each produce at most one event. Pending body, event name and file count remain stable.
- UC2 Consumed deadline: actual common dispatcher with a fake receiver writes ordinary delivery receipts; later identical scans add zero files and zero receiver inputs. These receipts are model-free test evidence, not native user ACKs.
- UC3 Meaningful change: explicit due/status/source/result changes and actual report completion each publish exactly one new event; another scan remains zero. Status closure preserves existing pending originals; reopen yields one new episode. Title/result evidence changes are tested without `now` in the signature.
- UC4 Upgrade/recovery: old pending, delivered and archived legacy notices are adopted without rewriting receipts; newer facts publish. Interrupted stage/state/rename retries finish the same event once. Missing/failed timer receipts do not become false acceptance.
- UC5 Existing behavior: escalation67 once, closed-worker739 zero, changed worker-result once, future waiting-human dates remain future, auto-drive=false starts zero workers. Existing enabled timer tests and legacy sender compatibility remain green.

Run RED focused fixtures first, implement narrowly, then repeat the exact copied-ledger/consumer matrix. Fresh independent review gets one fixed source SHA; required public CI runs before merge. Live watcher/source/config/start remain unchanged until the parent accepts source evidence and deployment preimages. The previous start bundle is NOT_READY_DUPLICATE_SOURCE.

## Validation-driven module separation

The functional source was fixed before extraction. The size preflight required splitting already-large touched files without raising limits or adding waivers. `ledger-watch.mjs` retains role observation, locks, state commits and outbox flush order. Per-round messenger orchestration, cached retry reads, addressing, human questions and state validation now have separate cohesive modules. Their original helper bodies are preserved; per-round mutable data remains scoped to one watcher call. No process-global service locator is introduced.

The original dispatcher test file is unchanged from the base. Its new deadline integration has a separate default-test entry. Large existing drive/ledger suites import their unchanged scenarios and fixtures; test names/counts and model-free publication observations are compared before and after extraction. The default test command now includes the full ledger suite explicitly.

### Extracted file responsibilities

| File | Existing responsibility preserved |
| --- | --- |
| `scripts/work-ledger/ledger-watch-state.mjs` | State normalization, role settings and waiting-human upsert |
| `scripts/work-ledger/ledger-watch-messenger.mjs` | Per-round messenger and intake orchestration |
| `scripts/work-ledger/ledger-watch-reads.mjs` | Shared read cache, rate-limit budget and channel failures |
| `scripts/work-ledger/ledger-watch-addressing.mjs` | Existing author/mention/reply and message-time interpretation |
| `scripts/work-ledger/ledger-watch-questions.mjs` | Existing human-question observation and its receipts |
| `scripts/work-ledger/drive-test-fixture.mjs` | Drive fake worker, setup, clock and fixture cleanup |
| `scripts/work-ledger/drive-execution.cases.mjs` | Existing drive execution scenarios |
| `scripts/work-ledger/drive-recovery.cases.mjs` | Existing drive retry/recovery and watcher integration scenarios |
| `scripts/work-ledger/ledger-test-fixture.mjs` | Ledger setup, fixed clock and temporary-file cleanup |
| `scripts/work-ledger/ledger-records.cases.mjs` | Existing header, card, publication and report records |
| `scripts/work-ledger/ledger-reports.cases.mjs` | Existing report settings and messenger adapter checks |
| `scripts/work-ledger/ledger-messenger.cases.mjs` | Existing edited/relayed message cases |
| `scripts/work-ledger/ledger-observation.cases.mjs` | Existing role routing and reply observation cases |
| `scripts/work-ledger/ledger-human-wait.cases.mjs` | Existing human-wait, thread and normalization cases |
| `scripts/work-ledger/ledger-instructions.cases.mjs` | Existing state recovery and instruction settings cases |
| `scripts/work-ledger/ledger-human-limits.cases.mjs` | Existing instruction deferral/drop and ledger-owner boundaries |
| `scripts/work-ledger/semantic-reminders.test.mjs` | New unchanged-fact, revision, legacy migration and interrupted-publication acceptance |
