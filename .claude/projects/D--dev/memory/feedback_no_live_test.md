---
name: feedback-no-live-test
description: 절대 실제 수신자에게 테스트하지 말 것. 테스트는 항상 luke.yang@nextain.io로만.
type: feedback
---

테스트 시 절대 실제 기자/외부 수신자에게 발송하지 말 것. `node send.js test`만 사용하거나 contacts를 테스트용으로 교체 후 실행.

**Why:** 2026-04-13 보도자료 중복 발송 사고. dedup 테스트를 실제 기자 리스트(`send` 명령)로 실행하여 3명에게 3통째 메일이 발송됨.

**How to apply:** 외부 발송 테스트 시 반드시 (1) `test` 명령 사용 또는 (2) contacts.json을 luke 전용으로 교체 후 실행. 절대 `send` 명령으로 실 데이터 테스트 금지.
