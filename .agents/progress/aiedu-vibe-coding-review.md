# aiedu 바이브코딩 커리큘럼 현황 + ref-cc 보강 분석

## 현황 요약

### Part 1: 원리 (9 lessons) — ✅ 완성, 운영 중
LLM 원리 → 컨텍스트 윈도우 → 할루시네이션 → 세션 → 에이전트 루프 → 프롬프트 엔지니어링 → 코딩 도구 → 하네스 → 도구 비교

### Part 2: 실전 (6+ lessons) — ⏳ 설계 완료, 구현 대기
Git, Task 분해, 실행/반복, 검증/테스트, 디버깅, 보안
- **블로커**: #58 (terminal lesson-specific modes), #59 (AI 교사 패널)

### Part 3: 심화 (2 lessons) — 📋 컨셉만
판단력, Context Engineering

### 인프라 이슈 (런칭 블로커)
- **#53**: exercise.md UI 표시 불가 (운동문제가 보이지 않음)
- **#54**: 레슨 전환 시 터미널 세션 미초기화
- **#52**: B2C 구매 경로 커리큘럼 매핑 오류

---

## ref-cc 기반 보강 분석

### 결론: Option C — 기존 보강 + 별도 커리큘럼 병행

### A. 기존 바이브코딩에 추가할 모듈 (Part 2/3 보강)

| 모듈 | 내용 | ref-cc 소스 | 난이도 |
|------|------|-------------|--------|
| Tool 설계 패턴 | buildTool(), 6속성, fail-closed | Tool.ts | 중급 |
| 장기 대화 유지 | 토큰 카운팅, 임계치, 컴팩션 기초 | services/compact/ | 중급 |
| 태스크 기반 개발 | 상태 머신, ID 생성, 진행 추적 | Task.ts | 중급 |
| 확장 가능 시스템 | 이벤트 훅, 28개 이벤트, 조합 | hooks/ | 중급-고급 |

### B. 별도 커리큘럼: Context Engineering (#23)

기존 이슈 #23이 이미 있음. ref-cc 분석이 이 커리큘럼의 85%+ 소스.

10주 과정:
1. Tool 추상화 마스터리
2. Context Window 관리
3. Task 라이프사이클
4. Hook 시스템
5. Agent Coordination
6. Memory 시스템
7. 사례 비교: Claude Code vs Naia OS

### C. 판단 기준

- Part 1은 **완성, 건드릴 필요 없음**
- Part 2에 ref-cc 모듈 2-3개 자연스럽게 추가 가능 (Tool 패턴, 태스크, 장기 대화)
- Part 3의 "Context Engineering" → #23 별도 커리큘럼으로 확장
- **바이브코딩 런칭에는 Part 2 구현이 급함** (#58, #59 해결 필요)

---

## 런칭 우선순위

### 즉시 (바이브코딩 런칭 블로커)
1. #53 Exercise UI — 운동문제 표시
2. #54 터미널 세션 초기화
3. #58 Terminal lesson-specific modes
4. #59 AI 교사 패널

### 단기 (Part 2 콘텐츠)
- Lesson 10-15 구현 (설계는 완료)
- ref-cc 기반 모듈 2-3개 추가

### 중기 (별도 커리큘럼)
- #23 Context Engineering 과정 설계 + 구현

---

## 전문가 패널 필요 여부

**기존 바이브코딩 보강**: 패널 불필요 — 이미 설계(v4 final)가 검증됨. ref-cc 모듈 추가는 기존 페다고지 프레임워크 안에서 가능.

**Context Engineering 별도 과정**: 패널 추천 — 새 커리큘럼이므로 타겟 청중(AI 개발자/기여자) 검증 필요. 다만 런칭 급한 상황에서 후순위.
