# Session health observation

For patterns in the work itself, see [session audit](session-audit.md).
Session health observes availability; session audit evaluates review activity,
priorities and other work signals.

Run one local observer per instance every five minutes. This produces one private
Markdown status sheet for all configured roles. It observes evidence; a running AI
or a recent commit does not establish task correctness. Start with the
[work requirements and scenarios](../work/session-health.md).

## Evidence and decisions

- **Alive:** an adapter identifies the exact role window and AI process. Missing
  windows are `missing`; a shell without an AI descendant is `empty`. Output
  fingerprint changes and session-record mtime establish activity. No change for
  `idleMinutes` (default 30) is `stopped`, subject to the optional work check
  below. The first output sample establishes a baseline, not historical activity.
  Adapter/read failures are `unknown`.
- **Progress:** top-level `workLedger` (`work-ledger.yaml` `진행 중` rows) and
  optional `workLedgerConfig` / `workLedgerDir` / `roles[].ledgerFile`
  (`scripts/work-ledger/` per-role `.json` `open` cards) supply each role's
  open work cards. Each card evaluates its own last progress evidence:
  ledger progress updates/transitions (`updated_at`, `checked_at`, `progress_at`,
  `drive.run`, status re-entry into open) plus linked local result path
  `mtime` and git commits on that result path. Plain Discord replies and `due`
  postponements do not refresh ledger card progress. Regardless of future `due`
  or `due_at`, any open card without progress for `staleMinutes` (default `90`;
  legacy `staleHours` fallback applies only if `staleMinutes` is omitted) marks
  `stalled`. Missing configured ledger files (`ENOENT`), invalid
  `work-ledger.json` schemas, or unknown card `status` values fail just like
  unreadable ledgers: they record `work ledger unavailable`, mark the run
  `degraded` (exit 2), display `unknown (ledger unavailable)` in the report, and
  retain existing card/stalled episodes rather than closing cards or reporting
  `no active task`. Every ledger-configured role must resolve a `wakeDir` (via
  `roles[].wakeDir` or `workLedgerConfig` `roles[].wake_dir`); missing `wakeDir`
  is rejected by config validation when `workLedgerConfig` is omitted and
  reported as `wake dir unavailable` (`degraded`) at runtime otherwise.
  Legacy configured Markdown work/todo files supply lines containing `진행 중`
  or `in progress` (case insensitive), checked alongside workspace commits,
  work-file mtime and response-watch confirmed reply timestamp. File edits or
  replies are only progress proxies; inspect actual deliverables separately.
- **Regular work:** top-level `regularSchedule` reads the
  [execution ledger](regular-schedule-ledger.md). Installed rows without a record
  covering the latest local due occurrence after `graceMinutes` show `안 돎`.
  Each missed occurrence has independent nudge/escalation receipts and the
  schedule signal has its own silent baseline. Invalid schedules remain unknown.
- **Drift:** compare SHA-256 of AGENTS.md, every tracked baseline/current
  `.agents/context/agents-rules*.json`, and the canonical JSON hooks object from
  `.claude/settings.json` against a full pinned `baselineSha` in `baselineRepo`.
  Added/deleted files are included. The sheet lists differing line numbers and
  hashes, never rule contents. `allowedOverrides` contains exact file paths;
  allowed differences stay visible and do not alert. Missing baseline data or
  invalid JSON is `unknown`, never a match. This checks files on disk at the
  declared session workspace, not the model's internal loaded context.
- **After compact:** optional normalized JSONL session records use
  `{"type":"compact","at":"<ISO-time>"}` and
  `{"type":"entry_read","path":"AGENTS.md","at":"<ISO-time>"}`.
  Only a later explicit read proves `confirmed`; compact without it is
  `not observed`; unsupported/absent records are `unknown`. Native session
  records must be normalized by an instance adapter; do not infer rereads from
  ordinary text mentioning AGENTS.md.

## Configuration and adapters

