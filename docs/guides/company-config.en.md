[English](company-config.en.md) | [한국어](company-config.ko.md)

# Company config file guide

For company administrators. When members connect company documents with
`pnpm adk:setup -- --company <address>`, the ADK reads `adk-company.json` at
the top of the company document repository. That one file decides two things:
which folders appear on the dashboard Docs tab, and which shared projects
members receive together.

Company documents are hidden by default. Only folders named in this file show
on the dashboard; folders not named there do not appear in the list and do
not open even by direct address.

## Example

```json
{
  "schemaVersion": 1,
  "title": "Company documents",
  "docs": {
    "include": ["01. Onboarding", "05. Brand & Marketing"]
  },
  "repos": [
    {
      "id": "hub",
      "path": "projects/hub",
      "remote": "https://github.com/example/hub.git",
      "docs": { "title": "Shared hub", "include": ["docs"] }
    }
  ],
  "board": {
    "repo": "hub",
    "script": "scripts/board-server.mjs",
    "port": 8894
  }
}
```

## Field reference

- `schemaVersion` is the format version of this file. It is 1 today.
- `title` is the name shown above the company document bundle on the Docs tab.
- `docs.include` lists the folder names to show on the dashboard.
- `repos` lists the shared projects members receive together. Each entry has:
  - `id`: a short name pointing at the project.
  - `path`: where to receive it. Only under `projects/` or `data-company/`;
    `..` and absolute paths are rejected.
  - `remote`: the Git repository address to pull from.
  - `docs`: when documents inside that project should also show on the Docs
    tab. `title` is the bundle name, `include` the folders to show.
- `board` is only written when using the work board. When set, the dashboard
  Work tab shows that board at the same address.
  - `repo` is the `id` of the project holding the board program. It must be
    one of the values in `repos` above.
  - `script` is the board program file location.
  - `port` is the port the board program uses.

To preview what a config change will do before applying it, run
`pnpm adk:setup -- --company <address> --dry-run`. It only shows what it
would do without receiving anything.
