# ⑦ [QC] 독립 적대적 타당성 확인 보고서 (Quality Control) — {{PROJECT_NAME}}

> **독립 검증 원칙**: QC는 개발자의 각본(`UC`)이나 내부 기능 명세(`FE`)에 오염되지 않고, 오직 **[📋 사용자 요구사항 원문 기록](docs/specs/00-USER-REQUESTS-traceability.ko.md)**, **[① 01-PC 상위기획](docs/specs/01-PC-product-concept.ko.md)**, **[② 02-SP 화면기획](docs/specs/02-SP-screen-plan.ko.md)**만을 기준으로 제품의 타당성과 안전 경계를 적대적으로 검증합니다.

---

## 1. 독립 적대 검증 항목 (`QC-01` ~ `QC-02`)

| QC ID | 검증 기준 (`REQ-LOG` / `PC` / `SP`) | 적대적 질문 (Adversarial Probe) | 확인 방법 | 판정 |
|---|---|---|---|---|
| **`QC-01`** | `REQ-LOG-01` · `PC-01` · `SP-01` | 사용자가 `/docs`에서 요구사항 원문부터 상위기획·화면도면까지 깨진 링크 없이 추적할 수 있으며, 복잡한 Mermaid 도면을 확대·드래그·전체화면(`⛶`)으로 읽고 `Esc`로 즉시 닫을 수 있는가? | `node scripts/validate-spec-chain.mjs` 및 `/docs` 뷰어 점검 | ✅ PASS |
| **`QC-02`** | `REQ-LOG-02` · `PC-02` · `SP-02` | 책임자(`responsible_human`)가 비어 있거나 `keys/` 폴더가 외부로 링크된 비정상 ADK를 즉시 차단하며, 런타임 에러 발생 시 로그 유실이나 메모리 폭주 없이 링버퍼(`MAX=200`)에 보존하는가? | `node scripts/validate-spec-chain.mjs` 및 `adk-link.mjs --check` 점검 | ✅ PASS |
