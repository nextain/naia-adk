<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# 사용자 컨텍스트

`.agents/context/`의 기계용 규칙을 사람이 읽는 문서로 설명하는 디렉터리입니다.

- `.agents/context/`: JSON/YAML 기계 원본(영어 기본)
- `.users/context/`: 한국어 human guide
- `.users/context/en/`: 영어 human guide
- `.users/context/agents-rules.md`: `.agents/context/agents-rules.json`에서
  `node .claude/hooks/agents-context-mirror.js`로 생성되는 파일입니다. JSON을 먼저 수정하고
  다시 생성합니다.

`README.md`는 한국어, `README.en.md`는 영어입니다. `AGENTS.md`는 shared English canonical
index이며 `CLAUDE.md`와 `GEMINI.md`는 byte-identical mirror입니다.
