<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# AI Work Index

`.agents/context/ai-work-index.yaml`에 대한 사람이 읽을 수 있는 가이드입니다.

## 목적

`ai-work-index.yaml` 파일은 AI가 작업 유형을 식별하고 적절한 워크플로우를 찾는 데 사용하는 인덱스입니다.

---

## 작업 카테고리

### 1. 이슈 기반 개발 (issue-driven-development) — 기본값

- **키워드**: feature, feature development, upstream, investigate, plan, review, bug fix
- **빠른 참조**: `ISSUE → UNDERSTAND → SCOPE → INVESTIGATE → PLAN → BUILD → REVIEW → E2E TEST → POST-TEST REVIEW → SYNC → SYNC VERIFY → REPORT → COMMIT` (13 phases)
- **워크플로우**: `.agents/workflows/issue-driven-development.yaml`
- **설명**: 기능 단위 작업의 기본 워크플로우. 신규 기능, 기능 단위 버그 수정, 주변 코드 품질이 불확실한 작업에 사용.

### 2. 서브모듈 관리 (submodule-management)

- **키워드**: submodule, init, update, sync
- **빠른 참조**: `git submodule update --init --recursive`
- **설명**: Git 서브모듈 초기화 및 동기화 작업

### 3. 문서화 (documentation)

- **키워드**: docs, document, proposal, business, hwp, hwpx, pdf, docx, xlsx, pptx, 발표, 제안서, 사업계획서, 이력서
- **빠른 참조**: `docs-business/AGENTS.md` 참조. HWP/HWPX/PDF/DOCX/XLSX/PPTX 파일은 `/read-doc` 스킬 사용.
- **스킬**: `read-doc`
- **스킬 실행 시점**: `.hwp` `.hwpx` `.pdf` `.docx` `.xlsx` `.pptx` 파일을 읽거나 분석해야 할 때 **반드시** `/read-doc <파일>` 먼저 실행. "파일을 읽을 수 없다"는 말은 절대 하지 말 것 — read-doc으로 항상 읽을 수 있음.
- **설명**: 비즈니스 문서, 제안서, 웹페이지 작업

### 4. 작업 로그 (work-logs)

- **키워드**: log, worklog, progress
- **빠른 참조**: `docs-work-logs/AGENTS.md` 참조
- **설명**: 개발자 작업 로그 관리

### 5. Cafelua 서비스 (cafelua-service)

- **키워드**: cafelua, service, gateway, credit, auth, proxy, any-llm, lab
- **빠른 참조**: `project-any-llm/README.md` 참조
- **워크플로우**: `.agents/workflows/development-cycle.yaml`
- **설명**: Any-LLM SDK, FastAPI 게이트웨이, 크레딧/인증/프록시 관련 작업

### 6. 인프라 (infra)

- **키워드**: gcp, cloud-run, cloud-sql, docker, deploy, domain
- **빠른 참조**: GCP project: cafelua-prod, Cloud Run + Cloud SQL (asia-northeast3)
- **설명**: 클라우드 인프라 배포/설정 작업

### 7. 데모 영상 (demo-video)

- **키워드**: demo, video, recording, tts, narration, playwright, ffmpeg
- **빠른 참조**: `naia-os/.agents/context/demo-video.yaml` 참조
- **설명**: 데모 영상 녹화, TTS 나레이션, ffmpeg 합성

---

## 사용 방법

1. 사용자 요청에서 키워드 추출
2. `ai-work-index.yaml`에서 카테고리 매칭
3. 빠른 참조로 먼저 확인
4. 상세 작업이 필요하면 워크플로우 문서 로드

---

## 참고 사항

- 각 서브모듈은 자체 진입점이 있음 — 수정 전 먼저 읽기
- 워크플로우는 온디맨드로 로드 (한꺼번에 로드하지 않음)
- **기능 단위 작업 (기본값)**: `issue-driven-development.yaml`
- **단순 변경 (오타, 설정값, 간단한 지시)**: `development-cycle.yaml`
- 1:1 미러링 원칙 준수
