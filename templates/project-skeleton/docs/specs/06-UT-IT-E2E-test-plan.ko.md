# ⑥ [UT / IT / E2E] 단계별 검증 계획 및 영수증 — {{PROJECT_NAME}}

> **원칙**: 첫 슬라이스는 실패 위험이 가장 큰 핵심 백엔드/모듈 경로의 **통합 시험(IT)**이며, 통합 시험(IT)이 통과한 뒤 화면 관통 시험(**E2E**)으로 닫습니다.  
> **상위 문서**: **[📋 요구사항 추적표](docs/specs/00-USER-REQUESTS-traceability.ko.md)** · **[④ 04-RQ 요구사항](docs/specs/04-RQ-requirements.ko.md)** · **[⑤ 05-FE 기능명세](docs/specs/05-FE-feature-spec.ko.md)**  
> **하위 연결**: **[⑦ 07-QC 독립 적대 검증 보고서](docs/specs/07-QC-adversarial-review.ko.md)**

---

## 1. 단위 시험 (UT) · 통합 시험 (IT) · 사용자 여정 관통 시험 (E2E) 매트릭스

| 검증 ID | 구분 | 연결 요구사항 / 기능 | 검증 방법 및 실행 명령 | 판정 기준 |
|---|---|---|---|---|
| **`UT-01`** | 단위 시험 (UT) | `REQ-LOG-01` · `RQ-01` · `FE-01` | `node scripts/validate-spec-chain.mjs` (`wirePanZoom` 배율 계산·리셋·팬 상태 검증) | `100%` → `125%` → `100%` 배율 및 `scale(1)` 변환 일치 |
| **`UT-02`** | 단위 시험 (UT) | `REQ-LOG-02` · `RQ-02` · `FE-02` | `node scripts/validate-spec-chain.mjs` (`src/debug-logger.mjs` `MAX=200` 링버퍼 및 글로벌 에러 포착 검증) | 250건 입력 시 정확히 최신 200건 유지, `ERROR` 채널 포착 |
| **`IT-01`** | 통합 시험 (IT) | `REQ-LOG-01` · `RQ-01` · `FE-01` | `docs/specs/` 8개 명세 문서 파싱 + 양방향 ID 추적 + 마크다운 파일 링크 실재성 관통 검사 | 누락 문서 `0건`, 깨진 링크 `0건` |
| **`IT-02`** | 통합 시험 (IT) | `REQ-LOG-02` · `RQ-02` · `FE-02` | `adk-link.mjs --check`로 `user`/`agent`/`project`/`org` 4종 ADK 상대 경로 소프트링크 및 `keys/` 격리 관통 검사 | 비어 있는 `responsible_human` 거부, `keys/` 링크 거부 |
| **`E2E-01`** | 관통 시험 (E2E) | `REQ-LOG-01` · `UC-01` · `SP-01` | `/docs` 스튜디오 뷰어에서 문서 카탈로그 로드, Mermaid 툴바(`+`/`-`/`100%`/`⛶`) 및 모달 `Esc` 닫기 확인 | 스튜디오 문서 뷰어 및 Mermaid 모달 정상 동작 |
| **`E2E-02`** | 관통 시험 (E2E) | `REQ-LOG-02` · `UC-02` · `SP-02` | `/play` 화면에서 액션 트리거 후 `window.__DEBUG__.exportSnapshot()` 출력 확인 | 실시간 구조화 로그 스냅샷 렌더링 |
