---
name: press-release
description: 보도자료 작성·기자 조사·개인화 발송·결과 수집·인사이트 도출 전체 워크플로우. "보도자료", "press release", "기자 발송", "PR 배포" 요청 시 사용.
---

# Press Release — 보도자료 배포 워크플로우

## 목적

보도자료 작성부터 기자 발송, 결과 수집, 인사이트 도출까지 풀 사이클 PR 워크플로우.

## 워크플로우

### Phase 1: 준비 (Prepare)

1. **보도자료 확인**: `about.nextain.io/src/content/press/ko/` 에서 원문 확인
2. **이메일 템플릿 생성/수정**: `scripts/press-release/template.html`
3. **제목 설정**: `scripts/press-release/subject.txt`

### Phase 2: 기자 조사 (Research)

1. WebSearch로 최근 1개월 내 유사 주제 기사 검색
2. 기자명, 매체, 이메일, 취재 분야 수집
3. `scripts/press-release/contacts.json`에 3개 그룹으로 분류:
   - `priority`: 주제 직접 관련 기자 (개인 이메일)
   - `general`: 관련 분야 기자 (개인 이메일)
   - `outlet_general`: 매체 대표 메일 (편집부)
4. **이메일 주소 검증**: 기자명과 이메일 ID 일치 여부 확인 (불일치 시 flag)

### Phase 3: 개인화 검증 (Personalize & Review)

1. `node send.js preview` — 전체 수신자 + 개인화 인사 미리보기
2. 개인화 규칙:
   - 기자: `{이름} 기자님께, {note} 취재하고 계신 것으로 파악되어 넥스테인의 AI 에이전트가 개인화하여 보내드리는 보도자료입니다.`
   - 편집부: `{매체} 담당자님께, 보도자료를 보내드립니다.`
   - 연락처 안내 포함
3. **AI 피어 리뷰** (3종 병렬):
   - 기자 UX 관점: 제목, 개인화, 요약, 본문 구조
   - PR 전문가 관점: 형식, 뉴스 가치, CTA, 법적 이슈
   - 기술 관점: SMTP, 이미지, 스팸 필터, 코드 품질
4. 리뷰 결과 반영

### Phase 4: 테스트 발송 (Test)

1. `node send.js test` — luke.yang@nextain.io로 테스트
2. 확인 항목:
   - [ ] 이미지 표시 (로고, 본문 사진)
   - [ ] 개인화 치환 정상
   - [ ] 모바일 렌더링
   - [ ] 정크 메일 분류 여부
   - [ ] SPF/DKIM pass 확인 (메일 헤더 → Authentication-Results)

### Phase 5: 발송 (Send)

- **로컬**: `node send.js send --delay 30`
- **클라우드**: Cloud Run Job `press-release-send` 실행
- **예약**: Cloud Scheduler 설정 (cron + Asia/Seoul timezone)
- 발송 후 Scheduler 즉시 pause하여 중복 방지

### Phase 6: 결과 수집 (Collect)

발송 후 24시간, 72시간, 7일 시점에 확인:

#### 6-1. 발송 결과
```
gcloud logging read "resource.type=cloud_run_job AND resource.labels.job_name=press-release-send" \
  --project project-a8b18af5-b980-43e7-8ec --limit 30 \
  --format="table(timestamp,textPayload)" --freshness=24h
```
- 성공/실패 건수
- 반송(bounce) 이메일 주소 → contacts.json에서 제거 또는 수정

#### 6-2. 반송 메일 확인
- luke.yang@nextain.io 받은편지함에서 "배달되지 않음" 메일 수집
- 반송 원인 분류: 주소 없음 / 메일함 가득 / 스팸 차단
- contacts.json 업데이트 (잘못된 주소 제거, 대체 주소 조사)

#### 6-3. 기사 게재 확인
- WebSearch: `"넥스테인" OR "nextain" site:매체도메인` (발송 후 24h~7일)
- 게재된 기사 링크 수집 → `scripts/press-release/results.json`에 기록:
```json
{
  "campaign": "2026-04-13-onmam-mou",
  "sent": 17, "bounced": 2, "articles": [
    { "outlet": "매체명", "url": "기사URL", "date": "2026-04-14", "journalist": "기자명" }
  ]
}
```

#### 6-4. 자동 회신 분류
- 부재중 자동 회신 → 무시 (발송 성공으로 간주)
- 세일/광고 자동 회신 → 매체 대표 메일의 일반 현상, 무시
- 기자 직접 회신 → 즉시 대응 필요 (luke에게 알림)

