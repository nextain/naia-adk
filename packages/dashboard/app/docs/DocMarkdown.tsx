"use client"

import React, { useEffect, useRef, useState } from "react"
import Link from "next/link"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  convertWikiLinks,
  findWikiTarget,
  resolveRelativePath,
  splitFrontmatter,
  WIKI_HREF_PREFIX,
} from "./markdown"
import { docHref, inferTab, type DocTab } from "./tabs"
import type { Source } from "./DocsView"
import { copyTextToClipboard, extractPreText } from "./clipboard"
import { useT } from "../i18n/provider.tsx"

export interface DocMarkdownProps {
  content: string
  sourceId: string
  path: string
  sources?: Source[]
  activeTab: DocTab
  sourceTab?: DocTab
  onNavigate?: (targetHref: string) => boolean
  onMouseUp?: () => void
}

export type CopyStatus = "idle" | "copied" | "failed"

export async function handleCodeBlockCopy(
  pre: { innerText?: string; textContent?: string | null } | null | undefined,
  copyFn: (text: string) => Promise<boolean> = copyTextToClipboard,
): Promise<"copied" | "failed"> {
  const text = extractPreText(pre)
  try {
    const ok = await copyFn(text)
    return ok ? "copied" : "failed"
  } catch {
    return "failed"
  }
}

export function CodeBlock({
  children,
  copyFn = copyTextToClipboard,
}: {
  children: React.ReactNode
  copyFn?: (text: string) => Promise<boolean>
}) {
  const t = useT()
  const [status, setStatus] = useState<CopyStatus>("idle")
  const preRef = useRef<HTMLPreElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    return () => {
      requestIdRef.current += 1
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  const copy = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const pre = preRef.current ?? e.currentTarget.parentElement?.querySelector("pre")
    const reqId = ++requestIdRef.current
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const nextStatus = await handleCodeBlockCopy(pre, copyFn)

    if (reqId !== requestIdRef.current) {
      return
    }

    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    setStatus(nextStatus)
    if (nextStatus === "copied") {
      timerRef.current = setTimeout(() => {
        if (reqId === requestIdRef.current) {
          setStatus("idle")
          timerRef.current = null
        }
      }, 1500)
    }
  }

  const label = status === "copied" ? t("docs.copied") : status === "failed" ? t("common.copyFailed") : t("docs.copy")

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
        aria-label={status === "copied" ? t("docs.copied") : status === "failed" ? t("common.copyFailed") : t("docs.copy")}
        className={`print:hidden absolute top-2 py-1 px-2 rounded text-xs transition-colors focus:outline-none focus:ring-1 focus:ring-neutral-400 ${
          status === "failed"
            ? "bg-neutral-800 text-red-400 hover:bg-neutral-700"
            : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
        } right-2`}
      >
        {label}
      </button>
      {status === "failed" && (
        <div role="status" className="mt-1 text-xs text-red-400">
          {t("common.copyFailed")}
        </div>
      )}
    </div>
  )
}

// javascript:, data:, vbscript: and other risky schemes render as plain text,
// never as links.
export function isUnsafeMarkdownHref(rawHref: string | null | undefined): boolean {
  const trimmed = String(rawHref ?? "").trim()
  if (!trimmed) return true
  if (
    trimmed.startsWith(WIKI_HREF_PREFIX) ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("?")
  ) {
    return false
  }
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/i)
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase()
    return scheme !== "http" && scheme !== "https" && scheme !== "mailto"
  }
  return false
}

export interface MarkdownLinkRendererOptions {
  sourceId: string
  path: string
  sources?: Source[]
  activeTab: DocTab
  sourceTab?: DocTab
  onNavigate?: (targetHref: string) => boolean
}

