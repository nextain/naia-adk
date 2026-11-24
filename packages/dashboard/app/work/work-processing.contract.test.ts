import assert from "node:assert/strict"
import fs from "node:fs"
import { describe, it } from "node:test"

const workBoardSource = fs.readFileSync(new URL("./WorkBoard.tsx", import.meta.url), "utf8")

describe("processing board render contract", () => {
  it("keeps the processing KPI and dedicated section wired to processing cards", () => {
    assert.match(workBoardSource, /data-testid=\"work-kpi-processing\"/)
    assert.match(workBoardSource, /data-testid=\"work-processing-section\"/)
    assert.match(workBoardSource, /summaryColumns\.processingItems\.length === 0/)
    assert.match(workBoardSource, /summaryColumns\.processingItems\.map\(/)
    assert.match(workBoardSource, /data-testid=\{`work-processing-card-\$\{item\.id\}`\}/)
    assert.match(workBoardSource, /maxSubagents !== null \? `/)
  })

  it("keeps the processing detail filter and worker card metadata wired", () => {
    assert.match(workBoardSource, /detailStatusFilters\(locale\)/)
    assert.match(workBoardSource, /data-testid=\{`detail-status-\$\{sf\.id\}`\}/)
    assert.match(workBoardSource, /item\.workerName/)
    assert.match(workBoardSource, /item\.resultLinks\.map\(/)
  })
})
