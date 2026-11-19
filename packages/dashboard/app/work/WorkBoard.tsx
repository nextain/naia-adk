"use client"

import React, { useMemo, useState } from "react"
import Link from "next/link"
import { ExternalLink, FileText, RefreshCw, AlertTriangle } from "lucide-react"
import {
  DETAIL_STATUS_FILTERS,
  LEDGER_STATUS_LABEL,
  WORK_BOARD_TABS,
  filterLedgerCards,
  formatDueLabel,
  isSafeHttpUrl,
  isActiveStatus,
  isStalled,
  summarizeRoles,
  type DetailStatusFilter,
  type LedgerCardItem,
  type LedgerPayload,
  type LedgerStatus,
  type WorkBoardTab,
} from "./work-ledger-view.ts"

export interface WorkBoardProps {
  status: "loading" | "ready" | "error"
  ledger: LedgerPayload | null
  hasBoard: boolean | null
  initialTab?: WorkBoardTab
  initialRole?: string
  initialDetailStatus?: DetailStatusFilter
  initialOverdueOnly?: boolean
  initialQuery?: string
  nowMs?: number
  onRefresh?: () => void
}

export function statusBadgeClass(status: LedgerStatus): string {
  switch (status) {
    case "open":
      return "border-blue-800/80 bg-blue-950/60 text-blue-300"
    case "waiting_human":
      return "border-amber-800/80 bg-amber-950/60 text-amber-300"
    case "escalated_human":
      return "border-rose-700/80 bg-rose-950/70 text-rose-300"
    case "done":
      return "border-emerald-800/80 bg-emerald-950/60 text-emerald-300"
    case "dropped":
      return "border-neutral-700 bg-neutral-900 text-neutral-400"
  }
}

export function ResultLinksList({ item }: { item: LedgerCardItem }) {
  if (!item.resultLinks || item.resultLinks.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      {item.resultLinks.map((link, idx) => {
        if (link.kind === "doc" && link.href) {
          return (
            <Link
              key={`${item.id}-res-${idx}`}
              href={link.href}
              data-testid={`ledger-result-doc-${item.id}`}
              className="inline-flex items-center gap-1 rounded border border-emerald-800/70 bg-emerald-950/40 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-900/50 transition-colors"
            >
              <FileText className="w-3 h-3 shrink-0" />
              <span className="truncate max-w-[220px]">{link.label}</span>
            </Link>
          )
        }
        if (link.kind === "url" && isSafeHttpUrl(link.href)) {
          return (
            <a
              key={`${item.id}-res-${idx}`}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`ledger-result-url-${item.id}`}
              className="inline-flex items-center gap-1 rounded border border-emerald-800/70 bg-emerald-950/40 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-900/50 transition-colors"
            >
              <ExternalLink className="w-3 h-3 shrink-0" />
              <span className="truncate max-w-[220px]">{link.label}</span>
            </a>
          )
        }
        return (
          <span
            key={`${item.id}-res-${idx}`}
            className="inline-flex items-center gap-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-400"
            title="포털 문서 폴더 밖 결과 파일"
          >
            <FileText className="w-3 h-3 shrink-0" />
            <span className="truncate max-w-[220px]">{link.label}</span>
          </span>
        )
      })}
    </div>
  )
}

