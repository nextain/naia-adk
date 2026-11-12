"use client"

import React, { useRef, useState } from "react"
import Link from "next/link"
import { scheduleLinkPath } from "@naia-adk/core/src/schedule-link"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { CodeBlock, isUnsafeMarkdownHref } from "./MessageMarkdown"
import { copyTextToClipboard } from "../docs/clipboard"
import { codeLineCount, docLinkKey, MSG, shouldFoldCode, tableElementRows, tableToTsv } from "./messenger"

function textOf(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (React.isValidElement(node)) return textOf((node.props as { children?: React.ReactNode }).children)
  return ""
}

// 30줄 넘는 코드는 접어 두고 [모두 보기]로 편다.
export function FoldableCode({ children, initialOpen = false }: { children: React.ReactNode; initialOpen?: boolean }) {
  const code = textOf(children)
  const fold = shouldFoldCode(code)
  const [open, setOpen] = useState(initialOpen)
  if (!fold) return <CodeBlock>{children}</CodeBlock>
  return (
    <div data-testid="msg-code-fold" data-open={open ? "1" : "0"} className="relative">
      <div className={open ? "" : "max-h-72 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"}>
        <CodeBlock>{children}</CodeBlock>
      </div>
      <button
        type="button"
        data-testid="msg-code-fold-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="-mt-2 mb-2 px-2.5 py-1 rounded-md border border-neutral-800 bg-neutral-900 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-white transition-colors"
      >
        {open ? MSG.foldHide : MSG.foldShow(codeLineCount(code))}
      </button>
    </div>
  )
}

export function CopyableTable({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLTableElement>(null)
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle")
  const copy = async () => {
    if (!ref.current) return
    const ok = await copyTextToClipboard(tableToTsv(tableElementRows(ref.current))).catch(() => false)
    setStatus(ok ? "copied" : "failed")
    setTimeout(() => setStatus("idle"), 1500)
  }
  return (
    <div data-testid="msg-table" className="relative my-2 group/table">
      <div className="overflow-x-auto rounded-md border border-neutral-800">
        <table ref={ref} className="min-w-full divide-y divide-neutral-800 text-sm">
          {children}
        </table>
      </div>
      <button
        type="button"
        data-testid="msg-table-copy"
        onClick={copy}
        aria-live="polite"
        className={`mt-1 px-2 py-0.5 rounded text-xs bg-neutral-900 border border-neutral-800 hover:bg-neutral-800 transition-colors ${
          status === "failed" ? "text-red-400" : "text-neutral-400 hover:text-neutral-200"
        }`}
      >
        {status === "copied" ? MSG.copied : status === "failed" ? MSG.copyFailed : MSG.copyTable}
      </button>
    </div>
  )
}

export interface MessageBodyProps {
  body: string
  onOpenDoc?: (key: string) => void
}

export function MessageBody({ body, onOpenDoc }: MessageBodyProps) {
  return (
    <div data-testid="msg-body" className="text-sm leading-relaxed text-neutral-200 break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
        components={{
          a: ({ href, children }) => {
            const raw = typeof href === "string" ? href : ""
            if (!raw || isUnsafeMarkdownHref(raw)) return <span>{children}</span>
            // 일정 화면 링크(알림 글의 [일정에서 보기])는 새 탭이 아니라 이 대시보드 안에서 연다.
            const schedulePath = scheduleLinkPath(raw, typeof window === "undefined" ? [] : [window.location.origin])
            if (schedulePath) {
              return (
                <Link
                  href={schedulePath}
                  data-testid="msg-schedule-link"
                  className="text-emerald-300 underline decoration-emerald-800 underline-offset-2 hover:text-emerald-200"
                >
                  {children}
                </Link>
              )
            }
            const key = docLinkKey(raw)
            if (key && onOpenDoc) {
              return (
                <a
                  href={key}
                  data-testid="msg-doc-link"
                  data-doc-key={key}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                    e.preventDefault()
                    onOpenDoc(key)
                  }}
                  className="text-sky-300 underline decoration-sky-800 underline-offset-2 hover:text-sky-200"
                >
                  {children}
                </a>
              )
            }
            return (
              <a href={raw} target="_blank" rel="noreferrer noopener" className="text-blue-300 underline decoration-blue-800 underline-offset-2 hover:text-blue-200">
                {children}
              </a>
            )
          },
          p: ({ children }) => <p className="my-1.5 whitespace-pre-wrap">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="text-neutral-200">{children}</li>,
          h1: ({ children }) => <p className="my-2 text-base font-bold text-white">{children}</p>,
          h2: ({ children }) => <p className="my-2 text-base font-semibold text-neutral-100">{children}</p>,
          h3: ({ children }) => <p className="my-1.5 font-semibold text-neutral-100">{children}</p>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-neutral-700 pl-3 my-2 text-neutral-400">{children}</blockquote>
          ),
          table: ({ children }) => <CopyableTable>{children}</CopyableTable>,
          th: ({ children }) => (
            <th className="px-3 py-1.5 bg-neutral-900 text-left text-xs font-semibold text-neutral-300 whitespace-nowrap">{children}</th>
          ),
          td: ({ children }) => <td className="px-3 py-1.5 text-sm text-neutral-300 border-t border-neutral-800/80 align-top">{children}</td>,
          pre: ({ children }) => <FoldableCode>{children}</FoldableCode>,
          code: ({ className, children }) => (
            <code className={className ?? "px-1 py-0.5 rounded bg-neutral-900 border border-neutral-800 text-neutral-200 font-mono text-xs"}>
              {children}
            </code>
          ),
        }}
      >
        {linkifyDocPaths(body)}
      </ReactMarkdown>
    </div>
  )
}

// 맨 /d/키 (호스트 없는 것)는 GFM 자동 링크가 안 되니 링크 글로 바꿔 준다(코드 블록 안은 건드리지 않음).
export function linkifyDocPaths(body: string): string {
  const parts = body.split(/(```[\s\S]*?```|`[^`\n]*`)/)
  return parts
    .map((p, i) => (i % 2 === 1 ? p : p.replace(/(^|[\s(])(\/d\/[A-Za-z0-9._~%\-]+(?:\/[A-Za-z0-9._~%\-]+)*)/g, (_m, pre, path) => `${pre}[${path}](${path})`)))
    .join("")
}
