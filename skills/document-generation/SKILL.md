---
name: document-generation
version: "0.1.0"
description: >
  Generate business documents (contracts, resolutions, payroll) as branded PDFs
  with optional digital signature (PAdES).
triggers:
  - "document generation"
  - "generate PDF"
  - "문서 생성"
  - "근로계약서"
  - "지출결의서"
input_schema:
  template:
    type: enum
    values: [contract, resolution, payroll]
    required: true
    description: "Document template type"
  data:
    type: object
    required: true
    description: "Template-specific data (parties, items, amounts, etc.)"
  output_path:
    type: path
    required: true
    description: "Output PDF file path"
  sign:
    type: boolean
    required: false
    description: "Apply digital signature after generation"
output:
  documents:
    - name: "generated_pdf"
      path_template: "{output_path}"
  side_effects:
    - description: "Optional PAdES digital signature"
      adapter: "signature"
steps:
  - id: "validate_input"
    action: "Validate template type and required data fields"
  - id: "generate"
    action: "Invoke generate-pdf.py with context, template, data"
  - id: "sign"
    action: "If sign=true, invoke sign-pdf.py with configured cert/key"
    gate: true
  - id: "finalize"
    action: "Save PDF, commit to git"
failure_policy:
  retry: false
  rollback: true
  on_failure: "abort"
idempotency: false
---

# Document Generation Skill

Generates branded business document PDFs using the Python fpdf2 engine.

## Usage

```bash
python3 scripts/generate-pdf.py '{"template":"contract","data":{...},"output":"out.pdf"}'
```

## Templates

| Template | Description | Required Data |
|----------|-------------|---------------|
| `contract` | Employment contract (근로기준법 compliant) | title, sections, signers, doc_id |
| `resolution` | Expense resolution (지출결의서) | title, items, signers, doc_id |
| `payroll` | Payroll statement (급여명세서) | employee, period, items, totals |