export function createMarkdownLinkRenderer({
  sourceId,
  path,
  sources = [],
  activeTab,
  sourceTab,
  onNavigate,
}: MarkdownLinkRendererOptions) {
  return function renderMarkdownLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
    const { href, children, ...rest } = props
    if (!href || isUnsafeMarkdownHref(href)) {
      return <span>{children}</span>
    }

    if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//")) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline hover:text-blue-300" {...rest}>
          {children}
        </a>
      )
    }

    if (href.startsWith(WIKI_HREF_PREFIX)) {
      let target = href.slice(WIKI_HREF_PREFIX.length)
      try {
        target = decodeURIComponent(target)
      } catch {}
      const tree = sources.find((s) => s.id === sourceId)?.tree ?? []
      const found = sourceId ? findWikiTarget(tree, target) : null
      if (!found) {
        return (
          <span className="text-neutral-400">
            {children}
            <span className="ml-1 text-xs text-neutral-600">(not in docs)</span>
          </span>
        )
      }
      const targetTab = inferTab(sourceId, found, activeTab, undefined, sourceTab)
      const nextHref = docHref(targetTab, sourceId, found)
      return (
        <Link
          href={nextHref}
          onClick={(e) => {
            if (onNavigate && !onNavigate(nextHref)) {
              e.preventDefault()
            }
          }}
          className="text-blue-400 underline hover:text-blue-300"
        >
          {children}
        </Link>
      )
    }

    if (href.startsWith("#")) {
      return (
        <a href={href} className="text-blue-400 hover:underline" {...rest}>
          {children}
        </a>
      )
    }

    if (sourceId && path && href.split("#")[0].toLowerCase().endsWith(".md")) {
      const resolved = resolveRelativePath(path, href)
      const targetTab = inferTab(sourceId, resolved, activeTab, undefined, sourceTab)
      const nextHref = docHref(targetTab, sourceId, resolved)
      return (
        <Link
          href={nextHref}
          onClick={(e) => {
            if (onNavigate && !onNavigate(nextHref)) {
              e.preventDefault()
            }
          }}
          className="text-blue-400 underline hover:text-blue-300"
          {...rest}
        >
          {children}
        </Link>
      )
    }

    return (
      <a href={href} className="text-blue-400 underline hover:text-blue-300" {...rest}>
        {children}
      </a>
    )
  }
}

export function slugifyHeading(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim().toLowerCase()
  return flat
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
}

function flattenCodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(flattenCodeText).join("")
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return flattenCodeText(node.props.children)
  }
  return ""
}

function isMermaidCodeElement(node: React.ReactNode): boolean {
  if (!React.isValidElement<{ className?: string }>(node)) return false
  const className = node.props.className
  return typeof className === "string" && className.split(/\s+/).includes("language-mermaid")
}

// Rendered SVG를 그대로 믿지 않는다: DOMParser(image/svg+xml)로 읽어
// 루트가 `<svg>` 하나인지 확인하고, `<script>`와 `on*` 행위 속성을 지운
// 뒤에만 마운트한다. 틀리면 null(대체 상자).
export function sanitizeMermaidSvg(raw: string): string | null {
  const text = typeof raw === "string" ? raw.trim() : ""
  if (!text.startsWith("<svg")) return null
  try {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml")
    if (doc.querySelector("parsererror")) return null
    const root = doc.documentElement
    if (!root || root.tagName.toLowerCase() !== "svg") return null
    root.querySelectorAll("script").forEach((el) => el.remove())
    root.querySelectorAll("*").forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name)
      }
    })
    return new XMLSerializer().serializeToString(doc)
  } catch {
    return null
  }
}