Use [the example](../../config/session-health.example.json) privately. All paths
are absolute. `roles[].workspace` must be the actual session rules root;
`baselineRepo` is a local upstream checkout containing the pinned commit (no
fetch occurs). Use a distinct state/report path from response-watch. Reports
contain task lines and must remain owner-private; default alerts contain only role IDs
and anomaly codes. Configured messages may also include descriptions and the report path. Keep credentials in the environment named by `tokenEnv`. To send alerts to the Naia messenger instead of Discord, set `notify.kind` to `messenger`; see `docs/guides/watch-notify.md`.

`adapter.kind: tmux` uses local list-panes, capture-pane and process descendant
inspection, matching the exact `session:window.pane` target. `aiPrograms` is an
exact executable-name allowlist. No keystrokes or session commands are injected.
`adapter.kind: herdr` executes a configured local `command` argv, without a shell,
which must emit the normalized snapshot below. Herdr CLI variants differ: the
instance wrapper must derive `aiRunning` from actual process evidence, not a
window label. `snapshot` reads a local JSON fixture/export with the same schema.
Commands have a timeout; snapshot producers must atomically replace their file.

```json
{"windows":[{"name":"<window>","aiRunning":true,"output":"<captured-output>"}]}
```

`stoppedRequiresWork` is a top-level boolean, defaulting to `false` for existing
behavior. Set it to `true` to report a quiet running AI as `idle` when a
successfully read `workLedger` has no `진행 중` row matching the role ID and
response-watch has no pending human request for that role's `botId`. `idle`
appears only in the status report and does not create a stopped notification.
An active ledger row or pending request keeps the quiet session `stopped`.
An omitted `workLedger`, unreadable ledger file or invalid ledger also keeps
`stopped`; legacy `workFiles` alone cannot establish that a role has no work.
This option leaves `missing`, `empty`, and independent progress, schedule and
drift anomalies unchanged.

A role waiting on a human can declare when it will look again. Any line in one
of its `workFiles` that starts with `기다림` or `Waiting` and contains
`다음 확인` or `next check` followed by a time turns a quiet `stopped` session
into `waiting` until that time. The time is either ISO 8601 with an offset
(`2026-11-11T00:30:00Z`) or `M/D HH:MM KST|UTC` (the year closest to now). A past
time, or one more than `waitMaxHours` (positive, default 24) ahead, is ignored.
`waiting` creates no notification; `missing`, `empty` and the other anomalies are
unchanged.

`responseWatchState` reuses the observer's `replies[botId].at` confirmed explicit
reply evidence. Missing older response-watch state has no reply evidence.
With `stoppedRequiresWork: true`, pending requests are read from
`channels[channelId].pending[messageId].botId` and matched to `roles[].botId`.
An omitted `responseWatchState` contributes no pending requests. A configured
state that cannot be read or whose pending-request evidence is invalid or
unavailable keeps the quiet session `stopped` and exposes the read error.
`notifications` uses the same nudgeChannelId and escalation.channelId/userId as
response-watch; `roles[].botId` routes the internal recall. No healthy or recovery
notifications are sent. First successful observation of each signal is silent; a failed independent
probe cannot suppress alerts from known signals. Each new
anomaly episode sends one nudge and one escalation after `escalateMinutes`
(default 30); a baseline anomaly remains eligible on the next observation.
Intent is saved before sending; ambiguous delivery stays blocked until an operator
backs up state and reconciles that exact receipt. Known HTTP 4xx rejection may
retry. Restart preserves episodes and receipts. Probe errors remain visible and
exit 2, without converting unknown into an anomaly claim.

### Alert wording

Optional top-level `messages.nudge` and `messages.escalate` customize each stage,
including Korean or another language. Omitted stages keep the exact legacy
`<@{user}> Session health {role}: {code}` wording. Both support:

| Placeholder | Value |
| --- | --- |
| `{user}` | Target user ID: role bot for nudge, escalation user for escalate; use `<@{user}>` for a mention |
| `{role}` | Role ID |
| `{code}` | Full anomaly code, including a missed schedule occurrence |
| `{codeText}` | Description from top-level `codeText`, falling back to the raw code |
| `{report}` | Absolute `reportFile` path, not report contents |

`codeText` maps codes to plain descriptions with the problem and the responsible
person's next action. Exact code matches take priority; `schedule-missed` covers
all `schedule-missed:<occurrence>` codes. Descriptions are inserted literally,
without recursively expanding placeholders. See the example configuration for
Korean wording. Including `{report}` discloses its path to the configured channel;
choose wording appropriate for that channel. Discord mentions remain restricted
to the stage's target user.

