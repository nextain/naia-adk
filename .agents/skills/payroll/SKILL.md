---
name: payroll
description: 급여명세서 PDF 생성 + 이메일 발송. 급여 데이터를 받아 A4 PDF를 만들고 각 사원에게 이메일로 발송합니다. "급여명세서", "급여 보내기", "payroll" 등 급여 관련 요청 시 사용.
argument-hint: "[YYYY-MM | 데이터를 직접 입력]"
---

# Payroll — 급여명세서 PDF 생성 + 이메일 발송

## 개요

사원 급여 데이터 → A4 PDF 급여명세서 생성 → 이메일 발송 (Office 365 SMTP)

## 사전 설치

```bash
pip install reportlab
```

## 워크플로우

### Step 1: 데이터 파싱

사용자가 제공한 급여 데이터(테이블, 텍스트 등)를 아래 JSON 구조로 변환:

```json
{
  "year": 2026,
  "month": 3,
  "company": {
    "name": "(주)넥스테인",
    "eng_name": "nextain Inc.",
    "biz_no": "529-81-03749",
    "ceo": "양병석",
    "address": "경기도 화성시 효행구 매송면 매송고색로 422번길 77, 나동 107호"
  },
  "employees": [
    {
      "code": 1,
      "name": "사원명",
      "email": "email@nextain.io",
      "hire_date": "2026-03-11",
      "items": {
        "기본급": 3000000,
        "식대": 135483
      },
      "deductions": {
        "국민연금": 135000,
        "건강보험": 111900
      },
      "total_pay": 3135483,
      "total_deduction": 246900,
      "net_pay": 2888583
    }
  ]
}
```

회사 정보는 `docs-business/01. 회사 정보/base-info.md` 참조.

### Step 2: PDF 생성 (dry-run)

먼저 dry-run으로 PDF만 생성하여 확인:

```bash
python .agents/skills/payroll/scripts/send_payroll.py \
  --data '<JSON>' \
  --output-dir 'docs-business/06. 급여/YYYY-MM/' \
  --dry-run
```

출력 디렉토리: `docs-business/06. 급여/{YYYY-MM}/`

### Step 3: 사용자 확인 (gate)

생성된 PDF 경로를 사용자에게 보여주고 확인 요청:
- "PDF를 확인하시겠습니까? 확인 후 이메일 발송하겠습니다."
- 사용자가 확인하면 Step 4 진행

### Step 4: 이메일 발송

```bash
python .agents/skills/payroll/scripts/send_payroll.py \
  --data '<JSON>' \
  --output-dir 'docs-business/06. 급여/YYYY-MM/'
```

SMTP 인증:
- `SMTP_USER` 환경변수 (기본: noreply@nextain.io)
- `SMTP_PASS` 환경변수 (필수)

없으면 사용자에게 안내: "SMTP_PASS 환경변수를 설정해주세요."

### Step 5: 결과 보고

| 사원 | 이메일 | PDF | 발송 |
|------|--------|-----|------|
| ... | ... | ... | O/X |

## 에러 처리

| 에러 | 조치 |
|------|------|
| reportlab 미설치 | `pip install reportlab` 안내 |
| SMTP_PASS 미설정 | dry-run으로 PDF만 생성, 환경변수 설정 안내 |
| 폰트 없음 | `sudo dnf install google-noto-sans-cjk-fonts` 안내 |
| 이메일 실패 | 에러 메시지 표시, PDF는 보존됨 |
