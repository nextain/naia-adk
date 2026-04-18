# naia-adk Detailed Design & Implementation Plan

> **Status**: Draft v2 (peer-reviewed by Claude + Codex)
> **Date**: 2026-04-17
> **Author**: Luke (Nextain)

---

## 1. Vision

### 1.1 Definition

**naia-adk** is an **AI business operations methodology + its reference infrastructure**.

```
Agile/Scrum  : Software development methodology → Jira, Sprint boards
DevOps       : Dev-Ops integration methodology  → CI/CD, containers
naia-adk     : AI business ops methodology       → Context, Skills, Runtime
```

### 1.2 Core Insight

| Approach | Examples | Gap |
|----------|----------|-----|
| AI coding tools | Claude Code, Cursor | File-based context, but **coding only** |
| Agent frameworks | LangChain, CrewAI | **Code required**, non-developers excluded |
| Enterprise SaaS | Copilot Studio, Glean | Platform lock-in, **not self-hostable** |
| AX consulting | McKinsey, Bain | Advice only, **no executable framework** |

**naia-adk fills the gap**: file-based context + composable skills for **general business operations**. Self-hostable, Git-backed, minimal.

### 1.3 What Makes This Different

The workflow looks developer-oriented (files, YAML, Git) but the actual work is natural language:

- **Context** = Natural language describing the company
- **Skills** = Structured instructions for AI ("do it this way")
- **Execution** = AI reads context, loads skills, performs work

The Naia Shell desktop app provides the UI layer so non-developers can use the same system without touching files directly.

### 1.4 Value Proposition

naia-adk bundles enterprise features that others charge for as SaaS:

| Capability | Traditional (paid service) | naia-adk (self-hosted) |
|-----------|---------------------------|----------------------|
| Digital signatures | DocuSign, 카카오싸인 (monthly fee) | Built-in PKI, zero cost |
| Document management | External DMS | Git-based, free |
| Approval workflows | Workflow SaaS | Defined as skills, free |
| OCR / data extraction | Cloud OCR API | LLM Vision adapter, included |
| Context management | Consulting fees | File-based, free |

---

## 2. Architecture: 3-Layer Fork Model

```
naia-adk (open source)        Generic runtime + skill spec
    ↓ fork
naia-adk-b (private)          Business scaffold + CLI + base skill set
    ↓ fork + init
{company}-adk                 Company-specific workspace
```

### 2.1 Layer 1: naia-adk (Open Source)

**Purpose**: Core runtime engine + skill specification

**Responsibilities**:
- `.naia/` directory spec (context, skills, adapters, config schemas)
- Runtime engine: loads context → resolves skill → binds input → executes → returns output
- Skill execution contract (input binding, output schema, approval gates, failure handling)
- Adapter interface (LLM, storage, email, PKI/signature, etc.)
- SDK for programmatic access
- Trigger dispatch (natural language → skill matching)

**Does NOT contain**:
- Any company-specific logic or data
- Business templates or processes
- CLI scaffolding

**Tech stack**: TypeScript (Node.js), pnpm monorepo

```
naia-adk/
├── README.md
├── AGENTS.md
├── package.json
├── pnpm-workspace.yaml
├── packages/
│   ├── core/                    # Runtime engine
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── context.ts       # Context loader & validator
│   │   │   ├── skill.ts         # Skill loader, executor & dispatch
│   │   │   ├── adapter.ts       # Adapter interface & registry
│   │   │   ├── runtime.ts       # Main orchestrator
│   │   │   ├── contract.ts      # Skill execution contract
│   │   │   └── trigger.ts       # NL → skill matching
│   │   └── tsconfig.json
│   └── sdk/                     # JS/TS SDK
│       ├── package.json
│       └── src/
│           └── index.ts
├── docs/
│   ├── design/
│   │   └── PLAN.md
│   └── spec/
│       ├── context-schema.md
│       ├── skill-schema.md
│       └── adapter-schema.md
├── templates/
│   └── .naia/                   # Empty template structure
│       ├── context.yaml         # Placeholder schema only (no real data)
│       ├── skills/
│       ├── adapters/
│       └── config.yaml
└── examples/
    └── hello-skill/
```

