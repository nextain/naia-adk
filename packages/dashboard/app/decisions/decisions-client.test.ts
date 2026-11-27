import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  countsOf,
  decisionHref,
  groupDecisionsByKind,
  workDecisionId,
  type DecisionItem,
} from "./decisions-client.ts"

const item = (over: Partial<DecisionItem> & { id: string; kind: DecisionItem["kind"] }): DecisionItem => ({
  decisionId: over.id,
  status: "pending",
  title: over.id,
  detail: null,
  source: null,
  path: null,
  url: null,
  actor: null,
  method: null,
  createdAt: null,
  updatedAt: null,
  ...over,
})

describe("decisions-client (pure helpers)", () => {
  it("countsOf tallies kinds and total", () => {
    const counts = countsOf([
      item({ id: "a1", kind: "approval" }),
      item({ id: "n1", kind: "note" }),
      item({ id: "w1", kind: "work" }),
      item({ id: "p1", kind: "publish" }),
    ])
    assert.deepEqual(counts, { total: 4, approvals: 1, notes: 1, workWaits: 1, publish: 1 })
    assert.deepEqual(countsOf([]), { total: 0, approvals: 0, notes: 0, workWaits: 0, publish: 0 })
  })

  it("groupDecisionsByKind buckets every kind", () => {
    const groups = groupDecisionsByKind([
      item({ id: "a1", kind: "approval" }),
      item({ id: "n1", kind: "note" }),
    ])
    assert.equal(groups.approval.length, 1)
    assert.equal(groups.note.length, 1)
    assert.equal(groups.work.length, 0)
    assert.equal(groups.publish.length, 0)
  })

  it("decisionHref links notes to /docs and work waits to /decisions", () => {
    assert.equal(
      decisionHref(item({ id: "note:1", kind: "note", source: "adk", path: "a.md" })),
      "/docs?source=adk&path=a.md",
    )
    assert.equal(decisionHref(item({ id: "note:1", kind: "note" })), null)
    assert.equal(
      decisionHref(item({ id: "work:helper:w1", kind: "work" })),
      "/decisions?item=work%3Ahelper%3Aw1",
    )
    assert.equal(decisionHref(item({ id: "approval:1", kind: "approval" })), null)
  })

  it("workDecisionId builds the namespaced work item id", () => {
    assert.equal(workDecisionId("helper", "w1"), "work:helper:w1")
  })
})
