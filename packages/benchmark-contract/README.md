# 영구 벤치마크 계약 패키지

`@naia-adk/benchmark-contract`는 모델 성능, `naia-agent` 실행 품질,
`naia-adk` 개발 계약을 서로 섞지 않고 반복 측정하기 위한 공유 스키마와 결정론적
검증기를 제공합니다. 제품 코어에는 특정 모델이나 프로젝트 규칙을 넣지 않습니다.

주요 원칙:

- 예정 과제·필수 지표·필수 조건을 빠짐없이 기록하며 누락은 무효로 처리합니다.
- 실패·재시도·fallback·상향 호출을 비용에서 빼지 않습니다.
- 지시부터 증거까지의 추적, 구현 전 재사용 판단과 동시 작업 예약을 검증합니다.
- 작성자의 셀프 체크를 독립 리뷰로 인정하지 않습니다.
- Windows 검증은 WSL, Bash, 심볼릭 링크 없이 Node로 실행됩니다.

스키마는 과제·실행뿐 아니라 라우팅 정책, 계층별 paired comparison,
비용 필드 상태, 자산·holdout·judge 보정, 전체 추적·재사용 예약,
듀얼 컨텍스트 번역 증거, 독립 리뷰 동결, baseline manifest를 함께 다룹니다.

검증:

```powershell
pnpm --filter @naia-adk/benchmark-contract test
```

정본 계약과 동결 증적은 `.agents/decisions/`와 `.agents/reviews/`에 있으며,
계약 SHA-256은 `e9c49d676a606440029a58e9b8a83ca9eadb8cd1c386c57383f5d358910174b1`입니다.
