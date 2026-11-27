import { describe, it, expect } from "vitest"
import {
  validateStopReadinessPolicy,
  validateStopReadinessState,
  evaluateStopReadiness,
} from "../stop-readiness.js"

const VALID_POLICY = {
  schemaVersion: 1,
  check_open_ledger: true,
  check_unanswered_messages: true,
  escalation_routes: {
    infra_fix_target: "route:infra-fix",
    human_approval_target: "route:human-approval",
  },
  stop_allowed_only_when_clear: true,
}

const CLEAR_STATE = {
  open_ledger_count: 0,
  unanswered_message_count: 0,
}

describe("validateStopReadinessPolicy", () => {
  it("accepts a fully valid policy", () => {
    const res = validateStopReadinessPolicy(VALID_POLICY)
    expect(res.valid).toBe(true)
    if (res.valid) {
      expect(res.data.escalation_routes.infra_fix_target).toBe("route:infra-fix")
    }
  })

  it("rejects non-objects and wrong schemaVersion", () => {
    expect(validateStopReadinessPolicy(null).valid).toBe(false)
    expect(validateStopReadinessPolicy([]).valid).toBe(false)
    expect(validateStopReadinessPolicy({ ...VALID_POLICY, schemaVersion: 2 }).valid).toBe(false)
  })

  it("rejects non-boolean checks and flags", () => {
    expect(validateStopReadinessPolicy({ ...VALID_POLICY, check_open_ledger: 1 }).valid).toBe(false)
    expect(validateStopReadinessPolicy({ ...VALID_POLICY, check_unanswered_messages: "yes" }).valid).toBe(false)
    expect(validateStopReadinessPolicy({ ...VALID_POLICY, stop_allowed_only_when_clear: 0 }).valid).toBe(false)
  })

  it("rejects missing or empty escalation routes", () => {
    expect(validateStopReadinessPolicy({ ...VALID_POLICY, escalation_routes: undefined }).valid).toBe(false)
    const emptyInfra = {
      ...VALID_POLICY,
      escalation_routes: { infra_fix_target: "  ", human_approval_target: "route:human-approval" },
    }
    expect(validateStopReadinessPolicy(emptyInfra).valid).toBe(false)
    const emptyHuman = {
      ...VALID_POLICY,
      escalation_routes: { infra_fix_target: "route:infra-fix", human_approval_target: "" },
    }
    expect(validateStopReadinessPolicy(emptyHuman).valid).toBe(false)
  })
})

describe("validateStopReadinessState", () => {
  it("accepts counts with optional pending flags", () => {
    expect(
      validateStopReadinessState({ ...CLEAR_STATE, needs_infra_fix: true, needs_human_approval: false }).valid,
    ).toBe(true)
  })

  it("rejects negative, fractional, or non-numeric counts", () => {
    expect(validateStopReadinessState({ ...CLEAR_STATE, open_ledger_count: -1 }).valid).toBe(false)
    expect(validateStopReadinessState({ ...CLEAR_STATE, unanswered_message_count: 1.5 }).valid).toBe(false)
    expect(validateStopReadinessState({ ...CLEAR_STATE, open_ledger_count: "3" }).valid).toBe(false)
    expect(validateStopReadinessState({}).valid).toBe(false)
  })

  it("rejects non-boolean pending flags", () => {
    expect(validateStopReadinessState({ ...CLEAR_STATE, needs_infra_fix: 1 }).valid).toBe(false)
  })
})

describe("evaluateStopReadiness", () => {
  it("allows stopping when every enabled check is clear", () => {
    const res = evaluateStopReadiness(CLEAR_STATE, VALID_POLICY)
    expect(res).toEqual({ allowStop: true, reasons: [], escalations: [] })
  })

  it("blocks stopping on open ledger items", () => {
    const res = evaluateStopReadiness({ ...CLEAR_STATE, open_ledger_count: 2 }, VALID_POLICY)
    expect(res.allowStop).toBe(false)
    expect(res.reasons).toHaveLength(1)
    expect(res.reasons[0]).toContain("2 open ledger items")
    expect(res.escalations).toEqual([])
  })

  it("blocks stopping on unanswered messages and uses singular wording for one", () => {
    const res = evaluateStopReadiness({ ...CLEAR_STATE, unanswered_message_count: 1 }, VALID_POLICY)
    expect(res.allowStop).toBe(false)
    expect(res.reasons[0]).toContain("1 unanswered message still pending")
  })

  it("skips disabled checks", () => {
    const policy = { ...VALID_POLICY, check_open_ledger: false, check_unanswered_messages: false }
    const res = evaluateStopReadiness({ open_ledger_count: 5, unanswered_message_count: 7 }, policy)
    expect(res).toEqual({ allowStop: true, reasons: [], escalations: [] })
  })

  it("routes pending infra fixes and human approvals to the configured targets", () => {
    const res = evaluateStopReadiness(
      { ...CLEAR_STATE, needs_infra_fix: true, needs_human_approval: true },
      VALID_POLICY,
    )
    expect(res.allowStop).toBe(false)
    expect(res.reasons).toHaveLength(2)
    expect(res.escalations).toEqual([
      {
        kind: "infra_fix",
        target: "route:infra-fix",
        detail: expect.stringContaining("infra fix"),
      },
      {
        kind: "human_approval",
        target: "route:human-approval",
        detail: expect.stringContaining("human approval"),
      },
    ])
  })

  it("is advisory when stop_allowed_only_when_clear is false", () => {
    const policy = { ...VALID_POLICY, stop_allowed_only_when_clear: false }
    const res = evaluateStopReadiness(
      { open_ledger_count: 3, unanswered_message_count: 1, needs_human_approval: true },
      policy,
    )
    expect(res.allowStop).toBe(true)
    expect(res.reasons).toHaveLength(3)
    expect(res.escalations).toHaveLength(1)
    expect(res.escalations[0].kind).toBe("human_approval")
  })

  it("is deterministic for identical inputs", () => {
    const state = { open_ledger_count: 1, unanswered_message_count: 2, needs_infra_fix: true }
    expect(evaluateStopReadiness(state, VALID_POLICY)).toEqual(evaluateStopReadiness(state, VALID_POLICY))
  })

  it("throws on malformed state or policy", () => {
    expect(() => evaluateStopReadiness({ open_ledger_count: -1, unanswered_message_count: 0 }, VALID_POLICY)).toThrow()
    expect(() => evaluateStopReadiness(CLEAR_STATE, { ...VALID_POLICY, schemaVersion: 9 })).toThrow()
  })
})
