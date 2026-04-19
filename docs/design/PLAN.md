# naia-adk Detailed Design & Implementation Plan

> **Status**: Draft v3 (peer-reviewed by Gemini + Claude, see §12)
> **Date**: 2026-04-19
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

## 2. Architecture: Base + Extension Pack + Config

```
naia-adk (open source)              Generic runtime + skill spec + base skills
    ↓ naia install business
naia-adk-business-pack (private)     Business skills + CLI + Docgen installed INTO workspace
    ↓ naia init {name}
{company}-adk                        Company-specific workspace (data + context + projects)
```

### 2.1 Base: naia-adk (Open Source)

**Purpose**: Core runtime engine + skill specification + individual skills

**Responsibilities**:
- `.agents/` directory spec (AAIF standard — context, skills, workflows, commands, hooks)
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
│   │   │   ├── trigger.ts       # NL → skill matching (keyword-first, LLM fallback)
│   │   │   ├── events.ts        # EventBus for monitoring & dashboard
│   │   │   └── pool.ts          # Worker pool (Python, LLM, Git I/O)
│   │   └── tsconfig.json
│   └── sdk/                     # JS/TS SDK
│       ├── package.json
│       └── src/
│           └── index.ts
├── skills/                      # Base individual skills (9)
├── docs/
│   ├── design/
│   │   └── PLAN.md
│   └── spec/
│       ├── context-schema.md
│       ├── skill-schema.md
│       └── adapter-schema.md
├── templates/
│   └── .agents/                 # Empty template structure
│       ├── context/             # Placeholder schemas (no real data)
│       ├── skills/
│       ├── workflows/
│       └── commands/
└── examples/
    └── hello-skill/
```

### 2.2 Extension Pack: naia-adk-business-pack (Private)

**Purpose**: Business skills + CLI + Docgen, installed INTO the naia-adk workspace

**Responsibilities**:
- CLI: `naia init`, `naia skill add`, `naia adapter connect`
- Business skills (payroll, contract, expense, accounting, CRM, etc.)
- Document generation engine (PDF, templates)
- Git integration (auto-commit, batch commit per skill execution)
- Multi-role workflow (requester → approver → executor)

**Note**: naia-adk-business-pack is installed into the workspace via `naia install business`, adding skills to `skills/business/` and packages to `packages/`.

```
naia-adk-business-pack/
├── package.json
├── packages/
│   ├── cli/                     # CLI tool
│   │   └── src/
│   │       ├── commands/
│   │       │   ├── init.ts
│   │       │   ├── skill.ts
│   │       │   └── adapter.ts
│   │       └── scaffolder.ts
│   └── docgen/                  # Document generation (Python bridge)
│       └── src/
│           ├── pdf.ts           # Worker pool bridge to Python PDF engine
│           └── template.ts      # Template engine
├── skills/                      # Business skills
│   ├── payroll/
│   ├── contract/
│   ├── expense/
│   └── ...
├── templates/                   # Generic business templates (no company data)
│   ├── contract/
│   ├── resolution/
│   └── payroll/
└── scripts/
    ├── generate-pdf.py          # Python PDF engine (fpdf2)
    └── sign-pdf.py              # Digital signature (PKCS#7)
```

### 2.3 Config: {company}-adk (Company-Specific Workspace)

**Purpose**: Company's actual AI workspace — context, skills, documents, data

**Key principle**: Data organized by security tier into top-level directories. Each can be split into a separate repo for access control.

```
{name}-adk/
├── .agents/                     ← AAIF standard (T2)
│   ├── context/                 ← Company info, rules, project index
│   ├── skills/                  ← Company-specific skills (if needed)
│   ├── workflows/               ← Workflow definitions
│   ├── commands/                ← Slash commands
│   └── hooks/                   ← Lifecycle hooks
├── data-company/                ← T2: Company general data
│   ├── docs-{company}/          ← Company documentation (submodule)
│   ├── docs-work-logs/          ← Work logs (submodule)
│   └── caretive/                ← Reference data
├── data-business/               ← T3: Company sensitive data
│   ├── docs-business/           ← Business docs (submodule)
│   ├── accounting/              ← Accounting data (submodule)
│   └── documents/               ← Generated documents (submodule)
├── data-private/                ← T3: Personal data
│   ├── envs/                    ← .env, key files (gitignored or git-crypt)
│   ├── personal/                ← Personal documents
│   └── memo/                    ← Personal memos
├── projects/                    ← Project repos (submodules)
│   └── refs/                    ← Read-only reference repos
├── skills/                      ← naia-adk + business pack skills
├── packages/                    ← Runtime packages
├── scripts/                     ← PDF/sign engine, tools
├── templates/                   ← Document templates
├── docs/                        ← Architecture, specs
├── AGENTS.md
└── .gitignore
```

**Permission model (future)**:

| Repo | Access | Content |
|------|--------|---------|
| `{name}-adk` | All employees | Context, skills, templates, data-company |
| `nextain-accounting` | CEO + accountant | Expenses, payroll, tax, receipts |
| `nextain-hr` | CEO + HR manager | Contracts, employee records, salaries |

For now: everything in one workspace. Split when team grows.

---

## 3. `.agents/` Specification (AAIF Standard)

### 3.1 Context (Schema)

```yaml
# .agents/context/ — Company information (NO personal data in public spec)
schema_version: "1"

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
cert_env: string             # env var pointing to cert (NOT direct path)
key_env: string              # env var pointing to key (NOT direct path)
ca_chain_path: string

