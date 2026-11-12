"use client"

import React, { useRef, useState } from "react"
import { Paperclip, SendHorizontal, X } from "lucide-react"
import {
  applyMention,
  messageAuthorLabel,
  checkAttachment,
  composerKeyAction,
  formatBytes,
  mentionCandidates,
  mentionQueryAt,
  MSG,
  type Attachment,
  type Message,
} from "./messenger"

export interface ComposerProps {
  placeholder: string
  replyTo?: Message | null
  onCancelReply?: () => void
  onSend: (body: string, attachmentIds: string[]) => Promise<void>
  onUpload?: (file: File) => Promise<Attachment>
  initialText?: string
  testId?: string
}

export function Composer({ placeholder, replyTo, onCancelReply, onSend, onUpload, initialText = "", testId = "composer" }: ComposerProps) {
  const [text, setText] = useState(initialText)
  const [caret, setCaret] = useState(initialText.length)
  const [files, setFiles] = useState<Attachment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [pick, setPick] = useState(0)
  const [mentionClosed, setMentionClosed] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const mention = mentionClosed ? null : mentionQueryAt(text, caret)
  const candidates = mention ? mentionCandidates(mention.query) : []

  const choose = (roleId: string) => {
    if (!mention) return
    const next = applyMention(text, mention.start, caret, roleId)
    setText(next.text)
    setCaret(next.caret)
    setPick(0)
    requestAnimationFrame(() => {
      areaRef.current?.focus()
      areaRef.current?.setSelectionRange(next.caret, next.caret)
    })
  }

  const send = async () => {
    const body = text.trim()
    if ((!body && files.length === 0) || sending) return
    setSending(true)
    setError(null)
    try {
      await onSend(body, files.map((f) => f.id))
      setText("")
      setCaret(0)
      setFiles([])
    } catch {
      setError(MSG.sendFailed)
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (candidates.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        setPick((p) => (p + (e.key === "ArrowDown" ? 1 : candidates.length - 1)) % candidates.length)
        return
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
        e.preventDefault()
        choose(candidates[Math.min(pick, candidates.length - 1)].id)
        return
      }
      if (e.key === "Escape") {
        setMentionClosed(true)
        return
      }
    }
    const action = composerKeyAction({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })
    if (action === "send") {
      e.preventDefault()
      void send()
    }
  }

  const onFiles = async (list: FileList | null) => {
    if (!list || !onUpload) return
    setError(null)
    for (const f of Array.from(list)) {
      const bad = checkAttachment(f.name, f.size)
      if (bad) {
        setError(bad)
        continue
      }
      try {
        const a = await onUpload(f)
        setFiles((prev) => [...prev, a])
      } catch {
        setError(MSG.sendFailed)
      }
    }
    if (fileRef.current) fileRef.current.value = ""
  }

  return (
    <div data-testid={testId} className="relative border-t border-neutral-800 bg-neutral-950 px-3 sm:px-4 py-2.5">
      {replyTo && (
        <div data-testid="composer-reply" className="mb-1.5 flex items-center gap-2 text-xs text-neutral-400">
          <span className="truncate">
            {MSG.replyingTo}: <span className="text-neutral-200">{messageAuthorLabel(replyTo)}</span> · {replyTo.body.split("\n")[0].slice(0, 60)}
          </span>
          <button type="button" onClick={onCancelReply} aria-label={MSG.cancel} className="p-0.5 rounded text-neutral-500 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {files.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {files.map((f) => (
            <span key={f.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-neutral-800 bg-neutral-900 text-xs text-neutral-300">
              <Paperclip className="w-3 h-3" />
              {f.name} <span className="text-neutral-500">{formatBytes(f.size)}</span>
              <button type="button" aria-label={`${f.name} 빼기`} onClick={() => setFiles((p) => p.filter((x) => x.id !== f.id))} className="text-neutral-500 hover:text-white">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {candidates.length > 0 && (
        <ul role="listbox" data-testid="mention-list" className="absolute bottom-full left-3 sm:left-4 mb-1 w-56 rounded-lg border border-neutral-800 bg-neutral-950 py-1 shadow-xl z-20">
          {candidates.map((r, i) => (
            <li key={r.id} role="option" aria-selected={i === pick}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(r.id)
                }}
                className={`w-full text-left px-3 py-1.5 text-sm flex items-center justify-between ${
                  i === pick ? "bg-neutral-800 text-white" : "text-neutral-300 hover:bg-neutral-900"
                }`}
              >
                <span>@{r.id}</span>
                <span className="text-xs text-neutral-500">{r.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2 rounded-lg border border-neutral-800 bg-neutral-900/80 px-2 py-1.5 focus-within:border-neutral-600">
        {onUpload && (
          <>
            <button
              type="button"
              data-testid="composer-attach"
              aria-label={MSG.attach}
              title={MSG.attach}
              onClick={() => fileRef.current?.click()}
              className="p-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} />
          </>
        )}
        <textarea
          ref={areaRef}
          data-testid="composer-input"
          aria-label="글 쓰기"
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart ?? e.target.value.length)
            setMentionClosed(false)
            setPick(0)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          className="flex-1 min-w-0 resize-none bg-transparent py-1 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none max-h-40 field-sizing-content"
        />
        <button
          type="button"
          data-testid="composer-send"
          aria-label={MSG.send}
          disabled={sending || (!text.trim() && files.length === 0)}
          onClick={() => void send()}
          className="p-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:bg-neutral-800 transition-colors"
        >
          <SendHorizontal className="w-4 h-4" />
        </button>
      </div>
      <div className="mt-1 hidden sm:block text-[11px] text-neutral-500">{MSG.keyHint}</div>
      {error && (
        <div role="status" className="mt-1 text-xs text-red-400">
          {error}
        </div>
      )}
    </div>
  )
}
