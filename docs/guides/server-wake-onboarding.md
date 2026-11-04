# Attach or repair a server

Use a work document as the starting point. Record intended behavior, baseline,
requirements/scenarios, instance overlay, tests and rollback there. Git records
the reviewed implementation; a hosted issue is not the work-process entrance.

1. **Sync from upstream.** Read the `sync-upstream` skill, record exact upstream
   revision and fork lineage, then use its supported sync path in the authorized
   workspace. Resolve unknown/shallow or unrelated history in the work document
   before integration. Identify the real execution cwd and its entrypoint.
2. **Fill instance settings only.** Keep roles, names, bot/channel IDs, paths,
   timezone, credential references and business schedules in private instance
   configuration. Inventory existing sensors/workers/timers; label retain,
   replace, repair or retire so two ingress paths cannot execute the same request.
   Before overwriting any server file, save the original and symlink target;
   record backup paths. Use `rsync --dry-run` before any approved copy.
3. **Test the wake contract.** In an authorized test channel, choose and record
   N minutes, then test mention → durable cursor → owner → executable session →
   delivery receipt → referenced reply within N. Record stage evidence, actual
   cwd/profile and message link. Also test role/name, assigned channel, denied
   read, missing/busy session, restart/compression and duplicate launch. Follow
   [the completion contract](wake-completion-contract.md).
4. **Enable the independent observer.** Complete a local configuration and DRY
   preview, baseline each new channel, then install exactly one periodic runner.
   Test 10-minute re-call and 30-minute owner notice in test scope, restart and
   per-stage deduplication, expected-bot replies and human conversations. Inspect
   failures and stale state; observer process health is not reply health.
5. **Reconcile the regular schedule ledger.** Follow
   [the ledger conversion procedure](regular-schedule-ledger.md), preserve
   proposals as off, and verify actual output artifacts for installed rows.
6. **Observe and close the work document.** Compare intended routes and actual
   results over one daily cycle. Record unresolved failures, owner/date and
   rollback. Move to acceptance only when evidence exists.

Any operational mechanism repaired on a server must open an upstream reflection
work item in the document ledger that same day; remove instance values before
preparing the common change.

## Acceptance checklist

- [ ] Fixed upstream revision and known lineage; real cwd loads shared rules.
- [ ] Instance routing and exclusions reviewed; no private values in upstream.
- [ ] Existing mechanisms classified; one ingress/observer owner per scope.
- [ ] Mention/role/name/assigned-channel probes have stage-by-stage evidence.
- [ ] Missing/busy session, denied channel, restart/compression and duplicate
      timer cases retain obligations and expose a named failed stage.
- [ ] Referenced bot reply arrives within declared N; ACK and task result differ.
- [ ] Observer baseline is silent; DRY leaves state unchanged; 10/30-minute
      notices are each sent once and uncertain delivery is reconciled.
- [ ] Apply the [Claude user profile](claude-user-profile.md) for every session
      user (`node scripts/adk-user-profile.mjs apply`, then `check` exits 0) and
      add `.naia-role.json` to each role folder.
- [ ] Enable [session health](session-health.md) every five minutes after private
      role/window/workspace/work-file/baseline-SHA setup; verify silent baseline,
      empty/stopped/stalled/drift alerts, DRY, restart and per-stage deduplication.
- [ ] Site failures/recovery and observer read errors are visible.
- [ ] Create one private [work ledger](work-ledger.md) and one regular schedule
      ledger per server; connect `workLedger` and `regularSchedule` to session
      health. Verify role matching, stale row detection, wrapper execution records,
      missed-run grace, silent baseline and one notification per stage.
- [ ] Ledger rows match inventory and real artifacts; proposals remain off.
- [ ] Backups, rollback, daily observation and remaining work are documented.

This checklist is an instance acceptance procedure. Passing local fake API tests
alone does not certify any installed server or execute this rollout.