# adapters/storage.yaml
type: storage
backend: git
auto_commit: boolean
commit_prefix: string
batch_commit: boolean          # commit once per skill execution (not per file)
rollback_on_failure: boolean
```

### 3.4 Config

```yaml
# .agents/context/config.yaml
schema_version: "1"

runtime:
  llm:
    provider: "anthropic"
    model: "claude-sonnet-4-20250514"
  adapters:
    email:
      smtp_host: "smtp.office365.com"
      smtp_port: 587
      user_env: "SMTP_USER"
      pass_env: "SMTP_PASS"
    storage:
      type: "git"
      auto_commit: true
      batch_commit: true
      commit_prefix: "[naia-adk]"
      rollback_on_failure: true
    signature:
      method: "pades"
      cert_env: "NAIA_CERT_PATH"
      key_env: "NAIA_KEY_PATH"

paths:
  company_data: "data-company/"
  business_data: "data-business/"
  private_data: "data-private/"
  documents: "data-business/documents/"
  templates: "templates/"
  assets: "assets/"

security:
  data_tiers:
    company: "T2"               # data-company/
    business: "T3"              # data-business/
    private: "T3"               # data-private/
  encrypted_paths:
    - "data-private/envs/"
    - "data-business/accounting/"
  encryption: "git-crypt"       # optional, for team use
  key_distribution: "per-role"

  mcp:
    allowed_commands: []         # whitelist of allowed MCP server commands
                                  # empty array = DENY ALL (fail-closed). Add explicit paths to allow.
    require_signature: false     # future: require signed manifests
    severity: "high"             # user-configurable: high | medium

  auth:
    naia_os:
      method: "ed25519"         # reuse naia-os device identity
      transport: "tls"
    dashboard:
      method: "api-key"
      transport: "https"
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
  → Check data-business/accounting/employees.yaml
  → Create/update record
  → PII fields encrypted at rest

Step 3: Contract Document Generation
  → Load templates/nextain-contract.md
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
  → Save to data-business/documents/contracts/{name}_{date}.pdf (encrypted)
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
  → Save to data-business/accounting/expenses/{resolution_no}/
  → Copy receipts to data-business/accounting/receipts/{resolution_no}/
  → Record in data-business/accounting/expenses.yaml
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

### 5.3 TypeScript ↔ Python Bridge (Worker Pool)

Instead of spawning a new process per document, maintain a persistent Python worker pool:

```typescript
// packages/core/src/pool.ts
interface WorkerPool {
  acquire(): Promise<Worker>;
  release(worker: Worker): void;
}

interface Worker {
  invoke(method: string, args: Record<string, any>): Promise<Result>;
}

// Worker communicates via stdin/stdout JSON, NOT command-line args
// This prevents code injection through argument strings
async function invokePython(worker: Worker, method: string, args: Record<string, any>): Promise<Result> {
  // Input validation against JSON Schema before sending
  validateAgainstSchema(args, methodSchema);
  // Send via stdin as JSON
  const result = await worker.invoke(method, args);
  // Parse JSON response from stdout
  return JSON.parse(result);
}
```

**Security measures**:
- Args sent via stdin JSON (not command-line) — prevents shell injection
- JSON Schema validation before sending to worker
- Worker process timeout (30s default)
- Certificate/key paths passed via env vars, never in args

