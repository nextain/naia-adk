import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { isMilestoneCompleted, partitionMilestones } from "./ScheduleCalendarSection.tsx"

const milestone = (id: string, completed: number, total: number) => ({
  id,
  name: id,
  completed,
  total,
  dueDate: null,
})

describe("milestone completion filtering", () => {
  it("completed milestones are partitioned from open milestones", () => {
    const result = partitionMilestones([milestone("done", 3, 3), milestone("open", 1, 3)])
    assert.deepEqual(result.completed.map((item) => item.id), ["done"])
    assert.deepEqual(result.incomplete.map((item) => item.id), ["open"])
  })

  it("zero-total milestones are not completed", () => {
    assert.equal(isMilestoneCompleted(milestone("empty", 0, 0)), false)
    assert.equal(isMilestoneCompleted(milestone("partial", 2, 3)), false)
    assert.equal(isMilestoneCompleted(milestone("done", 3, 3)), true)
  })
})
