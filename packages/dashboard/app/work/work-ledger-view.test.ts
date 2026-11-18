import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  filterLedgerCards,
  formatDueLabel,
  isSafeHttpUrl,
  normalizeWorkTab,
  sortLedgerCards,
  splitSummaryColumns,
  summarizeRoles,
  type LedgerCardItem,
} from "./work-ledger-view.ts"

function card(partial: Partial<LedgerCardItem> & { id: string }): LedgerCardItem {
  return {
    id: partial.id,
    role: partial.role ?? "minho",
    title: partial.title ?? partial.id,
    status: partial.status ?? "open",
    due: partial.due ?? "2026-11-18T12:00:00Z",
    dueDate: partial.dueDate ?? "2026-11-18",
    overdue: partial.overdue ?? false,
    isTodo: partial.isTodo ?? (partial.status === undefined || partial.status === "open" || partial.status === "waiting_human"),
    createdAt: null,
    checkedAt: partial.checkedAt ?? null,
    note: partial.note ?? "",
    channel: partial.channel ?? "100",
    msgId: partial.msgId ?? "200",
    quote: "",
    sourceUrl: partial.sourceUrl ?? null,
    resultLinks: partial.resultLinks ?? [],
    workerName: null,
    hasDrive: false,
  }
}

describe("work-ledger-view pure helpers", () => {
  it("sortLedgerCards places overdue active items first, then active upcoming, then closed", () => {
    const items = [
      card({ id: "done-1", status: "done", isTodo: false, due: "2026-11-10T00:00:00Z", checkedAt: "2026-11-18T01:00:00Z" }),
      card({ id: "upcoming-2", status: "open", overdue: false, due: "2026-11-20T00:00:00Z" }),
      card({ id: "overdue-later", status: "waiting_human", overdue: true, due: "2026-11-15T00:00:00Z" }),
      card({ id: "overdue-earlier", status: "open", overdue: true, due: "2026-11-14T00:00:00Z" }),
      card({ id: "upcoming-1", status: "open", overdue: false, due: "2026-11-19T00:00:00Z" }),
    ]
    assert.deepEqual(
      sortLedgerCards(items).map((i) => i.id),
      ["overdue-earlier", "overdue-later", "upcoming-1", "upcoming-2", "done-1"],
    )
  })

  it("filters by role, status, overdueOnly, and search query, and splits summary columns", () => {
    const items = [
      card({ id: "a", role: "minho", status: "open", overdue: true, title: "메신저 통합" }),
      card({ id: "b", role: "jina", status: "waiting_human", overdue: false, title: "화면 검수" }),
      card({ id: "c", role: "jina", status: "done", isTodo: false, overdue: false, title: "완료됨" }),
    ]
    assert.deepEqual(filterLedgerCards(items, { role: "jina", statusFilter: "todo" }).map((i) => i.id), ["b"])
    assert.deepEqual(filterLedgerCards(items, { overdueOnly: true }).map((i) => i.id), ["a"])
    assert.deepEqual(filterLedgerCards(items, { query: "메신저" }).map((i) => i.id), ["a"])

    const cols = splitSummaryColumns(items, { role: "jina" })
    assert.deepEqual(cols.openItems.map((i) => i.id), [])
    assert.deepEqual(cols.waitingItems.map((i) => i.id), ["b"])
    assert.deepEqual(cols.recentDoneItems.map((i) => i.id), ["c"])

    assert.deepEqual(summarizeRoles(items, ["alpha", "jina", "minho"]), [
      { role: "alpha", total: 0, todoCount: 0, overdueCount: 0 },
      { role: "jina", total: 2, todoCount: 1, overdueCount: 0 },
      { role: "minho", total: 1, todoCount: 1, overdueCount: 1 },
    ])
  })

  it("formats due labels and validates URLs and tabs safely", () => {
    const now = Date.parse("2026-11-18T06:00:00Z")
    assert.match(formatDueLabel("2026-11-16T06:00:00Z", true, now, "Asia/Seoul"), /2일 지남/)
    assert.equal(formatDueLabel(null, false, now), "기한 없음")
    assert.equal(normalizeWorkTab("detail", null), "detail")
    assert.equal(normalizeWorkTab(null, "archive"), "archive")
    assert.equal(normalizeWorkTab(null, null), "summary")
    assert.equal(isSafeHttpUrl("https://discord.com/channels/1/2/3"), true)
    assert.equal(isSafeHttpUrl("javascript:alert(1)"), false)
  })
})