**Sandbox note**: OS-level sandboxing (cgroups/seccomp on Linux, job objects on Windows) is deferred to post-MVP. Current mitigation: JSON Schema validation + workspace-scoped paths + subprocess timeout. Workers cannot access paths outside the workspace by design (all paths resolved relative to workspace root).

**Performance**:
- Worker pool maintains N persistent Python processes
- No spawn overhead per document (~200-500ms saved per invocation)
- Batch processing: multiple PDFs generated in parallel across workers

---

## 6. Security Design

### 6.1 Data Classification

| Tier | Name | Content | Storage | Examples |
|------|------|---------|---------|---------|
| T1 | Public | Skills, specs, templates | Git (public repo) | SKILL.md, architecture docs |
| T2 | Internal | Company general data | Git (private subrepo) | Company info, work logs |
| T3 | Confidential | Business sensitive, personal | Git (private subrepo, git-crypt optional) | Accounting, employees, .env |
| T4 | Secret | Certificates, API keys | Outside git (.gitignore) | .pem, .p12, SMTP credentials |

### 6.2 Subprocess Security (Review Finding F1 — CRITICAL)

The TypeScript ↔ Python bridge uses **stdin IPC** instead of command-line arguments:

```
OLD (vulnerable):  spawn("python3", [script, JSON.stringify(args)])
NEW (secure):       persistent worker → stdin JSON → stdout JSON
```

- JSON Schema validation on all inputs before dispatch
- Worker process runs with restricted permissions
- 30s default timeout, configurable per skill
- Certificate/key paths via env vars, never in args

### 6.3 MCP Server Security (Review Finding F2 — HIGH)

MCP server manifest (`skill.json`) can specify arbitrary `mcp.command` to spawn. Mitigations:

- **Whitelist**: `config.yaml → security.mcp.allowed_commands` defines permitted binaries
- **Severity configurable**: User can lower to `medium` if whitelist is too restrictive
- **Future**: Signed manifests for distributed skill packages

### 6.4 Authentication (Review Finding F3 — HIGH)

| Connection | Auth Method | Transport |
|------------|-------------|-----------|
| naia-adk ↔ naia-os | Ed25519 device identity (reuse from naia-os) | TLS + WebSocket |
| naia-adk ↔ Web Dashboard | API Key | HTTPS |
| naia-adk ↔ MCP clients | API Key (future: OAuth) | TLS |

### 6.5 Encryption at Rest

```bash
# git-crypt for sensitive paths (optional, for team use)
git-crypt init
echo "data-private/envs/** filter=git-crypt diff=git-crypt" >> .gitattributes
echo "data-business/accounting/** filter=git-crypt diff=git-crypt" >> .gitattributes
git-crypt add-gpg-user luke@nextain.io
```

For 1-person company: separate private repos provide sufficient access control. git-crypt adds complexity without real benefit. Add when team grows.

### 6.6 Secret Management

- API keys, SMTP credentials → `.env` files in `data-private/envs/` (gitignored)
- Certificates, private keys → encrypted volume or hardware token
- Schema validation: `.agents/context/config.yaml` references env vars, never direct values
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
| Define `.agents/` spec | `docs/spec/*.md` | Schema validation script |
| Create runtime skeleton | `packages/core/src/` | `pnpm build` passes |
| Create SDK skeleton | `packages/sdk/src/` | `pnpm build` passes |
| Define skill execution contract | `packages/core/src/contract.ts` | Unit tests |
| Define trigger dispatch (keyword-first) | `packages/core/src/trigger.ts` | Unit tests |
| Implement EventBus | `packages/core/src/events.ts` | Unit tests |
| Implement Worker Pool | `packages/core/src/pool.ts` | Unit tests |
| Write README + AGENTS.md | Root files | Peer review |
| Create empty template | `templates/.agents/` | Structure matches spec |
| Bundle fonts in template | `templates/.agents/assets/fonts/` | Self-hostable, no download |

### Phase 2: nextain-adk Setup

**Goal**: Nextain workspace with context and existing payroll skill

| Task | Output | Verification |
|------|--------|-------------|
| Setup workspace structure | `data-company/`, `data-business/`, `data-private/` | Directories exist |
| Create `.agents/context/` | Nextain info (placeholder schema) | Schema valid |
| Setup git-crypt (optional) | `.gitattributes`, GPG key | `git-crypt lock/unlock` works |
| Migrate payroll skill | `skills/business/payroll/` | PDF generates with existing script |
| Create employee data | `data-business/accounting/employees.yaml` | Exists |
| Setup submodules | `data-company/docs-nextain/`, etc. | `git submodule status` OK |

