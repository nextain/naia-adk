# ④ [RQ] 요구사항 및 수용기준 (Requirements) — {{PROJECT_NAME}}

> **상위 문서**: **[📋 요구사항 추적표](docs/specs/00-USER-REQUESTS-traceability.ko.md)** · **[① 01-PC 상위기획](docs/specs/01-PC-product-concept.ko.md)** · **[② 02-SP 화면기획](docs/specs/02-SP-screen-plan.ko.md)** · **[③ 03-UC 사용자 시나리오](docs/specs/03-UC-user-scenarios.ko.md)**  
> **하위 연결**: **[⑤ 05-FE 기능명세](docs/specs/05-FE-feature-spec.ko.md)** · **[⑥ 06-UT/IT/E2E 검증 계획](docs/specs/06-UT-IT-E2E-test-plan.ko.md)**

---

## 1. 기능 및 비기능 요구사항 정의

| 요구사항 ID | 상위 근거 | 요구사항 설명 | 측정 가능한 수용기준 (Acceptance Criteria) |
|---|---|---|---|
| **`RQ-01`** | `REQ-LOG-01`<br/>`PC-01` · `SP-01` · `UC-01` | **명세 사슬 양방향 추적 및 인터랙티브 Mermaid 스튜디오 서버** | 1. `docs/specs/` 내 8개 표준 문서가 모두 존재하고 깨진 내부 마크다운 링크가 `0건`이어야 한다.<br/>2. `scripts/lib/mermaid-viewer-client.mjs`가 `wirePanZoom`, `+`/`-`/`100%`/`⛶` 툴바, `openMermaidModal` 및 `Escape` 닫기를 제공해야 한다. |
| **`RQ-02`** | `REQ-LOG-02`<br/>`PC-02` · `SP-02` · `UC-02` | **D47 구조화 디버그 로거 및 ADK 소유·책임자·키 격리 무결성** | 1. `src/debug-logger.mjs`는 `MAX=200` 링버퍼를 유지하며 200개 초과 시 가장 오래된 항목부터 제거해야 한다.<br/>2. 글로벌 `error` 및 `unhandledrejection` 이벤트를 자동 포착하고 `window.__DEBUG__`로 노출해야 한다.<br/>3. `adk.json`의 `owner`와 `responsible_human`이 비어 있지 않고 `keys/`가 심볼릭 링크가 아님을 검증기가 확인해야 한다. |