// Safe client-side Mermaid renderer for ```mermaid fenced blocks.
// The `mermaid` package is optional: when it cannot load (offline bundle,
// missing dep) or the diagram source is malformed, the block falls back to a
// clean readable source box instead of crashing or injecting raw markup.
// Rendered with `securityLevel: "strict"` and only `<svg...` output is mounted.
export function MermaidBlock({ code }: { code: string }) {
  const t = useT()
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setFailed(false)
    if (!code.trim()) {
      setFailed(true)
      return
    }
    const timer = setTimeout(() => {
      import("mermaid")
        .then(async ({ default: mermaid }) => {
          if (cancelled) return
          try {
            mermaid.initialize({ startOnLoad: false, securityLevel: "strict" as const })
            const { svg: text } = await mermaid.render(
              `mermaid-${Math.random().toString(36).slice(2)}`,
              code,
            )
            if (cancelled) return
            const clean = sanitizeMermaidSvg(text)
            if (clean) {
              setSvg(clean)
            } else {
              setFailed(true)
            }
          } catch {
            if (!cancelled) setFailed(true)
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true)
        })
    }, 30)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [code])

  if (failed) {
    return (
      <div
        data-testid="mermaid-fallback"
        role="note"
        aria-label={t("docs.diagramFailed")}
        className="my-4 rounded-lg border border-amber-900/60 bg-amber-950/20 overflow-hidden"
      >
        <div className="px-3 py-1.5 text-[11px] font-medium text-amber-300 border-b border-amber-900/40">
          {t("docs.diagram")} · {t("docs.diagramFailed")}
        </div>
        <pre className="p-4 overflow-x-auto text-xs font-mono text-neutral-300 whitespace-pre">
          {code.replace(/\n$/, "")}
        </pre>
      </div>
    )
  }

  if (!svg) {
    return (
      <div
        data-testid="mermaid-loading"
        aria-label={t("docs.diagramLoading")}
        className="my-4 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 text-xs text-neutral-500"
      >
        {t("docs.diagramLoading")}
      </div>
    )
  }

  return (
    <div
      data-testid="mermaid-diagram"
      role="img"
      aria-label={t("docs.diagram")}
      className="my-4 rounded-lg border border-neutral-800 bg-neutral-950 p-4 overflow-x-auto [&>svg]:max-w-full [&>svg]:h-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

export function DocMarkdown({
  content,
  sourceId,
  path,
  sources = [],
  activeTab,
  sourceTab,
  onNavigate,
  onMouseUp,
}: DocMarkdownProps) {
  const parsedDoc = splitFrontmatter(content)
  const docBody = convertWikiLinks(parsedDoc.body)
  const renderMarkdownLink = createMarkdownLinkRenderer({
    sourceId,
    path,
    sources,
    activeTab,
    sourceTab,
    onNavigate,
  })

  const renderMarkdownImage = (props: React.ImgHTMLAttributes<HTMLImageElement>) => {
    const { src, alt, ...rest } = props
    if (!src || typeof src !== "string") return null

    if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("/")) {
      return <img src={src} alt={alt || ""} className="max-w-full rounded border border-neutral-800 my-4" {...rest} />
    }

    if (sourceId && path) {
      const resolved = resolveRelativePath(path, src)
      const assetUrl = `/api/portal/asset?source=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(resolved)}`
      return <img src={assetUrl} alt={alt || ""} className="max-w-full rounded border border-neutral-800 my-4" {...rest} />
    }

    return <img src={src} alt={alt || ""} className="max-w-full rounded border border-neutral-800 my-4" {...rest} />
  }

  return (
    <div data-testid="doc-markdown" data-print="doc-body" onMouseUp={onMouseUp} className="prose prose-invert max-w-none space-y-4 text-neutral-200">
      {parsedDoc.meta && (
        <pre className="p-3 rounded bg-neutral-900/60 border border-neutral-800 text-xs text-neutral-400 whitespace-pre-wrap font-mono">
          {parsedDoc.meta}
        </pre>
      )}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => url}
        components={{
          a: renderMarkdownLink,
          img: renderMarkdownImage,
          h1: ({ children }) => {
            const id = slugifyHeading(flattenCodeText(children))
            return <h1 id={id || undefined} className="scroll-mt-20 text-2xl font-bold pb-2 border-b border-neutral-800 mt-6 mb-4 text-white">{children}</h1>
          },
          h2: ({ children }) => {
            const id = slugifyHeading(flattenCodeText(children))
            return <h2 id={id || undefined} className="scroll-mt-20 text-xl font-semibold pb-1 border-b border-neutral-800/60 mt-6 mb-3 text-neutral-100">{children}</h2>
          },
          h3: ({ children }) => {
            const id = slugifyHeading(flattenCodeText(children))
            return <h3 id={id || undefined} className="scroll-mt-20 text-lg font-medium mt-5 mb-2 text-neutral-200">{children}</h3>
          },
          h4: ({ children }) => {
            const id = slugifyHeading(flattenCodeText(children))
            return <h4 id={id || undefined} className="scroll-mt-20 text-neutral-200">{children}</h4>
          },
          p: ({ children }) => <p className="leading-relaxed my-3">{children}</p>,
          ul: ({ children }) => (
            <ul className="list-disc list-inside space-y-1 my-3 pl-2">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside space-y-1 my-3 pl-2">{children}</ol>
          ),
          li: ({ children }) => <li className="text-neutral-300">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-neutral-700 pl-4 py-1 italic my-4 text-neutral-400 bg-neutral-900/40 rounded-r">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-4">
              <table className="min-w-full divide-y divide-neutral-800 border border-neutral-800">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="px-4 py-2 bg-neutral-900 text-left text-xs font-semibold text-neutral-300 uppercase tracking-wider">{children}</th>,
          td: ({ children }) => <td className="px-4 py-2 text-sm text-neutral-300 border-t border-neutral-800/80">{children}</td>,
          pre: ({ children }) => {
            if (React.isValidElement(children) && isMermaidCodeElement(children)) {
              const code = flattenCodeText(
                (children as React.ReactElement<{ children?: React.ReactNode }>).props.children,
              )
              return <MermaidBlock code={code} />
            }
            return <CodeBlock>{children}</CodeBlock>
          },
          code: ({ className, children }) => (
            <code className={className ?? "px-1.5 py-0.5 rounded bg-neutral-900 border border-neutral-800 text-neutral-200 font-mono text-xs"}>
              {children}
            </code>
          ),
        }}
      >
        {docBody}
      </ReactMarkdown>
    </div>
  )
}
