---
name: verify-conflict-markers
description: "Staged 및 추적 파일에서 git conflict marker(<<<<<<<, =======, >>>>>>>)를 탐지합니다. 커밋 전, 빌드 전, PR 전 반드시 실행."
disable-model-invocation: true
---

# Conflict Marker 검증

## 목적

코드에 남아있는 git conflict marker를 탐지하여 빌드 에러와 파싱 오류를 사전에 방지합니다.

## Workflow

### Step 1: Staged 파일 스캔

```bash
git diff --cached --name-only
```

스테이징된 각 파일에 대해:

```bash
git show :"<file>" | grep -n "^<<<<<<<\|^=======\|^>>>>>>>"
```

### Step 2: 전체 워킹 트리 스캔

```bash
git diff --name-only HEAD
```

수정된(미스테이징 포함) 파일에서도 conflict marker가 있는지 확인.

### Step 3: 결과 보고

- **PASS**: conflict marker가 없음
- **FAIL**: marker 발견 시 파일:라인 목록 출력

## Exceptions

- `.gitignore`에 등록된 파일은 검사 제외
- 바이너리 파일은 grep 오류 시 스킵
- 마크다운 파일 내에서 conflict marker를 **설명**하는 코드 블록은 제외 (``` 로 감싸진 블록 내부)

## PASS/FAIL 기준

| 조건 | 결과 |
|------|------|
| 0개 marker 발견 | PASS |
| 1개 이상 marker 발견 | FAIL |
