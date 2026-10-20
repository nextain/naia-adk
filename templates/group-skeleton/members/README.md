# Group Members (`members/`)

Define one markdown or JSON profile per group member in this directory and reference it from `group_config.members[].file` in `adk.json`.

## Role Placeholders in Skeleton

- `group-owner`: Primary human responsible for the group (`responsible_human`).
- `member-a`: Group member slot (`access: "unset"` until confirmed).
- `member-b`: Group member slot (`access: "unset"` until confirmed).

## Access Levels

- `owner`: Full group administration and policy control.
- `admin`: Manages projects, channels, and member permissions.
- `member`: Standard read/write access within granted roots.
- `viewer`: Read-only access to allowed roots.
- `unset`: Open placeholder slot reported by `adk-link.mjs --check` until assigned.
