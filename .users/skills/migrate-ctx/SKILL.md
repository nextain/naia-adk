---
name: migrate-ctx
description: >
  기존 .agents/context/*.yaml 파일을 ctx 섹션 포맷(stable ID + tags + metadata)으로 마이그레이션.
  컨텍스트 유실 방지가 최우선 — content는 기계적 복사, AI 재작성 금지.
  "컨텍스트 파일 분할", "ctx 마이그레이션", "lessons-learned 분할", "context 구조화" 요청 시 반드시 사용.
argument-hint: "[대상 파일 또는 디렉토리]"
---

# migrate-ctx

## 목적

기존 대용량 YAML 컨텍스트 파일을 토픽별 작은 파일로 분할하고, ctx 섹션 포맷(stable ID, tags, related, updated_at)을 추가하여 AI가 필요한 섹션만 정밀하게 로드할 수 있게 한다.

**핵심 원칙**: 컨텍스트 유실 = 절대 금지.
- content 블록은 원본 byte-for-byte 복사 (AI 재작성/요약/paraphrase 금지)
- 메타데이터(id, title, tags, related)만 AI가 생성 가능
- 원본 파일은 검증 5개 체크 모두 통과 + 사용자 승인 후에만 삭제

## 전제조건

- 반드시 `ctx-migration` 브랜치에서 실행 (main 브랜치에서 직접 작업 금지)
- Git checkpoint 커밋이 완료된 상태여야 함

## 섹션 포맷

```yaml
# .agents/context/{topic}.yaml
id: {project}:{topic}              # stable ID, 영문 소문자 + 언더스코어
title: "{섹션 제목}"
tags: [tag1, tag2, tag3]           # 검색 키워드
related: [{project}:{other_id}]    # 연관 섹션 IDs
updated_at: "YYYY-MM-DD"
# 이하 원본 YAML 내용 그대로 (entries, content 등)
```

## 워크플로우

### Step 1 — 분석 (read-only, 사용자 보고)

1. 대상 파일 읽기 (전체)
2. 논리적 섹션 경계 식별 (topic, project, issue_type 등 기준)
3. 사용자에게 보고:
   - 제안하는 분할 파일 목록 (파일명, 항목 수)
   - 각 파일의 예상 ID
   - 원본 파일 총 라인 수 / 분할 후 예상 라인 수
4. **[GATE]** 사용자 확인 대기

### Step 2 — 드라이런 (preview)

1. 실제 파일 작성 없이 변환 결과를 콘솔에 출력
2. 각 분할 파일의 헤더 (id, title, tags, related, updated_at)만 보여줌
3. 원본 entries 수 vs 분할 후 합산 entries 수 비교
4. **[GATE]** 사용자 확인 대기

### Step 3 — 변환 실행 (결정론적)

**content 처리 규칙 (절대 준수):**
```
원본 YAML entries/content → 분할 파일에 verbatim 복사
AI 재작성 금지: 오탈자 수정도 하지 않음 (원본 그대로)
AI 생성 허용: id, title, tags, related, updated_at (메타데이터만)
```

각 분할 파일 작성:
```yaml
# Auto-split from {원본파일명} on YYYY-MM-DD
# ctx-section-format: v1
id: {project}:{topic}
title: "..."
tags: [...]
related: [...]
updated_at: "YYYY-MM-DD"
source: "{원본파일명} (migrated)"

version: 1
entries:
  # 원본 entries 그대로 복사 ↓
  - ...
```

원본 파일은 그대로 유지 (삭제 금지).

### Step 4 — 검증 (자동, 5개 모두 통과 필수)

```bash
# Check 1: ID 유일성
grep -rh "^id:" .agents/context/ | sort | uniq -d
# → 출력 없어야 함

# Check 2: Content diff 검증 (핵심)
# 각 분할 파일의 entries 수 vs 원본 entries 수 확인
# entries 합산이 원본과 일치해야 함
grep -c "  - date:" {분할파일들} | awk -F: '{sum+=$2} END{print sum}'
grep -c "  - date:" {원본파일} | awk -F: '{print $2}'
# → 두 수가 일치해야 함

# Check 3: 교차 참조
# related[] 내 모든 ID가 실제 파일에 존재하는지 확인
# (각 분할 파일의 related 목록을 추출하여 id 목록과 대조)

# Check 4: 검색 smoke test
grep -l "{핵심_키워드}" .agents/context/ | head -3
# → 분할된 파일에서 찾아져야 함

# Check 5: 하네스 발동 확인
# 분할 파일 중 하나를 1자 수정 후 저장 → cascade-check.js 로그 확인
# → "[Harness] You edited .agents/context/..." 메시지 출력돼야 함
# → 수정 되돌림
```

**검증 실패 시**: 분할 파일 삭제, 원본 유지, 실패 항목 보고 후 중단.

**검증 결과 보고 형식:**
```
✅ Check 1: ID 유일성 — {분할파일 수}개 파일, {섹션 수}개 ID, 중복 없음
✅ Check 2: Content diff — 원본 {N}개 항목 = 분할 합산 {N}개 항목
✅ Check 3: 교차 참조 — {K}개 related 링크 모두 유효
✅ Check 4: Smoke test — "{키워드}" → {파일명} 에서 발견
✅ Check 5: 하네스 발동 — cascade-check.js 정상 출력 확인
```

### Step 5 — 사용자 최종 승인 후 원본 삭제

**[GATE]** 5개 체크 결과 사용자에게 보고 후 승인 대기.

승인 후:
1. 원본 파일 삭제
2. `project-index.yaml`의 `on_demand_loading` 섹션 업데이트
3. `.gitignore`에 `.agents/context/.ctx-index.json` 추가 (없으면)
4. AGENTS.md / CLAUDE.md / GEMINI.md에 ctx on_demand_loading 가이드 추가

## Key Files

| 파일 | 용도 |
|------|------|
| `.agents/context/*.yaml` | 분할 대상 원본 파일 |
| `.agents/context/.ctx-index.json` | 자동 생성 인덱스 (gitignore) |
| `.agents/context/project-index.yaml` | on_demand_loading 섹션 추가 대상 |
| `.claude/hooks/ctx-index-rebuild.js` | 파일 수정 시 인덱스 자동 재빌드 훅 |

## 참고

- `agents-rules.json`은 절대 분할 금지 (SoT, 24개 파일이 직접 참조)
- `cascade-check.js`는 수정 금지 (순수 advisory 역할 보존)
- 모든 작업은 `ctx-migration` 브랜치에서만 진행
- 롤백: `git checkout main` (branch 버림)
