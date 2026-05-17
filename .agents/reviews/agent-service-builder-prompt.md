# 크로스 리뷰 요청 — Agent Service Builder 아키텍처 설계 (DRAFT v1)

당신은 nextain Naia 4-repo 생태계의 아키텍처 리뷰어입니다. 아래 설계 문서를
**판정**하세요. 칭찬·요약 금지. 결함·모순·누락만. 한국어로.

## 검토 대상 (반드시 읽을 것)
- 설계: `/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md`

## baseline (수정 불가 — 위배 시 critical)
- 4-repo Part A: `/var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md` (특히 §A.1~A.13. F07 = Part A 수정 금지)
- naia-agent 매트릭스: `/var/home/luke/alpha-adk/projects/naia-agent/.agents/progress/ref-adoption-matrix.md` (특히 B19 LangChain core 거부 / B20 LangGraph StateGraph reducer 거부 / D44 Vercel AI SDK / R5 LOCKED)
- naia-agent F-rules: `/var/home/luke/alpha-adk/projects/naia-agent/.agents/context/agents-rules.json` (F01 스켈레톤 게이트 / F06 D1~D8 / F07 Part A / F08 OPEN P0)
- #31 진입점: `/var/home/luke/alpha-adk/projects/naia-agent/.agents/progress/issue-draft-agent-eval-framework.md`

## 공격 포인트 (각각 PASS/FAIL + 근거)
1. **Part A.3 불변식** — 설계의 RAGProvider/OrchestrationPolicy/service-manifest 신규 계약이 zero-runtime-dep + interface-not-dependency + 계약↔구현 의존방향(A.3)을 깨지 않는가? naia-agent 가 alpha-memory/naia-adk 를 import 하게 되는 경로가 숨어있지 않은가?
2. **매트릭스 B19/B20 정면충돌** — §3 LangGraph 해소안 A(자체 OrchestrationPolicy + 경량 stream-first DAG executor)가 *정말* B20(StateGraph reducer ↔ D1 stream-first 충돌)을 회피하는가, 아니면 이름만 바꾼 동일 위배인가? §D 신규로 정당화 가능한가?
3. **레포 경계 모순** — 축1(런타임 의존)/축2(fork chain) 직교 모델이 자기모순 없는가? service manifest 스키마 SoT=naia-adk vs 런타임 계약 SoT=naia-agent 의 소유권 경계가 A.6 와 충돌하지 않는가? Fork chain 4단계 정정이 A.11(공개계약 canonical)과 정합하는가?
4. **개인/비즈니스 경계** — naia-business-adk "구현만, 계약 미수정"(A.11) 이 RBAC/SDLC/멀티테넌시 governance 를 정말 계약 수정 없이 얹을 수 있는가? 개인 layer 자족성(외부 데모 = 개인 layer 동작) 주장이 현실적인가?
5. **누락** — Part A 에 있어야 하는데 설계가 회피한 원칙/소유권/경계? observability emit 의무(A.5/A.11), ErrorEvent 계약, security/audit 소유(A.6), regression gate(A.11) 가 빌더 layer 에 어떻게 적용되는지 누락 아닌가?
6. **외부 데모 MVP 현실성** — Phase1 SB-1~SB-4 (manifest→RAG+memory+persona+qwen3.6-27b e2e+평가) 가 R5 LOCKED + F01/F08 게이트 상태에서 슬라이스 순서·의존이 실행 가능한가? 비현실적 낙관 없는가?
7. **karpathy 위배** — 설계가 요청 안 된 유연성/추상화를 넣었는가(Simplicity First)? 가정이 불명확한데 침묵한 곳?

## 출력 형식
```
VERDICT: CLEAN | ISSUES_FOUND
[CRITICAL] <항목>: <근거 파일:섹션> — <왜 baseline 위배인지>
[MAJOR] ...
[MINOR] ...
[누락] ...
종합 1문단: 이 설계로 개발 착수해도 되는가 (조건부 가능/불가 + 핵심 1~2개)
```
critical = Part A/매트릭스/F-rule 정면 위배. 그것만 엄격히. Part B/C(구현중 결정 보류)를 "미해결"로 잡지 말 것.
