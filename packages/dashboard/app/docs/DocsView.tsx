"use client"

import React, { useState } from "react"
import Link from "next/link"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  Folder,
  FolderOpen,
  BookOpen,
  Image as ImageIcon,
  Video,
  Music,
  FileText,
  FileCode,
  File as FileIcon,
  Star,
  Edit3,
} from "lucide-react"
import {
  canEditDoc,
  createBreadcrumbs,
  getFileName,
  MSG_FORBIDDEN,
  MSG_NOT_FOUND,
  MSG_READ_ONLY,
  truncateQuote,
  type DocNoteItem,
  type FavoriteItem,
  type FileKind,
  type FolderGridEntry,
} from "./kinds"
import {
  archiveBadgeLabel,
  docHref,
  docVisibleInTab,
  inferTab,
  isArchiveDirName,
  isArchivedDocPath,
  searchResultHref,
  searchResultTabLabel,
  type DocTab,
  type SearchArchiveInfo,
  type TabSection,
} from "./tabs"
import {
  convertWikiLinks,
  findWikiTarget,
  resolveRelativePath,
  splitFrontmatter,
  WIKI_HREF_PREFIX,
  type DocTreeNode,
} from "./markdown"
import { FavoritesGroup } from "./Favorites"
import { FolderGrid } from "./FolderGrid"
import { FileView } from "./FileView"
import { DocEditor } from "./DocEditor"
import { NotesBanner, NotesPanel } from "./NotesPanel"

export type TreeNode = DocTreeNode

export interface Source {
  id: string
  title: string
  tree: TreeNode[]
  tab?: DocTab
  missing?: boolean
  readOnly?: boolean
}

export interface SearchHit {
  source: string
  path: string
  title: string
  snippet: string
  archive: SearchArchiveInfo | null
}

// ── 트리 노드 아이콘 7종 (SP-01) ─────────────────────────────────────────────
function TreeNodeKindIcon({ kind }: { kind?: FileKind | string }) {
  switch (kind) {
    case "image":
      return <ImageIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
    case "video":
      return <Video className="w-3.5 h-3.5 text-purple-400 shrink-0" />
    case "audio":
      return <Music className="w-3.5 h-3.5 text-pink-400 shrink-0" />
    case "pdf":
      return <FileText className="w-3.5 h-3.5 text-rose-400 shrink-0" />
    case "text":
      return <FileCode className="w-3.5 h-3.5 text-sky-400 shrink-0" />
    case "other":
      return <FileIcon className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
    case "doc":
    default:
      return <BookOpen className="w-3.5 h-3.5 text-blue-400 shrink-0" />
  }
}

