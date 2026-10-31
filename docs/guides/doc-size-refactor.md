# Refactoring oversized documents

`scripts/doc-size-refactor.mjs` moves eligible historical Markdown sections into monthly archives without rewriting their lines. Inspect candidates with `node scripts/doc-size-refactor.mjs --dry-run` before enabling automation. A normal run processes up to five documents; `--limit 1` through `--limit 5` and `--path <repository-relative-path>` narrow the run. Successful changes are committed using a temporary Git index and pushed to the current branch. A failed push leaves the commit locally; the next run does not retry that push automatically, so push the branch explicitly before rerunning. The shared index is preserved and can consequently differ from the new HEAD.

Configuration is through environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOC_SIZE_ROOT` | repository containing the script | Workspace root |
| `DOC_SIZE_TARGETS` | `["docs"]` | JSON array of repository-relative Markdown files or directories; archives are excluded |
| `DOC_SIZE_MAX_BYTES` | `102400` | Byte threshold, exclusive |
| `DOC_SIZE_MAX_LINES` | `2000` | Line threshold, exclusive; exceeding either threshold selects a document |
| `DOC_SIZE_MODEL` | `gpt-6-luna` | Codex model |
| `DOC_SIZE_EFFORT` | `low` | Model reasoning effort |
| `DOC_SIZE_CODEX` | `codex` | Codex executable |
| `DOC_SIZE_CODEX_RUNTIME` | unset | Absolute path to the actual Codex runtime binary when the executable is a wrapper; permits that binary in the model sandbox |
| `TMPDIR` | operating system temporary directory | Temporary files and advisory lock |

The script chooses candidates before invoking the model: fenced code is ignored, the first and last ten `##` sections are retained, protected words in titles are excluded, and dates in the title or first nonempty body line must all be valid and more than seven days old in Asia/Seoul. Yearless dates use the current year. The model receives candidate metadata only, in a temporary workspace with user configuration ignored, restricted filesystem access and no command network access. It returns section numbers; malformed JSON, duplicates, or any number outside the candidates reject the whole selection. No candidate means no model call. Model calls time out after 15 minutes.

Archives are written under `docs/archive/<source path without extension>/<year-month>.md`; the source gains one link. A line multiset comparison preserves original UTF-8 bytes represented by each line, including duplicate lines; documents must end in a newline. Snapshot checks refuse concurrent changes and roll back installed files when safe. Existing source or archive changes are refused; an already dirty log is excluded from the commit. Pathspec metacharacters and symlink targets are rejected before model invocation. The shared advisory lock only coordinates cooperating writers. A non-cooperating writer can still change a file between its last check and rename.

Copy the examples in `templates/systemd/` into the user's systemd unit directory, replace the absolute placeholders, and configure the environment for the workspace. Review the timer and run a dry run before enabling it. The service uses `NoNewPrivileges` and `PrivateTmp`; those settings do not restrict all service writes. The script logs results in `docs/archive/doc-size/` and can partially archive a document that remains above its threshold.
