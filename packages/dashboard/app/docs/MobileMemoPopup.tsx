"use client"

import React, { useState } from "react"
import { MessageSquarePlus, X } from "lucide-react"
import { createNote } from "./NotesPanel"
import { truncateQuote } from "./kinds"
import { useT } from "../i18n/provider.tsx"

// Floating memo action for touch selections (ported from the pre-11/24 docs
// UX). On phones a long-press never fires `mouseup`, so the docs view watches
// `selectionchange` and floats this button below the selected text. Tapping it
// opens an in-place sheet, so readers never scroll back to the top to leave a
// design/direction memo. Memos stay direction feedback, not formal approval.
export interface MobileMemoButtonProps {
  top: number
  left: number
  onOpen: () => void
}

export function MobileMemoButton({ top, left, onOpen }: MobileMemoButtonProps) {
  const t = useT()
  return (
    <button
      type="button"
      data-testid="mobile-memo-btn"
      data-print="hide"
      aria-label={t("docs.memo")}
      // Pressing the button clears the selection, but the screen only reflects
      // the selection change ~0.25s later, so `click` still lands first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
      style={{ position: "fixed", top, left, width: 112, height: 40, zIndex: 60 }}
      className="print:hidden inline-flex items-center justify-center gap-1.5 rounded-full bg-blue-600 active:bg-blue-500 text-sm font-semibold text-white shadow-lg shadow-black/50 border border-blue-400/40 select-none"
    >
      <MessageSquarePlus className="w-4 h-4" />
      {t("docs.memo")}
    </button>
  )
}

// In-place memo sheet opened from the floating button. The software keyboard
// slides up from the bottom, so the sheet sits at the top of the viewport.
export interface MobileMemoSheetProps {
  source: string
  path: string
  quote: string
  forbidden?: boolean
  forbiddenMessage?: string
  onClose: () => void
  onSaved?: () => void
  fetchFn?: typeof fetch
}

export function MobileMemoSheet({
  source,
  path,
  quote,
  forbidden = false,
  forbiddenMessage,
  onClose,
  onSaved,
  fetchFn,
}: MobileMemoSheetProps) {
  const t = useT()
  const [body, setBody] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Ignore backdrop taps right after opening: the tap that opened the sheet
  // would otherwise land on the backdrop and close it immediately.
  const [openedAt] = useState(() => Date.now())
  const quoted = truncateQuote(quote, 2000)

  const handleSave = async () => {
    if (!body.trim() || submitting) return
    setSubmitting(true)
    setError(null)
    const res = await createNote({ source, path, quote: quoted.trim() || null, body: body.trim(), fetchFn })
    setSubmitting(false)
    if (res.ok) {
      onSaved?.()
      onClose()
    } else {
      setError(res.error || t("docs.notesSaveFailed"))
    }
  }

  return (
    <div
      data-testid="mobile-memo-sheet"
      data-print="hide"
      role="dialog"
      aria-modal="true"
      aria-label={t("docs.memo")}
      className="print:hidden fixed inset-0 z-[70] flex items-start justify-center bg-black/50 p-2 pt-[max(0.5rem,env(safe-area-inset-top))]"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting && Date.now() - openedAt > 500) onClose()
      }}
    >
      <div className="w-full max-w-lg rounded-xl border border-neutral-700 bg-neutral-900 p-3 space-y-3 shadow-2xl">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-white">{t("docs.memo")}</span>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            disabled={submitting}
            className="p-1.5 -m-1.5 rounded text-neutral-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="text-xs text-neutral-400 max-h-20 overflow-y-auto border-l-2 border-blue-700 pl-2">
          <span className="italic">&quot;{truncateQuote(quoted, 300)}&quot;</span>
        </div>
        {forbidden ? (
          <p className="text-xs text-neutral-400">{forbiddenMessage}</p>
        ) : (
          <>
            <textarea
              data-testid="mobile-memo-input"
              value={body}
              autoFocus
              onChange={(e) => setBody(e.target.value)}
              disabled={submitting}
              placeholder={t("docs.notePlaceholder")}
              // 16px keeps the mobile keyboard from zooming the viewport.
              className="w-full h-28 p-2.5 rounded bg-neutral-950 border border-neutral-800 text-base text-neutral-200 focus:outline-none focus:border-neutral-600 resize-none"
            />
            {error && <p className="text-xs text-amber-400">{error}</p>}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="px-4 py-2 rounded bg-neutral-800 text-sm text-neutral-300"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                data-testid="mobile-memo-save"
                onClick={handleSave}
                disabled={submitting || !body.trim()}
                className="px-4 py-2 rounded bg-blue-600 text-sm font-medium text-white disabled:opacity-50"
              >
                {submitting ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
