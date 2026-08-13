# 에이전트 등록부

> AI 정본: `.agents/context/agent-registry.json`

워크스페이스 ADK는 `agents/<agent-id>/` 아래에 실제 실행 주체를 둘 수 있습니다.
공개 `naia-adk` 보일러플레이트에는 구체적인 에이전트가 없으며, 각 포크가 자신의
에이전트를 등록합니다.

각 에이전트 디렉터리에는 다음 두 파일이 필요합니다.

- `AGENTS.md`: 정체성, 역할, 행동 및 정보 범위
- `agent.json`: 실행 엔진, 허용·금지 정보 경로, 채널 상태를 담은 기계 판독 설정

비밀값은 등록부나 프롬프트에 넣지 않습니다. `data-private/` 또는 외부 비밀정보
저장소에서 실행기가 직접 읽고, 모델 컨텍스트에는 전달하지 않습니다.

`node scripts/verify-agent-registry.mjs`로 등록부와 디렉터리의 일치 여부를 확인합니다.