### 2.2 Layer 2: naia-adk-b (Private)

**Purpose**: Business scaffold + CLI + base skills

**Responsibilities**:
- CLI: `naia init`, `naia skill add`, `naia adapter connect`
- Base skills (email, document generation, scheduling)
- Document generation engine (PDF, templates)
- Git integration (auto-commit, version tracking)
- Multi-role workflow (requester → approver → executor)

**Note**: naia-adk-b depends on naia-adk as an **npm workspace dependency**, not a symlink (symlinks are fragile across repos and on Windows).

```
naia-adk-b/
├── package.json                 # naia-adk as dependency
├── packages/
│   ├── cli/                     # CLI tool
│   │   └── src/
│   │       ├── commands/
│   │       │   ├── init.ts
│   │       │   ├── skill.ts
│   │       │   └── adapter.ts
│   │       └── scaffolder.ts
│   └── docgen/                  # Document generation (Python subprocess bridge)
│       └── src/
│           ├── pdf.ts           # Bridge to Python PDF engine
│           └── template.ts      # Template engine
├── skills/                      # Base business skills
│   ├── document-generation/
│   └── email/
├── templates/                   # Generic business templates (no company data)
│   ├── contract/
│   ├── resolution/
│   └── payroll/
└── scripts/
    ├── generate-pdf.py          # Python PDF engine (fpdf2)
    └── sign-pdf.py              # Digital signature (PKCS#7)
```

**TypeScript ↔ Python bridge**: The runtime (TypeScript) invokes Python scripts via subprocess for PDF generation and signing. Defined interface:

```typescript
interface PDFGenerator {
  command: "python3 scripts/generate-pdf.py"
  args: { template: string; data: Record<string, any>; output: string }
  return: { success: boolean; path: string; error?: string }
}
```

### 2.3 Layer 3: {company}-adk (Company-Specific)

**Purpose**: Company's actual AI workspace — context, skills, documents, data

**Key principle**: Domains that may need separate access control later are organized as **top-level directories** that can be split into separate repos via `git subtree split`.

```
nextain-adk/
├── .naia/
│   ├── context.yaml             # Nextain company info (NO personal data)
│   ├── config.yaml              # Runtime config
│   ├── skills/
│   │   ├── payroll/             # 급여명세서 (existing, migrated)
│   │   ├── contract/            # 근로계약서 (NEW)
│   │   └── expense/             # 지출결의 + 영수증 (NEW)
│   ├── adapters/
│   │   ├── llm.yaml             # Claude/GPT/Gemini (vision for OCR)
│   │   ├── email.yaml           # Office 365 SMTP
│   │   ├── storage.yaml         # Git-based
│   │   └── signature.yaml       # PKI digital signature
│   └── templates/               # Nextain-branded templates
│       ├── nextain-contract.md
│       └── nextain-resolution.md
├── accounting/                  ← SPLIT CANDIDATE: nextain-accounting
│   ├── expenses/
│   ├── payroll/
│   ├── receipts/
│   └── tax/
├── hr/                          ← SPLIT CANDIDATE: nextain-hr
│   ├── contracts/
│   └── employees/               # Encrypted at rest
├── documents/                   # Generated documents
│   ├── contracts/
│   ├── resolutions/
│   └── payroll/
├── data/                        # Structured data (YAML)
│   ├── employees.yaml           # git-crypt encrypted (PII)
│   └── expenses.yaml
└── scripts/
    └── generate-pdf.py          # Nextain-branded PDF generator
```

**Permission model (future)**:

