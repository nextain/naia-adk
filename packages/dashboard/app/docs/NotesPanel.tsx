"use client"

import React, { useEffect, useState } from "react"
import Link from "next/link"
import { MessageSquare, CheckCircle, RotateCcw, X } from "lucide-react"
import {
  getFileName,
  getOpenNotesBannerText,
  mapNotesError,
  MSG_FORBIDDEN,
  MSG_QUOTE_WHOLE_DOC,
  sortNotes,
  type DocNoteItem,
} from "./kinds"
import { docHref, type DocTab } from "./tabs"

// ── API 함수들 ──────────────────────────────────────────────────────────────
export async function createNote(params: {
  source: string
  path: string
  quote: string | null
  body: string
  fetchFn?: typeof fetch
}): Promise<{ ok: boolean; status: number; note?: DocNoteItem; error?: string }> {
  const fetcher = params.fetchFn ?? fetch
  try {
    const res = await fetcher("/api/portal/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: params.source,
        path: params.path,
        quote: params.quote || null,
        body: params.body,
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (res.ok) {
      return { ok: true, status: res.status, note: json.note }
    }
    return { ok: false, status: res.status, error: mapNotesError(res.status, json) }
  } catch {
    return { ok: false, status: 0, error: "메모를 저장하지 못했습니다." }
  }
}

export async function updateNote(params: {
  id: string
  body?: string
  status?: "open" | "resolved"
  fetchFn?: typeof fetch
}): Promise<{ ok: boolean; status: number; note?: DocNoteItem; error?: string }> {
  const fetcher = params.fetchFn ?? fetch
  try {
    const res = await fetcher(`/api/portal/notes/${encodeURIComponent(params.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(params.body !== undefined ? { body: params.body } : {}),
        ...(params.status !== undefined ? { status: params.status } : {}),
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (res.ok) {
      return { ok: true, status: res.status, note: json.note }
    }
    return { ok: false, status: res.status, error: mapNotesError(res.status, json) }
  } catch {
    return { ok: false, status: 0, error: "메모를 변경하지 못했습니다." }
  }
}

export async function deleteNote(params: {
  id: string
  fetchFn?: typeof fetch
}): Promise<{ ok: boolean; status: number; error?: string }> {
  const fetcher = params.fetchFn ?? fetch
  try {
    const res = await fetcher(`/api/portal/notes/${encodeURIComponent(params.id)}`, {
      method: "DELETE",
    })
    if (res.ok) {
      return { ok: true, status: res.status }
    }
    const json = await res.json().catch(() => ({}))
    return { ok: false, status: res.status, error: mapNotesError(res.status, json) }
  } catch {
    return { ok: false, status: 0, error: "메모를 삭제하지 못했습니다." }
  }
}

// ── 상단 배너 컴포넌트 (SP-05) ──────────────────────────────────────────────
export interface NotesBannerProps {
  openNotes: DocNoteItem[]
  tab: DocTab
  onNavigate?: (targetHref: string) => boolean
}

export function NotesBanner({ openNotes, tab, onNavigate }: NotesBannerProps) {
  const [modalOpen, setModalOpen] = useState(false)
  const openCount = openNotes.length

  if (openCount === 0) return null

  return (
    <>
      <div className="w-full">
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="w-full text-left px-4 py-2.5 rounded-lg bg-blue-950/40 border border-blue-900/60 text-blue-300 text-xs font-medium flex items-center justify-between hover:bg-blue-900/40 transition-colors"
        >
          <span>{getOpenNotesBannerText(openCount)}</span>
          <span className="text-[11px] text-blue-400 font-normal">목록 보기 →</span>
        </button>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-xl max-h-[80vh] flex flex-col rounded-xl bg-neutral-950 border border-neutral-800 p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
              <h2 className="text-base font-semibold text-white">전체 열린 메모 ({openCount}건)</h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="p-1 rounded text-neutral-400 hover:text-white hover:bg-neutral-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="overflow-y-auto space-y-3 pr-1">
              {openNotes.map((note) => {
                const targetHref = docHref(tab, note.source, note.path)
                return (
                  <Link
                    key={note.id}
                    href={targetHref}
                    onClick={(e) => {
                      if (onNavigate && !onNavigate(targetHref)) {
                        e.preventDefault()
                        return
                      }
                      setModalOpen(false)
                    }}
                    className="block p-3 rounded-lg border border-neutral-800 bg-neutral-900/50 hover:bg-neutral-900 hover:border-neutral-700 transition-colors space-y-1.5"
                  >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-xs text-blue-400 truncate">
                      {getFileName(note.path)}
                    </span>
                    <span className="text-[10px] text-neutral-500">
                      {new Date(note.createdAt).toLocaleDateString("ko-KR")}
                    </span>
                  </div>
                  {note.quote && (
                    <p className="text-xs text-neutral-400 italic line-clamp-1 border-l-2 border-neutral-700 pl-2">
                      &quot;{note.quote}&quot;
                    </p>
                  )}
                  <p className="text-xs text-neutral-200 line-clamp-2">{note.body}</p>
                </Link>
              )})}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── 문서 옆 메모 패널 (SP-05) ──────────────────────────────────────────────
export interface NotesPanelProps {
  source: string
  path: string
  notes: DocNoteItem[]
  selectedQuote?: string | null
  onClearQuote?: () => void
  onNotesChange?: () => void
  forbidden?: boolean
  onNavigate?: (targetHref: string) => boolean
}

export function NotesPanel({
  source,
  path,
  notes,
  selectedQuote,
  onClearQuote,
  onNotesChange,
  forbidden = false,
  onNavigate,
}: NotesPanelProps) {
  const [isWriting, setIsWriting] = useState(Boolean(selectedQuote))
  const [quote, setQuote] = useState(selectedQuote || "")
  const [body, setBody] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    if (selectedQuote !== undefined && selectedQuote !== null) {
      setQuote(selectedQuote)
      setIsWriting(true)
    }
  }, [selectedQuote])

  // 수정 중인 메모 ID 및 본문
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBody, setEditBody] = useState("")

  const sorted = sortNotes(notes)

  const handleStartWrite = (selectedText?: string) => {
    setQuote(selectedText ?? selectedQuote ?? "")
    setIsWriting(true)
    setErrorMessage(null)
  }

  const handleCancelWrite = () => {
    setIsWriting(false)
    setQuote("")
    setBody("")
    setErrorMessage(null)
    onClearQuote?.()
  }

  const handleSubmitNote = async () => {
    if (!body.trim()) return
    setSubmitting(true)
    setErrorMessage(null)

    const res = await createNote({
      source,
      path,
      quote: quote.trim() ? quote.trim() : null,
      body: body.trim(),
    })

    setSubmitting(false)

    if (res.ok) {
      handleCancelWrite()
      onNotesChange?.()
    } else {
      setErrorMessage(res.error || "메모를 저장하지 못했습니다.")
    }
  }

  const handleUpdate = async (id: string) => {
    if (!editBody.trim()) return
    const res = await updateNote({ id, body: editBody.trim() })
    if (res.ok) {
      setEditingId(null)
      setErrorMessage(null)
      onNotesChange?.()
    } else {
      setErrorMessage(res.error || "메모를 수정하지 못했습니다.")
    }
  }

  const handleDelete = async (id: string) => {
    if (typeof window !== "undefined" && !window.confirm("메모를 삭제할까요?")) return
    const res = await deleteNote({ id })
    if (res.ok) {
      setErrorMessage(null)
      onNotesChange?.()
    } else {
      setErrorMessage(res.error || "메모를 삭제하지 못했습니다.")
    }
  }

  const handleReopen = async (id: string) => {
    const res = await updateNote({ id, status: "open" })
    if (res.ok) {
      setErrorMessage(null)
      onNotesChange?.()
    } else {
      setErrorMessage(res.error || "메모를 다시 열지 못했습니다.")
    }
  }

  return (
    <div className="space-y-4">
      {errorMessage && (
        <div className="p-2.5 rounded bg-red-950/40 border border-red-900/60 text-xs text-red-300">
          {errorMessage}
        </div>
      )}
      <div className="flex items-center justify-between pb-2 border-b border-neutral-800">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-neutral-400" />
          <h3 className="text-sm font-semibold text-white">메모</h3>
          <span className="text-xs text-neutral-400">{notes.length}건</span>
        </div>
        {!isWriting && (
          <button
            type="button"
            onClick={() => handleStartWrite()}
            disabled={forbidden}
            className="px-2.5 py-1 rounded bg-neutral-900 border border-neutral-800 hover:bg-neutral-800 text-xs font-medium text-neutral-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            메모 추가
          </button>
        )}
      </div>

      {forbidden && (
        <div className="p-3 rounded bg-neutral-900 border border-neutral-800 text-xs text-neutral-400 text-center">
          {MSG_FORBIDDEN}
        </div>
      )}

      {/* 작성 폼 */}
      {isWriting && !forbidden && (
        <div className="p-3 rounded-lg border border-neutral-800 bg-neutral-900/60 space-y-3">
          <div className="text-xs text-neutral-400">
            <span className="font-semibold text-neutral-300">인용: </span>
            <span className="italic">{quote.trim() ? quote.trim() : MSG_QUOTE_WHOLE_DOC}</span>
          </div>

          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={submitting}
            placeholder="수정 방향이나 의견을 적어 주세요..."
            className="w-full h-24 p-2.5 rounded bg-neutral-950 border border-neutral-800 text-xs text-neutral-200 focus:outline-none focus:border-neutral-600 resize-none"
          />

          {errorMessage && (
            <p className="text-xs text-amber-400">{errorMessage}</p>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleCancelWrite}
              disabled={submitting}
              className="px-3 py-1 rounded bg-neutral-900 text-xs text-neutral-400 hover:text-white"
            >
              취소
            </button>
            <button
              type="button"
              onClick={handleSubmitNote}
              disabled={submitting || !body.trim()}
              className="px-3 py-1 rounded bg-blue-600 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {submitting ? "저장 중..." : "저장"}
            </button>
          </div>
        </div>
      )}

      {/* 메모 목록: 열린 것 먼저, 최신 순 */}
      <div className="space-y-3">
        {sorted.map((note) => {
          const isOpen = note.status === "open"
          const isEditingThis = editingId === note.id

          return (
            <div
              key={note.id}
              className={`p-3 rounded-lg border text-xs space-y-2 ${
                isOpen
                  ? "border-neutral-800 bg-neutral-900/40"
                  : "border-neutral-800/60 bg-neutral-950 opacity-70"
              }`}
            >
              {/* 상단: 상태, 인용, 때 */}
              <div className="flex items-center justify-between text-[11px] text-neutral-400">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      isOpen
                        ? "bg-blue-950 text-blue-300 border border-blue-900/60"
                        : "bg-neutral-800 text-neutral-400"
                    }`}
                  >
                    {isOpen ? "열림" : "처리됨"}
                  </span>
                  <span className="truncate max-w-[150px] text-neutral-400">
                    {note.quote ? `"${note.quote}"` : MSG_QUOTE_WHOLE_DOC}
                  </span>
                </div>
                <span>{new Date(note.createdAt).toLocaleDateString("ko-KR")}</span>
              </div>

              {/* 본문 또는 수정창 */}
              {isEditingThis ? (
                <div className="space-y-2 pt-1">
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    className="w-full h-20 p-2 rounded bg-neutral-950 border border-neutral-700 text-xs text-neutral-200"
                  />
                  <div className="flex justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="px-2 py-0.5 rounded bg-neutral-800 text-[11px] text-neutral-300"
                    >
                      취소
                    </button>
                    <button
                      type="button"
                      onClick={() => handleUpdate(note.id)}
                      className="px-2 py-0.5 rounded bg-blue-600 text-[11px] text-white"
                    >
                      저장
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-neutral-200 whitespace-pre-wrap leading-relaxed">{note.body}</p>
              )}

              {/* AI 답 (있을 때) */}
              {note.reply && (
                <div className="p-2.5 rounded bg-neutral-950 border border-neutral-800 text-neutral-300 space-y-1">
                  <div className="flex items-center gap-1 text-[10px] font-semibold text-emerald-400">
                    <CheckCircle className="w-3 h-3" />
                    <span>AI 답변</span>
                  </div>
                  <p className="text-xs leading-relaxed">{note.reply}</p>
                </div>
              )}

              {/* 하단 단추 */}
              {!forbidden && !isEditingThis && (
                <div className="flex items-center justify-end gap-2 pt-1 text-[11px] text-neutral-400">
                  {isOpen ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(note.id)
                          setEditBody(note.body)
                        }}
                        className="hover:text-white"
                      >
                        고치기
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(note.id)}
                        className="hover:text-rose-400"
                      >
                        지우기
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleReopen(note.id)}
                      className="hover:text-blue-400 flex items-center gap-1"
                    >
                      <RotateCcw className="w-3 h-3" />
                      다시 열기
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {notes.length === 0 && !isWriting && (
          <p className="text-xs text-neutral-500 text-center py-4">등록된 메모가 없습니다.</p>
        )}
      </div>
    </div>
  )
}
