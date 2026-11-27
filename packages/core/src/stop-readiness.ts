/**
 * No-early-stop harness policy contract.
 *
 * A harness (or hook) asks `evaluateStopReadiness(state, policy)` before
 * stopping an agent turn. The evaluator is pure and deterministic: the same
 * state + policy always yields the same verdict, so any ADK harness can
 * enforce the no-early-stop rule without bespoke logic. This module carries
 * only the generic contract — concrete route targets and thresholds live in
 * instance config, never here.
 */

/** No-early-stop policy: which pre-stop checks apply and where to escalate. */
export interface StopReadinessPolicy {
  schemaVersion: 1
  /** When true, open ledger items block stopping (when `stop_allowed_only_when_clear`). */
  check_open_ledger: boolean
  /** When true, unanswered messages block stopping (when `stop_allowed_only_when_clear`). */
  check_unanswered_messages: boolean
  /** Where to route each escalation class. Opaque target identifiers. */
  escalation_routes: {
    /** Route for harness/infra fixes. */
    infra_fix_target: string
    /** Route for human approvals. */
    human_approval_target: string
  }
  /**
   * When true, stopping is allowed only when every enabled check is clear.
   * When false, the evaluator still reports reasons/escalations but always
   * allows stopping (advisory mode).
   */
  stop_allowed_only_when_clear: boolean
}

/** Observable harness state examined before a stop. */
export interface StopReadinessState {
  /** Number of open (unresolved) ledger items. Non-negative integer. */
  open_ledger_count: number
  /** Number of unanswered inbound messages. Non-negative integer. */
  unanswered_message_count: number
  /** When true, a harness/infra fix is still pending. */
  needs_infra_fix?: boolean
  /** When true, a human approval is still pending. */
  needs_human_approval?: boolean
}

export type StopEscalationKind = "infra_fix" | "human_approval"

export interface StopEscalation {
  kind: StopEscalationKind
  /** Opaque route target taken from the policy's `escalation_routes`. */
  target: string
  /** Human-readable reason for the escalation. */
  detail: string
}

export interface StopReadinessResult {
  allowStop: boolean
  /** Every condition found; empty means fully clear. */
  reasons: string[]
  /** Required routing for pending infra/human needs; empty when none pending. */
  escalations: StopEscalation[]
}

export const STOP_READINESS_POLICY_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "ADK Stop Readiness (No-Early-Stop) Policy",
  type: "object",
  required: [
    "schemaVersion",
    "check_open_ledger",
    "check_unanswered_messages",
    "escalation_routes",
    "stop_allowed_only_when_clear",
  ],
  properties: {
    schemaVersion: { type: "integer", const: 1, description: "Schema version, must be 1" },
    check_open_ledger: { type: "boolean" },
    check_unanswered_messages: { type: "boolean" },
    escalation_routes: {
      type: "object",
      required: ["infra_fix_target", "human_approval_target"],
      properties: {
        infra_fix_target: { type: "string", description: "Route target for harness/infra fixes" },
        human_approval_target: { type: "string", description: "Route target for human approvals" },
      },
    },
    stop_allowed_only_when_clear: { type: "boolean" },
  },
} as const

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export function validateStopReadinessPolicy(
  raw: unknown,
): { valid: true; data: StopReadinessPolicy } | { valid: false; error: string } {
  const where = "stop-readiness policy"
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, error: `${where}: must be a JSON object` }
  }
  const obj = raw as Record<string, unknown>
  if (obj.schemaVersion !== 1) {
    return { valid: false, error: `${where}: schemaVersion must be 1` }
  }
  for (const key of ["check_open_ledger", "check_unanswered_messages", "stop_allowed_only_when_clear"] as const) {
    if (typeof obj[key] !== "boolean") {
      return { valid: false, error: `${where}: ${key} must be a boolean` }
    }
  }
  const routes = obj.escalation_routes
  if (typeof routes !== "object" || routes === null || Array.isArray(routes)) {
    return { valid: false, error: `${where}: escalation_routes must be an object` }
  }
  const routeObj = routes as Record<string, unknown>
  for (const key of ["infra_fix_target", "human_approval_target"] as const) {
    if (!isNonEmptyString(routeObj[key])) {
      return { valid: false, error: `${where}: escalation_routes.${key} must be a non-empty string` }
    }
  }
  return {
    valid: true,
    data: {
      schemaVersion: 1,
      check_open_ledger: obj.check_open_ledger as boolean,
      check_unanswered_messages: obj.check_unanswered_messages as boolean,
      escalation_routes: {
        infra_fix_target: (routeObj.infra_fix_target as string),
        human_approval_target: (routeObj.human_approval_target as string),
      },
      stop_allowed_only_when_clear: obj.stop_allowed_only_when_clear as boolean,
    },
  }
}

