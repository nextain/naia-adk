---
name: doc-notes
description: 작업공간 문서에 달린 메모를 확인하고 처리합니다. "메모 처리해", "메모 확인해", "문서 메모 봐줘" 요청 시 반드시 사용.
---

# doc-notes

## 목적

작업공간 대시보드 문서에서 사용자가 남긴 메모를 확인하고, 문서 수정 및 답변 등록을 거쳐 메모를 해결(resolve)하거나 질문 답변(reply)을 남깁니다.
메모는 작업공간 로컬의 `<작업공간 루트>/.agents/work/doc-notes/<id>.json`에 저장되며 저장소 커밋 대상이 아닙니다.

## 명령 도구

`node scripts/doc-notes.mjs` 스크립트를 사용합니다. (공통 인자 `--root <작업공간 루트>` 지원)

### 1. 열린 메모 목록 조회
```bash
node scripts/doc-notes.mjs list --open
```
전체 메모 목록을 조회하려면 `--open` 없이 `node scripts/doc-notes.mjs list`를 실행합니다.

### 2. 메모 상세 확인
```bash
node scripts/doc-notes.mjs show <id>
```
메모 대상 문서 경로(`source:path`), 인용 문구(`quote`), 본문(`body`), 기존 답변(`reply`) 등을 확인합니다.

### 3. 모호한 내용 질문 (열어 둔 채 답변만 등록)
```bash
node scripts/doc-notes.mjs reply <id> --reply "질문 내용..."
```
수정 방향이 모호하거나 확인이 필요한 경우, `reply`로 질문을 남기고 상태는 열림(`open`)으로 유지합니다.

### 4. 메모 해결 (수정 완료 후 사람 말로 답변)
```bash
node scripts/doc-notes.mjs resolve <id> --reply "무엇을 어떻게 바꿨는지 사람 말로 설명"
```
대상 문서를 지시대로 수정한 후, 변경 내역을 사람이 읽기 편하게 설명하여 해결 상태(`resolved`)로 완료합니다.

## 처리 절차 (AI 워크플로우)

1. **열린 메모 목록 확인**: `node scripts/doc-notes.mjs list --open` 명령으로 열린 메모들을 파악합니다.
2. **대상 문서 검토**: 메모마다 적힌 대상 문서(`source:path`)와 인용 구절, 수정 요청 내용을 확인합니다.
3. **수정 또는 질문**:
   - 수정 요청이 명확한 경우: 문서를 수정 방향대로 수정하고 `resolve <id> --reply "..."`로 처리 완료를 기록합니다.
   - 수정 요청이 모호한 경우: `reply <id> --reply "..."`로 명확한 질문을 남기고 상태를 열린 채로 유지합니다.
4. **보고**: 커밋하지 않고, 수정한 문서 및 답변을 남긴 메모 목록을 대화에서 사용자에게 보고합니다.
