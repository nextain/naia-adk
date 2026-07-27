<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# 용어·의사소통 가이드 (Terminology & Communication)

> SoT: `.agents/context/terminology.yaml` — 본 문서는 사람이 읽을 수 있는 미러.

## 핵심 원칙

**우리만의 신조어·합성어를 만들지 않는다.** 일반인이 알아들을 수 있는 용어를
default 로 쓰고, 학계용어와 약자는 첫 등장 시 한국어 풀이 + 괄호로 원문 표기를
동반한다.

### 왜

1. 우리 신조어가 본문에 가득하면 사용자 본인도 못 알아본다 (2026-05-28 B2B 미팅 사고).
2. 학계용어를 풀이 없이 쓰면 일반 청중은 부담스러워한다.
3. 표준 용어와 신조어가 섞이면 신뢰성이 떨어진다.
4. 컨텍스트는 미래의 AI / 사람 모두에게 읽힌다 — "지금 우리"만 아는 단어는 빠르게 무용해진다.

## 적용 범위

- 모든 문서 (`docs/`, README, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.users/` 미러)
- 코드 주석 (인라인 + 모듈 docstring)
- JSON / YAML 안의 자연어 텍스트 (description, why, notes)
- PR / Issue 본문 / 커밋 메시지의 자연어 부분
- 메모리 entry / `.agents/progress` / `.agents/reviews`
- 외부 발표·슬라이드·대외 카피

## 면제

- 코드 식별자 (변수 / 함수 / 클래스 / 파일명 / 모듈명) — 영문 그대로 OK
- JSON / YAML key — 스키마 안정성 위해 영문 그대로 OK
- GitHub URL / PR 번호 / 커밋 SHA — 변환 불가

## 3종 분류

### 1. 표준 용어 / 제품명 → 그대로 사용

업계 표준 약어:
> AI / LLM / RAG / API / SDK / CLI / STT / TTS / VAD / E2E / MoE / RBAC / CRM /
> SQLite / ICLR / LongMemEval / KsponSpeech / KEMDy20

제품명:
> Claude / Gemini / Codex / ollama / vLLM /
> mem0 /
> naia-adk / naia-agent / naia-memory / naia-os / naia-cognitive (브랜드명)

컴공 일반 용어:
> 도메인 / 모듈 / 백엔드 / 런타임 / 게이트웨이 / 프리셋 / 폴백 / 카탈로그 /
> 프로세스 / 스레드 / 컨테이너 / 컨피그 / 캐시 / 큐

**⚠️ 예외 — `harness`**: 외부 표면(발표 / 슬라이드 / 대외 README)에 사용 금지.
한국어 청중에게 "하네스"는 "안전 끈"으로 받아들여진다. → "벤치마크" / "평가 체계" / "측정 도구"로 교체.
내부 코드 / 메모리 / `.agents/` 안에서는 harness 그대로 OK.

### 2. 학계용어·측정 약어 → 한국어 풀이 + 괄호로 원문

첫 등장 시: `한국어 풀이 (원문 또는 약어[, 출처])`. 두 번째부터는 한국어 풀이 또는 약어 단독 OK.

예시:
- 예측적 동기화 (Predictive Entrainment, Keller & Appel 2010)
- 세계 모델 (World Model, 얀 르쿤 2022)
- 음정 곡선 (F0 contour)
- 개방 루프 / 폐쇄 루프 (open-loop / closed-loop)
- 글자 오류율 (CER)
- 단어 오류율 (WER)
- 주관 청취 점수 (MOS, 1-5)
- 첫 응답까지 시간 (TTFB)
- 동기화 어긋남 (sync drift)

### 3. 우리만의 합성어·신조어 → 교체 필수

발견 즉시 평이한 한국어 또는 표준 용어로 교체.

| 우리 신조어 | 교체 |
|---|---|
| 4-CLI judge ensemble | 외부 AI 4종 교차 검증 |
| skills overlay | 업종별 기능 모듈 |
| vertical preset | 업종 사전 설정 |
| ref_audio hotswap | 음성 즉시 교체 |
| score memory (본문) | 곡 기억 모듈 |
| emotion vec (본문) | 감정 벡터 |
| spectrum switch (본문) | 말↔노래 전환 |
| mismatch DSP (본문) | 음정 차이 보정 |

> 참고: 본문 prose 에서만 교체. `score_memory_poc.py` 같은 파일·식별자, JSON key `emotion_vec` 는 그대로 OK.

## 판별 게이트

- 사용자 본인이 처음 보고 갸우뚱하면 그게 신조어 신호 → 즉시 교체.
- 컴공 교과서 / AI 업계 표준 문서·논문에 그대로 나오면 표준. 아니면 신조어.
- Google 검색에 한 줄 안 보이면 신조어 후보 — 풀이 또는 교체.
- 브랜드명 (`naia-*` 시리즈) 은 게이트 면제. 단 첫 등장 시 "음성 인지 모듈 (naia-cognitive)" 식 한국어 풀이 권장.

## 개발 작업 단위

| 용어 | 정의 |
|---|---|
| Issue | 독립적으로 계획·개발·검증·병합할 수 있는 개발 전달 단위 |
| UC (Use Case) | 행위자가 시스템을 사용해 달성하려는 목표와 관찰 가능한 결과 |
| FE (Feature) | 하나 이상의 UC에서 재사용될 수 있는 코드 수준 기능 단위 |
| UCT (Use Case Test) | UC의 사용자 여정과 관찰 가능한 결과를 검증하는 테스트 |
| FT (Feature Test) | FE의 코드 계약, 경계값과 실패 처리를 검증하는 테스트 |

`FE`는 버튼·화면·클릭 단계가 아니며 프론트엔드(Front-end)의 약자도 아니다.
UC와 FE는 다대다 관계이고 기본 추적 구조는 `Issue → UC ↔ FE → UCT/FT`다.

## 검토 시점

- 개발 프로세스 phase 7 (Review) 와 phase 9 (Post-test Review) 에서 본 가이드 통과 확인.
- 외부 표면 (블로그 / 슬라이드 / 대외 README) commit 전 사용자 본인 1회 통독.
- PR 의 markdown / docstring / 주석 안 신조어 발견 시 즉시 교체 제안.

## 관련

- `.agents/context/writing-style.json` (K-Startup SNS persona — 어조 정책, 별 SoT)
- `.agents/context/contributing.yaml` (커밋·이슈 규칙)
- 메모리 [[feedback_neologism_no_external_exposure]] (사용자 본인 사고 사례)
- 메모리 [[feedback_copy_tone_show_dont_tell]] (대외 카피 톤)

## 용어 정의 (definitions)

> **정책이 "어떻게 쓰나"라면, 정의는 "무슨 뜻인가".** 정의가 없으면 사람도 AI 도 추측하고,
> 추측이 코드가 되면 드리프트다.
>
> 사고 실례 — 2026-07-13: AI 가 `FE` 를 "Frontend" 로 오독해 엉뚱한 계약을 작성했다.
> (그 전에 UC/FE 를 논의했으나 "너무 길어서" 사전에 못 들어간 것이 원인.)

**규칙**

- 여기 없는 약어는 문서·이슈·커밋에 쓰지 않는다. 새 약어는 **먼저 여기 추가**한다.
- 정의 없는 약어를 만난 AI 는 **추측하지 말고 되묻는다** (되묻기 = 1급 행위).
- 용어를 바꾸면 코드·문서보다 **이 사전이 먼저** 바뀐다.

### 개발 방법 (계약 체인)

**계약 → UC → UC 테스트 → FE → FE 테스트 → 구현 → 검증**

| 용어 | 뜻 | 아닌 것 |
|------|-----|--------|
| **계약** (contract) | 개발 전에 못 박는 규칙 문서. 일탈은 게이트(마커)로만 연다. | |
| **UC** (Use Case, 유저 시나리오) | **무엇을 원하는가.** 페이지 + 시나리오(행동 → 기대 결과). 개발 착수의 입장권. | 설계도·구현안이 아니다 |
| **UC 테스트** (유저 시나리오 테스트) | UC 시나리오를 실제로 밟아 기대 결과가 나오는지 확인. **완료 판정의 실행.** | |
| **FE** (FEature, 기능) | **UC 를 이루기 위해 무엇을 만들 것인가**의 기능 명세. | ⚠ **Frontend 가 아니다.** 프론트엔드는 "프론트엔드"로 풀어 쓴다 |
| **FE 테스트** (기능 테스트) | FE(기능)가 명세대로 동작하는지 검증. | |
| **드리프트** (drift) | 소스(git)와 실제(서버·운영)가 어긋난 상태. 반복 사고의 공통 뿌리. | |

프로젝트 고유 도메인 용어(예: onmam 의 포털·홈피·lynx)는 각 프로젝트의
`.agents/context/glossary.md` 에 둔다. 이 문서는 **전 포크 공통 방법론 용어**만 담는다.
