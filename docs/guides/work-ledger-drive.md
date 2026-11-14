# Work ledger drive

`scripts/work-ledger-drive.mjs` makes a role's work ledger start overdue work
itself. Every item carries an instruction file, a result file and a worker
model. When the deadline passes and no worker is running, the tick starts a
headless worker from that instruction file and only notifies the lead. Design
and reasons: [work-ledger-drive design](../work/work-ledger-drive.md).

The ledger is one JSON file per role at `.agents/work/ledger/<role>.json` under
`--root`. Server differences live in a private copy of
[the example configuration](../../config/work-ledger-drive.example.json).

## Commands

Every command takes `--root <workspace>`, `--config <file>` (default
`config/work-ledger-drive.json`) and `--role <role>` (optional with one role).

| Command | Effect |
| --- | --- |
| `add --title --due <UTC ISO> --channel --msg-id --prompt <file> --result-file <file> --model <name>` | Registers an item. Refused when the instruction file is missing, empty or not a regular file, when the result file already exists, or when the model is not in `worker.models`. |
| `adopt <id> --prompt --result-file --model` | Attaches an instruction to an open row that has none. |
| `start <id>` | Starts the worker now, before the deadline. |
| `attach <id> --pid <n>` | Records a worker that was started some other way. |
| `done <id> --result <file or URL>` | Closes with a result address. A file must exist and have content. |
| `confirm <id> --channel <id> --msg-id <id> [--as done\|dropped]` | Closes with an owner message. The message author must be in `owner_ids`, and the message, or the message it replies to, must contain the first 8 characters of the item id. |
| `list` | Open items with worker state. |
| `tick [--dry]` | One pass over all roles. Prints started workers, alerts and errors as JSON. |

There is no `drop`. An item with an instruction that is set to `done` or
`dropped` in the file without a close record is reopened by the next tick.
Deadlines cannot be moved by command.

## What a tick does

For each open item, earliest deadline first:

1. A running worker (same pid and kernel start time) is left alone. Past
   `max_run_min` the lead gets a `long-run` alert; the worker is not stopped.
2. A result file with content gives a `result-ready` alert and no new worker.
   The tick never closes an item.
3. An overdue item with no worker and no result gets a worker, unless one of
   these holds, each of which only alerts: `attempts-exhausted` (`max_attempts`
   starts without a result), `instruction-missing`, `disk-low` (free space on
   `disk.path` below `disk.min_free_gb`), `queued` (`max_parallel` reached).
4. An overdue row with no instruction gives `no-instruction`.

The worker command is `worker.command` with `{model}`, `{id}`, `{prompt}` and
`{result_file}` filled in. Standard input is a short header followed by the
instruction file; `worker.preamble` replaces the header. The worker also gets
`LEDGER_ROLE`, `LEDGER_ITEM_ID` and `LEDGER_RESULT_FILE`. Prompt copies and
logs are kept in `.agents/work/ledger/runs/<id>/`.

Alerts are files in `notify.wake_dir` named
`<time>-ledger-drive-<reason>-<id>-route-<role>.md`, and optionally the standard
input of `notify.command`. The same alert repeats at most once per
`notify.repeat_min`; `launched`, `reopened` and `launch-failed` are always sent.

## Enabling and reverting

1. Copy the example to a private configuration. Set the worker command and
   permission mode this server allows, the model list, the wake folder the lead
   reads, and the owner ids.
2. Run `tick --dry` and read which items would start.
3. Attach instructions to existing open rows with `adopt`.
4. Run `tick` from a timer, for example a systemd user timer every 10 minutes
   with the messenger token in the service environment.
5. Point the lead's ledger wrapper at this script so `add` and `done` go
   through it.

To revert, stop the timer and restore the previous wrapper. The added item
fields (`prompt`, `result_file`, `model`, `run`, `closed`, `alerts`) are
ignored by readers that do not know them, so the ledger file needs no
conversion. Running workers are separate processes; stop them by pid from
`list` if needed.

## Limits

- The lock uses `flock` (util-linux). Worker identity uses `/proc`; elsewhere it
  falls back to a pid check.
- A URL given to `done --result` is recorded, not fetched.
- Anyone who can edit the configuration can change the owner list or worker
  command; protect that file like other host policy.

Tests: `LEDGER_DRIVE_TEST_TMP=<run-folder>/tmp node --test scripts/work-ledger-drive.test.mjs`.
