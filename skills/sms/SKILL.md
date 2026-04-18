---
name: sms
version: "0.1.0"
description: Send SMS messages via gateway adapter. Korean business SMS (알림톡, 문자).
triggers:
  - "send sms"
  - "문자 발송"
  - "SMS"
  - "알림톡"
input_schema:
  to:
    type: "string[]"
    required: true
  message:
    type: string
    required: true
  type:
    type: enum
    values: [sms, lms, mms, alt]
    required: false
output:
  side_effects:
    - description: "Send SMS via gateway adapter"
      adapter: "sms"
steps:
  - id: "validate"
    action: "Validate recipients, message length"
  - id: "send"
    action: "Invoke SMS adapter"
  - id: "log"
    action: "Record sent message"
failure_policy:
  retry: true
  rollback: false
  on_failure: "notify"
idempotency: false
---

# SMS Skill

Send SMS/LMS/MMS messages. Supports Korean 알림톡 via gateway adapter.

## Adapters

| Adapter | Service | Notes |
|---------|---------|-------|
| `coolsms` | CoolSMS | Korean SMS gateway |
| `sens` | NAVER Cloud SENS | 알림톡 + SMS |
| `solapi` | SolAPI | 알림톡 + 친구톡 |
