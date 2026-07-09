---
name: sync-upstream
description: ADK fork chain의 upstream 동기화. naia-adk(최상위) 이하 모든 fork가 주기적으로 `git merge upstream/main`로 정식 동기화하도록 한다. selective cherry-pick으로 인한 체인 부패(divergence)를 예방. "upstream sync", "fork 동기화", "naia-adk에서 받아와", "sync-upstream" 요청 시 사용. drift(behind/merge-base 낡음) 감지→fetch→merge→버전 스탬프까지.
argument-hint: "[--merge] [--remote URL]"
---

# Upstream 동기화 (Sync Upstream)

## 목적

ADK fork chain의 위생을 유지한다. selective cherry-pick 대신 **정식 `git merge upstream/main`** 로
주기적으로 동기화하여, 3개월치 sync 빚이 쌓여 대형 충돌이 되는 일(체인 부패)을 막는다.

## Fork chain (위→아래)

```
naia-adk            ← 범용/개인 base (최상위, upstream_repo: null)
  └─ naia-business-adk   ← 회사 layer
       └─ nextain-adk     ← 넥스테인 org
            └─ alpha-adk   ← 루크 (넥스테인 직원)
```
`onmam-adk`는 `naia-business-adk`에서 분기. **각 fork는 바로 위 단계에서만 동기화**한다
(skip-hop 금지 — nextain-adk가 naia-adk를 직접 받지 않고 business-adk를 받는 식).

## 버전 / 동기화 SoT

- `VERSION` (루트) — 현재 adk 버전(semver). 동기화 시 upstream의 값으로 맞춰진다.
- `.agents/upstream-sync.yaml` — 동기화 baseline. 각 fork가 자기 `upstream_repo` +
  마지막 동기화 커밋/날짜를 기록. drift 감지의 기준.

## 핵심 스크립트

```bash
# drift 보고만 (변경 없음) — behind 정도, merge-base 낡음, 버전 차이 점검
node .agents/skills/sync-upstream/sync-upstream.js

# 실제 동기화: fetch + merge + 버전 스탬프
node .agents/skills/sync-upstream/sync-upstream.js --merge

# upstream remote가 없으면 declared upstream_repo에서 자동 세팅.
# 강제 지정: --remote https://github.com/nextain/naia-adk.git
```

출력은 ASCII-safe. 스크립트는 `.agents/upstream-sync.yaml`의 `upstream_repo`를 읽어 대상을 정한다.
최상위(naia-adk, `upstream_repo: null`)는 no-op.

## 워크플로우

### Step 1: drift 보고

`sync-upstream.js`(인자 없음)로 현재 위생 상태를 본다:
- `behind` 커밋 수 — 0이면 이미 최신.
- `merge-base` 날짜 — 오래됐으면 동기화 빚.
- `version drift` — local VERSION vs upstream VERSION.

`behind`가 크거나 merge-base가 수주 이상이면 Step 2.

### Step 2: fetch + merge

`--merge`로 실행. 충돌이 없으면 자동으로 버전 스탬프까지 찍힌다.

### Step 3: 충돌 해소 정책 (upstream-structure-first)

충돌이 나면 **upstream(위 단계)의 구조적 개선을 우선 채택**하고, **fork 고유 layer 추가본만 보존**:

| 분류 | 정책 |
|------|------|
| SoT 구조 파일(context lessons/harness/gstack, hooks, settings) | **upstream 것 채택** (신설계가 우선) |
| 진입점 문서(AGENTS/CLAUDE/GEMINI/README) | upstream 내용 + fork 정체성(이름·scope·fork-chain) |
| `.gitignore` | 양쪽 합집합 |
| fork 고유 기능(회사 RBAC·business skills 등) | **보존** (보통 비충돌 신규 파일이라 자동 포함) |

핵심: fork가 가진 차이가 "낡은 구버전"이면 upstream 것으로, "진짜 layer 추가"면 보존.
헷갈리면 `git log`로 그 차이가 selective sync 잔재인지 fork 고유 작업인지 확인.

### Step 4: 버전 스탬프 + push

clean merge면 스크립트가 `VERSION` + `.agents/upstream-sync.yaml`(upstream_commit,
last_synced_at, adk_version)을 갱신. 변경 검토 후 `git push origin main`.

### Step 5: 아래 단계로 연쇄

이 fork를 동기화했으면, **한 단계 아래 fork**가 이제 이 fork를 upstream으로 sync-upstream 한다
(business-adk 완료 → nextain-adk가 business-adk sync → alpha-adk가 nextain-adk sync …).

## 언제 동기화하나

- upstream에 의미 있는 변경(스kill/컨텍스트 추가, hook 개선)이 올라왔을 때
- `behind`가 20+ 커밋 또는 merge-base가 2주+ 낡았을 때
- 정기(예: 월 1회) 위생 점검

## Key Files

| 파일 | 용도 |
|------|------|
| `sync-upstream.js` | drift 보고 + fetch/merge + 버전 스탬프 (node, 외부 의존성 무) |
| `VERSION` | adk 버전(semver) |
| `.agents/upstream-sync.yaml` | 동기화 baseline SoT |

## 참고

- selective cherry-pick은 금지 아니다 — 긴급 단건 반영은 가능. 단, **정기 full merge를 대체하지 않음**.
  cherry-pick만 계속하면 merge-base가 얼어붙어 빚이 쌓인다(이 스킬이 막는 현상).
- skip-hop(한 단계 건너뛰기) 금지: nextain-adk는 naia-adk가 아닌 business-adk에서 받는다.
- node 18+ 필요.