| Repo | Access | Content |
|------|--------|---------|
| nextain-adk | All employees | Context, skills, templates, general documents |
| nextain-accounting | CEO + accountant | Expenses, payroll, tax, receipts |
| nextain-hr | CEO + HR manager | Contracts, employee records, salaries |

For now: everything in nextain-adk. Split when team grows.

---

## 3. `.naia/` Specification

### 3.1 context.yaml (Schema)

```yaml
# Generic schema — NO real company data in the open-source spec
company:
  name: { type: string, required: true }
  eng_name: { type: string, required: true }
  biz_no: { type: string, required: true }
  ceo: { type: string, required: true }
  address: { type: string, required: true }
  logo: { type: path, required: true }
  seal: { type: path, required: true }

branding:
  primary_color: { type: color, required: true }
  colors: { type: object }
  fonts: { type: object }

roles:
  - name: { type: string }
    holder: { type: string }
    permissions: { type: string[], values: [approve, execute, sign, read] }

workflow:
  approval:
    single_person: { type: boolean, default: false }
    process_as_multi: { type: boolean, default: true }
    policy: { type: string, description: "When to enforce vs simulate role separation" }
```

### 3.2 Skill Execution Contract

Each skill must define:

```yaml
# SKILL.md frontmatter
name: { type: string, required: true }
version: { type: semver, required: true }
description: { type: string, required: true }
triggers: { type: string[], required: true }

# Input/Output contract
input_schema:
  {field}: { type: string|number|enum|path, required: bool }

output:
  documents:
    - {name}: { path_template: string }
  records:
    - {name}: { path: string }
  side_effects:
    - { description: string, adapter: string }

# Execution control
steps:
  - id: {string}
    action: {string}
    gate: {boolean, default: false}  # pause for user approval

failure_policy:
  retry: { type: boolean, default: false }
  rollback: { type: boolean, default: true }
  on_failure: { type: enum, values: [abort, skip, notify] }

idempotency: { type: boolean, default: true }
```

### 3.3 Adapter Schema

```yaml
# adapters/llm.yaml
type: llm
provider: anthropic | openai | google
model: string
capabilities: [text, vision, code]

# adapters/email.yaml
type: email
smtp_host: string
smtp_port: number
auth_env_user: string
auth_env_pass: string

# adapters/signature.yaml
type: signature
method: pkcs7 | pades
certificate_path: string         # encrypted
private_key_path: string         # encrypted
ca_chain_path: string

# adapters/storage.yaml
type: storage
backend: git
auto_commit: boolean
commit_prefix: string
rollback_on_failure: boolean     # revert partial commits
```

### 3.4 config.yaml

```yaml
runtime:
  llm:
    provider: "anthropic"
    model: "claude-sonnet-4-20250514"  # Must match actual Anthropic model IDs
  adapters:
    email:
      smtp_host: "smtp.office365.com"
      smtp_port: 587
      user_env: "SMTP_USER"
      pass_env: "SMTP_PASS"
    storage:
      type: "git"
      auto_commit: true
      commit_prefix: "[naia-adk]"
      rollback_on_failure: true
    signature:
      method: "pades"
      cert_env: "NAIA_CERT_PATH"
      key_env: "NAIA_KEY_PATH"

paths:
  documents: "documents/"
  data: "data/"
  templates: ".naia/templates/"
  assets: "assets/"

security:
  encrypted_paths:
    - "data/employees.yaml"
    - "hr/"
  encryption: "git-crypt"
  key_distribution: "per-role"
```

---

## 4. Skill Designs

### 4.1 Skill: 근로계약서 (Employment Contract)

#### Workflow

