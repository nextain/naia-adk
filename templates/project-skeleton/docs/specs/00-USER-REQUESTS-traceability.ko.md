# 📋 사용자 요구사항 원문 기록 & 문서·구현 양방향 추적표 (User Request Traceability)

> **프로젝트**: `{{PROJECT_NAME}}` (`{{PROJECT_ID}}`) · **소유**: `{{OWNER}}` · **책임자(사람)**: `{{RESPONSIBLE_HUMAN}}`  
> **목적**: 사용자가 지시한 모든 요구사항을 **원문 발언 순서대로 기록**하고, 각 요구사항이 **표준 명세 사슬(`PC → SP/UC → RQ → FE → [UT → IT → E2E] → QC`)에 어떻게 반영되었는지 양방향 링크로 추적·검증**합니다.

---

## 1. 전체 명세 사슬 바로가기

- **[① 01-PC 상위기획 (Product Concept)](docs/specs/01-PC-product-concept.ko.md)**
- **[② 02-SP 화면기획 (Screen Plan)](docs/specs/02-SP-screen-plan.ko.md)**
- **[③ 03-UC 사용자 시나리오 (User Scenarios)](docs/specs/03-UC-user-scenarios.ko.md)**
- **[④ 04-RQ 요구사항 및 수용기준 (Requirements)](docs/specs/04-RQ-requirements.ko.md)**
- **[⑤ 05-FE 기능명세 (Feature Spec)](docs/specs/05-FE-feature-spec.ko.md)**
- **[⑥ 06-UT/IT/E2E 단계별 검증 계획](docs/specs/06-UT-IT-E2E-test-plan.ko.md)**
- **[⑦ 07-QC 독립 적대적 타당성 확인 보고서](docs/specs/07-QC-adversarial-review.ko.md)**

---

## 2. 사용자 요구사항 원문 기록 & 양방향 추적 매트릭스 (`REQ-LOG-01` ~ `REQ-LOG-02`)

| ID | 사용자 원문 발언 / 요구사항 요약 | 반영된 명세 문서 링크 (클릭 시 이동) | 검증 항목 (`UT / IT / E2E / QC`) | 상태 |
|---|---|---|---|---|
| **REQ-LOG-01** | **핵심 제품 가치 및 통합 스튜디오 뷰어 제공**<br/>*"기획 문서(`PC→SP/UC→RQ→FE→QC`)와 실행 화면(`/play`)을 한 곳에서 보고, 다이어그램은 마우스 휠 확대·축소·전체화면 모달로 볼 수 있어야 함"* | • [01-PC `PC-01`](docs/specs/01-PC-product-concept.ko.md)<br/>• [02-SP `SP-01`](docs/specs/02-SP-screen-plan.ko.md)<br/>• [03-UC `UC-01`](docs/specs/03-UC-user-scenarios.ko.md)<br/>• [04-RQ `RQ-01`](docs/specs/04-RQ-requirements.ko.md)<br/>• [05-FE `FE-01`](docs/specs/05-FE-feature-spec.ko.md) | • [06-UT/IT/E2E `UT-01` · `IT-01` · `E2E-01`](docs/specs/06-UT-IT-E2E-test-plan.ko.md)<br/>• [07-QC `QC-01`](docs/specs/07-QC-adversarial-review.ko.md) | ✅ 반영 완료 |
| **REQ-LOG-02** | **구조화 디버그 로거(D47) 및 키·책임자 무결성 보장**<br/>*"링버퍼 `MAX=200`과 글로벌 에러 자동 포착(`window.__DEBUG__`)을 기본 탑재하고, 책임자(`responsible_human`) 및 `keys/` 격리를 검증기로 강제할 것"* | • [01-PC `PC-02`](docs/specs/01-PC-product-concept.ko.md)<br/>• [02-SP `SP-02`](docs/specs/02-SP-screen-plan.ko.md)<br/>• [03-UC `UC-02`](docs/specs/03-UC-user-scenarios.ko.md)<br/>• [04-RQ `RQ-02`](docs/specs/04-RQ-requirements.ko.md)<br/>• [05-FE `FE-02`](docs/specs/05-FE-feature-spec.ko.md) | • [06-UT/IT/E2E `UT-02` · `IT-02` · `E2E-02`](docs/specs/06-UT-IT-E2E-test-plan.ko.md)<br/>• [07-QC `QC-02`](docs/specs/07-QC-adversarial-review.ko.md) | ✅ 반영 완료 |
