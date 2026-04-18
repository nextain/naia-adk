---
name: service-management
version: "0.1.0"
description: Monitor and manage deployed services — uptime checks, cost tracking, incident response.
triggers:
  - "service management"
  - "서비스 관리"
  - "모니터링"
  - "인시던트"
input_schema:
  action:
    type: enum
    values: [status, cost, incident, deploy-check, ssl-check]
    required: true
  service:
    type: string
    required: false
output:
  records:
    - name: "service_status"
      path: "data/service-status.json"
steps:
  - id: "check"
    action: "Query service status / metrics"
  - id: "report"
    action: "Generate report or alert"
failure_policy:
  retry: true
  rollback: false
  on_failure: "notify"
idempotency: true
---

# Service Management

Super-individual monitors all deployed services. One person ops.
