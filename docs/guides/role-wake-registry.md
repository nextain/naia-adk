# Role wake registry

One private instance file names the live workspace, the wake boxes and every
role. `scripts/role-wake.mjs` reads only that file, so role lookup, wake
delivery, consumer checks, the role-session table and wake-box retention cannot
point at different trees or different role lists.

Copy `config/role-wake.example.json` to a private path and pass it with
`--config` or `ADK_ROLE_WAKE_CONFIG`. Server differences live in this file
only; the script is the same on every server.

## Registry fields

| Field | Meaning |
|---|---|
| `root` | The one live workspace. `wake_root` and `retention.archive_dir` must stay inside it. |
| `retired_roots` | Old workspace copies. Any unit file, crontab line or process that still uses one is an error. |
| `unit_dirs` | Directories of timer and service files scanned for retired roots. |
| `roles.<id>.find.pane_id` | The session pane. The foreground program of this pane decides whether the session is alive and which tool it runs. |
| `roles.<id>.tool`, `tools` | First-choice tool and the ordered list a start script may fall back to. `tool` must equal `tools[0]`. |
| `roles.<id>.wake_subdir` | Folder under `wake_root`; `""` is the top-level box. |
| `roles.<id>.wait` | Optional in-session wait script, checked under the pane's own process tree. |
| `delivery.command` | Instance command that puts one wake file in front of a role (`{role}`, `{file}`). |
| `role_views` | Role lists other tools still keep (`l4-roles`, `wake-routes`, `liveness`, `session-health`, `bot-mention-wake`). |

The role block keeps the keys the pane liveness tool already reads (`user`,
`find`, `tool`, `restart_cmd`, `wait`), so that tool can read the registry
file directly instead of a second list.

## Consumers do not depend on the tool

A wait script started inside a session exists only for tools that can run
background commands, and it stops whenever the session restarts or compacts.
The registry therefore requires a consumer that runs outside the session:

- `deliver` hands each new wake file to `delivery.command` in name order and
  records it in `state_dir/delivered-<role>.jsonl`. A box seen for the first
  time is recorded, not replayed. A failed file holds that role until it
  succeeds, so later files cannot overtake it.
- A role with neither `delivery` nor `wait` is rejected when the file loads.
- `wait` stays optional. When delivery is configured, a stopped wait script is
  a warning; without delivery it is an error.

## Commands

| Command | Effect |
|---|---|
| `validate` | Load and check the registry. |
| `check [--json]` | Read-only. Exit 1 on any error finding. |
| `watch --repair` | `check`, then run `deliver` once if the delivery heartbeat is stale, then send error findings through `notify.command` once per `repeat_seconds`. |
| `board` | Print the role-session table for a status page. |
| `deliver [--role id]` | Run one delivery pass. Install exactly one periodic runner. |
| `sweep [--apply]` | Dry by default. Moves delivered files older than `retention.delivered_days` to `archive_dir/<role>/<yyyymmdd>/`. |
| `view --kind l4-roles\|wake-routes` | Print the role list in an older tool's shape during migration. |

Findings: `retired-root-in-use`, `role-view-missing`, `role-view-drift`,
`session-down`, `pane-unreadable`, `tool-drift`, `tool-fallback`,
`wait-script-missing`, `wait-down`, `delivery-stale`, `delivery-lag`,
`box-backlog`.

Run `watch --repair` from a scheduler other than the one that runs `deliver`
(for example the pane liveness cadence), so one stopped timer cannot hide the
other. Pane restart and the in-session wait nudge remain with the pane
liveness tool; this script does not type into panes.

## Retention

`sweep` never deletes. It moves only files the delivery ledger records, and
leaves undelivered files where they are however old. Removing archive folders
is a separate decision for the workspace owner.

## Migration order

1. Write the private registry; run `validate` and `check`. Expect
   `delivery-stale` until step 3.
2. List every other role list under `role_views` and clear each
   `role-view-drift` by making that tool read the registry or by regenerating
   its list with `view`.
3. Run `deliver` once while the old deliverer still runs (the first run records
   the existing box contents without replay), stop the old deliverer, then
   install the periodic runner. A file that arrives in between is delivered
   twice rather than lost.
4. Install `watch --repair` on a separate scheduler.
5. Run `sweep`, review the counts, then `sweep --apply`.
6. Retire units that `retired-root-in-use` names, following
   [server onboarding](server-wake-onboarding.md) backup rules.
