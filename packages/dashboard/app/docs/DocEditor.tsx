"use client"

import React, { useEffect, useRef, useState } from "react"
import {
  docsMessage,
  mapDocSaveError,
  MSG_ARCHIVED_DOC,
  MSG_SAVED_DOC,
} from "./kinds"
import { getDict } from "../i18n/index.ts"
import { useLocale, useT } from "../i18n/provider.tsx"
import type { Locale } from "../i18n/types.ts"
import {
  setStoredItem,
  type StorageLike,
} from "./panel-size"
import { RichDocEditor, type RichDocEditorProps } from "./RichDocEditor"
import { RichEditorPreservationSession } from "./rich-editor-preservation"

export const EDITOR_MODE_KEY = "docs.editorMode"
type EditorMode = "rich" | "source"

export interface SaveDocRequest {
  source: string
  path: string
  content: string
  baseHash: string
  fetchFn?: typeof fetch
  locale?: Locale
}

export interface SaveDocResponse {
  ok: boolean
  status: number
  sha256?: string
  conflict?: boolean
  forbidden?: boolean
  error?: string
}

// 검수 반영 3번 & 2회차 반영: DocEditor가 [저장]에서 부르는 바로 그 저장 함수
// PUT 본문에 { content, baseHash } 만 보내고, If-Match 헤더는 보내지 않는다.
export async function saveDocument(req: SaveDocRequest): Promise<SaveDocResponse> {
  const fetcher = req.fetchFn ?? fetch
  const locale = req.locale ?? "ko"
  const url = `/api/portal/doc?source=${encodeURIComponent(req.source)}&path=${encodeURIComponent(req.path)}`

  try {
    const res = await fetcher(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: req.content,
        baseHash: req.baseHash,
      }),
    })

    if (res.status === 200) {
      const etagHeader = res.headers.get("etag")?.replace(/^"(.*)"$/, "$1")
      const json = await res.json().catch(() => ({}))
      const newHash = etagHeader || json.sha256
      return {
        ok: true,
        status: 200,
        sha256: newHash,
      }
    }

    const json = await res.json().catch(() => ({}))

    if (res.status === 409) {
      return {
        ok: false,
        status: 409,
        conflict: true,
        error: mapDocSaveError(409, json, locale),
      }
    }

    if (res.status === 403) {
      return {
        ok: false,
        status: 403,
        forbidden: true,
        error: mapDocSaveError(403, json, locale),
      }
    }

    return {
      ok: false,
      status: res.status,
      error: mapDocSaveError(res.status, json, locale),
    }
  } catch (err: unknown) {
    return {
      ok: false,
      status: 0,
      error: getDict(locale)["docs.editorNetworkFailed"],
    }
  }
}

export interface DocEditorProps {
  source: string
  path: string
  initialContent: string
  initialBaseHash: string
  content?: string
  onChangeContent?: (value: string) => void
  onUploadPendingChange?: (count: number) => void
  isArchived?: boolean
  readOnly?: boolean
  onSaveSuccess?: (newContent: string, newHash: string) => void
  onCancel?: () => void
  renderPreview?: (markdown: string) => React.ReactNode
  storage?: StorageLike | null
  richEditorComponent?: React.ComponentType<RichDocEditorProps>
}