export function validateStopReadinessState(
  raw: unknown,
): { valid: true; data: StopReadinessState } | { valid: false; error: string } {
  const where = "stop-readiness state"
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, error: `${where}: must be a JSON object` }
  }
  const obj = raw as Record<string, unknown>
  for (const key of ["open_ledger_count", "unanswered_message_count"] as const) {
    const value = obj[key]
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return { valid: false, error: `${where}: ${key} must be a non-negative integer` }
    }
  }
  for (const key of ["needs_infra_fix", "needs_human_approval"] as const) {
    if (obj[key] !== undefined && typeof obj[key] !== "boolean") {
      return { valid: false, error: `${where}: ${key} must be a boolean when present` }
    }
  }
  return {
    valid: true,
    data: {
      open_ledger_count: obj.open_ledger_count as number,
      unanswered_message_count: obj.unanswered_message_count as number,
      ...(typeof obj.needs_infra_fix === "boolean" ? { needs_infra_fix: obj.needs_infra_fix } : {}),
      ...(typeof obj.needs_human_approval === "boolean" ? { needs_human_approval: obj.needs_human_approval } : {}),
    },
  }
}

function assertValidState(state: StopReadinessState): void {
  const checked = validateStopReadinessState(state)
  if (!checked.valid) throw new Error(checked.error)
}

function assertValidPolicy(policy: StopReadinessPolicy): void {
  const checked = validateStopReadinessPolicy(policy)
  if (!checked.valid) throw new Error(checked.error)
}

/**
 * Pure evaluator: decides whether a harness may stop, why not, and where to
 * escalate. Deterministic — no I/O, no clock, no randomness. Throws on
 * malformed state/policy (validate first with the validators above when the
 * input comes from outside the process).
 */
export function evaluateStopReadiness(
  state: StopReadinessState,
  policy: StopReadinessPolicy,
): StopReadinessResult {
  assertValidState(state)
  assertValidPolicy(policy)

  const reasons: string[] = []
  const escalations: StopEscalation[] = []

  if (policy.check_open_ledger && state.open_ledger_count > 0) {
    const unit = state.open_ledger_count === 1 ? "item" : "items"
    reasons.push(`${state.open_ledger_count} open ledger ${unit} still pending; resolve or hand off before stopping`)
  }
  if (policy.check_unanswered_messages && state.unanswered_message_count > 0) {
    const unit = state.unanswered_message_count === 1 ? "message" : "messages"
    reasons.push(
      `${state.unanswered_message_count} unanswered ${unit} still pending; answer or hand off before stopping`,
    )
  }
  if (state.needs_infra_fix === true) {
    reasons.push("a harness/infra fix is still pending")
    escalations.push({
      kind: "infra_fix",
      target: policy.escalation_routes.infra_fix_target,
      detail: "route the pending harness/infra fix to the infra fix target before stopping",
    })
  }
  if (state.needs_human_approval === true) {
    reasons.push("a human approval is still pending")
    escalations.push({
      kind: "human_approval",
      target: policy.escalation_routes.human_approval_target,
      detail: "route the pending human approval to the human approval target before stopping",
    })
  }

  const allowStop = policy.stop_allowed_only_when_clear ? reasons.length === 0 : true
  return { allowStop, reasons, escalations }
}
