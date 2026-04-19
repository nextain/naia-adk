---
name: weekly-report
description: 주간 업무 결과를 git 커밋과 작업 로그에서 수집해 작성합니다. "주간 업무 결과", "결과 작성", "이번 주 뭐 했는지" 등 주간 보고 요청 시 사용.
argument-hint: "[YYYYMMDD-YYYYMMDD | 이번주 | 지난주]"
---

# 주간 업무 결과 작성

## 목적

이번 주(또는 지정 기간) 작업 내용을 git 커밋과 작업 로그에서 수집해 주간 보고 형식으로 작성합니다.

## 워크플로우

### Step 1: 날짜 범위 결정

`$ARGUMENTS`가 없으면 현재 주 월~일(KST)을 기본값으로 사용합니다.

```bash
# 이번 주 월요일
date -d "last monday" +%Y-%m-%d 2>/dev/null || date -v-monday +%Y-%m-%d
```

### Step 2: 커밋 수집

각 로컬 프로젝트에서 해당 기간 커밋을 수집합니다:

```bash
for dir in naia-os naia.nextain.io about.nextain.io aiedu.nextain.io admin.nextain.io project-any-llm cafelua.com; do
  echo "=== $dir ==="
  git -C /var/home/luke/dev/$dir log --oneline --since="SINCE" --until="UNTIL" 2>/dev/null
done
```

루트 워크스페이스도 확인합니다:

```bash
git -C /var/home/luke/dev log --oneline --since="SINCE" --until="UNTIL"
```

### Step 3: 작업 로그 확인

`docs-work-logs/luke/03.done/`에서 해당 기간 파일을 찾습니다:

```bash
find /var/home/luke/dev/docs-work-logs/luke/03.done -name "*.md" \
  -newermt "SINCE" 2>/dev/null | sort
```

각 파일의 날짜·프로젝트·유형·완료 내용을 읽어 참고합니다.

### Step 4: 분류 및 작성

수집된 커밋과 작업 로그를 아래 형식으로 작성합니다:

```markdown
# 결과

- [분류] 작업명 (MD)
    - 레파지토리 : repo-name
    - **MM/DD~MM/DD 완료한 내용 요약**
```

MD(Man-Day)는 커밋 수와 복잡도를 기준으로 추정합니다.

## 분류

| 분류 | 해당 프로젝트 |
|------|-------------|
| [제품 개발] | naia-os, naia.nextain.io, aiedu.nextain.io, admin.nextain.io |
| [오픈소스] | project-any-llm, about.nextain.io |
| [인프라] | CI/CD, titanoboa, ISO 빌드, 서버 설정 |
| [리서치] | R&D, 참조 프로젝트 분석 |
| [사업/문서] | docs-business, docs-nextain |
| [개인] | cafelua.com |
| [기타] | 위에 해당하지 않는 것 |

## Key Files

| 파일 | 용도 |
|------|------|
| `docs-work-logs/luke/03.done/` | 완료된 작업 로그 |
| `docs-work-logs/luke/02.doing/` | 진행 중 작업 (참고용) |

## 참고

- 커밋 없이 작업 로그만 있는 경우도 결과에 포함합니다.
- 같은 기능의 여러 커밋은 하나로 묶어 작성합니다.
- 작업 로그 파일명 규칙: `YYYYMMDD-NN-주제.md`
