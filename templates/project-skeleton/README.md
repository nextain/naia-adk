# {{PROJECT_NAME}}

> **설명**: {{PROJECT_DESCRIPTION}}  
> **ADK 종류**: `project` (`adk_version: 0.2.0`) · **소유**: `{{OWNER}}` · **책임자(사람)**: `{{RESPONSIBLE_HUMAN}}`  
> **생성일**: {{DATE}}

---

## 1. 표준 명세 사슬 (`PC → SP/UC → RQ → FE → [UT → IT → E2E] → QC`)

- **[📋 00. 사용자 요구사항 원문 기록 & 추적표 (REQ-LOG)](docs/specs/00-USER-REQUESTS-traceability.ko.md)**
- **[① 01-PC 상위기획 (Product Concept)](docs/specs/01-PC-product-concept.ko.md)**
- **[⑧ 08-AC 동작 구조·개념 설명 (Architecture Concepts) — 01-PC 다음에 읽기](docs/specs/08-AC-architecture-concepts.ko.md)**
- **[② 02-SP 화면기획 (Screen Plan)](docs/specs/02-SP-screen-plan.ko.md)**
- **[③ 03-UC 사용자 시나리오 (User Scenarios)](docs/specs/03-UC-user-scenarios.ko.md)**
- **[④ 04-RQ 요구사항 및 수용기준 (Requirements)](docs/specs/04-RQ-requirements.ko.md)**
- **[⑤ 05-FE 기능명세 (Feature Spec)](docs/specs/05-FE-feature-spec.ko.md)**
- **[⑥ 06-UT/IT/E2E 단계별 검증 계획 및 영수증](docs/specs/06-UT-IT-E2E-test-plan.ko.md)**
- **[⑦ 07-QC 독립 적대적 타당성 확인 보고서](docs/specs/07-QC-adversarial-review.ko.md)**

---

## 2. 실행 및 검증 명령

```bash
# 1. 명세 사슬 양방향 추적 + 마크다운 링크 무결성 + 디버그 로거 검증
node scripts/validate-spec-chain.mjs

# 2. 통합 스튜디오 서버 실행 (/docs 문서·Mermaid 뷰어 + /play 실행 뷰어)
node scripts/dev-server.mjs
```