### Phase 3: Contract Skill

**Goal**: 근로계약서 PDF 생성 + 디지털 서명

| Task | Output | Verification |
|------|--------|-------------|
| Create contract SKILL.md | `skills/business/contract/SKILL.md` | Execution contract valid |
| Create contract template | `templates/nextain-contract.md` | Template renders |
| Create ContractPDF class | `scripts/generate-pdf.py` | PDF generates |
| Setup self-signed cert | `naia cert generate` | Cert exists |
| Implement PAdES signing | `scripts/sign-pdf.py` | Signed PDF validates |
| Test: 통역사 계약 (10만원/시간) | Real contract PDF | Manual review |

### Phase 4: Expense Skill

**Goal**: 지출결의 + 영수증 OCR

| Task | Output | Verification |
|------|--------|-------------|
| Create expense SKILL.md | `skills/business/expense/SKILL.md` | Execution contract valid |
| Create resolution template | `templates/nextain-resolution.md` | Template renders |
| Create ResolutionPDF class | `scripts/generate-pdf.py` | PDF generates |
| Implement LLM Vision OCR | Receipt extraction | Accuracy test (10+ samples) |
| Receipt validation | File type, size, duplicate detection | Edge case tests |
| Test: AI 크래딧 지출결의 | Real resolution PDF | Manual review |
| Migrate 2026-001 | Existing expense data | Matches OneDrive records |

### Phase 5: naia-adk-business-pack Extraction

**Goal**: Extract common patterns into reusable extension pack

| Task | Output | Verification |
|------|--------|-------------|
| Identify reusable patterns | Document | Review |
| Create naia-adk-business-pack repo | Extension pack | `naia install business` works |
| Extract PDF engine | `packages/docgen/` | Tests pass |
| Extract business skills | `skills/business/` | Skills load |
| CLI: init, skill add, adapter connect | Working commands | Integration tests |

### Phase 6: Peer Review Integration

**Goal**: 3-CLI headless peer review as a reusable skill

| Task | Output | Verification |
|------|--------|-------------|
| Update review-pass SKILL.md | `--peer` mode | Spec valid |
| Create peer review runner | Shell script | 3 CLIs execute |
| Structured output schema | JSON schema for findings | Validation |
| Safety constraints | `--apply` flag, no auto-destructive changes | Tested |

### Phase 7: naia-os Integration

**Goal**: naia-adk serves as skill backend for naia-os

| Task | Output | Verification |
|------|--------|-------------|
| Implement MCP Server in runtime | `packages/core/src/mcp-server.ts` | naia-os can connect |
| Extract `@naia/skill-sdk` | Shared package | Types, registry, loader |
| Ed25519 authentication | Auth module | Handshake works |
| WebSocket transport | Gateway adapter | naia-os agent can invoke skills |
| Skill hot-reload | `unregister()` + `register()` lifecycle | Skills update without restart |

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
  - data-business/documents/contracts/{name}_2026-04-17.pdf (encrypted, digitally signed)
  - data-business/accounting/employees.yaml (updated, encrypted)
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
  - data-business/accounting/expenses/2026-001.pdf (digitally signed)
  - data-business/accounting/receipts/2026-001/ (receipt files)
  - data-business/accounting/expenses.yaml (updated)
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
| Python subprocess injection | Medium | Critical | stdin IPC, JSON Schema validation, worker isolation |
| MCP arbitrary process spawn | Low | High | Command whitelist, user-configurable severity |
| Git conflict in shared data | Medium | Medium | Batch commits, file locking strategy |

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

## 12. Performance Design

### 12.1 Worker Pool Pattern

Three independent worker pools for different I/O types:

| Pool | Workers | Purpose | Isolation |
|------|---------|---------|-----------|
| Python | 2-4 | PDF generation, signing | Subprocess, restricted FS |
| LLM | Configurable | Skill dispatch, OCR | API calls, rate-limited |
| Git | 1 | Commits, rollback | Sequential (git lock) |

### 12.2 Trigger Dispatch (Keyword-First)

```
User input → Local keyword/embedding match (instant)
  ↓ if ambiguous
  LLM classification (100-500ms)
  ↓
  Skill execution
```

Avoids LLM latency on clear matches. LLM used only as fallback.

### 12.3 Batch Commits

Instead of committing after each file write, accumulate changes per skill execution:

```
Skill starts → file writes → Skill ends → single commit with all changes
```

Rollback: if skill fails, revert the entire batch (atomic).

---

## 13. EventBus Architecture

