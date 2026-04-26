/**
 * @naia-adk/process — Workflow spec for naia instances.
 *
 * 4-repo 책임 (LOCK 2026-04-26):
 *   - naia-adk process (본 pkg) = workflow spec (정적 패턴)
 *   - naia-agent supervisor = workflow 실행 (orchestration)
 *
 * Phase 4.0 = spec/skeleton only. 실 enforcement는 naia-agent supervisor.
 */

export type WorkflowGate =
  | "understand"
  | "scope"
  | "plan"
  | "build"
  | "review"
  | "test"
  | "sync"
  | "report"
  | "commit";

export interface WorkflowStep {
  id: string;
  name: string;
  /** Gate type — user confirmation required? */
  isGate: boolean;
  /** Iterative review (TWO consecutive passes) — naia-os IDD pattern */
  iterativeReview?: boolean;
  description?: string;
}

export interface WorkflowSpec {
  name: string;
  description: string;
  steps: readonly WorkflowStep[];
}

/**
 * Default review→decide→execute workflow (naia 기본 협업 패턴).
 * 사용자가 (1) 검토 → (2) 결정 → (3) AI가 실행 → (4) 보고
 */
export const REVIEW_DECIDE_EXECUTE_WORKFLOW: WorkflowSpec = {
  name: "review-decide-execute",
  description: "사용자 검토 → 결정 → AI 실행 → 정직 보고. 단일 대화창에서 완성.",
  steps: [
    {
      id: "review",
      name: "검토 (사용자 또는 AI 분석)",
      isGate: false,
    },
    {
      id: "decide",
      name: "결정 (사용자 confirmation)",
      isGate: true,
    },
    {
      id: "execute",
      name: "실행 (AI 수행)",
      isGate: false,
      iterativeReview: false,
    },
    {
      id: "verify",
      name: "검증 (자동 test/lint/build)",
      isGate: false,
    },
    {
      id: "report",
      name: "정직 보고 (수치 기반)",
      isGate: false,
    },
  ],
};

/**
 * Issue-Driven Development workflow (naia-os AGENTS.md 14 phases simplified).
 * Phase 4.0+ 적용 — 본 pkg는 spec only, naia-agent supervisor가 enforce.
 */
export const ISSUE_DRIVEN_DEVELOPMENT_WORKFLOW: WorkflowSpec = {
  name: "issue-driven-development",
  description: "GitHub Issue로 작업 단위 추적. 단계별 gate + iterative review.",
  steps: [
    { id: "issue", name: "Issue 생성", isGate: false },
    { id: "understand", name: "Understand", isGate: true },
    { id: "scope", name: "Scope", isGate: true },
    { id: "investigate", name: "Investigate", isGate: false },
    { id: "plan", name: "Plan", isGate: true, iterativeReview: true },
    { id: "build", name: "Build", isGate: false, iterativeReview: true },
    { id: "review", name: "Review (TWO consecutive passes)", isGate: false, iterativeReview: true },
    { id: "test", name: "E2E Test", isGate: false },
    { id: "post-test-review", name: "Post-test Review", isGate: false, iterativeReview: true },
    { id: "sync", name: "Sync (.agents/ ↔ .users/)", isGate: true },
    { id: "report", name: "Report", isGate: false },
    { id: "commit", name: "Commit + PR", isGate: false },
    { id: "close", name: "Close (gate)", isGate: true },
  ],
};
