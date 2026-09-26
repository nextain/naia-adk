"use client"

import React, { useEffect, useState } from "react"
import {
  mapDocSaveError,
  MSG_ARCHIVED_DOC,
  MSG_CONFIRM_DISCARD,
  MSG_SAVED_DOC,
} from "./kinds"

export interface SaveDocRequest {
  source: string
  path: string
  content: string
  baseHash: string
  fetchFn?: typeof fetch
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
        error: mapDocSaveError(409, json),
      }
    }

    if (res.status === 403) {
      return {
        ok: false,
        status: 403,
        forbidden: true,
        error: mapDocSaveError(403, json),
      }
    }

    return {
      ok: false,
      status: res.status,
      error: mapDocSaveError(res.status, json),
    }
  } catch (err: unknown) {
    return {
      ok: false,
      status: 0,
      error: "네트워크 오류로 문서를 저장하지 못했습니다.",
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
  isArchived?: boolean
  readOnly?: boolean
  onSaveSuccess?: (newContent: string, newHash: string) => void
  onCancel?: () => void
  renderPreview?: (markdown: string) => React.ReactNode
}

export function DocEditor({
  source,
  path,
  initialContent,
  initialBaseHash,
  content: propContent,
  onChangeContent,
  isArchived = false,
  readOnly = false,
  onSaveSuccess,
  onCancel,
  renderPreview,
}: DocEditorProps) {
  const [localContent, setLocalContent] = useState(initialContent)
  const content = propContent !== undefined ? propContent : localContent
  const [currentBaseHash, setCurrentBaseHash] = useState(initialBaseHash)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null)
  const [mobileTab, setMobileTab] = useState<"editor" | "preview">("editor")

  const isDirty = content !== initialContent

  const handleContentChange = (newVal: string) => {
    setLocalContent(newVal)
    onChangeContent?.(newVal)
  }

  // 브라우저 닫기/새로고침 시 고친 내용 분실 경고
  useEffect(() => {
    if (!isDirty) return

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = MSG_CONFIRM_DISCARD
      return MSG_CONFIRM_DISCARD
    }

    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [isDirty])

  // [취소] 클릭 시 변경 확인
  const handleCancelClick = () => {
    if (isDirty) {
      if (typeof window !== "undefined" && !window.confirm(MSG_CONFIRM_DISCARD)) {
        return
      }
    }
    onCancel?.()
  }

  // [저장] 실행
  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    setMessage(null)

    const result = await saveDocument({
      source,
      path,
      content,
      baseHash: currentBaseHash,
    })

    setSaving(false)

    if (result.ok && result.sha256) {
      setCurrentBaseHash(result.sha256)
      setMessage({ text: MSG_SAVED_DOC, type: "success" })
      onSaveSuccess?.(content, result.sha256)
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

      {/* 모바일 좁은 화면 탭 전환 ([원문] [미리보기]) */}
      <div className="flex md:hidden items-center justify-between border-b border-neutral-800 pb-2">
        <div className="flex gap-1 p-0.5 rounded bg-neutral-900 border border-neutral-800 text-xs">
          <button
            type="button"
            onClick={() => setMobileTab("editor")}
            className={`px-3 py-1 rounded transition-colors ${
              mobileTab === "editor" ? "bg-neutral-800 text-white font-medium" : "text-neutral-400 hover:text-white"
            }`}
          >
            원문
          </button>
          <button
            type="button"
            onClick={() => setMobileTab("preview")}
            className={`px-3 py-1 rounded transition-colors ${
              mobileTab === "preview" ? "bg-neutral-800 text-white font-medium" : "text-neutral-400 hover:text-white"
            }`}
          >
            미리보기
          </button>
        </div>
      </div>

      {/* 편집 및 미리보기 영역 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start min-h-[500px]">
        {/* 원문 편집창 (왼쪽) */}
        <div className={`space-y-2 ${mobileTab === "editor" ? "block" : "hidden md:block"}`}>
          <textarea
            value={content}
            onChange={(e) => handleContentChange(e.target.value)}
            disabled={saving}
            placeholder="마크다운 문서 내용을 입력하세요..."
            className="w-full h-[600px] p-4 rounded-lg bg-neutral-950 border border-neutral-800 text-xs font-mono text-neutral-200 focus:outline-none focus:border-neutral-600 resize-y leading-relaxed disabled:opacity-50"
          />
        </div>

        {/* 미리보기 (오른쪽) */}
        <div
          className={`h-[600px] p-6 rounded-lg bg-neutral-950 border border-neutral-800 overflow-y-auto ${
            mobileTab === "preview" ? "block" : "hidden md:block"
          }`}
        >
          {renderPreview ? (
            renderPreview(content)
          ) : (
            <div className="text-xs text-neutral-400 whitespace-pre-wrap font-mono">{content}</div>
          )}
        </div>
      </div>

      {/* 하단 액션 버튼: [저장] [취소] (저장 중 잠김) */}
      <div className="flex items-center justify-end gap-3 pt-4 border-t border-neutral-800">
        <button
          type="button"
          onClick={handleCancelClick}
          disabled={saving}
          className="px-4 py-2 rounded-md bg-neutral-900 border border-neutral-800 hover:bg-neutral-800 text-xs font-medium text-neutral-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          취소
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? "저장 중..." : "저장"}
        </button>
      </div>
    </div>
  )
}
