# 3회전 크로스리뷰 — Agent Service Builder 설계 v3

당신은 Naia 4-repo 아키텍처 리뷰어. v3 **판정**. 칭찬·요약 금지. 한국어.

## 라운드 이력
- v1: codex+gemini ISSUES_FOUND (CRITICAL 2 / MAJOR 4 / 누락 2)
- v2: M2/M3/M4 양쪽 PASS. codex strict C1/C2/M1/m1 FAIL(="가정으로 표현"). gemini C1~m1 全 PASS. **공통 신규결함 = RAG RetrievalCapable vs MemoryProvider.recall 중복**.
- v3 surgical 교정 (변경이력·§7 참조):
  - RAG: RetrievalCapable 신설 **폐기** → 기존 `MemoryProvider.recall()` 흡수 (manifest `rag.sources` 선언, alpha-memory source-aware)
  - loader: naia-os/business host-side → **naia-agent CLI(=host, A.4 'CLI소유=naia-agent' + direction 'host=CLI')** 로 일관, SB-1 `naia-agent --service`=CLI-host(모순 제거)
  - manifest SoT: "naia-adk docs" → **`naia-adk/docs/service-manifest-schema.md` + naia-adk semver + 호환표**, "비-계약" 가정→단정
  - orchestration: step→history = **기존 D6 turn lifecycle 재사용**(독립 Agent.sendStream 직렬, 신규 물질화 경계 0)
  - F08/F01: §6 G0-1·G0-5 = **실측 완료**(#3·4·5·6 CLOSED·OPEN P0 0건·bin/naia-agent.ts 실존, 사실 명기)

## 검토 대상
- v3: `/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md`

## baseline (위배=critical)
- Part A: `/var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md` (A.1~A.13, F07)
- 매트릭스: `/var/home/luke/alpha-adk/projects/naia-agent/.agents/progress/ref-adoption-matrix.md` (B19/B20/A.5 capability 거버넌스/D44)
- F-rules: `/var/home/luke/alpha-adk/projects/naia-agent/.agents/context/agents-rules.json` (F08 = OPEN P0 시 차단)
- agent-loop D1~D8 / MemoryProvider.recall: `/var/home/luke/alpha-adk/projects/naia-agent/docs/agent-loop-design.md`

## 판정 (각 PASS/FAIL + file:line 근거)
1. **C1 (manifest 제4계약)** — v3 §2가 manifest=naia-adk 데이터파일(비-계약 **단정**) + SoT 경로 고정 + Part A 3계약 불변. strict 로 "제4계약 아님" 입증됐나? 아직 가정 잔존?
2. **C2 (F08 우회)** — v3 §6 G0-1 = P0 실측완료(#3·4·5·6 CLOSED, OPEN P0 0) 사실 명기. F08 통과가 사실로 닫혔나? slice 작성이 F08 비위배인가?
3. **M1 (B20/D1)** — v3 §4-3 = 각 step 독립 Agent.sendStream + D6 turn lifecycle 재사용(신규 경계 0). reducer 부재·D1 보존이 계약으로 닫혔나? gemini v2 누락("step간 history 오염")이 해소됐나?
4. **RAG 중복 (v2 공통 신규결함)** — v3 가 RetrievalCapable 폐기, recall 흡수. MemoryProvider.recall 과 책임 중복이 *제거*됐나? recall 시그니처로 rag.sources 전달이 agent-loop-design recall 계약과 정합하나?
5. **loader 소유권 모순 (codex v2 MAJOR)** — naia-agent CLI=host 일관화로 §2/SB-1 모순 제거됐나? A.4(CLI소유=naia-agent) 정합?
6. **manifest SoT (codex v2 MAJOR)** — 경로/semver/호환규칙 고정으로 소유권 닫혔나?
7. **신규 결함** — v3 surgical 교정이 만든 새 모순/누락 (특히 recall 에 rag.sources 끼우는 게 D6/MemoryProvider 계약 위배 아닌지)

## 출력
```
VERDICT: CLEAN | ISSUES_FOUND
[C1·C2·M1·RAG·loader·manifestSoT 해소]: PASS/FAIL 각 1줄
[CRITICAL]/[MAJOR]/[MINOR]/[누락] (신규/미해소만)
종합: 개발 착수 가능? (가능/조건부/불가 + 핵심 1개)
```
critical=Part A/매트릭스/F-rule 정면위배만. "문서가 단정 안 했다"는 표현 트집이 아니라 *실질 위배*만 critical. Part B/C 보류는 미해결로 잡지 말 것.
