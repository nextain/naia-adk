"use client"

import React, { Suspense, useCallback, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { WorkBoard } from "./WorkBoard"
import { normalizeWorkTab, type LedgerPayload } from "./work-ledger-view"

function WorkPageContent() {
  const searchParams = useSearchParams()
  const initialTab = normalizeWorkTab(searchParams?.get("tab"), searchParams?.get("view"))
  const initialRole = searchParams?.get("role") ?? ""

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [ledger, setLedger] = useState<LedgerPayload | null>(null)
  const [hasBoard, setHasBoard] = useState<boolean | null>(null)

  const loadData = useCallback(async () => {
    setStatus("loading")
    try {
      const [ledgerRes, portalRes] = await Promise.all([
        fetch("/api/portal/ledger", { cache: "no-store" }),
        fetch("/api/portal", { cache: "no-store" }).catch(() => null),
      ])
      if (!ledgerRes.ok) {
        throw new Error(`HTTP ${ledgerRes.status}`)
      }
      const ledgerJson = (await ledgerRes.json()) as LedgerPayload
      setLedger(ledgerJson)
      if (portalRes && portalRes.ok) {
        const portalJson = (await portalRes.json()) as { board?: { port?: number } | null }
        setHasBoard(Boolean(portalJson?.board?.port))
      } else {
        setHasBoard(false)
      }
      setStatus("ready")
    } catch {
      setStatus("error")
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  return (
    <WorkBoard
      key={`${initialTab}:${initialRole}`}
      status={status}
      ledger={ledger}
      hasBoard={hasBoard}
      initialTab={initialTab}
      initialRole={initialRole}
      onRefresh={() => void loadData()}
    />
  )
}

export default function WorkPage() {
  return (
    <Suspense fallback={<div className="py-12 text-center text-sm text-neutral-400">작업 보드 로딩 중...</div>}>
      <WorkPageContent />
    </Suspense>
  )
}
