# Naia Ecosystem Architecture

> naia-adk is the foundation. Everything else is an example of how it's used.

## Overview

```
            naia-adk (OSS — this repo)
            ┌─────────────────────────┐
            │  Individual Skills      │
            │  review-pass, email     │
            │  sms, read-doc          │
            │  doc-coauthoring        │
            │  document-generation    │
            │  channel-management     │
            │  web-monitoring         │
            │  service-management     │
            └────────────┬────────────┘
                         │ extends
                         ▼
                  naia-adk-b (private)
                  ┌─────────────────────┐
                  │  + Business Skills  │
                  │  payroll, contract  │
                  │  expense, accounting│
                  │  CRM, patent, PR    │
                  │  + CLI, Docgen, PDF │
                  └────────┬────────────┘
                           │ naia init
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        nextain-adk   onmam-adk    {company}-adk
        (CEO Luke)    (Onmam CTO)  (any company)
        .naia/        .naia/        .naia/
        context.yaml  context.yaml  context.yaml
        data/         data/         data/
```

## Layer Rules

| Layer | What | For Who |
|-------|------|---------|
| **naia-adk** | 개인용 스킬 (9) | 모든 개인 — 개발자, 크리에이터, 프리랜서 |
| **naia-adk-b** | 개인용 + 비즈니스 스킬 (20) | 회사 운영하는 슈퍼개인 / 소규모 팀 |
| **{company}-adk** | naia-adk-b + 회사 데이터 | 특정 회사의 업무 환경 |

## naia-adk Skills (9 — Individual)

| Skill | Description |
|-------|-------------|
| `review-pass` | 4-stage multi-AI cross-validation review |
| `email` | SMTP email with templates |
| `sms` | SMS/알림톡 |
| `read-doc` | HWP/PDF/DOCX/XLSX text extraction |
| `doc-coauthoring` | Structured document co-authoring |
| `document-generation` | PDF generation (contract/resolution/payroll) |
| `channel-management` | Discord/Slack channel management |
| `web-monitoring` | SEO, uptime, analytics |
| `service-management` | Service monitoring, incident response |

## naia-adk-b Skills (11 — Business, adds on top)

| Skill | Description |
|-------|-------------|
| `payroll` | 급여명세서 PDF + 이메일 발송 |
| `contract` | 근로계약서 (근로기준법) + 디지털 서명 |
| `expense` | 지출결의서 + 영수증 OCR |
| `accounting` | 장부 기록, 월마감, 세무 |
| `crm` | 파일 기반 경량 CRM |
| `client-communication` | 고객 소통 관리 |
| `copyright-reg` | 어문저작권 등록 서류 |
| `patent-draft` | 특허 명세서 초안 |
| `patent-pipeline` | 특허 발굴·평가·출원 |
| `press-release` | 보도자료 작성·발송 |
| `weekly-report` | 주간 업무 결과 |

## {company}-adk (Company Workspace)

`naia init {name}` creates:

```
{name}-adk/
├── .naia/
│   ├── context.yaml      ← 회사 정보
│   ├── config.yaml        ← 런타임 설정
│   ├── skills/            ← 회사 전용 스킬 (필요시)
│   ├── adapters/          ← 이메일, SMS, 서명 설정
│   └── templates/         ← 회사 브랜딩 템플릿
├── .local/                ← 개인 확장 (gitignore)
├── data/                  ← 직원, 고객, 비용 데이터
├── documents/             ← 생성된 문서
├── accounting/            ← 회계 파일
└── hr/                    ← 인사 파일
```

## Real Examples

### nextain-adk (= Luke's workspace)

```
D:\dev\                    ← 이게 곧 nextain-adk
├── .naia/
│   └── context.yaml       ← 넥스테인 회사정보
├── .agents/               ← 개발 워크플로우
├── naia-adk/              ← OSS 개발 (submodule)
├── naia-adk-b/            ← 비즈니스 개발 (submodule)
├── naia-os/               ← 데스크톱 제품 (submodule)
├── home.onmam.com/        ← 온맘 프로젝트 (submodule)
└── ...
```

### onmam-adk (= Onmam team workspace)

```
onmam-adk/
├── .naia/
│   └── context.yaml       ← 온맘 회사정보
├── data/                   ← 온맘 직원/고객 데이터
└── documents/              ← 온맘 문서
```