All runtime operations emit events for monitoring, dashboard, and audit:

```typescript
interface NaiaEvent {
  type: "skill:start" | "skill:end" | "skill:error" | "commit:batch" | "worker:acquire" | "worker:release";
  timestamp: string;
  data: Record<string, unknown>;
}

// Subscribers:
// - Web Dashboard (SSE stream)
// - Audit log (JSONL file)
// - naia-os (WebSocket forwarding)
```

No extra API calls — events are in-process, zero-cost emission.

---

## 14. Schema Versioning

All config files include `schema_version`:

```yaml
# .agents/context/config.yaml
schema_version: "1"
```

Runtime validates schema version on load:
- Unknown version → warn + attempt best-effort parse
- Breaking version → error + migration guide

This enables forward/backward compatibility as the spec evolves.

---

## 15. Peer Review Log

### Round 1 (2026-04-19): Gemini + Claude (orchestrator)

**Verdict**: NEEDS_REVISION

| # | Finding | Severity | Source | Resolution |
|---|---------|----------|--------|------------|
| F1 | Python subprocess code injection | CRITICAL | Both | §5.3: stdin IPC + Worker Pool + Schema validation |
| F2 | MCP arbitrary process spawn | HIGH | CONTESTED→CONFIRMED | §6.3: Command whitelist, user-configurable |
| F3 | No auth naia-adk ↔ naia-os | HIGH | Both | §6.4: Ed25519 device identity |
| F4 | Python spawn overhead per PDF | HIGH | Both | §5.3: Worker Pool pattern |
| F5 | Web dashboard no auth | HIGH | Orchestrator | §6.4: API Key + HTTPS |
| F6 | LLM trigger dispatch latency | MEDIUM | Both | §12.2: Keyword-first, LLM fallback |
| F7 | Git commit per document | MEDIUM | Both | §12.3: Batch commits |
| F8 | No hot-reload | MEDIUM | Both | Phase 7: unregister/register lifecycle (see Phase 7 task table) |
| F9 | Git conflict resolution undefined | MEDIUM | Both | §12.3: Sequential git pool + file locking |
| F10 | Script sandbox missing | MEDIUM | Gemini | §5.3: Worker isolation |

**Applied changes**: All findings reflected in v3 of this document.

### Round 2 (2026-04-19): Re-review — CONVERGED

**Reviewer**: Gemini 2.5 Flash
**Verdict**: APPROVE
**Findings**: 0 — All 10 findings adequately addressed. Architecture coherent. Paths consistent.

> Note: Claude reviewer skipped (rate limit). Planning stage convergence = 1 clean round with R=1. Satisfied.

### Round 2 Claude (2026-04-19): APPROVE with observations

**Reviewer**: Claude Sonnet
**Verdict**: APPROVE
**Findings**: 2 MEDIUM + 4 LOW (no blockers)

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| C1 | LOW | §15 section number refs wrong (§10.x → §12.x) | Fixed |
| C2 | LOW | Phase 7 missing hot-reload task | Added |
| C3 | MEDIUM | `mcp.allowed_commands: []` semantics undefined | Added DENY ALL comment |
| C4 | LOW | `data-business/hr/` not in §2.3 structure | Changed to `data-business/documents/` |
| C5 | MEDIUM | Worker sandbox enforcement unspecified | Added sandbox note |
| C6 | LOW | Use case output path still had `hr/` | Fixed to `documents/` |

All observations resolved.

### Round 3-5 Gemini (2026-04-19): Final convergence

**Reviewer**: Gemini 2.5 Flash
**Verdict**: APPROVE (CLEAN)
**Findings**: 0 — All Claude observations resolved. No remaining inconsistencies.

**Final status: CONVERGED** (Gemini R2 + Claude R2 + Gemini R5 = 3 clean passes)

---

## Appendix A: Dependency Map

| Resource | Location | Usage |
|----------|----------|-------|
| Payroll PDF script | `skills/business/payroll/scripts/send_payroll.py` | Base PDF pattern |
| Company info | `data-business/docs-business/01. 회사 정보/base-info.md` | context source |
| Logo | `projects/about.nextain.io/public/assets/logos/` | PDF branding |
| Seal | `data-business/docs-business/07.증명서/` | PDF seal (separate from digital sig) |
| Existing accounting | OneDrive `넥스테인 회계/04.비용관리/` | Historical data source |
| Expense 2026-001 | `data-business/docs-business/06. 발급문서/지출결의서/` | Migration source |

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
