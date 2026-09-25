"use client"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  WIKI_HREF_PREFIX,
  convertWikiLinks,
  findWikiTarget,
  firstDoc,
  orderSources,
  resolveRelativePath,
  splitFrontmatter,
  type DocTreeNode,
} from "./markdown"

type TreeNode = DocTreeNode

interface Source {
  id: string
  title: string
  tree: TreeNode[]
}

interface PortalResponse {
  sources: Source[]
  board: { port: number } | null
}

function TreeItem({
  node,
  sourceId,
  currentSource,
  currentPath,
  level = 0,
  defaultOpen = true,
}: {
  node: TreeNode
  sourceId: string
  currentSource: string | null
  currentPath: string | null
  level?: number
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(
    defaultOpen || (currentSource === sourceId && Boolean(currentPath?.startsWith(`${node.path}/`))),
  )
  const isSelected = currentSource === sourceId && currentPath === node.path

  if (node.type === "directory") {
    return (
      <div className="text-sm">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="w-full text-left py-1 px-2 rounded hover:bg-neutral-800 text-neutral-300 hover:text-white flex items-center justify-between transition-colors"
          style={{ paddingLeft: `${Math.max(level * 12 + 8, 8)}px` }}
        >
          <span className="font-medium truncate">{node.name}</span>
          <span className="text-xs text-neutral-500">{open ? "▾" : "▸"}</span>
        </button>
        {open && node.children && (
          <div className="space-y-0.5 mt-0.5">
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                sourceId={sourceId}
                currentSource={currentSource}
                currentPath={currentPath}
                level={level + 1}
                defaultOpen={defaultOpen}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <Link
      href={`/docs?source=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(node.path)}`}
      className={`block py-1 px-2 rounded text-sm transition-colors truncate ${
        isSelected
          ? "bg-neutral-800 text-white font-medium border-l-2 border-blue-500"
          : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900"
      }`}
      style={{ paddingLeft: `${Math.max(level * 12 + 8, 8)}px` }}
    >
      {node.name.replace(/\.md$/i, "")}
    </Link>
  )
}

// 여러 줄 명령을 한 덩어리로 보여 주고 통째로 복사할 수 있게 한다.
function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  const copy = (e: React.MouseEvent<HTMLButtonElement>) => {
    const text = e.currentTarget.parentElement?.querySelector("pre")?.innerText ?? ""
    navigator.clipboard
      ?.writeText(text.replace(/\n$/, ""))
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  return (
    <div className="relative my-4">
      <pre className="p-4 pr-16 rounded-lg bg-neutral-900 border border-neutral-800 overflow-x-auto text-xs font-mono text-neutral-200 [&>code]:p-0 [&>code]:border-0 [&>code]:bg-transparent">
        {children}
      </pre>
      <button
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 px-2 py-1 rounded text-xs bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
      >
        {copied ? "복사됨" : "복사"}
      </button>
    </div>
  )
}

function DocsViewer() {
  const searchParams = useSearchParams()
  const router = useRouter()

  const sourceParam = searchParams.get("source")
  const pathParam = searchParams.get("path")

  const [portal, setPortal] = useState<PortalResponse | null>(null)
  const [docContent, setDocContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false)

  useEffect(() => {
    fetch("/api/portal")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setPortal(data)
      })
      .catch((err) => {
        setError(`포털 정보를 불러오지 못했습니다: ${err.message}`)
      })
  }, [])

  useEffect(() => {
    if (!sourceParam || !pathParam) {
      setDocContent(null)
      return
    }

    setLoading(true)
    setError(null)

    const url = `/api/portal/doc?source=${encodeURIComponent(sourceParam)}&path=${encodeURIComponent(pathParam)}`
    fetch(url)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`문서를 찾을 수 없습니다 (${res.status})`)
        }
        return res.text()
      })
      .then((text) => {
        setDocContent(text)
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setDocContent(null)
        setLoading(false)
      })
  }, [sourceParam, pathParam])

  const sources = orderSources(portal?.sources || [])

  // 문서를 고르지 않고 들어오면 회사 문서의 첫 문서(보통 온보딩 시작하기)를 연다.
  useEffect(() => {
    if (sourceParam || pathParam || !portal) return
    const company = orderSources(portal.sources).find((s) => s.id.startsWith("company:"))
    const first = company ? firstDoc(company.tree) : null
    if (company && first) {
      router.replace(`/docs?source=${encodeURIComponent(company.id)}&path=${encodeURIComponent(first)}`)
    }
  }, [portal, sourceParam, pathParam, router])

  const parsedDoc = docContent ? splitFrontmatter(docContent) : null
  const docBody = parsedDoc ? convertWikiLinks(parsedDoc.body) : null
  const hasCompanySource = sources.some((s) => s.id.startsWith("company:"))

  const renderMarkdownLink = (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    const { href, children, ...rest } = props
    if (!href) return <a {...rest}>{children}</a>

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
      } catch {
        // 잘못된 인코딩이면 적힌 그대로 찾는다.
      }
      const tree = sources.find((s) => s.id === sourceParam)?.tree ?? []
      const found = sourceParam ? findWikiTarget(tree, target) : null
      if (!found) {
        return (
          <span className="text-neutral-400" title="이 문서는 문서 화면에 보이는 폴더에 없습니다">
            {children}
            <span className="ml-1 text-xs text-neutral-600">(문서 화면에 없음)</span>
          </span>
        )
      }
      return (
        <Link
          href={`/docs?source=${encodeURIComponent(sourceParam as string)}&path=${encodeURIComponent(found)}`}
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

    if (sourceParam && pathParam && href.split("#")[0].toLowerCase().endsWith(".md")) {
      const resolved = resolveRelativePath(pathParam, href)
      const nextHref = `/docs?source=${encodeURIComponent(sourceParam)}&path=${encodeURIComponent(resolved)}`
      return (
        <Link href={nextHref} className="text-blue-400 underline hover:text-blue-300" {...rest}>
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

  const renderMarkdownImage = (props: React.ImgHTMLAttributes<HTMLImageElement>) => {
    const { src, alt, ...rest } = props
    if (!src || typeof src !== "string") return null

    if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("/")) {
      return <img src={src} alt={alt || ""} className="max-w-full rounded border border-neutral-800 my-4" {...rest} />
    }

    if (sourceParam && pathParam) {
      const resolved = resolveRelativePath(pathParam, src)
      const assetUrl = `/api/portal/asset?source=${encodeURIComponent(sourceParam)}&path=${encodeURIComponent(resolved)}`
      return <img src={assetUrl} alt={alt || ""} className="max-w-full rounded border border-neutral-800 my-4" {...rest} />
    }

    return <img src={src} alt={alt || ""} className="max-w-full rounded border border-neutral-800 my-4" {...rest} />
  }

  return (
    <div className="space-y-6">
      {/* 회사 설정 전 안내 배너 */}
      {!hasCompanySource && (
        <div className="p-4 rounded-lg bg-neutral-900 border border-neutral-800 text-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <span className="font-semibold text-neutral-200">회사 설정이 아직 없습니다:</span>
            <code className="ml-2 px-2 py-1 rounded bg-neutral-950 border border-neutral-800 text-neutral-300 font-mono text-xs">
              pnpm adk:setup -- --company &lt;회사 문서 저장소 주소&gt;
            </code>
          </div>
        </div>
      )}

      {/* 모바일 화면 트리 접기/펼치기 토글 */}
      <div className="md:hidden">
        <button
          type="button"
          onClick={() => setMobileTreeOpen(!mobileTreeOpen)}
          className="w-full py-2 px-4 rounded border border-neutral-800 bg-neutral-900 text-sm font-medium flex items-center justify-between"
        >
          <span>문서 목록 {sourceParam && pathParam ? `(${pathParam})` : ""}</span>
          <span>{mobileTreeOpen ? "▲ 접기" : "▼ 펼치기"}</span>
        </button>
      </div>

      <div className="flex flex-col md:flex-row gap-8 items-start">
        {/* 왼쪽 폴더 트리 사이드바 */}
        <aside
          className={`w-full md:w-72 flex-shrink-0 rounded-lg border border-neutral-800 bg-neutral-950 p-4 space-y-6 ${
            mobileTreeOpen ? "block" : "hidden md:block"
          }`}
        >
          {sources.map((source) => (
            <div key={source.id} className="space-y-2">
              <div className="text-xs font-bold tracking-wider text-neutral-400 px-2 flex items-center justify-between">
                <span>{source.title}</span>
                {source.id === "adk" && <span className="text-[10px] font-normal text-neutral-600">개발자용</span>}
              </div>
              {source.tree.length > 0 ? (
                <div className="space-y-0.5">
                  {source.tree.map((node) => (
                    <TreeItem
                      key={node.path}
                      node={node}
                      sourceId={source.id}
                      currentSource={sourceParam}
                      currentPath={pathParam}
                      defaultOpen={source.id !== "adk"}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-xs text-neutral-600 px-2 py-1">문서 없음</div>
              )}
            </div>
          ))}
        </aside>

        {/* 오른쪽 문서 본문 영역 */}
        <article className="flex-1 min-w-0 w-full rounded-lg border border-neutral-800 bg-neutral-950 p-6 sm:p-8">
          {loading && (
            <div className="text-neutral-500 py-12 text-center text-sm">문서를 불러오는 중입니다...</div>
          )}

          {error && (
            <div className="p-4 rounded bg-red-950/40 border border-red-900/60 text-red-300 text-sm">
              {error}
            </div>
          )}

          {!loading && !error && docContent && (
            <div className="prose prose-invert max-w-none space-y-4 text-neutral-200">
              {parsedDoc?.meta && (
                <pre className="p-3 rounded bg-neutral-900/60 border border-neutral-800 text-xs text-neutral-400 whitespace-pre-wrap font-mono">
                  {parsedDoc.meta}
                </pre>
              )}
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: renderMarkdownLink,
                  img: renderMarkdownImage,
                  h1: ({ children }) => <h1 className="text-2xl font-bold pb-2 border-b border-neutral-800 mt-6 mb-4 text-white">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-xl font-semibold pb-1 border-b border-neutral-800/60 mt-6 mb-3 text-neutral-100">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-lg font-medium mt-5 mb-2 text-neutral-200">{children}</h3>,
                  p: ({ children }) => <p className="leading-relaxed my-3">{children}</p>,
                  ul: ({ children }) => <ul className="list-disc list-inside space-y-1 my-3 pl-2">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal list-inside space-y-1 my-3 pl-2">{children}</ol>,
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
                  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
                  code: ({ className, children }) => (
                    <code
                      className={
                        className ??
                        "px-1.5 py-0.5 rounded bg-neutral-900 border border-neutral-800 text-neutral-200 font-mono text-xs"
                      }
                    >
                      {children}
                    </code>
                  ),
                }}
              >
                {docBody}
              </ReactMarkdown>
            </div>
          )}

          {!loading && !error && !docContent && (
            <div className="py-8 space-y-6">
              <div>
                <h1 className="text-2xl font-bold text-white">문서 포털</h1>
                <p className="text-neutral-400 mt-2 text-sm">
                  왼쪽 목록에서 열람할 문서를 선택하세요. 회사 문서 및 연계 프로젝트 문서를 한곳에서 확인할 수 있습니다.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
                {sources.map((s) => (
                  <div key={s.id} className="p-4 rounded-lg border border-neutral-800 bg-neutral-900/50 space-y-2">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-white">{s.title}</h3>
                    </div>
                    <p className="text-xs text-neutral-400">
                      {s.tree.length > 0 ? `${s.tree.length}개 항목` : "문서 없음"}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </article>
      </div>
    </div>
  )
}

export default function DocsPage() {
  return (
    <Suspense fallback={<div className="text-neutral-500 py-12 text-center text-sm">문서 포털 로딩 중...</div>}>
      <DocsViewer />
    </Suspense>
  )
}
