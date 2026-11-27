"use client"

import React, { useEffect, useState } from "react"
import { fetchDecisions } from "./decisions-client"
import { DecisionsDrawer } from "./DecisionsDrawer"
import { formatMessage } from "../i18n/index.ts"
import { useT } from "../i18n/provider.tsx"

// Single amber human-review badge (`결재/확인 N`) + right-side quick drawer.
// `null` hides the badge (public domain or unreachable API); `0` shows subtly
// while keeping the drawer accessible. `initialCount` is a test seam: when set,
// no network fetch runs on mount.
export function DecisionsBadge({ initialCount }: { initialCount?: number | null }) {
  const t = useT()
  const [count, setCount] = useState<number | null>(initialCount ?? null)
  const [open, setOpen] = useState(false)

  const refresh = () => {
    fetchDecisions()
      .then((res) => {
        if (res.ok) setCount(res.snapshot.counts.total)
        else setCount(null)
      })
      .catch(() => setCount(null))
  }

  useEffect(() => {
    if (initialCount !== undefined) return
    refresh()
    const timer = setInterval(refresh, 60000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      {count !== null && (
        <button
          type="button"
          data-testid="decisions-badge"
          onClick={() => setOpen(true)}
          aria-label={formatMessage(t("nav.reviewBadge"), { count })}
          title={t("nav.reviewTitle")}
          aria-expanded={open}
          className={`whitespace-nowrap px-2 sm:px-3 py-1 sm:py-1.5 rounded-md text-[12px] sm:text-sm font-medium transition-colors ${
            count > 0
              ? "bg-amber-600 text-white hover:bg-amber-500"
              : "border border-amber-900/60 text-amber-400/70 hover:text-amber-300"
          }`}
        >
          {formatMessage(t("nav.reviewBadge"), { count })}
        </button>
      )}
      <DecisionsDrawer open={open} onClose={() => setOpen(false)} onChanged={refresh} />
    </>
  )
}
