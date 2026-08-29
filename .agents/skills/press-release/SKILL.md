---
name: press-release
description: 보도자료 작성·기자 조사·개인화 발송·결과 수집·인사이트 도출 전체 워크플로우. "보도자료", "press release", "기자 발송", "PR 배포" 요청 시 사용.
---

# Press Release — 보도자료 배포 워크플로우

## 목적

보도자료 작성부터 기자 발송, 결과 수집, 인사이트 도출까지 풀 사이클 PR 워크플로우.

## 워크플로우

### Phase 1: 준비 (Prepare)

1. **보도자료 확인**: 조직의 보도자료 원문 보관 위치에서 원문 확인 (경로는 조직마다 다르다)
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
   - 기자: `{이름} 기자님께, {note} 취재하고 계신 것으로 파악되어 {SENDER_NAME}에서 개인화하여 보내드리는 보도자료입니다.`
   - 편집부: `{매체} 담당자님께, 보도자료를 보내드립니다.`
   - 연락처 안내 포함
3. **AI 피어 리뷰** (3종 병렬):
   - 기자 UX 관점: 제목, 개인화, 요약, 본문 구조
   - PR 전문가 관점: 형식, 뉴스 가치, CTA, 법적 이슈
   - 기술 관점: SMTP, 이미지, 스팸 필터, 코드 품질
4. 리뷰 결과 반영

### Phase 4: 테스트 발송 (Test)

1. `node send.js test` — `TEST_RECIPIENT`(미지정 시 `SMTP_USER`)로 테스트
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
- 발신 계정 받은편지함에서 "배달되지 않음" 메일 수집
- 반송 원인 분류: 주소 없음 / 메일함 가득 / 스팸 차단
- contacts.json 업데이트 (잘못된 주소 제거, 대체 주소 조사)

#### 6-3. 기사 게재 확인
- WebSearch: `"{조직명}" site:매체도메인` (발송 후 24h~7일)
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

## 설정

이 스킬은 조직 고유 값을 코드에 담지 않는다. `.env`(gitignore) 또는 환경변수로 준다.

| 변수 | 쓰임 | 미지정 시 |
|------|------|-----------|
| `SMTP_HOST` / `SMTP_PORT` | 발송 서버 | `smtp.gmail.com` / `587` |
| `SMTP_USER` / `SMTP_PASS` | 발송 계정 | 없으면 발송 불가 |
| `SENDER_NAME` | From 표시 이름. 인사말에도 쓰인다 | `Press Office` |
| `SENDER_EMAIL` | From 주소 | `SMTP_USER` |
| `CONTACT_EMAIL` | 본문 인사말의 회신처 | `SENDER_EMAIL`. 둘 다 없으면 회신처 문구가 빠진다 |
| `TEST_RECIPIENT` | `send.js test` 수신자 | `SMTP_USER` |
| `CLOUD_URL` | 클라우드 발송 엔드포인트 | 없으면 클라우드 발송을 거부하고 이유를 알린다 |
| `PRESS_SECRET` | 그 엔드포인트 인증값 | 빈 값 |

`template.html` 과 `subject.txt` 는 자리표시자로 배포된다. 발송 전에 자기 내용으로
바꾼다. `template.html` 의 `{{name}} 기자님께,` 와 `{{greeting}}` 두 토큰은 `send.js`
가 치환하므로 지우지 않는다.

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
| 조직의 보도자료 보관 위치 | 보도자료 원문 |
| `CLOUD_URL` 이 가리키는 엔드포인트 | Cloud Run API 엔드포인트 |

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
- **정크 메일 대응**: 첫 발송 시 도메인 평판 부족으로 정크 분류 가능. 자기 도메인 링크 포함으로 도메인 신뢰도 구축
- **수신거부**: 템플릿 하단에 수신거부 링크 필수 (정보통신망법)
- **매체 선별**: 주제와 무관하거나 관계상 제외할 매체는 배포 전에 명시적으로 정한다

## 운영 시 주의 — 실제 캠페인에서 나온 것들

| 항목 | 내용 |
|------|------|
| 예약 발송 | Scheduler 는 권한을 부여한 순간 즉시 재시도한다. Job 생성과 Scheduler 생성을 분리하고, Scheduler 는 최종 확인 뒤에 enable 한다. 그러지 않으면 예약 시각과 무관하게 새벽에 나갈 수 있다 |
| 중복 발송 | 위 재시도 + dedup 을 실 데이터로 시험하면 같은 수신자에게 여러 통이 간다. `sent-log.json` 의 캠페인 id 만으로는 늦다 |
| **테스트 원칙** | **실 데이터(기자 리스트)로 절대 테스트하지 않는다.** `test` 명령 또는 `--test-only` 플래그만 쓴다. 이 원칙을 어겨 실제 기자에게 중복 발송된 사고가 있었다 |
| 이메일 정확도 | 검색으로 수집한 기자 이메일은 반송이 난다. 발송 전 기자명과 이메일 ID 일치를 확인하고, 반송은 정상 범위로 계획한다 |
| 정크 분류 | 신규 도메인 + 심야 발송 + HTML 메일 조합은 정크로 분류되기 쉽다. SPF/DKIM 을 먼저 맞추고 업무 시간에 보낸다 |
| CID 이미지 | Cloud Run 에서는 CID 첨부가 불가하다. 이미지는 절대 URL 로 참조한다 |
| 발송 차단 하네스 | 외부 발송 명령을 가로채는 가드를 두고, 테스트 시 수신자를 자기 주소로 리다이렉트한다 |