### Phase 7: 인사이트 (Insights)

| 지표 | 측정 방법 |
|------|----------|
| 도달률 | (발송 - 반송) / 발송 |
| 게재율 | 게재 기사 수 / 발송 수 |
| 매체별 반응 | 어떤 그룹(priority/general/outlet)이 게재율 높은지 |
| 제목 효과 | 열람 추적 불가 → 게재 여부로 간접 측정 |
| 기자 DB 품질 | 반송률로 측정, 30% 초과 시 DB 재조사 필요 |

인사이트를 `scripts/press-release/results.json`에 누적 → 다음 캠페인에 반영:
- 게재한 기자 → priority로 승격
- 반송된 주소 → 제거 또는 재조사
- 무반응 매체 대표 메일 → 개별 기자 이메일 조사

## Key Files

| 파일 | 용도 |
|------|------|
| `scripts/press-release/send.js` | 로컬 발송 스크립트 |
| `scripts/press-release/send-cloud.js` | Cloud Run API 호출 |
| `scripts/press-release/contacts.json` | 기자 DB |
| `scripts/press-release/template.html` | 이메일 HTML 템플릿 |
| `scripts/press-release/subject.txt` | 제목 |
| `scripts/press-release/results.json` | 캠페인 결과 기록 (발송 후 생성) |
| `scripts/press-release/check-replies.js` | IMAP으로 반송/회신/자동회신 수집 |
| `scripts/press-release/sent-log.json` | 중복 발송 방지 lock (자동 생성) |
| `scripts/press-release/.env` | SMTP/IMAP 인증 (gitignore) |
| `.claude/hooks/email-send-guard.js` | 외부 이메일 발송 차단 하네스 |
| `about.nextain.io/src/content/press/ko/` | 보도자료 원문 |
| `admin.nextain.io/app/api/press-release/send/route.ts` | Cloud Run API 엔드포인트 |

## Cloud Infrastructure

| 리소스 | 이름 | 용도 |
|--------|------|------|
| Cloud Run Job | `press-release-send` | 실제 발송 |
| Cloud Run Job | `press-release-test` | 테스트 발송 |
| Cloud Scheduler | `press-release-MMDD` | 예약 발송 트리거 |
| GCP Project | `project-a8b18af5-b980-43e7-8ec` | Naia-OS 프로젝트 |
| Region | `asia-northeast3` | 서울 |

## 주의사항

- **중복 발송 금지**: 발송 후 Scheduler 즉시 pause
- **새벽 발송 지양**: 08:30~09:30 KST 권장 (기자 이메일 확인 시간)
- **이메일 주소 검증**: 기자명과 이메일 ID 불일치 시 발송 전 확인
- **정크 메일 대응**: 첫 발송 시 도메인 평판 부족으로 정크 분류 가능. about.nextain.io 링크 포함으로 도메인 신뢰도 구축
- **수신거부**: 템플릿 하단에 수신거부 링크 필수 (정보통신망법)
- **기독교 매체**: 온맘닷컴 보도자료의 경우 의도적 제외 (luke 결정, 2026-04-13)

## 레슨 런 (2026-04-13 첫 캠페인)

| 항목 | 내용 |
|------|------|
| 발송 시간 | 새벽 2시 발송됨 (Scheduler 권한 부여 후 즉시 실행). 08:55 예약이었으나 미달 |
| 반송 2건 | jinwook@g-enews.com, parkhoon@enetnews.co.kr — AI 검색으로 수집한 이메일의 정확도 한계 |
| 정크 분류 | luke 메일함에서 정크 분류됨. 신규 도메인 + 새벽 발송 + HTML 메일 조합 |
| CID 이미지 | Cloud Run에서는 CID 첨부 불가 → URL 참조로 전환 필요 (about.nextain.io CDN) |
| Scheduler 주의 | 권한 부여 후 즉시 재시도됨 → Job 생성과 Scheduler 생성을 분리하고, Scheduler는 최종 확인 후 enable |
| 중복 발송 3회 | Scheduler 2회 + dedup 테스트를 실 데이터로 실행하여 1회 추가. 전원 3통 수신 |
| 하네스 추가 | email-send-guard.js로 외부 발송 명령 차단. `--test-only` 플래그로 테스트 시 전원 luke로 리다이렉트 |
| 테스트 원칙 | **절대 실 데이터(기자 리스트)로 테스트 금지.** `test` 명령 또는 `--test-only` 플래그만 사용 |
