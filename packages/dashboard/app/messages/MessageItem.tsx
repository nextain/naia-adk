"use client"

import React, { useState } from "react"
import { CornerDownRight, FileText, MessageSquare, Paperclip, SmilePlus } from "lucide-react"
import { copyTextToClipboard } from "../docs/clipboard"
import { MessageBody } from "./MessageBody"
import {
  attachmentHref,
  authorLabel,
  messageAuthorLabel,
  docLinkKey,
  formatBytes,
  formatMessageTime,
  MSG,
  parseApprovalForm,
  REACTION_EMOJIS,
  type Message,
} from "./messenger"

export interface MessageActions {
  onReact?: (m: Message, emoji: string) => void
  onReply?: (m: Message) => void
  onOpenThread?: (m: Message) => void
  onOpenDoc?: (key: string) => void
  onDecide?: (m: Message, decision: "approve" | "reject") => Promise<void> | void
}

export interface MessageItemProps extends MessageActions {
  message: Message
  replyCount?: number
  viewerKind?: "human" | "agent"
  highlighted?: boolean
  now?: Date
  compact?: boolean
}

function Avatar({ id, kind }: { id: string; kind: "human" | "agent" }) {
  const label = authorLabel(id).slice(0, 1)
  return (
    <div
      aria-hidden="true"
      className={`w-8 h-8 shrink-0 rounded-md flex items-center justify-center text-sm font-semibold ${
        kind === "agent" ? "bg-sky-950 text-sky-300 border border-sky-800/70" : "bg-neutral-800 text-neutral-200 border border-neutral-700"
      }`}
    >
      {label}
    </div>
  )
}