// ── 트리 아이템 컴포넌트 ───────────────────────────────────────────────────
function TreeItem({
  node,
  sourceId,
  currentSource,
  currentPath,
  tab,
  level = 0,
  defaultOpen = true,
  noteCounts,
  onNavigate,
}: {
  node: TreeNode
  sourceId: string
  currentSource: string | null
  currentPath: string | null
  tab: DocTab
  level?: number
  defaultOpen?: boolean
  noteCounts?: Record<string, number>
  onNavigate?: (targetHref: string) => boolean
}) {
  const isArchive = node.type === "directory" && isArchiveDirName(node.name)
  const containsCurrent = currentSource === sourceId && Boolean(currentPath?.startsWith(`${node.path}/`))
  const isSelected = currentSource === sourceId && currentPath === node.path
  const [open, setOpen] = useState((defaultOpen && !isArchive) || containsCurrent || isSelected)

  // 열린 메모 숫자 (SP-01)
  const countKey = `${sourceId}\u0000${node.path}`
  const openNoteCount = noteCounts?.[countKey] ?? 0

  if (node.type === "directory") {
    const dirHref = docHref(tab, sourceId, node.path)
    // 폴더를 누르면 펼치고 동시에 그 폴더의 격자를 연다 (SP-01, 검수 반영 2번)
    return (
      <div className="text-sm">
        <div
          className={`flex items-center justify-between py-1 px-2 rounded hover:bg-neutral-800 transition-colors ${
            isSelected ? "bg-neutral-800 text-white font-medium" : "text-neutral-300 hover:text-white"
          }`}
          style={{ paddingLeft: `${Math.max(level * 12 + 8, 8)}px` }}
        >
          <Link
            href={dirHref}
            onClick={(e) => {
              if (onNavigate && !onNavigate(dirHref)) {
                e.preventDefault()
                return
              }
              setOpen(!open)
            }}
            className="flex items-center gap-1.5 min-w-0 flex-1 truncate text-left"
          >
            {open ? (
              <FolderOpen className="w-3.5 h-3.5 text-amber-500/90 shrink-0" />
            ) : (
              <Folder className="w-3.5 h-3.5 text-amber-500/80 shrink-0" />
            )}
            <span className={`truncate ${isArchive ? "text-neutral-500" : "font-medium"}`}>
              {node.name}
              {isArchive && (
                <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-neutral-800 text-neutral-400 border border-neutral-700">
                  보관 · 옛 판
                </span>
              )}
            </span>
          </Link>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setOpen(!open)
            }}
            className="text-xs text-neutral-500 hover:text-neutral-300 p-0.5"
          >
            {open ? "▾" : "▸"}
          </button>
        </div>

        {open && node.children && (
          <div className="space-y-0.5 mt-0.5">
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                sourceId={sourceId}
                currentSource={currentSource}
                currentPath={currentPath}
                tab={tab}
                level={level + 1}
                defaultOpen={defaultOpen && !isArchive}
                noteCounts={noteCounts}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  // 파일 노드 (7종류 아이콘 및 메모 숫자)
  const isDoc = !node.kind || node.kind === "doc"
  const displayName = isDoc ? node.name.replace(/\.md$/i, "") : node.name
  const fileHref = docHref(tab, sourceId, node.path)

  return (
    <Link
      href={fileHref}
      onClick={(e) => {
        if (onNavigate && !onNavigate(fileHref)) {
          e.preventDefault()
        }
      }}
      className={`flex items-center justify-between py-1 px-2 rounded text-sm transition-colors ${
        isSelected
          ? "bg-neutral-800 text-white font-medium border-l-2 border-blue-500"
          : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900"
      }`}
      style={{ paddingLeft: `${Math.max(level * 12 + 8, 8)}px` }}
    >
      <div className="flex items-center gap-1.5 min-w-0 truncate">
        <TreeNodeKindIcon kind={node.kind} />
        <span className="truncate">{displayName}</span>
      </div>

      {openNoteCount > 0 && (
        <span className="ml-2 px-1.5 py-0.2 rounded-full text-[10px] bg-blue-900/60 text-blue-300 font-semibold shrink-0">
          {openNoteCount}
        </span>
      )}
    </Link>
  )
}

// ── 코드 블록 ───────────────────────────────────────────────────────────────
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

// ── DocsView Props ──────────────────────────────────────────────────────────
export interface DocsViewProps {
  activeTab: DocTab
  sources: Source[]
  tabSections: TabSection[]
  currentSource: string | null
  currentPath: string | null
  noteCounts?: Record<string, number>
  mobileTreeOpen?: boolean
  onToggleMobileTree?: () => void

  // 상단 배너
  allOpenNotes?: DocNoteItem[]

  // 즐겨찾기
  favorites?: FavoriteItem[]
  onRemoveFavorite?: (source: string, path: string) => void
  isFavorite?: boolean
  onToggleFavorite?: () => void

  // 검색
  queryInput?: string
  searching?: boolean
  hits?: SearchHit[] | null
  includeArchived?: boolean
  archivedHidden?: number
  searchError?: string | null
  onQueryChange?: (val: string) => void
  onSearchSubmit?: () => void
  onToggleArchived?: (on: boolean) => void
  onCloseSearch?: () => void

  // 포털 상태
  portalStatus?: "loading" | "ok" | "error"

  // 보기 모드 및 권한
  viewMode: "grid" | "doc" | "file"
  forbidden?: boolean

  // 폴더 격자 데이터 (viewMode === "grid")
  folderData?: {
    entries: FolderGridEntry[]
    total: number
    truncated: boolean
  } | null

  // 문서 데이터 (viewMode === "doc")
  docContent?: string | null
  docBaseHash?: string
  docLoading?: boolean
  docError?: string | null
  isEditing?: boolean
  onStartEdit?: () => void
  onCancelEdit?: () => void
  onSaveDocSuccess?: (content: string, newHash: string) => void

  // 메모 (viewMode === "doc")
  notes?: DocNoteItem[]
  selectedQuote?: string | null
  onClearQuote?: () => void
  onNotesChange?: () => void

  // 파일 데이터 (viewMode === "file")
  fileData?: {
    kind?: FileKind
    size?: number
    textContent?: string | null
    textTruncated?: boolean
  } | null

  // 회사 출처 여부
  hasCompanySource?: boolean

  // 출처 탭 (W1c-2, 결함 7·11)
  sourceTab?: DocTab

  // 저장 완료 문구 (결함 5)
  saveMessage?: string | null

  // 선택된 인용구 (결함 3)
  selectionQuote?: string | null
  onQuoteSelect?: (quote: string | null) => void

  // 이동 가드 (결함 4)
  onNavigate?: (targetHref: string) => boolean

  // 편집 본문 및 변경 콜백 (결함 1·4 보강)
  editContent?: string | null
  onChangeEditContent?: (content: string) => void

  // 별 및 즐겨찾기 실패 안내 (결함 5)
  starError?: string | null
  groupFavoriteError?: string | null
}

export function DocsView({
  activeTab,
  sources,
  tabSections,
  currentSource,
  currentPath,
  noteCounts,
  mobileTreeOpen = false,
  onToggleMobileTree,
  allOpenNotes = [],
  favorites = [],
  onRemoveFavorite,
  isFavorite = false,
  onToggleFavorite,
  queryInput = "",
  searching = false,
  hits = null,
  includeArchived = false,
  archivedHidden = 0,
  searchError = null,
  onQueryChange,
  onSearchSubmit,
  onToggleArchived,
  onCloseSearch,
  portalStatus = "ok",
  viewMode,
  forbidden = false,
  folderData,
  docContent,
  docBaseHash = "",
  docLoading = false,
  docError = null,
  isEditing = false,
  onStartEdit,
  onCancelEdit,
  onSaveDocSuccess,
  notes = [],
  selectedQuote = null,
  onClearQuote,
  onNotesChange,
  fileData,
  hasCompanySource = true,
  sourceTab,
  saveMessage = null,
  selectionQuote = null,
  onQuoteSelect,
  onNavigate,
  editContent = null,
  onChangeEditContent,
  starError = null,
  groupFavoriteError = null,
}: DocsViewProps) {
  const currentSourceObj = sources.find((s) => s.id === currentSource)
  const sourceTitle = currentSourceObj?.title || currentSource || "문서"
  const isReadOnly = Boolean(currentSourceObj?.readOnly || currentSource?.startsWith("data:"))
  const canEdit = canEditDoc(currentSource, isReadOnly, currentSourceObj?.missing)
  const isArchived = currentPath ? isArchivedDocPath(currentPath) : false

  const parsedDoc = docContent ? splitFrontmatter(docContent) : null
  const docBody = parsedDoc ? convertWikiLinks(parsedDoc.body) : null

  const [forbiddenNotice, setForbiddenNotice] = useState(false)
  const [localSelection, setLocalSelection] = useState<string | null>(null)
  const activeSelection = selectionQuote !== null && selectionQuote !== undefined ? selectionQuote : localSelection

  const handleBodyMouseUp = () => {
    if (typeof window === "undefined") return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) {
      setLocalSelection(null)
      return
    }
    const text = sel.toString().trim()
    if (text) {
      setLocalSelection(text)
      onQuoteSelect?.(text)
    } else {
      setLocalSelection(null)
    }
  }

  // 마크다운 링크 렌더러
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
      } catch {}
      const tree = sources.find((s) => s.id === currentSource)?.tree ?? []
      const found = currentSource ? findWikiTarget(tree, target) : null
      if (!found) {
        return (
          <span className="text-neutral-400" title="이 문서는 문서 화면에 보이는 폴더에 없습니다">
            {children}
            <span className="ml-1 text-xs text-neutral-600">(문서 화면에 없음)</span>
          </span>
        )
      }
      const targetTab = inferTab(currentSource, found, activeTab, undefined, sourceTab)
      const nextHref = docHref(targetTab, currentSource, found)
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

    if (currentSource && currentPath && href.split("#")[0].toLowerCase().endsWith(".md")) {
      const resolved = resolveRelativePath(currentPath, href)
      const targetTab = inferTab(currentSource, resolved, activeTab, undefined, sourceTab)
      const nextHref = docHref(targetTab, currentSource, resolved)
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

  // 마크다운 이미지 렌더러
  const renderMarkdownImage = (props: React.ImgHTMLAttributes<HTMLImageElement>) => {
    const { src, alt, ...rest } = props
    if (!src || typeof src !== "string") return null

    if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("/")) {
      return <img src={src} alt={alt || ""} className="max-w-full rounded border border-neutral-800 my-4" {...rest} />
    }

    if (currentSource && currentPath) {
      const resolved = resolveRelativePath(currentPath, src)
      const assetUrl = `/api/portal/asset?source=${encodeURIComponent(currentSource)}&path=${encodeURIComponent(resolved)}`
      return <img src={assetUrl} alt={alt || ""} className="max-w-full rounded border border-neutral-800 my-4" {...rest} />
    }

    return <img src={src} alt={alt || ""} className="max-w-full rounded border border-neutral-800 my-4" {...rest} />
  }

  // 미리보기용 마크다운 렌더러
  const renderPreview = (markdown: string) => {
    const parsed = splitFrontmatter(markdown)
    const converted = convertWikiLinks(parsed.body)
    return (
      <div className="prose prose-invert max-w-none text-neutral-200 text-xs">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: renderMarkdownLink,
            img: renderMarkdownImage,
          }}
        >
          {converted}
        </ReactMarkdown>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 1. 회사 설정 전 안내 배너: loading 동안에는 보이지 않는다 */}
      {portalStatus !== "loading" && !hasCompanySource && (
        <div className="p-4 rounded-lg bg-neutral-900 border border-neutral-800 text-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <span className="font-semibold text-neutral-200">회사 설정이 아직 없습니다:</span>
            <code className="ml-2 px-2 py-1 rounded bg-neutral-950 border border-neutral-800 text-neutral-300 font-mono text-xs">
              pnpm adk:setup -- --company &lt;회사 문서 저장소 주소&gt;
            </code>
          </div>
        </div>
      )}

      {/* 2. 화면 위 한 줄 열린 메모 배너 (SP-05) */}
      <NotesBanner openNotes={allOpenNotes} tab={activeTab} onNavigate={onNavigate} />

      {/* 3. 검색 입력창 */}
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          onSearchSubmit?.()
        }}
      >
        <input
          type="search"
          value={queryInput}
          onChange={(e) => onQueryChange?.(e.target.value)}
          placeholder="문서 검색 (공통·브랜드·마케팅·개발자 전체, 제목과 본문)"
          aria-label="문서 검색"
          className="w-full px-4 py-2 rounded-lg border border-neutral-800 bg-neutral-950 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600"
        />
        <label className="mt-2 inline-flex items-center gap-2 text-xs text-neutral-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => onToggleArchived?.(e.target.checked)}
            className="accent-neutral-500"
          />
          보관 문서 포함 (옛 판은 현행 문서 아래에 보입니다)
        </label>
      </form>

      {/* 4. 모바일 화면 트리 접기/펼치기 토글 */}
      <div className="md:hidden">
        <button
          type="button"
          onClick={onToggleMobileTree}
          className="w-full py-2 px-4 rounded border border-neutral-800 bg-neutral-900 text-sm font-medium flex items-center justify-between gap-3"
        >
          <span className="min-w-0 truncate text-left">
            문서 목록{currentPath ? ` · ${getFileName(currentPath).replace(/\.md$/i, "")}` : ""}
          </span>
          <span className="shrink-0 whitespace-nowrap text-neutral-400">{mobileTreeOpen ? "▲ 접기" : "▼ 펼치기"}</span>
        </button>
      </div>

      <div className="flex flex-col md:flex-row gap-8 items-start">
        {/* 5. 왼쪽 사이드바 (탭, 즐겨찾기 묶음, 트리 목록) */}
        <aside
          className={`w-full md:w-72 flex-shrink-0 rounded-lg border border-neutral-800 bg-neutral-950 p-4 space-y-4 ${
            mobileTreeOpen ? "block" : "hidden md:block"
          }`}
        >
          {/* 탭 버튼 */}
          <div role="tablist" aria-label="문서 구분" className="grid grid-cols-3 gap-1 p-1 rounded-md bg-neutral-900 border border-neutral-800">
            {(["common", "brand", "developer"] as DocTab[]).map((t) => {
              const label = t === "common" ? "공통" : t === "brand" ? "브랜드·마케팅" : "개발자"
              const selected = t === activeTab
              const canRetain =
                currentSource &&
                currentPath &&
                docVisibleInTab(currentSource, currentPath, t, undefined, sourceTab)
              const tabHref = canRetain ? docHref(t, currentSource, currentPath) : docHref(t)
              return (
                <Link
                  key={t}
                  role="tab"
                  aria-selected={selected}
                  href={tabHref}
                  onClick={(e) => {
                    if (onNavigate && !onNavigate(tabHref)) {
                      e.preventDefault()
                    }
                  }}
                  className={`text-center py-1.5 rounded text-sm transition-colors ${
                    selected ? "bg-neutral-700 text-white font-semibold" : "text-neutral-400 hover:text-white"
                  }`}
                >
                  {label}
                </Link>
              )
            })}
          </div>

          {/* 트리 맨 위 즐겨찾기 묶음 (SP-01) */}
          <FavoritesGroup
            favorites={favorites}
            tab={activeTab}
            currentSource={currentSource}
            currentPath={currentPath}
            errorMessage={groupFavoriteError}
            onRemoveFavorite={onRemoveFavorite}
            onNavigate={onNavigate}
          />

          {/* 섹션별 트리 목록 */}
          {tabSections.map((section) => {
            const isMissing = section.missing
            const isSectionReadOnly = section.readOnly

            return (
              <div key={`${section.sourceId}:${section.unclassified}`} className="space-y-2">
                <div className="text-xs font-bold tracking-wider text-neutral-400 px-2 flex items-center justify-between">
                  <span className={section.unclassified ? "text-amber-400" : undefined}>{section.title}</span>
                  <div className="flex items-center gap-1">
                    {isSectionReadOnly && (
                      <span className="text-[10px] font-normal px-1.5 py-0.2 rounded bg-neutral-900 text-neutral-400 border border-neutral-800">
                        {MSG_READ_ONLY}
                      </span>
                    )}
                    {isMissing && (
                      <span className="text-[10px] font-normal px-1.5 py-0.2 rounded bg-rose-950/60 text-rose-300 border border-rose-900/60">
                        {MSG_NOT_FOUND}
                      </span>
                    )}
                  </div>
                </div>

                {/* missing: true 출처는 펼치지 않는다 (SP-01) */}
                {!isMissing && (
                  <div className="space-y-0.5">
                    {section.tree.map((node) => (
                      <TreeItem
                        key={node.path}
                        node={node}
                        sourceId={section.sourceId}
                        currentSource={currentSource}
                        currentPath={currentPath}
                        tab={activeTab}
                        defaultOpen={section.sourceId !== "adk"}
                        noteCounts={noteCounts}
                        onNavigate={onNavigate}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {portalStatus === "error" ? (
            <div className="text-xs text-neutral-400 px-2 py-1">문서 목록을 불러오지 못했습니다</div>
          ) : portalStatus === "loading" ? null : (
            tabSections.length === 0 && <div className="text-xs text-neutral-600 px-2 py-1">문서 없음</div>
          )}
        </aside>

        {/* 6. 오른쪽 본문 영역 */}
        <article className="flex-1 min-w-0 w-full rounded-lg border border-neutral-800 bg-neutral-950 p-6 sm:p-8">
          {/* 검색 중일 때: 검색 결과 목록 */}
          {searching && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h1 className="text-lg font-semibold text-white">
                  {`"${queryInput}" 검색 결과`}
                  {hits && <span className="ml-2 text-sm font-normal text-neutral-400">{`${hits.length}건`}</span>}
                </h1>
                {onCloseSearch && (
                  <button type="button" onClick={onCloseSearch} className="text-xs text-neutral-400 hover:text-white">
                    검색 닫기
                  </button>
                )}
              </div>

              {searchError && (
                <div className="p-4 rounded bg-red-950/40 border border-red-900/60 text-red-300 text-sm">{searchError}</div>
              )}

              {!hits && !searchError && <div className="text-neutral-500 text-sm">찾는 중입니다...</div>}
              {hits && hits.length === 0 && (
                <div className="text-neutral-500 text-sm">
                  {includeArchived ? "찾은 문서가 없습니다." : "찾은 현행 문서가 없습니다."}
                </div>
              )}

              {hits && !includeArchived && archivedHidden > 0 && (
                <div className="text-xs text-neutral-500">
                  {`보관 문서 ${archivedHidden}건은 숨겼습니다. `}
                  <button type="button" onClick={() => onToggleArchived?.(true)} className="underline hover:text-neutral-300">
                    보관 문서 포함
                  </button>
                </div>
              )}

              {/* 검색 결과 목록: 보이는 글에는 파일 이름과 출처만 두고 전체 경로(hit.path)는 보이지 않는다 (검수 8번 및 2회차) */}
              <ul className="space-y-2">
                {(hits ?? []).map((hit) => {
                  const badge = archiveBadgeLabel(hit.archive)
                  const hitSourceTab = sources.find((s) => s.id === hit.source)?.tab
                  const fileNameOnly = getFileName(hit.path)

                  return (
                    <li key={`${hit.source}:${hit.path}`}>
                      <Link
                        href={searchResultHref(hit.source, hit.path, undefined, hitSourceTab)}
                        onClick={(e) => {
                          const targetHref = searchResultHref(hit.source, hit.path, undefined, hitSourceTab)
                          if (onNavigate && !onNavigate(targetHref)) {
                            e.preventDefault()
                          }
                        }}
                        className={`block p-3 rounded-lg border hover:bg-neutral-900 hover:border-neutral-700 ${
                          badge ? "border-dashed border-neutral-800 bg-transparent opacity-80" : "border-neutral-800 bg-neutral-900/40"
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="shrink-0 px-2 py-0.5 rounded text-xs bg-neutral-800 text-neutral-300">
                            {searchResultTabLabel(hit.source, hit.path, undefined, hitSourceTab)}
                          </span>
                          {badge && (
                            <span className="shrink-0 px-2 py-0.5 rounded text-xs bg-amber-950/60 text-amber-300 border border-amber-900/60">
                              {badge}
                            </span>
                          )}
                          <span className="font-medium text-white truncate">{hit.title}</span>
                        </div>
                        <div className="mt-1 text-xs text-neutral-500 truncate">{fileNameOnly}</div>
                        {hit.snippet && <div className="mt-1 text-sm text-neutral-300 line-clamp-2">{hit.snippet}</div>}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {/* 검색이 아닐 때: 포털 로딩 중 또는 폴더 격자, 문서, 파일 보기 분기 */}
          {!searching && (
            <>
              {portalStatus === "loading" ? (
                <div className="text-neutral-500 py-12 text-center text-sm">불러오는 중...</div>
              ) : (
                <>
                  {/* (1) 폴더 격자 (viewMode === "grid") */}
                  {viewMode === "grid" && (
                <FolderGrid
                  sourceId={currentSource || "adk"}
                  sourceTitle={sourceTitle}
                  path={currentPath || ""}
                  tab={activeTab}
                  entries={folderData?.entries || []}
                  total={folderData?.total}
                  truncated={folderData?.truncated}
                  isFavorite={isFavorite}
                  onToggleFavorite={onToggleFavorite}
                  starError={starError}
                  forbidden={forbidden}
                  onNavigate={onNavigate}
                />
              )}

              {/* (2) 파일 보기 (viewMode === "file") */}
              {viewMode === "file" && currentPath && (
                <FileView
                  sourceId={currentSource || "adk"}
                  sourceTitle={sourceTitle}
                  path={currentPath}
                  tab={activeTab}
                  kind={fileData?.kind}
                  size={fileData?.size}
                  textContent={fileData?.textContent}
                  textTruncated={fileData?.textTruncated}
                  isFavorite={isFavorite}
                  onToggleFavorite={onToggleFavorite}
                  starError={starError}
                  onNavigate={onNavigate}
                />
              )}

              {/* (3) 문서 보기 또는 편집 (viewMode === "doc") */}
              {viewMode === "doc" && (
                <div className="space-y-6">
                  {docLoading && (
                    <div className="text-neutral-500 py-12 text-center text-sm">문서를 불러오는 중입니다...</div>
                  )}

                  {docError && (
                    <div className="p-4 rounded bg-red-950/40 border border-red-900/60 text-red-300 text-sm">
                      {docError}
                    </div>
                  )}

                  {!docLoading && !docError && docContent && (
                    <>
                      {/* 편집 모드인 경우 */}
                      {isEditing ? (
                        <DocEditor
                          key={`${currentSource || ""}\0${currentPath || ""}`}
                          source={currentSource || "adk"}
                          path={currentPath || ""}
                          initialContent={docContent}
                          initialBaseHash={docBaseHash}
                          content={editContent ?? docContent}
                          onChangeContent={onChangeEditContent}
                          isArchived={isArchived}
                          readOnly={isReadOnly}
                          onSaveSuccess={onSaveDocSuccess}
                          onCancel={onCancelEdit}
                          renderPreview={renderPreview}
                        />
                      ) : (
                        /* 읽기 모드인 경우: 헤더, 마크다운 본문, 메모 패널 */
                        <div className="space-y-6">
                          {/* 저장 성공 안내 문구 (결함 5) */}
                          {saveMessage && (
                            <div className="p-3 rounded-lg bg-emerald-950/40 border border-emerald-900/60 text-emerald-300 text-xs font-medium">
                              {saveMessage}
                            </div>
                          )}

                          {/* SP-06 접근 제한 안내 문구 (결함 8) */}
                          {(forbidden || forbiddenNotice) && (
                            <div className="p-3 rounded-lg bg-neutral-900 border border-neutral-800 text-xs text-neutral-400 text-center">
                              {MSG_FORBIDDEN}
                            </div>
                          )}

                          {/* 문서 상단 헤더: breadcrumbs, 제목, 별, [편집] */}
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-neutral-800">
                            <div className="space-y-1 min-w-0">
                              <nav aria-label="문서 경로" className="flex items-center gap-1.5 text-xs text-neutral-400 flex-wrap">
                                {createBreadcrumbs(sourceTitle, currentPath || "").map((crumb, idx, arr) => {
                                  const isLast = idx === arr.length - 1
                                  if (isLast) {
                                    return (
                                      <span key={crumb.path || "root"} className="font-medium text-neutral-200 truncate">
                                        {crumb.name}
                                      </span>
                                    )
                                  }
                                  const crumbHref = docHref(activeTab, currentSource, crumb.path)
                                  return (
                                    <span key={crumb.path || "root"} className="flex items-center gap-1.5">
                                      <Link
                                        href={crumbHref}
                                        onClick={(e) => {
                                          if (onNavigate && !onNavigate(crumbHref)) {
                                            e.preventDefault()
                                          }
                                        }}
                                        className="hover:text-neutral-200 transition-colors truncate"
                                      >
                                        {crumb.name}
                                      </Link>
                                      <span className="text-neutral-600">/</span>
                                    </span>
                                  )
                                })}
                              </nav>

                              <div className="flex items-center gap-2">
                                <h1 className="text-xl font-bold text-white truncate">
                                  {getFileName(currentPath || "").replace(/\.md$/i, "")}
                                </h1>
                                {onToggleFavorite && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (forbidden) {
                                        setForbiddenNotice(true)
                                        return
                                      }
                                      onToggleFavorite()
                                    }}
                                    title={isFavorite ? "즐겨찾기 해제" : "즐겨찾기 추가"}
                                    aria-label={isFavorite ? "즐겨찾기 해제" : "즐겨찾기 추가"}
                                    className="p-1 rounded hover:bg-neutral-800 text-neutral-400 hover:text-amber-400 transition-colors"
                                  >
                                    <Star className={`w-5 h-5 ${isFavorite ? "fill-amber-400 text-amber-400" : ""}`} />
                                  </button>
                                )}
                                {starError && (
                                  <span className="text-xs text-amber-400 font-normal">{starError}</span>
                                )}
                              </div>
                            </div>

                            {/* 편집 단추: 데이터 폴더 및 readOnly 출처에는 없음 (SP-04, FE 46행) */}
                            {canEdit && onStartEdit && (
                              <div className="shrink-0">
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (forbidden) {
                                      setForbiddenNotice(true)
                                      return
                                    }
                                    onStartEdit()
                                  }}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-neutral-900 border border-neutral-800 hover:bg-neutral-800 text-xs font-medium text-neutral-200 hover:text-white transition-colors"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                  편집
                                </button>
                              </div>
                            )}
                          </div>

                          {/* 고른 글 옆 [메모] 단추 (SP-05, 결함 3) */}
                          {activeSelection && (
                            <div className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-blue-950/40 border border-blue-900/60 my-2">
                              <div className="text-xs text-blue-300 truncate min-w-0">
                                <span className="font-semibold text-blue-200 mr-1.5">선택한 글:</span>
                                &quot;{truncateQuote(activeSelection, 100)}&quot;
                              </div>
                              <button
                                type="button"
                                data-testid="quote-memo-btn"
                                onClick={() => {
                                  if (forbidden) {
                                    setForbiddenNotice(true)
                                    return
                                  }
                                  const truncated = truncateQuote(activeSelection, 2000)
                                  onQuoteSelect?.(truncated)
                                }}
                                className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white transition-colors shrink-0"
                              >
                                메모
                              </button>
                            </div>
                          )}

                          {/* 문서 본문 + 메모 패널 (2열 그리드) */}
                          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
                            {/* 마크다운 본문 (2열) */}
                            <div
                              onMouseUp={handleBodyMouseUp}
                              className="lg:col-span-2 prose prose-invert max-w-none space-y-4 text-neutral-200"
                            >
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
                                    <code className={className ?? "px-1.5 py-0.5 rounded bg-neutral-900 border border-neutral-800 text-neutral-200 font-mono text-xs"}>
                                      {children}
                                    </code>
                                  ),
                                }}
                              >
                                {docBody}
                              </ReactMarkdown>
                            </div>

                            {/* 메모 목록 (1열, SP-05) */}
                            <div className="lg:col-span-1 rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
                              <NotesPanel
                                source={currentSource || "adk"}
                                path={currentPath || ""}
                                notes={notes}
                                selectedQuote={activeSelection ? truncateQuote(activeSelection, 2000) : selectedQuote}
                                onClearQuote={() => {
                                  setLocalSelection(null)
                                  onClearQuote?.()
                                }}
                                onNotesChange={onNotesChange}
                                forbidden={forbidden}
                                onNavigate={onNavigate}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
                </>
              )}
            </>
          )}
        </article>
      </div>
    </div>
  )
}
