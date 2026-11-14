"use client"

// Markdown pieces the messenger needs: a code block with a copy button, the unsafe-link check,
// and a read-only document view for the side preview. Kept here so the messenger does not depend
// on the docs screen's internal renderer.
import React, { useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { convertWikiLinks, resolveRelativePath, splitFrontmatter, WIKI_HREF_PREFIX } from "../docs/markdown"
import { copyTextToClipboard, extractPreText } from "../docs/clipboard"
import type { DocTab } from "../docs/tabs"

type CopyStatus = "idle" | "copied" | "failed"

export function CodeBlock({
  children,
  copyFn = copyTextToClipboard,
}: {
  children: React.ReactNode
  copyFn?: (text: string) => Promise<boolean>
}) {
  const [status, setStatus] = useState<CopyStatus>("idle")
  const preRef = useRef<HTMLPreElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const copy = async () => {
    let next: CopyStatus = "failed"
    try {
      next = (await copyFn(extractPreText(preRef.current))) ? "copied" : "failed"
    } catch {
      next = "failed"
    }
    if (timerRef.current) clearTimeout(timerRef.current)
    setStatus(next)
    if (next === "copied") timerRef.current = setTimeout(() => setStatus("idle"), 1500)
  }

  const label = status === "copied" ? "복사됨" : status === "failed" ? "복사 실패" : "복사"
  return (
    <div className="relative my-4">
      <pre
        ref={preRef}
        className="p-4 pr-16 rounded-lg bg-neutral-900 border border-neutral-800 overflow-x-auto text-xs font-mono text-neutral-200 [&>code]:p-0 [&>code]:border-0 [&>code]:bg-transparent"
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={copy}
        data-print="hide"
        aria-live="polite"
        aria-label={status === "idle" ? "코드 복사" : label}
        className={`print:hidden absolute top-2 right-2 px-2 py-1 rounded text-xs bg-neutral-800 hover:bg-neutral-700 ${
          status === "failed" ? "text-red-400" : "text-neutral-300"
        }`}
      >
        {label}
      </button>
    </div>
  )
}

// javascript:, data:, vbscript: and other risky schemes render as text, never as <a>.
export function isUnsafeMarkdownHref(rawHref: string | null | undefined): boolean {
  const trimmed = String(rawHref ?? "").trim()
  if (!trimmed) return true
  if (trimmed.startsWith(WIKI_HREF_PREFIX) || trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("?")) {
    return false
  }
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/i)
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase()
    return scheme !== "http" && scheme !== "https" && scheme !== "mailto"
  }
  return false
}

export interface DocMarkdownProps {
  content: string
  sourceId: string
  path: string
  activeTab?: DocTab
}

// Read-only document body for the messenger's side preview. Links open in the docs screen.
export function DocMarkdown({ content, sourceId, path }: DocMarkdownProps) {
  const parsed = splitFrontmatter(content)
  return (
    <div data-print="doc-body" className="prose prose-invert max-w-none space-y-4 text-neutral-200">
      <ReactMarkdown
        remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
        components={{
          a: ({ href, children }) =>
            !href || isUnsafeMarkdownHref(href) || href.startsWith(WIKI_HREF_PREFIX) ? (
              <span>{children}</span>
            ) : (
              <a href={href} className="text-sky-400 hover:underline" target={/^https?:/i.test(href) ? "_blank" : undefined} rel="noreferrer">
                {children}
              </a>
            ),
          img: ({ src, alt }) => {
            if (!src || typeof src !== "string") return null
            const url = /^(https?:)?\//i.test(src)
              ? src
              : `/api/portal/asset?source=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(resolveRelativePath(path, src))}`
            return <img src={url} alt={alt || ""} className="max-w-full rounded border border-neutral-800 my-4" />
          },
          table: ({ children }) => (
            <div className="overflow-x-auto my-4">
              <table className="min-w-full divide-y divide-neutral-800 border border-neutral-800">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="px-4 py-2 bg-neutral-900 text-left text-xs font-semibold text-neutral-300">{children}</th>,
          td: ({ children }) => <td className="px-4 py-2 text-sm text-neutral-300 border-t border-neutral-800/80">{children}</td>,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {convertWikiLinks(parsed.body)}
      </ReactMarkdown>
    </div>
  )
}
