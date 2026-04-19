---
name: read-doc
description: 문서 파일(HWP/HWPX/PDF/DOCX/XLSX/PPTX)의 텍스트를 추출해 컨텍스트에 로드합니다. docs-business/ 폴더의 파일이나 .hwp/.hwpx/.pdf/.docx/.xlsx/.pptx 파일이 언급될 때, 또는 문서 내용을 검토/분석해야 할 때 반드시 사용.
argument-hint: "<file-path-or-glob>"
---

# Read Document

문서 파일의 텍스트를 추출해 분석할 수 있도록 컨텍스트에 로드합니다.

## 지원 형식

| 확장자 | 방법 | 사전 설치 |
|--------|------|----------|
| `.hwp` | hwp5html → XHTML → 텍스트 | `pip install pyhwp` |
| `.hwpx` | PrvText.txt 추출 + XML fallback | 없음 |
| `.pdf` | pdftotext -layout | `sudo dnf install poppler-utils` |
| `.docx` | python-docx | `pip install python-docx` |
| `.xlsx` | openpyxl | `pip install openpyxl` |
| `.pptx` | OOXML `<a:t>` 파싱 | 없음 |
| `.txt` / `.md` | Read 도구 직접 사용 | 없음 |

## 실행 방법

### Step 1: 경로 확인

`$ARGUMENTS`가 없으면 사용법 안내 후 종료:
> "Usage: /read-doc \<file-path\>  (glob 지원: /read-doc /path/*.hwp)"

glob(`*`) 또는 디렉토리인 경우 지원 확장자 파일 목록으로 확장. 알파벳순 정렬.

### Step 2: 사이드카 우선 확인

docs-business HWP/HWPX 파일은 사전 추출된 `.txt` 사이드카가 있을 수 있음:

```bash
SIDECAR="${FILE%.*}.txt"
[ -s "$SIDECAR" ] && cat "$SIDECAR" && exit 0
```

사이드카가 있으면 Read 도구로 직접 읽음 (훨씬 빠름).

### Step 3: 추출 실행

```bash
python .agents/skills/read-doc/scripts/extract_doc.py "$FILE"
```

HWP 파일 5MB 이상이면 5~15초 소요 — 시작 전 사용자에게 안내.

### Step 4: 결과 표시

```
📄 **<파일명>** (<확장자>, <N>자)
경로: <절대경로>
---
<추출된 텍스트>
```

15,000자 초과 시 앞 15,000자만 표시:
> `(... 이하 생략. 전체 ${N}자)`

파일 여러 개면 `---`로 구분, 마지막에:
> `총 N개 파일, M자 처리 완료`

## 에러 처리

| 에러 | 조치 |
|------|------|
| 파일 없음 | 경로 보고 후 종료 |
| 미지원 확장자 | 지원 형식 안내 |
| 도구 미설치 | 설치 명령어 출력 (스크립트가 자동 안내) |
| 빈 결과 | "텍스트를 추출할 수 없습니다 (이미지 전용 문서일 수 있음)" |