`messages` must be an object containing only `nudge`/`escalate`, with non-empty
string values and the placeholders listed above. `codeText` must be an object
mapping non-empty codes to non-empty strings. Invalid settings fail validation
before evidence collection or notification delivery.

```sh
node scripts/session-health.mjs --config <private-config.json> --dry
node scripts/session-health.mjs --config <private-config.json>
```

DRY (`DRY_RUN=1` also supported) reads evidence and previews status/alert/wake counts,
without writing files, locking, or posting. Real runs use an exclusive PID-verified
state lock (`scripts/lib/pid-lock.mjs`) and atomic state/report replacement. Lock
files record `{ pid, start, boot, started }`: live owners still fail concurrent runs
closed (`EEXIST`), while locks left behind by dead, zombie, PID-recycled, or pre-reboot
processes (or legacy PID-less locks past the 30-second grace window) are automatically
quarantined into `.recovered-locks/` and logged to `.recovered-locks/recovery.jsonl`.
Malformed state fails closed. Use owner-only parent directories and
platform journal rotation. No timers are installed or started by this repository.

## 멈춘 카드 깨움 및 모든 ADK 서버 공통 5분 타이머 설치·되돌리기

- **역할 깨움함 연결:** 각 역할은 `roles[].wakeDir` 또는 `workLedgerConfig`
  (`config/work-ledger.json`)의 `roles[].wake_dir`를 사용합니다. 장부가 설정된
  역할에 `wakeDir`이 없으면 설정 검증에서 거부하거나(`workLedgerConfig`가
  있고 `roles[].wake_dir`이 빠진 경우) 실행 시 `wake dir unavailable` 오류와
  `degraded`로 보고합니다. 열린 카드(`open`, `진행 중`)가 기한과 무관하게
  `staleMinutes`(기본 `90`) 이상 진행 증거가 없으면 해당 역할 깨움함에
  `<stamp>-stalled-<id>-route-<role>.md` 파일을 남깁니다. 본문에는
  `멈춘 카드: <제목>`, `카드 id`, `멈춘 시간`, `마지막 증거`를 포함합니다.
- **재깨움·보고 대상·중단 조건·중복 억제:** 같은 카드는 `repeatMinutes`(기본
  `30`) 간격으로 재깨우며, 같은 에피소드 `escalateAfterCount`(기본 `3`)회째부터
  장부(`report.channel` / `from.channel` 등) 또는 역할 `reportChannel`의 사람
  채널을 `보고 대상(사람 채널)`으로 표시합니다. 새 진행 증거(결과 경로 mtime·커밋,
  장부 진행 갱신)가 생기거나 상태가 사람 대기(`waiting_human`, `blocked-human`,
  `human-approval-wait`, `waiting-approval`, `waiting`, `대기`, `막힘`)·종료(`done`,
  `dropped`, `끝`)로 바뀌면 즉시 멈추고 에피소드를 정리합니다. `stateFile`
  (`cardStalls`)로 같은 주기 내 중복 깨움을 막으며, `EEXIST`로 깨움 파일을 새로
  만들지 못한 경우에는 `wakeCount`와 `lastWakeAt`을 올리지 않습니다.
- **오류 비은폐 원칙(fail-loud):** 설정된 역할 JSON 장부 파일이 없거나(`ENOENT`)
  읽기·구문·날짜 오류가 있거나, `status`가 허용된 집합 밖이거나,
  `work-ledger.json` 형식이 어긋나면 0건·정상으로 처리하지 않습니다. 오류
  (`work ledger unavailable`)와 `degraded`(종료 코드 `2`), 보고서 `unknown`을
  남기고 기존 카드 에피소드 상태를 그대로 보존합니다.
- **공통 설정 예시(모든 ADK 서버 동일 기준):** [설정 예시](../../config/session-health.example.json)를
  비공개 경로(예: `/srv/adk/private/session-health.json`)로 복사한 뒤
  `staleMinutes: 90`, `repeatMinutes: 30`, `escalateAfterCount: 3` 값을
  유지하고 자리표시자 경로만 각 서버 경로로 바꿉니다.

