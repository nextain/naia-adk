<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# User Context

These directories provide human-readable guides for `.agents/context/`.

- `.agents/context/`: machine-facing JSON/YAML source, English by default
- `.users/context/`: Korean human guides
- `.users/context/en/`: English human guides
- `.users/context/agents-rules.md`: generated from
  `.agents/context/agents-rules.json` by `node .claude/hooks/agents-context-mirror.js`;
  edit the JSON first, then regenerate.

`README.md` is Korean and `README.en.md` is English. `AGENTS.md` is the shared English canonical
index; `CLAUDE.md` and `GEMINI.md` are one-line `@AGENTS.md` imports.