```
Step 1: Input Collection
  → Worker info (name, address, birth, phone, email)
  → Contract terms (type, rate, period, duties, location, hours)

Step 2: Employee Record (encrypted)
  → Check data/employees.yaml (git-crypt decrypted)
  → Create/update record
  → PII fields encrypted at rest

Step 3: Contract Document Generation
  → Load .naia/templates/nextain-contract.md
  → Fill with context + worker info + contract terms
  → Generate PDF via Python subprocess

Step 4: Digital Signature (PKI)
  → Sign PDF with company certificate (PAdES)
  → NOT just a seal image — cryptographic signature
  → Tamper-evident, legally valid

Step 5: Review & Approval (gate)
  → Present signed contract to user
  → User confirms or requests modifications

Step 6: Finalize
  → Save to hr/contracts/{name}_{date}.pdf (encrypted)
  → Commit to git: "[naia-adk] contract: {worker_name}"
  → Optional: email to worker

Step 7: Notify (optional)
  → Send contract PDF to worker via email adapter
```

#### Contract Template Structure (근로기준법 compliant)

1. **Header**: Company name, contract title, document ID
2. **Parties**: Employer info (from context), Employee info (from input)
3. **Contract Terms**: 계약기간, 근무장소, 업무내용, 근로시간, 임금, 휴일·휴가, 안전·보건, 계약해지
4. **Digital Signatures**: Employer (PAdES), Employee (PAdES or image placeholder)
5. **Footer**: Document hash, legal notice, verification URL

#### Digital Signature Design

```
PDF generation → Sign with company cert (PAdES) → Tamper-evident seal
                                     ↓
                          certificate/key from adapter config
                          stored in encrypted volume, NOT in git
```

For small teams without PKI infrastructure: provide a self-signed certificate generation tool (`naia cert generate`). Not legally equivalent to accredited certificates, but provides tamper detection and non-repudiation.

### 4.2 Skill: 지출결의 + 영수증 (Expense Resolution + Receipts)

#### Workflow

```
Step 1: Expense Input
  → Collect items (date, amount, category, description, payer)
  → Collect receipt files (image/PDF paths)
  → Classify: 법인경비 vs 개인선결제 (reimbursement)

Step 2: Receipt OCR (LLM Vision adapter)
  → Send receipt images to LLM Vision
  → Extract: date, amount, vendor, category, tax amount
  → Validate extracted data vs user input
  → Flag discrepancies for review

Step 3: Resolution Document Generation
  → Auto-increment: resolution number {YYYY}-{NNN}
  → Load template, fill with items + totals
  → Generate PDF with Nextain branding

Step 4: Digital Signature (gate)
  → Present resolution + extracted receipt data
  → User confirms → sign with PAdES

Step 5: Finalize
  → Save to accounting/expenses/{resolution_no}/
  → Copy receipts to accounting/receipts/{resolution_no}/
  → Record in data/expenses.yaml
  → Commit: "[naia-adk] expense: {resolution_no}"

Step 6: Payment (optional)
  → If reimbursement: record bank transfer info
  → Update status: paid
```

#### Receipt Processing (LLM Vision)

```python
# Adapter: llm.vision
# Input: receipt image
# Output: structured JSON

{
  "date": "2026-04-07",
  "vendor": "Google",
  "amount": 29000,
  "currency": "KRW",
  "category": "소프트웨어",
  "tax_amount": 0,
  "payment_method": "신용카드",
  "confidence": 0.95
}
```

Receipt validation rules:
- File type: JPG, PNG, PDF only
- Size limit: 10MB per file
- Duplicate detection: hash-based
- Low confidence (< 0.7): flag for manual review

---

## 5. Document Generation Engine

### 5.1 PDF Generation (Python)

Based on existing `payroll/scripts/send_payroll.py` pattern (fpdf2):

