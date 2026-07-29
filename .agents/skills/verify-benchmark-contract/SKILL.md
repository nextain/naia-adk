---
name: verify-benchmark-contract
description: 벤치마크 계약의 스키마·의미 검증, 공급자 영수증, 비용 집계, HMAC 저널, Windows DPAPI 어댑터와 듀얼 컨텍스트를 결정론적으로 검증한다. packages/benchmark-contract 또는 개발 모델 라우팅을 수정한 뒤, Review/Post-test Review 및 커밋 전에 사용한다.
---

# 벤치마크 계약 검증

모델을 호출해 스스로 채점하지 말고, 패키지에 고정된 검증기와 외부 채점 경계를 실행한다.

## 워크플로우

1. 변경 범위를 확인한다.

```powershell
git status --short
git diff --check
```

2. 스키마, 의미 규칙, 이전 기준선, 공급자 어댑터, 개발 세트, 저널과 분석기를 검증한다.

```powershell
pnpm --dir packages/benchmark-contract test
```

3. 엔트리포인트와 듀얼 컨텍스트를 검증한다.

```powershell
pnpm run test:entry-points
pnpm run test:context-translation
```

4. 실제 개발 저널을 근거로 사용할 때만 DPAPI 도우미로 분석기를 실행한다. 평문 키를 출력하거나 직접 파일로 만들지 않는다. 분석기가 계획 바인딩·HMAC 체인·완결 분모를 모두 통과해야 한다.

```powershell
powershell.exe -NoProfile -NonInteractive -File packages/benchmark-contract/scripts/windows-journal-key.ps1 `
  -Action exec -KeyFile .agents/work/benchmark-development/journal-key.dpapi `
  -NodeScript packages/benchmark-contract/src/development-analysis.mjs `
  -NodeArgumentsBase64 <UTF8-JSON-ARRAY-BASE64>
```

5. 공급자 키는 값이 아니라 환경 변수 이름의 존재만 확인한다. `UPSTAGE_KEY`, `OPENROUTER_API_KEY`, `AZURE_DEEPSEEK_*` 값은 로그·영수증·다이제스트에 포함하지 않는다.

## 판정

PASS 조건:

- 패키지 테스트, 엔트리포인트, 번역 배치가 모두 종료 코드 0이다.
- Windows 증거는 Node와 네이티브 PowerShell만 사용하며 WSL, Bash, 심볼릭 링크, Linux VM·컨테이너를 요구하지 않는다.
- 실제 저널 기반 보고서는 복구 가능한 외부 키로 HMAC 체인을 재검증했다.
- 공급자 간 결과는 `model_provider_adapter` 복합 비교로 표시하고 모델 단독 인과를 주장하지 않는다.
- 개발 세트는 운영 승급이나 비용 최적화 완료를 주장하지 않는다.
- 구현자의 셀프 체크는 독립 적대 리뷰로 계산하지 않는다.

FAIL 조건:

- 소비량, 공급자 정체, 캐시, 실패 비용 또는 저널 무결성이 불명인데 성공·0비용으로 처리한다.
- 키 없는 교정 저널을 채택 근거로 사용한다.
- HY3 벤치 결과를 별도 정책 결정 없이 운영 라우팅에 사용한다.
- 원격 모델 성공으로 Windows 네이티브 하네스 통과를 대신한다.

## 관련 파일

| 파일 | 목적 |
|---|---|
| `packages/benchmark-contract/**` | 스키마, 러너, 어댑터, 채점기, 테스트 |
| `.agents/context/development-model-routing.yaml` | AI 정본 라우팅·승급 계약 |
| `.users/context/development-model-routing.md` | 한국어 사용자 미러 |
| `.users/context/en/development-model-routing.md` | 영어 사용자 미러 |

## 예외

- 외부 공급자 키가 없는 상태는 패키지 검증 실패가 아니다. 해당 경로의 실호출과 승급 판단만 보류한다.
- Haiku 세션 한도 뒤 선언된 Luna/Sonnet fallback으로 번역 배치가 통과한 것은 실패가 아니다. fallback 영수증은 보존한다.
- `.agents/work/`의 암호화 키·저널은 생성 증거이며 커밋 대상이 아니다.