export function DocEditor({
  source,
  path,
  initialContent,
  initialBaseHash,
  content: propContent,
  onChangeContent,
  onUploadPendingChange,
  isArchived = false,
  readOnly = false,
  onSaveSuccess,
  onCancel,
  renderPreview,
  storage,
  richEditorComponent: RichEditorComponent = RichDocEditor,
}: DocEditorProps) {
  const locale = useLocale()
  const t = useT()
  const [localContent, setLocalContent] = useState(initialContent)
  const content = propContent !== undefined ? propContent : localContent
  const [currentBaseHash, setCurrentBaseHash] = useState(initialBaseHash)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const latestContent = useRef(content)
  latestContent.current = content
  const [pendingUploads, setPendingUploads] = useState(0)
  const pendingUploadsRef = useRef(0)
  const [unpreservedLines, setUnpreservedLines] = useState(0)
  const unpreservedLinesRef = useRef(0)
  const preservationSession = useRef<RichEditorPreservationSession | null>(null)
  if (!preservationSession.current) preservationSession.current = new RichEditorPreservationSession(initialContent)
  const [confirmSave, setConfirmSave] = useState<{ content: string; extraLines: number } | null>(null)
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null)
  const [showRead, setShowRead] = useState(false)
  const [editorMode, setEditorMode] = useState<EditorMode>("rich")

  const handleEditorModeChange = (mode: EditorMode) => {
    if (savingRef.current || pendingUploadsRef.current > 0) return
    setEditorMode(mode)
    setShowRead(false)
    setStoredItem(EDITOR_MODE_KEY, mode, storage)
  }

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'))
    const currentIndex = tabs.indexOf(event.target as HTMLButtonElement)
    if (currentIndex < 0) return
    event.preventDefault()
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? tabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
    tabs[nextIndex].focus()
    tabs[nextIndex].click()
  }

  const isDirty = content !== initialContent

  const handleContentChange = (newVal: string) => {
    latestContent.current = newVal
    setConfirmSave(null)
    setLocalContent(newVal)
    onChangeContent?.(newVal)
  }

  const handleUploadPendingChange = (count: number) => {
    pendingUploadsRef.current = count
    setPendingUploads(count)
    onUploadPendingChange?.(count)
    if (count > 0) setConfirmSave(null)
  }

  const handleUnpreservedLinesChange = (count: number) => {
    if (unpreservedLinesRef.current !== count) setConfirmSave(null)
    unpreservedLinesRef.current = count
    setUnpreservedLines(count)
  }

  // 브라우저 닫기/새로고침 시 고친 내용 분실 경고
  useEffect(() => {
    if (!isDirty && pendingUploads === 0) return

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = t("docs.discardConfirm")
      return t("docs.discardConfirm")
    }

    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [isDirty, pendingUploads, t])

  // [취소] 클릭 시 변경 확인
  const handleCancelClick = () => {
    if (savingRef.current || pendingUploadsRef.current > 0) return
    if (isDirty) {
      if (typeof window !== "undefined" && !window.confirm(t("docs.discardConfirm"))) {
        return
      }
    }
    onCancel?.()
  }

  // [저장] 실행
  const handleSave = async (confirmed?: { content: string; extraLines: number }) => {
    if (savingRef.current || pendingUploadsRef.current > 0) return
    const savedContent = latestContent.current
    if (unpreservedLinesRef.current > 0 && (confirmed?.content !== savedContent || confirmed.extraLines !== unpreservedLinesRef.current)) {
      setConfirmSave({ content: savedContent, extraLines: unpreservedLinesRef.current })
      return
    }
    savingRef.current = true
    setConfirmSave(null)
    setSaving(true)
    setMessage(null)

    const result = await saveDocument({
      source,
      path,
      content: savedContent,
      baseHash: currentBaseHash,
      locale,
    })

    savingRef.current = false
    setSaving(false)

    if (result.ok && result.sha256) {
      setCurrentBaseHash(result.sha256)
      if (latestContent.current === savedContent && pendingUploadsRef.current === 0) {
        setMessage({ text: MSG_SAVED_DOC, type: "success" })
        onSaveSuccess?.(savedContent, result.sha256)
      } else {
        setMessage({ text: "저장했습니다. 편집 중인 내용은 다시 저장해 주세요.", type: "success" })
      }
    } else {
      setMessage({ text: result.error || "문서를 저장하지 못했습니다.", type: "error" })
    }
  }

  return (
    <div className="space-y-4">
      {/* 보관 문서 표시 (SP-04) */}
      {isArchived && (
        <div className="px-3 py-2 rounded bg-neutral-900 border border-neutral-800 text-xs text-neutral-400 font-medium">
          {MSG_ARCHIVED_DOC}
        </div>
      )}

      {/* 상태 및 피드백 문구 (저장 성공, 충돌 등) */}
      {message && (
        <div
          className={`px-4 py-2.5 rounded text-xs font-medium border ${
            message.type === "success"
              ? "bg-emerald-950/40 border-emerald-900/60 text-emerald-300"
              : "bg-amber-950/40 border-amber-900/60 text-amber-300"
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1 text-xs" role="tablist" aria-label="문서 편집 방식" onKeyDown={handleTabKeyDown}>
        <button
          type="button"
          id="doc-editor-rich-tab"
          role="tab"
          aria-selected={!showRead && editorMode === "rich"}
          aria-controls="doc-editor-rich-panel"
          tabIndex={!showRead && editorMode === "rich" ? 0 : -1}
          disabled={saving || pendingUploads > 0}
          onClick={() => handleEditorModeChange("rich")}
          className={`px-3 py-1.5 rounded border transition-colors ${
            !showRead && editorMode === "rich"
              ? "bg-neutral-800 border-neutral-700 text-white font-medium"
              : "border-neutral-800 text-neutral-400 hover:text-white"
          }`}
        >
          서식 편집
        </button>
        <button
          type="button"
          id="doc-editor-read-tab"
          role="tab"
          aria-selected={showRead}
          aria-controls="doc-editor-read-panel"
          tabIndex={showRead ? 0 : -1}
          disabled={saving || pendingUploads > 0}
          onClick={() => {
            if (savingRef.current || pendingUploadsRef.current > 0) return
            setShowRead(true)
          }}
          className={`px-3 py-1.5 rounded border transition-colors ${
            showRead
              ? "bg-neutral-800 border-neutral-700 text-white font-medium"
              : "border-neutral-800 text-neutral-400 hover:text-white"
          }`}
        >
          읽기
        </button>
        <button
          type="button"
          id="doc-editor-source-tab"
          role="tab"
          aria-selected={!showRead && editorMode === "source"}
          aria-controls="doc-editor-source-panel"
          tabIndex={!showRead && editorMode === "source" ? 0 : -1}
          disabled={saving || pendingUploads > 0}
          onClick={() => handleEditorModeChange("source")}
          className={`px-3 py-1.5 rounded border transition-colors ${
            !showRead && editorMode === "source"
              ? "bg-neutral-800 border-neutral-700 text-white font-medium"
              : "border-neutral-800 text-neutral-400 hover:text-white"
          }`}
        >
          원문
        </button>
      </div>

      {/* 읽기는 표시만 바꾸고 직전 편집기와 보존 세션을 유지한다. */}
      <div className="w-full min-w-0">
        <div
          id="doc-editor-rich-panel"
          role="tabpanel"
          aria-labelledby="doc-editor-rich-tab"
          hidden={showRead || editorMode !== "rich"}
          className="space-y-2 w-full min-w-0"
        >
          {editorMode === "rich" && (
            <>
              {/* 자바스크립트 없이 여는 읽기 환경·시험 렌더를 위한 원문 대체 표시 */}
              <noscript>{content}</noscript>
              <RichEditorComponent
                source={source}
                path={path}
                content={content}
                onChange={handleContentChange}
                onUploadPendingChange={handleUploadPendingChange}
                onUnpreservedLinesChange={handleUnpreservedLinesChange}
                preservationSession={preservationSession.current}
                disabled={saving}
              />
            </>
          )}
        </div>
        <div
          id="doc-editor-source-panel"
          role="tabpanel"
          aria-labelledby="doc-editor-source-tab"
          hidden={showRead || editorMode !== "source"}
          className="space-y-2 w-full min-w-0"
        >
          {editorMode === "source" && (
            <textarea
              aria-label="문서 원문"
              value={content}
              onChange={(e) => {
                const result = preservationSession.current!.editSource(e.target.value)
                handleUnpreservedLinesChange(result.unpreservedLines)
                handleContentChange(result.markdown)
              }}
              disabled={saving}
              placeholder="마크다운 문서 내용을 입력하세요..."
              className="w-full h-[600px] p-4 rounded-lg bg-neutral-950 border border-neutral-800 text-xs font-mono text-neutral-200 focus:outline-none focus:border-neutral-600 resize-y leading-relaxed disabled:opacity-50"
            />
          )}
        </div>

        <div
          id="doc-editor-read-panel"
          role="tabpanel"
          aria-labelledby="doc-editor-read-tab"
          hidden={!showRead}
          className="w-full min-w-0"
        >
          {showRead && (renderPreview ? (
            renderPreview(content)
          ) : (
            <div className="text-xs text-neutral-400 whitespace-pre-wrap font-mono">{content}</div>
          ))}
        </div>
      </div>

      {confirmSave && (
        <div role="alertdialog" aria-label="문서 저장 확인" aria-describedby="doc-save-warning" className="rounded border border-amber-900 bg-amber-950/40 p-4 space-y-3">
          <p id="doc-save-warning" className="text-sm text-amber-200">고친 곳 밖 {unpreservedLines}줄도 바뀝니다</p>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setConfirmSave(null)} className="px-3 py-1.5 rounded border border-neutral-700 text-xs text-neutral-300">취소</button>
            <button type="button" onClick={() => handleSave(confirmSave)} disabled={saving || pendingUploads > 0} className="px-3 py-1.5 rounded bg-blue-600 text-xs text-white disabled:opacity-50">그대로 저장</button>
          </div>
        </div>
      )}

      {/* 하단 액션 버튼: [저장] [취소] */}
      <div className="flex items-center justify-end gap-3 pt-4 border-t border-neutral-800">
        {pendingUploads > 0 && <span role="status" className="mr-auto text-xs text-neutral-400">그림 올리는 중</span>}
        <button
          type="button"
          onClick={handleCancelClick}
          disabled={saving || pendingUploads > 0}
          className="px-4 py-2 rounded-md bg-neutral-900 border border-neutral-800 hover:bg-neutral-800 text-xs font-medium text-neutral-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          취소
        </button>
        <button
          type="button"
          onClick={() => handleSave()}
          disabled={saving || pendingUploads > 0}
          className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? "저장 중..." : "저장"}
        </button>
      </div>
    </div>
  )
}