```python
class NaiaDocumentPDF(FPDF):
    """Base class — company-agnostic, configured from context.yaml"""

    def __init__(self, context: dict):
        super().__init__(orientation="P", unit="mm", format="A4")
        self.context = context
        self._setup_fonts()
        self._load_branding()

    def _setup_fonts(self):
        # Fonts bundled with skill, NOT auto-downloaded
        # Self-hostable: no runtime network dependency
        font_dir = self.context["paths"]["assets"] + "/fonts/"
        self.add_font("NanumGothic", "", font_dir + "NanumGothic-Regular.ttf")
        self.add_font("NanumGothic", "B", font_dir + "NanumGothic-Bold.ttf")

    def _load_branding(self):
        colors = self.context["branding"]["colors"]
        self.primary = self._hex_to_rgb(colors.get("primary", "#2563EB"))

    def draw_header(self): ...
    def draw_company_info(self): ...
    def draw_signature_block(self, signers: list): ...
    def draw_footer(self, doc_id: str): ...
```

Subclasses per document type:
- `ContractPDF` — employment contracts
- `ResolutionPDF` — expense resolutions
- `PayrollPDF` — payroll statements (existing, refactored)

### 5.2 Digital Signature (PKCS#7 / PAdES)

```python
# scripts/sign-pdf.py
# Signs an existing PDF with PAdES (PDF Advanced Electronic Signature)

import subprocess

def sign_pdf(input_path, output_path, cert_path, key_path):
    """
    Uses openssl or endesive for PAdES signing.
    Certificate stored outside git (encrypted volume or env-var path).
    """
    # Option A: openssl-based (requires .p12/.pfx)
    # Option B: endesive library (pure Python)
    pass
```

Self-signed certificate generation:
```bash
naia cert generate --org "Nextain" --country "KR"
# Creates: naia-cert.pem, naia-key.pem
# Store outside repo, reference via config.yaml → adapters.signature
```

### 5.3 TypeScript ↔ Python Bridge

```typescript
// packages/core/src/adapter.ts
interface SubprocessAdapter {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeout?: number;
}

async function invokePython(script: string, args: Record<string, any>): Promise<Result> {
  const proc = spawn("python3", [script, JSON.stringify(args)], {
    timeout: 30000,
    env: { ...process.env, ...args.env },
  });
  // parse JSON stdout, handle stderr
}
```

---

## 6. Security Design

### 6.1 Data Classification

| Level | Content | Storage | Examples |
|-------|---------|---------|---------|
| Public | Templates, specs | Git (plain) | context.yaml (company info), skills |
| Internal | Generated documents | Git (plain) | Contracts, resolutions, payroll PDFs |
| Confidential | Employee PII, salaries | Git (git-crypt) | employees.yaml, salary data |
| Secret | Certificates, keys | Outside git | .pem, .p12, API keys (.env) |

### 6.2 Encryption at Rest

```bash
# Setup git-crypt for sensitive paths
git-crypt init
echo "data/employees.yaml filter=git-crypt diff=git-crypt" >> .gitattributes
echo "hr/** filter=git-crypt diff=git-crypt" >> .gitattributes
git-crypt add-gpg-user luke@nextain.io
```

### 6.3 Secret Management

- API keys, SMTP credentials → `.env` files (gitignored)
- Certificates, private keys → encrypted volume or hardware token
- Never commit secrets to git

---

## 7. Peer Review Process (3-CLI Headless)

### 7.1 CLI Commands

| CLI | Headless Command | Notes |
|-----|-----------------|-------|
| Claude | `echo "prompt" \| claude -p --output-format text` | stdin pipe for long prompts |
| Gemini | `gemini -p "prompt" -m gemini-2.5-pro` | server capacity may limit availability |
| Codex | `codex exec "prompt" --sandbox read-only` | `exec` = non-interactive |

### 7.2 Review Flow

```
1. Prepare review prompt (same for all 3 CLIs)
2. Run available CLIs in parallel (tolerate failures gracefully)
3. Aggregate findings with structured output:
   - Each finding: [SEVERITY] [FILE:LINE] description
   - Normalize across CLI outputs
4. Confidence levels:
   - 2+ CLIs agree → HIGH → auto-fix
   - 1 CLI only → MEDIUM → present to user, don't auto-fix
   - All fail → fall back to self-review
5. Apply fixes, re-run (max 3 rounds)
```