function LedgerCard({ item, nowMs }: { item: LedgerCardItem; nowMs?: number }) {
  const dueText = formatDueLabel(item.due, item.overdue, nowMs)
  return (
    <article
      data-testid={`ledger-card-${item.id}`}
      data-overdue={item.overdue ? "true" : "false"}
      data-role={item.role}
      className={`rounded-lg border p-3 space-y-2 transition-colors ${
        item.overdue
          ? "border-rose-700/80 bg-rose-950/20"
          : "border-neutral-800 bg-neutral-900/50 hover:border-neutral-700"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            data-testid={`ledger-role-${item.id}`}
            className="inline-flex items-center rounded-full border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-[11px] font-semibold text-neutral-100"
          >
            {item.role}
          </span>
          <span
            data-testid={`ledger-status-${item.id}`}
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusBadgeClass(item.status)}`}
          >
            {LEDGER_STATUS_LABEL[item.status]}
          </span>
          {isStalled(item, nowMs ?? Date.now()) && (
            <span data-testid={`ledger-stalled-${item.id}`} className="rounded-full border border-amber-700 px-2 py-0.5 text-[11px] text-amber-300">서 있음</span>
          )}
          {item.overdue && (
            <span
              data-testid={`ledger-overdue-${item.id}`}
              className="inline-flex items-center gap-1 rounded-full border border-rose-600/80 bg-rose-950/70 px-2 py-0.5 text-[11px] font-semibold text-rose-300"
            >
              <AlertTriangle className="w-3 h-3" />
              기한 넘음
            </span>
          )}
        </div>
        <span className={`text-[11px] font-mono ${item.overdue ? "text-rose-300 font-semibold" : "text-neutral-400"}`}>
          {dueText}
        </span>
      </div>

      <div className="text-sm font-medium text-white break-words">{item.title}</div>
      <div className="text-[11px] text-neutral-400">
        갱신: {item.updatedAt ?? "확인되지 않음"}
        {item.workerName && <span> · 일꾼: {item.workerName} ({item.workerAlive === true ? "살아 있음" : item.workerAlive === false ? "종료됨" : "상태 확인 불가"})</span>}
      </div>

      {item.note && (
        <p className="text-xs text-neutral-400 break-words whitespace-pre-wrap">{item.note}</p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[11px]">
        {isSafeHttpUrl(item.sourceUrl) ? (
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`ledger-source-link-${item.id}`}
            className="inline-flex items-center gap-1 rounded border border-blue-800/70 bg-blue-950/40 px-2 py-0.5 text-blue-300 hover:bg-blue-900/50 transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            원글 보기
          </a>
        ) : item.channel ? (
          <span className="text-neutral-500">채널 {item.channel}</span>
        ) : null}
        <span className="text-neutral-500 font-mono truncate max-w-[160px]" title={item.id}>
          {item.id}
        </span>
      </div>

      <ResultLinksList item={item} />
    </article>
  )
}

export function WorkBoard({
  status,
  ledger,
  hasBoard,
  initialTab = "summary",
  initialRole = "",
  initialDetailStatus = "todo",
  initialOverdueOnly = false,
  initialQuery = "",
  nowMs,
  onRefresh,
}: WorkBoardProps) {
  const [activeTab, setActiveTab] = useState<WorkBoardTab>(initialTab)
  const [selectedRole, setSelectedRole] = useState<string>(initialRole)
  const [detailStatus, setDetailStatus] = useState<DetailStatusFilter>(initialDetailStatus)
  const [overdueOnly, setOverdueOnly] = useState<boolean>(initialOverdueOnly)
  const [query, setQuery] = useState<string>(initialQuery)

  const items = ledger?.items ?? []
  const roleBuckets = useMemo(
    () => summarizeRoles(items, ledger?.roles ?? []),
    [items, ledger?.roles],
  )
  const visibleActiveItems = useMemo(
    () => filterLedgerCards(items, { role: selectedRole, overdueOnly, query }).filter((item) => isActiveStatus(item.status)),
    [items, selectedRole, overdueOnly, query],
  )
  const detailItems = useMemo(
    () => filterLedgerCards(items, { role: selectedRole, statusFilter: detailStatus, overdueOnly, query }),
    [items, selectedRole, detailStatus, overdueOnly, query],
  )

  if (status === "loading") {
    return (
      <div data-testid="work-loading" className="py-12 text-center text-sm text-neutral-400">
        업무 장부를 불러오는 중입니다...
      </div>
    )
  }

  if (status === "error") {
    return (
      <div data-testid="work-error" className="p-6 rounded-lg border border-red-900/60 bg-red-950/30 text-sm text-red-300 space-y-3">
        <p>업무 장부를 불러오지 못했습니다.</p>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 rounded border border-red-800 px-3 py-1.5 text-xs hover:bg-red-950"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            다시 불러오기
          </button>
        )}
      </div>
    )
  }

  // 장부 설정이 없는 서버는 옛 작업보드 화면 그대로 띄운다.
  if (!ledger || !ledger.configured) {
    return (
      <iframe
        src="/board/index.html"
        title="작업보드"
        data-testid="legacy-board-iframe"
        className="fixed inset-x-0 top-14 h-[calc(100dvh-3.5rem)] w-full border-0 bg-neutral-950"
      />
    )
  }

  const summary = ledger.summary

  return (
    <div data-testid="work-ledger-board" className="space-y-5">
      {/* 상단 제목 및 요약 지표 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-white">작업 보드</h1>
            <span className="rounded-full border border-neutral-700 bg-neutral-900 px-2.5 py-0.5 text-xs text-neutral-300">
              업무 장부 · 읽기 전용
            </span>
          </div>
          <p className="text-xs text-neutral-400 mt-1">
            역할별 열린 작업입니다. 기한이 넘은 항목이 먼저 옵니다.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              data-testid="work-refresh-btn"
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-800 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              새로고침
            </button>
          )}
        </div>
      </div>

      {/* 경고 배너 (장부 파일 일부 읽기 실패 등) */}
      {(!ledger.available || ledger.warnings.length > 0) && (
        <div
          data-testid="work-warnings"
          className="rounded-lg border border-amber-800/70 bg-amber-950/30 px-4 py-2.5 text-xs text-amber-300 space-y-1"
        >
          {!ledger.available && <p>업무 장부 설정을 읽을 수 없습니다.</p>}
          {ledger.warnings.slice(0, 5).map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}

      {/* 핵심 지표 카드 */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
          <div className="text-xs text-neutral-400">할 일 (열림+대기)</div>
          <div data-testid="summary-todo-count" className="text-2xl font-bold text-white mt-1">
            {summary.todoCount}
          </div>
        </div>
        <div className="rounded-lg border border-rose-900/60 bg-rose-950/20 p-3">
          <div className="text-xs text-rose-300">기한 넘음</div>
          <div data-testid="summary-overdue-count" className="text-2xl font-bold text-rose-300 mt-1">
            {summary.overdue}
          </div>
        </div>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
          <div className="text-xs text-neutral-400">진행 중</div>
          <div className="text-2xl font-bold text-blue-300 mt-1">{summary.open}</div>
        </div>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
          <div className="text-xs text-neutral-400">사람 확인 대기</div>
          <div className="text-2xl font-bold text-amber-300 mt-1">{summary.waiting_human}</div>
        </div>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
          <div className="text-xs text-neutral-400">완료 · 취소</div>
          <div className="text-2xl font-bold text-neutral-300 mt-1">{summary.done + summary.dropped}</div>
        </div>
      </div>

      {/* 보기 탭: 요약 / 상세 / 보관(옛 대기열) */}
      <div role="tablist" aria-label="작업 보드 보기" className="flex items-center gap-1 border-b border-neutral-800">
        {WORK_BOARD_TABS.map((tab) => {
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`work-tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
                active
                  ? "border-blue-500 text-white"
                  : "border-transparent text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* 역할 필터 + 검색 (요약/상세 탭에서만) */}
      {activeTab !== "archive" && (
        <div className="space-y-2.5 rounded-lg border border-neutral-800 bg-neutral-950 p-3">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="역할별 거르기">
            <button
              type="button"
              data-testid="role-filter-all"
              aria-pressed={selectedRole === ""}
              onClick={() => setSelectedRole("")}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                selectedRole === ""
                  ? "border-blue-600 bg-blue-950/70 text-blue-200"
                  : "border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700"
              }`}
            >
              전체 역할 ({summary.todoCount})
            </button>
            {roleBuckets.map((rb) => {
              const active = selectedRole === rb.role
              return (
                <button
                  key={rb.role}
                  type="button"
                  data-testid={`role-filter-${rb.role}`}
                  aria-pressed={active}
                  onClick={() => setSelectedRole(active ? "" : rb.role)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    active
                      ? "border-blue-600 bg-blue-950/70 text-blue-200"
                      : "border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700"
                  }`}
                >
                  {rb.role} ({rb.todoCount})
                  {rb.overdueCount > 0 && (
                    <span className="ml-1 text-rose-300">· 넘음 {rb.overdueCount}</span>
                  )}
                </button>
              )
            })}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="제목·메모·ID 검색"
              aria-label="작업 검색"
              data-testid="work-search-input"
              className="flex-1 min-w-[200px] rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-500 focus:border-neutral-600 focus:outline-none"
            />
            <label className="inline-flex items-center gap-1.5 text-xs text-neutral-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={overdueOnly}
                onChange={(e) => setOverdueOnly(e.target.checked)}
                data-testid="work-overdue-only"
                className="accent-rose-500"
              />
              기한 넘은 것만
            </label>
          </div>
        </div>
      )}

      {/* 역할별 열린 작업 */}
      {activeTab === "summary" && (
        <div data-testid="work-summary-view" className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
          {roleBuckets.filter((bucket) => !selectedRole || bucket.role === selectedRole).map((bucket) => {
            const roleItems = visibleActiveItems.filter((item) => item.role === bucket.role)
            return (
              <section key={bucket.role} data-testid={`role-column-${bucket.role}`} className="rounded-lg border border-neutral-800 bg-neutral-950 p-3 space-y-3">
                <div className="border-b border-neutral-800 pb-2">
                  <h2 className="text-sm font-semibold text-white">{bucket.role}</h2>
                  <p className="text-xs text-neutral-400">열린 작업 {bucket.todoCount} · 기한 넘음 {bucket.overdueCount}</p>
                </div>
                <div className="space-y-2.5 max-h-[65vh] overflow-y-auto pr-1">
                  {roleItems.length === 0 ? <p className="py-6 text-center text-xs text-neutral-500">열린 작업이 없습니다.</p> : roleItems.map((item) => <LedgerCard key={`${item.role}:${item.id}`} item={item} nowMs={nowMs} />)}
                </div>
              </section>
            )
          })}
        </div>
      )}

      {/* 2. 상세 탭 */}
      {activeTab === "detail" && (
        <div data-testid="work-detail-view" className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="상태별 거르기">
            {DETAIL_STATUS_FILTERS.map((sf) => {
              const active = detailStatus === sf.id
              return (
                <button
                  key={sf.id}
                  type="button"
                  data-testid={`detail-status-${sf.id}`}
                  aria-pressed={active}
                  onClick={() => setDetailStatus(sf.id)}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                    active
                      ? "border-blue-600 bg-blue-950/70 text-blue-200"
                      : "border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200"
                  }`}
                >
                  {sf.label}
                </button>
              )
            })}
            <span className="ml-auto text-xs text-neutral-400">{detailItems.length}건</span>
          </div>

          <div className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950">
            <table className="min-w-full divide-y divide-neutral-800 text-xs">
              <thead className="bg-neutral-900/80 text-neutral-400">
                <tr>
                  <th className="px-3 py-2.5 text-left font-semibold">담당</th>
                  <th className="px-3 py-2.5 text-left font-semibold">상태</th>
                  <th className="px-3 py-2.5 text-left font-semibold">제목 · 메모</th>
                  <th className="px-3 py-2.5 text-left font-semibold">기한</th>
                  <th className="px-3 py-2.5 text-left font-semibold">원글</th>
                  <th className="px-3 py-2.5 text-left font-semibold">결과 문서</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800/80">
                {detailItems.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-neutral-500">
                      조건에 맞는 작업 줄이 없습니다.
                    </td>
                  </tr>
                ) : (
                  detailItems.map((item) => (
                    <tr
                      key={`${item.role}:${item.id}`}
                      data-testid={`detail-row-${item.id}`}
                      className={item.overdue ? "bg-rose-950/15" : "hover:bg-neutral-900/40"}
                    >
                      <td className="px-3 py-2.5 align-top whitespace-nowrap">
                        <span className="inline-flex rounded-full border border-neutral-700 bg-neutral-800 px-2 py-0.5 font-semibold text-neutral-100">
                          {item.role}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 align-top whitespace-nowrap">
                        <div className="flex flex-col gap-1 items-start">
                          <span className={`inline-flex rounded-full border px-2 py-0.5 font-medium ${statusBadgeClass(item.status)}`}>
                            {LEDGER_STATUS_LABEL[item.status]}
                          </span>
                          {item.overdue && (
                            <span className="inline-flex rounded-full border border-rose-600/80 bg-rose-950/70 px-2 py-0.5 font-semibold text-rose-300">
                              기한 넘음
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 align-top min-w-[260px] max-w-[440px]">
                        <div className="font-medium text-white break-words">{item.title}</div>
                        {item.note && <div className="text-neutral-400 mt-0.5 break-words">{item.note}</div>}
                        <div className="text-[10px] text-neutral-500 font-mono mt-0.5">{item.id}</div>
                      </td>
                      <td className={`px-3 py-2.5 align-top whitespace-nowrap font-mono ${item.overdue ? "text-rose-300 font-semibold" : "text-neutral-300"}`}>
                        {formatDueLabel(item.due, item.overdue, nowMs)}
                      </td>
                      <td className="px-3 py-2.5 align-top whitespace-nowrap">
                        {isSafeHttpUrl(item.sourceUrl) ? (
                          <a
                            href={item.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-blue-300 hover:underline"
                          >
                            <ExternalLink className="w-3 h-3" />
                            원글
                          </a>
                        ) : (
                          <span className="text-neutral-500">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 align-top min-w-[180px]">
                        {item.resultLinks.length > 0 ? <ResultLinksList item={item} /> : <span className="text-neutral-500">-</span>}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3. 보관(옛 대기열) 탭 */}
      {activeTab === "archive" && (
        <div data-testid="work-archive-view">
          {hasBoard === false ? (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-6 text-center text-sm text-neutral-400">
              연결된 옛 대기열 작업보드(naia-comm)가 없습니다.
            </div>
          ) : (
            <iframe
              src="/board/index.html"
              title="보관(옛 대기열)"
              data-testid="archive-board-iframe"
              className="w-full h-[calc(100dvh-16rem)] min-h-[480px] rounded-lg border border-neutral-800 bg-neutral-950"
            />
          )}
        </div>
      )}
    </div>
  )
}
