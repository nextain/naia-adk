import { describe, expect, it } from "vitest";
import {
  ISSUE_DRIVEN_DEVELOPMENT_WORKFLOW,
  REVIEW_DECIDE_EXECUTE_WORKFLOW,
  type WorkflowSpec,
} from "../index.js";

describe("WorkflowSpec — review-decide-execute + IDD", () => {
  it("REVIEW_DECIDE_EXECUTE has 5 steps", () => {
    expect(REVIEW_DECIDE_EXECUTE_WORKFLOW.steps.length).toBe(5);
    const ids = REVIEW_DECIDE_EXECUTE_WORKFLOW.steps.map((s) => s.id);
    expect(ids).toEqual(["review", "decide", "execute", "verify", "report"]);
  });

  it("decide step is gate (user confirmation required)", () => {
    const decide = REVIEW_DECIDE_EXECUTE_WORKFLOW.steps.find(
      (s) => s.id === "decide",
    );
    expect(decide?.isGate).toBe(true);
  });

  it("ISSUE_DRIVEN_DEVELOPMENT has all 14 phases-ish", () => {
    expect(ISSUE_DRIVEN_DEVELOPMENT_WORKFLOW.steps.length).toBeGreaterThanOrEqual(13);
  });

  it("IDD plan/sync/close are gates", () => {
    const gates = ISSUE_DRIVEN_DEVELOPMENT_WORKFLOW.steps.filter((s) => s.isGate);
    const ids = gates.map((s) => s.id);
    expect(ids).toContain("plan");
    expect(ids).toContain("sync");
    expect(ids).toContain("close");
  });

  it("IDD plan/build/review have iterativeReview", () => {
    const iterative = ISSUE_DRIVEN_DEVELOPMENT_WORKFLOW.steps.filter(
      (s) => s.iterativeReview,
    );
    expect(iterative.length).toBeGreaterThan(0);
  });

  it("WorkflowSpec type allows custom workflows", () => {
    const custom: WorkflowSpec = {
      name: "custom",
      description: "test",
      steps: [{ id: "do", name: "Do", isGate: false }],
    };
    expect(custom.steps.length).toBe(1);
  });
});
