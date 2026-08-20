---
name: email
version: "0.1.0"
description: >
  Send emails via SMTP adapter with template support.
  Supports attachments (PDF, images) and HTML body.
triggers:
  - "send email"
  - "email"
  - "이메일 발송"
input_schema:
  to:
    type: "string[]"
    required: true
    description: "Recipient email addresses"
  subject:
    type: string
    required: true
    description: "Email subject"
  body:
    type: string
    required: true
    description: "Email body (plain text or HTML)"
  attachments:
    type: "path[]"
    required: false
    description: "File paths to attach"
  html:
    type: boolean
    required: false
    description: "Whether body is HTML (default: false)"
output:
  side_effects:
    - description: "Send email via SMTP adapter"
      adapter: "email"
steps:
  - id: "validate"
    action: "Validate recipients, subject, body"
  - id: "resolve_attachments"
    action: "Verify attachment files exist"
  - id: "send"
    action: "Invoke email adapter (SMTP)"
  - id: "log"
    action: "Record sent email in log"
failure_policy:
  retry: true
  rollback: false
  on_failure: "notify"
idempotency: false
---

# Email Skill

Sends emails via configured SMTP adapter. Supports HTML body and file attachments.

## Configuration

Set in `.naia/config.yaml`:

```yaml
runtime:
  adapters:
    email:
      smtp_host: "smtp.office365.com"
      smtp_port: 587
      user_env: "SMTP_USER"
      pass_env: "SMTP_PASS"
```