**Safety constraints**:
- Auto-fix is read-only by default (suggests changes, doesn't apply)
- Explicit `--apply` flag needed to auto-apply fixes
- All changes reviewed by user before commit

---

## 8. Implementation Phases

### Phase 1: naia-adk Foundation

**Goal**: Core spec + minimal runtime

| Task | Output | Verification |
|------|--------|-------------|
| Define `.naia/` spec | `docs/spec/*.md` | Schema validation script |
| Create runtime skeleton | `packages/core/src/` | `pnpm build` passes |
| Create SDK skeleton | `packages/sdk/src/` | `pnpm build` passes |
| Define skill execution contract | `packages/core/src/contract.ts` | Unit tests |
| Define trigger dispatch interface | `packages/core/src/trigger.ts` | Unit tests |
| Write README + AGENTS.md | Root files | Peer review |
| Create empty template | `templates/.naia/` | Structure matches spec |
| Bundle fonts in template | `templates/.naia/assets/fonts/` | Self-hostable, no download |

### Phase 2: nextain-adk Setup

**Goal**: Nextain workspace with context and existing payroll skill

| Task | Output | Verification |
|------|--------|-------------|
| Fork naia-adk → nextain-adk | Repo | `git clone` works |
| Create `.naia/context.yaml` | Nextain info (placeholder schema) | Schema valid |
| Setup git-crypt | `.gitattributes`, GPG key | `git-crypt lock/unlock` works |
| Migrate payroll skill | `.naia/skills/payroll/` | PDF generates with existing script |
| Create employee data (encrypted) | `data/employees.yaml` | `git-crypt status` shows encrypted |
| Setup directory structure | `accounting/`, `hr/`, `documents/` | Exists |

### Phase 3: Contract Skill

**Goal**: 근로계약서 PDF 생성 + 디지털 서명

| Task | Output | Verification |
|------|--------|-------------|
| Create contract SKILL.md | `.naia/skills/contract/SKILL.md` | Execution contract valid |
| Create contract template | `.naia/templates/nextain-contract.md` | Template renders |
| Create ContractPDF class | `scripts/generate-pdf.py` | PDF generates |
| Setup self-signed cert | `naia cert generate` | Cert exists |
| Implement PAdES signing | `scripts/sign-pdf.py` | Signed PDF validates |
| Test: 통역사 계약 (10만원/시간) | Real contract PDF | Manual review |

### Phase 4: Expense Skill

**Goal**: 지출결의 + 영수증 OCR

| Task | Output | Verification |
|------|--------|-------------|
| Create expense SKILL.md | `.naia/skills/expense/SKILL.md` | Execution contract valid |
| Create resolution template | `.naia/templates/nextain-resolution.md` | Template renders |
| Create ResolutionPDF class | `scripts/generate-pdf.py` | PDF generates |
| Implement LLM Vision OCR | Receipt extraction | Accuracy test (10+ samples) |
| Receipt validation | File type, size, duplicate detection | Edge case tests |
| Test: AI 크래딧 지출결의 | Real resolution PDF | Manual review |
| Migrate 2026-001 | Existing expense data | Matches OneDrive records |

### Phase 5: naia-adk-b Extraction

**Goal**: Extract common patterns into reusable layer

| Task | Output | Verification |
|------|--------|-------------|
| Identify reusable patterns | Document | Review |
| Create naia-adk-b repo | Fork + CLI + base skills | `naia init` works |
| Extract PDF engine | `packages/docgen/` | Tests pass |
| Extract base skills | `skills/document-generation/`, `skills/email/` | Skills load |
| CLI: init, skill add, adapter connect | Working commands | Integration tests |

### Phase 6: Peer Review Integration

**Goal**: 3-CLI headless peer review as a reusable skill

| Task | Output | Verification |
|------|--------|-------------|
| Update review-pass SKILL.md | `--peer` mode | Spec valid |
| Create peer review runner | Shell script | 3 CLIs execute |
| Structured output schema | JSON schema for findings | Validation |
| Safety constraints | `--apply` flag, no auto-destructive changes | Tested |

---

## 9. Real-World Use Cases (Immediate)

### 9.1 통역사 근로계약

```
Input:
  worker_name: "{통역사 이름}"
  contract_type: "계약직"
  hourly_rate: 100000
  duties: "통역 및 번역 업무"
  start_date: "2026-04-17"
  end_date: "2026-12-31"

Output:
  - hr/contracts/{name}_2026-04-17.pdf (encrypted, digitally signed)
  - data/employees.yaml (updated, encrypted)
```

### 9.2 AI 크래딧 지출결의 (2026-001)

```
Input:
  items:
    - Google AI Pro (5TB): ₩29,000 × 3 months
    - Claude Max: ₩375,000 + ₩187,500
  total: ₩649,500
  payer: 개인카드 (양병석)
  reimburse_to: 토스뱅크 1000-3504-2010

Output:
  - accounting/expenses/2026-001.pdf (digitally signed)
  - accounting/receipts/2026-001/ (receipt files)
  - data/expenses.yaml (updated)
```

---

## 10. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Non-developer adoption | High | Medium | Naia Shell UI (future) |
| Korean legal doc compliance | Medium | High | 근로기준법 reference, labor attorney review |
| Digital signature legality | Medium | High | PAdES standard, future accredited cert integration |
| PII exposure in git | Medium | High | git-crypt, .gitignore, secret management |
| PDF rendering differences | Low | Medium | Standard fonts, test on multiple platforms |
| Git storage limits | Low | Low | Git LFS for receipts, repo split for scale |
| Multi-person workflow | Medium | Medium | Build single-person first, policy exception model defined |
| Peer review CLI availability | High | Low | Tolerate failures, fall back to self-review |

---

## 11. Success Criteria

1. **Contract skill**: Generate 근로기준법-compliant, digitally signed employment contract PDF
2. **Expense skill**: Create expense resolution with receipt OCR and digital signature
3. **Security**: PII encrypted at rest, certificates outside git, no secrets committed
4. **Self-hostable**: Zero runtime network dependencies (bundled fonts, local signing)
5. **Peer review**: Multi-CLI review with structured output and safety constraints
6. **Reusability**: Same skills work for any company by changing context.yaml
7. **Audit trail**: Full history in git, digitally signed documents

---

## Appendix A: Dependency Map

| Resource | Location | Usage |
|----------|----------|-------|
| Payroll PDF script | `.agents/skills/payroll/scripts/send_payroll.py` | Base PDF pattern |
| Company info | `docs-business/01. 회사 정보/base-info.md` | context.yaml source |
| Logo | `about.nextain.io/public/assets/logos/` | PDF branding |
| Seal | `docs-business/07.증명서/` | PDF seal (separate from digital sig) |
| Existing accounting | OneDrive `넥스테인 회계/04.비용관리/` | Historical data source |
| Expense 2026-001 | `docs-business/06. 발급문서/지출결의서/` | Migration source |

## Appendix B: Glossary

| Term | Definition |
|------|-----------|
| ADK | Agent Development Kit |
| AX | AI Transformation |
| Context | Company information that AI reads to understand the business |
| Skill | Structured instruction set for AI to perform specific business operations |
| Adapter | Interface to external systems (LLM, email, storage, PKI) |
| Harness | Collective set of contexts, skills, and adapters that guide AI behavior |
| Resolution | 지출결의 — formal approval document for expenses |
| PAdES | PDF Advanced Electronic Signature (EU standard, applicable in KR) |
| git-crypt | Transparent file encryption in git using GPG |
| Peer review | Multi-model review using 3 different AI CLIs in headless mode |
