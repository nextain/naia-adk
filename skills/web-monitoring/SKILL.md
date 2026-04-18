---
name: web-monitoring
version: "0.1.0"
description: Web presence monitoring — SEO, uptime, analytics, competitive analysis.
triggers:
  - "web monitoring"
  - "웹 모니터링"
  - "SEO"
  - "웹 분석"
  - "보고"
input_schema:
  action:
    type: enum
    values: [uptime, seo-check, analytics, competition, report]
    required: true
  urls:
    type: "string[]"
    required: false
  period:
    type: string
    required: false
output:
  documents:
    - name: "web_report"
      path_template: "documents/web-reports/{date}.md"
steps:
  - id: "collect"
    action: "Gather data from URLs / APIs"
  - id: "analyze"
    action: "Generate insights"
  - id: "report"
    action: "Create report document"
failure_policy:
  retry: true
  rollback: false
  on_failure: "notify"
idempotency: true
---

# Web Monitoring

Super-individual monitors web presence across all company sites and products.
