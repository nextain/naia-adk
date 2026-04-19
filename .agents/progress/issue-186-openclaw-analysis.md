# #186 OpenClaw 제거 — 스킬 생태계 종합 분석

## 1. OpenClaw이 Naia OS에 제공하는 것 (3가지)

| 역할 | 구체적 기능 | 제거 시 영향 |
|------|-----------|-------------|
| **런타임 데몬** | WebSocket :18789, systemd 서비스, 프로세스 관리 | 게이트웨이 자체가 없어짐 |
| **명령 실행** | exec.bash, file ops, skills.invoke (50+ 스킬) | 모든 도구 실행 불가 |
| **채널 통합** | Discord/Telegram/Slack, 세션 관리, 메모리 파일 | 외부 채널 완전 단절 |

## 2. 생태계 비교

| 생태계 | 상태 | 강점 | 약점 |
|--------|------|------|------|
| **MCP (Anthropic)** | 업계 표준화 중 | OpenAI/Google/MS 합류, NIST 인정, 벤더 중립 | 아직 초기, 엣지케이스 미해결 |
| **OpenAI Function Calling** | 성숙, 쇠퇴 중 | 검증됨, 대규모 운영 | 벤더 종속, OpenAI 자체도 MCP로 이동 |
| **OpenClaw** | 폭발 성장 (250K stars) | 5,400+ 스킬, 멀티채널 | 개인 비서 특화, 스킬 비이식 |
| **CrewAI/AutoGen/LangGraph** | 프레임워크 수준 | 각 영역 성숙 | 도구 시스템 상호 비호환 |

## 3. 전략 권고: MCP 정렬

**MCP가 이기고 있는 이유:**
- OpenAI, Google, Microsoft 모두 합류
- NIST AI Agent Standards Initiative (2026.02) — 정부 수준 표준화
- Claude Code 5.2M VSCode 설치 — IDE 생태계 장악
- Linux Foundation Agentic AI 거버넌스

**Naia OS 포지셔닝:**
- MCP 호환 → Naia 스킬이 Claude Code, VSCode, Cursor에서도 동작
- 벤더 중립 유지 → any-llm 게이트웨이와 자연스럽게 연결

## 4. 마이그레이션 경로 (4단계)

### Phase 1: 추상화 계층 (즉시)
- Agent 내부에 `ToolExecutor` 인터페이스 정의
- OpenClaw exec.bash → ToolExecutor 구현 래핑
- 향후 자체 실행 엔진으로 교체 가능한 구조

### Phase 2: 자체 명령 실행 (1-2개월)
- Node.js `child_process`로 exec.bash 대체
- 파일 시스템 직접 접근 (OpenClaw 경유 제거)
- 승인 시스템(exec.approvals) 자체 구현 (#183 tier 시스템 활용)

### Phase 3: MCP 스킬 브릿지 (2-3개월)
- MCP 서버로 기존 Naia 스킬 노출
- MCP 클라이언트로 외부 MCP 도구 사용
- 스킬 정의를 MCP JSON Schema 호환으로

### Phase 4: OpenClaw 완전 제거 (3-6개월)
- any-llm 게이트웨이가 런타임 데몬 역할
- 채널 통합(Discord 등)을 자체 또는 MCP 기반으로
- `~/.openclaw/` → `~/.naia/` 완전 이관

## 5. 이미 완료된 준비 작업

| 이슈 | 기여 |
|------|------|
| #183 도구 안전 메타데이터 | Phase 2의 승인 시스템 기반 |
| #184 태스크 라이프사이클 | Phase 2의 실행 추적 기반 |
| #185 토큰 예산 | Phase 3의 컨텍스트 관리 기반 |

## 6. 논의 필요 사항

1. **OpenClaw 스킬 호환**: 기존 5,400+ OpenClaw 스킬 생태계를 어느 수준까지 호환할 건지?
   - A: 완전 호환 래퍼 (복잡, 유지보수 부담)
   - B: 핵심 스킬만 MCP로 재구현 (실용적)
   - C: 호환 안 함, Naia 자체 스킬만 (단순, 생태계 포기)

2. **채널 통합**: Discord/Telegram을 어떻게 유지?
   - A: 자체 채널 어댑터 (Cloud Run 릴레이 — 현재 #155 설계대로)
   - B: MCP 기반 채널 도구
   - C: 채널 통합 제거 (데스크톱 전용)

3. **타이밍**: Phase 1부터 바로 시작? 아니면 다른 우선순위 먼저?