```sh
# 1. 동작 확인 (드라이 런 — 파일 쓰기·발송 없음)
node scripts/session-health.mjs --config /path/to/private/session-health.json --dry
```

- **systemd 5분 타이머 견본 설치 및 켜기 절차:** 저장소의
  [서비스 견본](../../templates/systemd/naia-session-health.service)과
  [타이머 견본](../../templates/systemd/naia-session-health.timer)(`OnUnitInactiveSec=5min`)을
  사용자 유닛 디렉터리에 복사해 경로를 채운 뒤 수동으로 켭니다.

```sh
mkdir -p ~/.config/systemd/user
cp templates/systemd/naia-session-health.service ~/.config/systemd/user/
cp templates/systemd/naia-session-health.timer ~/.config/systemd/user/
# 서비스 파일의 WorkingDirectory, PATH, ExecStart 경로와 (필요 시) EnvironmentFile 수정
systemctl --user daemon-reload
systemctl --user enable --now naia-session-health.timer
systemctl --user list-timers naia-session-health.timer
journalctl --user -u naia-session-health.service -n 30 --no-pager
```

- **되돌리기 절차:** 타이머를 끄고 상태 파일(`stateFile`)을 보존한 채 이전 설정으로 복구합니다.

```sh
systemctl --user disable --now naia-session-health.timer
# 필요 시 비공개 설정 백업으로 복원하고 daemon-reload
systemctl --user daemon-reload
```

## Periodic wiring for `work-watch` and `watcher-unit-health` (no extra timers)

`session-health.mjs` runs both worker progress/death checks (`scripts/work-watch.mjs`) and
watcher unit health checks (`scripts/watcher-unit-health.mjs`) inside its existing
five-minute cycle by default, so no additional `systemd` timer or cron entry is needed:

1. **Worker supervision (`workWatch`, enabled by default):** On every non-DRY
   `session-health.mjs` run, if `<baselineRepo>/.agents/work/work-watch/registry.json`
   exists (created automatically by `scripts/worker-runner/spawn-worker.mjs`) or top-level
   `workWatch` is configured (`true` or `{"root": "/<adk>", "registryFile": "/<registry.json>"}`),
   `watchWorkers` inspects registered workers and writes `[일꾼 감시]` wake files (`일꾼 끝`,
   `진도 없음`, `유닛 죽음`) to each spawning role's `wakeDir`. Set `"workWatch": false` to
   disable. If 1-minute worker completion latency is desired on a host that already runs an
   existing 1-minute watcher service, append `ExecStartPost=-/usr/bin/env node /<adk>/scripts/work-watch.mjs watch --root /<adk>`
   to that existing `.service` instead of adding a new `.timer`.
2. **Watcher unit failure monitoring (`watcherUnits`, enabled by default on live adapters):**
   On live `tmux`/`herdr` observer runs (or when `watcherUnits` is explicitly set to `true`
   or an object), `checkWatcherUnits` monitors `systemd --user` watcher units matching
   `patterns` (default `["naia-*", "minho-*"]`, excluding transient worker units
   `["*-worker-*", "worker-*"]`). When `watcherUnits` is omitted, `role` defaults to
   `roles[0].id` and `wakeDir` defaults to `<baselineRepo>/.agents/work/wake/<role>`. Set
   `"watcherUnits": false` to opt out, or run standalone via
   `node scripts/watcher-unit-health.mjs --config <file> [--dry]`:

- When a unit enters `failed` state or reaches `failureThreshold` consecutive failing
  checks (default `2`), a `[감시 유닛 실패]` wake file is written to `watcherUnits.wakeDir`
  for `watcherUnits.role` (deduplicated per `repeatMinutes`, default `30`).
- When failures persist beyond `escalationAfterStreak` consecutive checks (default `2`,
  meaning 3+ consecutive failures), the unit is recorded in `candidatesFile`
  (`ceo-escalation-candidates.json` next to `stateFile` by default) and escalated once
  per episode through the existing `notifications.escalation` Discord channel/mention
  transport (or `watcherUnits.notifyCommand` argv with `{text}`). Recovery resets the
  streak and marks the candidate `resolved`.
