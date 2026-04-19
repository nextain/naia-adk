[English](../README.md) | 한국어

# Naia ADK

**개인 및 기업을 위한 AI 개발 킷.**

AI 에이전트, 스킬, 데이터, 워크플로우를 하나의 워크스페이스로 통합하는 오픈소스 프레임워크입니다. 포크해서 설정하고, 당신의 것으로 만드세요.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## Naia ADK란?

Naia ADK는 AI 기반 운영을 위한 기반 프레임워크입니다 — 개인과 조직 모두 포크하여 자신의 워크스페이스를 구성할 수 있습니다:

- **개인용** — 스킬, 자동화, 프로젝트 관리가 포함된 개인 AI 워크스페이스
- **기업용** — 포크하여 회사 데이터와 서브모듈을 추가하고 팀에 배포
- **제품 연동** — [Naia OS](https://github.com/nextain/naia-os)의 스킬·데이터 백엔드로 MCP/WebSocket 연결

### 포크 체인

```
naia-adk                  ← Base 프레임워크 (공개, Apache 2.0)
  ├─ naia-business-adk   ← 비즈니스 확장 (유료): 급여, HR, 컴플라이언스
  │    └── {조직}-adk     ← 조직 포크: 기업 데이터 + 서브모듈
  │          └── {사용자}-adk  ← 개인 포크: 개인 데이터 + 프로젝트
  └── {사용자}-adk         ← 직접 포크: 개인 사용
```

예시 — 넥스테인 체인:

```
naia-adk → naia-business-adk → nextain-adk → alpha-adk
```

어느 레이어에서든 포크 가능. 개인은 `naia-adk`를 직접 포크, 조직은 비즈니스 확장을 거칩니다.

### 비즈니스 팩

**[Naia Business ADK](https://nextain.io/adk)** — 조직을 위한 유료 확장 팩:

- 사전 구축된 비즈니스 스킬 (급여, 회계, HR 문서 생성)
- 멀티테넌트 팀 관리
- 우선 지원 및 SLA
- 컴플라이언스 대응 템플릿 (GDPR, 개인정보보호법)

비즈니스 팩은 `naia-adk`의 프라이빗 포크에 추가 스킬과 설정을 제공합니다. [문의하기](https://nextain.io/contact)

## 포크 가이드

### 1. 포크 생성

GitHub에서 `naia-adk`를 포크합니다.

### 2. 클론 및 설정

```bash
git clone https://github.com/YOUR-ORG/your-adk.git
cd your-adk
git remote add upstream https://github.com/nextain/naia-adk.git
```

### 3. 데이터 디렉토리 생성

```bash
mkdir -p data-company data-business data-private projects
```

### 4. 프로젝트 서브모듈 추가

```bash
git submodule add https://github.com/your-org/your-project projects/your-project
```

### 5. FORK.md 작성

포크 루트에 `FORK.md`를 생성하여 조직/사용자 정보, 프로젝트 목록, 데이터 서브모듈, 기본 언어를 기록합니다.

### 6. upstream 동기화

```bash
git fetch upstream
git merge upstream/main
```

### 7. Naia OS 연동 (선택)

[Naia OS](https://github.com/nextain/naia-os)를 사용하는 경우, 워크스페이스 경로를 ADK 디렉토리로 설정하세요. 스킬과 데이터가 MCP/WebSocket으로 제공됩니다.

## 보안 등급

| 등급 | 수준 | 예시 |
|------|------|------|
| T1 | 공개 | 오픈소스 코드, 공개 문서 |
| T2 | 기업 | 사내 문서, 공유 리소스 |
| T3 | 기밀 | 회계, 계약서, 개인 데이터 |
| T4 | 비밀 | API 키, 자격증명 (`.env`, 절대 커밋 금지) |

## 스킬

| 스킬 | 설명 |
|------|------|
| `review-pass` | 4단계 멀티 AI 교차 검증 리뷰 |
| `doc-coauthoring` | 구조화된 문서 공동 작성 워크플로우 |
| `read-doc` | HWP/PDF/DOCX/XLSX/PPTX 텍스트 추출 |
| `press-release` | 보도자료 작성, 기자 조사, 발송 |
| `patent-draft` | 특허청 전자출원 양식 기반 특허 명세서 작성 |
| `patent-pipeline` | AI 특허 발굴, 평가, 출원 자동화 |
| `copyright-reg` | 저작권 등록 서류 생성 |
| `payroll` | 급여명세서 PDF 생성 + 이메일 발송 |
| `weekly-report` | git 커밋 기반 주간 업무 보고서 생성 |
| `webapp-testing` | Playwright E2E 웹 앱 테스트 |
| `merge-worktree` | 워크트리 스쿼시 머지 |
| `verify-implementation` | 통합 검증 보고서 생성 |
| `manage-skills` | 검증 스킬 자동 관리 |

## 기여

**모든 언어로 기여할 수 있습니다.** 이슈, PR, 디스커션은 모국어로 작성해도 됩니다 — AI가 번역합니다.

Git 기록(커밋, 컨텍스트, 공유 산출물)은 영어로 작성합니다.

## 라이선스

Apache License 2.0 — 자세한 내용은 [LICENSE](../LICENSE) 파일을 참조하세요.

## 링크

- **Naia OS** — [github.com/nextain/naia-os](https://github.com/nextain/naia-os)
- **Nextain** — [nextain.io](https://nextain.io)
