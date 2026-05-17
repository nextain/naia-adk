# 재크로스리뷰 — Agent Service Builder 설계 v2 (1회전 ISSUES_FOUND 교정본)

당신은 nextain Naia 4-repo 아키텍처 리뷰어. v2 를 **판정**. 칭찬·요약 금지.
결함·모순·누락만. 한국어. v1 라운드에서 아래가 지적됨 — **각 해소 여부를
엄격 검증** + 신규 결함.

## v1 지적 (해소 검증 대상)
- **C1(CRITICAL)** service.manifest "제4 계약" — Part A 3-계약(types/protocol/skill-spec)+capability=agent-types 위배
- **C2(CRITICAL)** F08(OPEN P0 시 R1 plan 차단)/#31 §D·sub-issue gate 우회
- **M1** LangGraph 해소안이 "이름만 바꾼 graph" — B20(reducer) vs D1(stream-first) 미정의
- **M2** Observability(A.5 Event emit)/ErrorEvent(A.11) builder layer 누락
- **M3** canonical/License 소유권 모순 (A.11 공개4repo만 canonical / A.6 License 원문)
- **M4** business governance 위치 (manifest 안=스키마확장 / 밖=portable 깨짐)
- **m1** karpathy: 추상화 선행, 미검증 가정 축으로 사용

## 검토 대상
- 설계 v2: `/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md` (§0 에 v1→v2 교정표)

## baseline (위배 시 critical, 수정 불가)
- 4-repo Part A: `/var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md` (A.1~A.13, F07)
- naia-agent 매트릭스: `/var/home/luke/alpha-adk/projects/naia-agent/.agents/progress/ref-adoption-matrix.md` (B19/B20/D44/§A capability 거버넌스 A.5)
- F-rules: `/var/home/luke/alpha-adk/projects/naia-agent/.agents/context/agents-rules.json` (F01/F06/F07/F08)
- agent-loop D1~D8: `/var/home/luke/alpha-adk/projects/naia-agent/docs/agent-loop-design.md`
- naia-business-adk README: `/var/home/luke/alpha-adk/projects/naia-business-adk/README.md`

## 판정 항목 (각 PASS/FAIL + 근거 file:line)
1. **C1 해소?** §2 "신규 최상위 계약 0개" + manifest=naia-adk workspace 파일포맷(A.6) + RAG=RetrievalCapable(agent-types additive, A.5 거버넌스) — 이게 정말 "제4 계약" 회피인가? agent-types additive PR 이 A.5 capability 거버넌스로 정당한가? loader=host-side 가 A.3 의존방향 안 깨나?
2. **C2 해소?** §6 Phase0 "G0-1 OPEN P0 실측·열려있으면 slice 차단(F08)" + "G0-4 §D PR+sub-issue" + "G0-1·4·5 미충족=Phase1 금지" — baseline gate 비우회 충분한가?
3. **M1 해소?** §4 1~6 (step=AsyncGenerator yield* 위임 / reducer 없음 / history append-only=D준수 / 1차 직렬만 / abort 재사용) — 이게 B20 reducer 부재 + D1 보존을 *구체 계약*으로 증명하나? 숨은 reducer/배치 위험 남았나?
4. **M2 해소?** §5 Event emit 지점·ErrorEvent shape·audit·regression — A.5/A.11 충분 적용인가?
5. **M3 해소?** §1.3 A.11 원문 준수("공개4repo 계약만 canonical, README=운영모델 아님 계약 canonical 아님") + A.6 License 원문 인용 + 개인 layer License 부재(bypass 아님) — 소유권 모순 해소됐나?
6. **M4 해소?** §3 governance=operate layer(naia-business-adk host 주입, manifest 미확장) — portable 보존 + A.11 계약미수정 둘 다 성립하나?
7. **m1 해소?** §6 MVP=SB-1~3 축소(orchestration SB-4 조건부) — karpathy Simplicity 충족하나? 남은 미검증 가정(§7)이 축으로 쓰이나?
8. **신규 결함** — v2 가 새로 만든 모순/누락 (특히 RAG=capability vs MemoryProvider 중복, manifest 비-계약인데 SB-1 에서 스키마 정의하는 위치 정합)

## 출력
```
VERDICT: CLEAN | ISSUES_FOUND
[C1~m1 해소]: PASS/FAIL 각 1줄 근거
[CRITICAL]/[MAJOR]/[MINOR]/[누락] (신규/미해소)
종합 1문단: 개발 착수 가능? (가능/조건부/불가 + 핵심)
```
critical=Part A/매트릭스/F-rule 정면위배만. Part B/C 보류를 미해결로 잡지 말 것.
