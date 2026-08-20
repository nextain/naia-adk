---
name: verify-i18n
description: "naia-agent IPC 메시지와 REPL 출력에 i18n 키가 올바르게 사용되는지 확인합니다. 신규 IPC 핸들러나 사용자 메시지 추가 후 반드시 실행."
disable-model-invocation: true
---

# i18n 검증

## 목적

사용자 대면 메시지(에러, 안내, REPL 출력)가 `t()` 함수를 통해 i18n 키를 사용하는지 확인하고, 하드코딩된 문자열을 탐지합니다.

## Workflow

### Step 1: i18n 키 존재 확인

`packages/runtime/src/i18n/index.ts`의 모든 로케일(en, ko, ja, ...)에서 동일한 키가 존재하는지 확인.

```bash
# en.ts에 있는 키가 ko.ts에도 있는지
diff <(grep -oP '"[^"]+"\s*:' en.ts | sort) <(grep -oP '"[^"]+"\s*:' ko.ts | sort)
```

### Step 2: 하드코딩 문자열 탐지

IPC 응답과 REPL 출력에서 `t()` 없이 직접 문자열을 사용하는 경우 탐지:

```bash
# bin/naia-agent.ts에서 t() 없이 한국어/일본어 문자열 사용 탐지
grep -n '[ㄱ-ㅎㅏ-ㅣ가-힣]' bin/naia-agent.ts | grep -v 't(' | grep -v '\/\/' | grep -v '\/\*'
```

### Step 3: 결과 보고

- **PASS**: 모든 로케일에 동일한 키 세트, 하드코딩 문자열 없음
- **FAIL**: 누락된 키 또는 하드코딩 문자열 발견

## Exceptions

- 주석 내의 비영어 문자열은 검사 제외
- `console.error` / `console.log` 디버그 로그는 검사 제외 (사용자 대면 아님)
- persona 프롬프트(시스템 프롬프트 내 텍스트)는 의도적이므로 제외

## PASS/FAIL 기준

| 조건 | 결과 |
|------|------|
| 모든 로케일 키 일치, 하드코딩 없음 | PASS |
| 누락 키 또는 하드코딩 발견 | FAIL |
