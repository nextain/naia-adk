# Group Projects (`projects/`)

List each product or service being built by the group in `group_config.projects[]` inside `adk.json`.

## Rules

- Each project has a unique `id`, human-readable `name`, `repo` (`string | null`), and `repo_status` (`"canonical"` or `"undecided"`).
- When `repo` is `null`, `repo_status` must be `"undecided"` (reported as an open slot during `--check`).
- A project may include one level of `services[]` for sub-services (`<project>/<service>`). Services cannot nest further `services`.
- Every entry in `milestones[]` must match a milestone `id` defined in `group_config.calendar`.