export function ReactionBar({ message, onReact }: { message: Message; onReact?: (m: Message, emoji: string) => void }) {
  const [picker, setPicker] = useState(false)
  const shown = message.reactions.filter((r) => r.count > 0)
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="msg-reactions">
      {shown.map((r) => (
        <button
          key={r.emoji}
          type="button"
          data-testid="msg-reaction"
          aria-pressed={r.mine}
          title={r.mine ? "내 반응 지우기" : "반응 더하기"}
          onClick={() => onReact?.(message, r.emoji)}
          className={`px-1.5 py-0.5 rounded-full border text-xs leading-5 transition-colors ${
            r.mine ? "border-blue-700 bg-blue-950/60 text-blue-200" : "border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-600"
          }`}
        >
          <span className="mr-1">{r.emoji}</span>
          {r.count}
        </button>
      ))}
      <div className="relative">
        <button
          type="button"
          data-testid="msg-reaction-add"
          aria-label="반응 고르기"
          aria-expanded={picker}
          onClick={() => setPicker((v) => !v)}
          className={`p-1 rounded-full text-neutral-500 hover:text-neutral-200 hover:bg-neutral-900 transition-colors ${
            shown.length ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100 max-sm:opacity-100"
          }`}
        >
          <SmilePlus className="w-3.5 h-3.5" />
        </button>
        {picker && (
          <div role="menu" data-testid="msg-reaction-picker" className="absolute z-10 left-0 bottom-full mb-1 flex gap-0.5 rounded-lg border border-neutral-800 bg-neutral-950 p-1 shadow-xl">
            {REACTION_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                role="menuitem"
                onClick={() => {
                  setPicker(false)
                  onReact?.(message, e)
                }}
                className="w-8 h-8 rounded-md text-base hover:bg-neutral-800"
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function ApprovalCard({
  message,
  viewerKind = "human",
  onDecide,
  onOpenDoc,
}: {
  message: Message
  viewerKind?: "human" | "agent"
  onDecide?: MessageActions["onDecide"]
  onOpenDoc?: (key: string) => void
}) {
  const approval = message.approval!
  const form = parseApprovalForm(message.body, approval)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle")
  const docKey = form.docUrl ? docLinkKey(form.docUrl) : null
  const status = approval.status
  const statusLabel = status === "approved" ? MSG.approvalApproved : status === "rejected" ? MSG.approvalRejected : MSG.approvalPending
  const statusClass =
    status === "approved"
      ? "bg-emerald-950/60 border-emerald-800 text-emerald-300"
      : status === "rejected"
        ? "bg-rose-950/60 border-rose-800 text-rose-300"
        : "bg-amber-950/60 border-amber-800 text-amber-300"
  const decide = async (d: "approve" | "reject") => {
    if (!onDecide || busy) return
    setBusy(true)
    setError(false)
    try {
      await onDecide(message, d)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-testid="approval-card" data-status={status} className="dashboard-card mt-1 rounded-lg border border-neutral-800 bg-neutral-900/70 p-3 sm:p-4 max-w-2xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-neutral-500 mb-0.5">승인 요청</div>
          <div data-testid="approval-title" className="font-semibold text-neutral-100 break-words">
            {form.title || "제목 없음"}
          </div>
        </div>
        <span data-testid="approval-status" className={`shrink-0 px-2 py-0.5 rounded-full border text-xs ${statusClass}`}>
          {statusLabel}
        </span>
      </div>
      {form.summary && <p className="mt-2 text-sm text-neutral-300 whitespace-pre-wrap">{form.summary}</p>}
      {/* 대시보드 문서(/d/...)만 링크로 만든다. 그 밖의 주소는 글자로만 보인다. */}
      {form.docUrl && !docKey && (
        <div data-testid="approval-doc-text" className="mt-2 text-sm text-neutral-400 break-all">
          {form.docUrl}
        </div>
      )}
      {docKey && (
        <a
          href={docKey}
          data-testid="approval-doc-link"
          onClick={(e) => {
            if (!onOpenDoc || e.metaKey || e.ctrlKey) return
            e.preventDefault()
            onOpenDoc(docKey)
          }}
          className="mt-2 inline-flex items-center gap-1.5 text-sm text-sky-300 hover:text-sky-200 underline decoration-sky-800 underline-offset-2 break-all"
        >
          <FileText className="w-3.5 h-3.5 shrink-0" />
          {form.docUrl}
        </a>
      )}
      {form.code && (
        <div className="mt-3 flex items-center gap-2">
          <code data-testid="approval-code" className="px-2 py-1 rounded bg-neutral-950 border border-neutral-800 font-mono text-xs text-neutral-200">
            {form.code}
          </code>
        </div>
      )}
      {viewerKind === "human" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {status === "pending" && (
            <>
              <button
                type="button"
                data-testid="approval-approve"
                disabled={busy}
                onClick={() => decide("approve")}
                className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50 transition-colors"
              >
                {MSG.approve}
              </button>
              <button
                type="button"
                data-testid="approval-reject"
                disabled={busy}
                onClick={() => decide("reject")}
                className="px-3 py-1.5 rounded-md border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 text-sm font-medium disabled:opacity-50 transition-colors"
              >
                {MSG.reject}
              </button>
            </>
          )}
          {form.code && (
            <button
              type="button"
              data-testid="approval-copy-code"
              onClick={async () => {
                const ok = await copyTextToClipboard(form.code!).catch(() => false)
                setCopy(ok ? "copied" : "failed")
                setTimeout(() => setCopy("idle"), 1500)
              }}
              className="px-3 py-1.5 rounded-md border border-neutral-800 bg-neutral-950 hover:bg-neutral-800 text-neutral-300 text-sm transition-colors"
            >
              {copy === "copied" ? MSG.copied : copy === "failed" ? MSG.copyFailed : MSG.copyCode}
            </button>
          )}
        </div>
      )}
      {status !== "pending" && approval.decided_by && (
        <div className="mt-2 text-xs text-neutral-500">
          {authorLabel(approval.decided_by)} · {approval.decided_at ? formatMessageTime(approval.decided_at) : ""}
        </div>
      )}
      {error && (
        <div role="status" className="mt-2 text-xs text-red-400">
          {MSG.approvalFailed}
        </div>
      )}
    </div>
  )
}

export function MessageItem({
  message,
  replyCount = 0,
  viewerKind = "human",
  highlighted = false,
  now,
  compact = false,
  onReact,
  onReply,
  onOpenThread,
  onOpenDoc,
  onDecide,
}: MessageItemProps) {
  return (
    <article
      id={`msg-${message.id}`}
      data-testid="msg-item"
      data-message-id={message.id}
      className={`group relative flex gap-3 px-3 sm:px-4 py-2 rounded-md transition-colors hover:bg-neutral-900/50 ${
        highlighted ? "bg-amber-950/30 ring-1 ring-amber-800/60" : ""
      }`}
    >
      <Avatar id={message.author_id} kind={message.author_kind} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-semibold text-neutral-100">{messageAuthorLabel(message)}</span>
          {message.author_kind === "agent" && (
            <span className="px-1.5 rounded bg-sky-950/70 border border-sky-800/70 text-[10px] leading-4 text-sky-300">{MSG.agent}</span>
          )}
          <time dateTime={message.created_at} className="text-xs text-neutral-500">
            {formatMessageTime(message.created_at, now)}
          </time>
        </div>
        {message.approval ? (
          <ApprovalCard message={message} viewerKind={viewerKind} onDecide={onDecide} onOpenDoc={onOpenDoc} />
        ) : (
          <MessageBody body={message.body} onOpenDoc={onOpenDoc} />
        )}
        {message.attachments.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-2">
            {message.attachments.map((a) =>
              a.mime?.startsWith("image/") ? (
                <a key={a.id} href={attachmentHref(a)} target="_blank" rel="noreferrer">
                  <img src={attachmentHref(a)} alt={a.name} className="max-h-48 max-w-full rounded-md border border-neutral-800" />
                </a>
              ) : (
                <a
                  key={a.id}
                  href={attachmentHref(a)}
                  data-testid="msg-attachment"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-neutral-800 bg-neutral-900 text-xs text-neutral-300 hover:bg-neutral-800"
                >
                  <Paperclip className="w-3.5 h-3.5" />
                  {a.name}
                  {a.size ? <span className="text-neutral-500">{formatBytes(a.size)}</span> : null}
                </a>
              ),
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <ReactionBar message={message} onReact={onReact} />
          {!compact && replyCount > 0 && (
            <button
              type="button"
              data-testid="msg-thread-open"
              onClick={() => onOpenThread?.(message)}
              className="mt-1 inline-flex items-center gap-1 text-xs text-blue-300 hover:text-blue-200"
            >
              <MessageSquare className="w-3.5 h-3.5" />
              {MSG.replies(replyCount)}
            </button>
          )}
        </div>
      </div>
      {onReply && (
        <div className="absolute right-2 top-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
          <button
            type="button"
            data-testid="msg-reply"
            title={MSG.reply}
            aria-label={MSG.reply}
            onClick={() => onReply(message)}
            className="p-1 rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800"
          >
            <CornerDownRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </article>
  )
}
