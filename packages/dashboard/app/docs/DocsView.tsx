"use client"

import React, { useEffect, useRef, useState } from "react"
import Link from "next/link"
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
  isArchiveDirName,
  isArchivedDocPath,
  searchResultHref,
  searchResultTabLabel,
  tabLabel,
  type DocTab,
  type SearchArchiveInfo,
  type TabSection,
} from "./tabs"
import { formatMessage } from "../i18n/index.ts"
import { useLocale, useT } from "../i18n/provider.tsx"
import {
  type DocTreeNode,
} from "./markdown"
import { FavoritesGroup } from "./Favorites"
import { FolderGrid } from "./FolderGrid"
import { FileView } from "./FileView"
import { DocEditor } from "./DocEditor"
import { DocMarkdown } from "./DocMarkdown"
import { NotesBanner, NotesPanel } from "./NotesPanel"
import { PanelResizer } from "./PanelResizer"
import { MobileMemoButton, MobileMemoSheet } from "./MobileMemoPopup"
import { computeMemoButtonPosition, isTouchSelectionMode } from "./selection-popup"
import { scrollToSection } from "./section-scroll"
import {
  clampSize,
  computeTreeAsideClasses,
  getStoredItem,
  parseStoredBoolean,
  parseStoredNumber,
  setStoredItem,
  NOTES_WIDTH_DEFAULT,
  NOTES_WIDTH_MAX,
  NOTES_WIDTH_MIN,
  NOTES_WIDTH_STEP,
  TREE_COLLAPSED_KEY,
  TREE_WIDTH_DEFAULT,
  TREE_WIDTH_MAX,
  TREE_WIDTH_MIN,
  TREE_WIDTH_STEP,
  type StorageLike,
} from "./panel-size"
import { ShortLinkButton } from "./ShortLinkButton"
import { LinkedCardsPanel } from "./LinkedCardsPanel"
import type { LedgerCardItem } from "../work/work-ledger-view"

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
  const archivedBadge = useT()("docs.archivedBadge")
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
                  {archivedBadge}
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
  initialTreeCollapsed?: boolean
  initialTreeWidth?: number
  initialNotesWidth?: number
  storage?: StorageLike | null

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

  // 결과 문서에 걸린 업무 장부 카드 (문서↔카드 연결)
  linkedCards?: LedgerCardItem[]
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
  initialTreeCollapsed,
  initialTreeWidth,
  initialNotesWidth,
  storage,
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
  linkedCards = [],
}: DocsViewProps) {
  const locale = useLocale()
  const t = useT()
  const currentSourceObj = sources.find((s) => s.id === currentSource)
  const sourceTitle = currentSourceObj?.title || currentSource || t("docs.sourceFallback")
  const isReadOnly = Boolean(currentSourceObj?.readOnly || currentSource?.startsWith("data:"))
  const canEdit = canEditDoc(currentSource, isReadOnly, currentSourceObj?.missing)
  const isArchived = currentPath ? isArchivedDocPath(currentPath) : false

  const [forbiddenNotice, setForbiddenNotice] = useState(false)
  const [sidePanelOpen, setSidePanelOpen] = useState(true)
  const [sidePanelTab, setSidePanelTab] = useState<"notes" | "cards">("notes")
  const [localSelection, setLocalSelection] = useState<string | null>(null)
  const activeSelection = selectionQuote !== null && selectionQuote !== undefined ? selectionQuote : localSelection

  // Left document tree collapse (persisted) + resizable widths.
  // 초깃값은 결정적으로 둔다(React #418 하이드레이션 불일치 방지).
  // 명시 저장소 prop이 있으면 같은 객체를 서버·클라이언트가 함께 보므로
  // 동기 읽기여도 어긋나지 않는다. 기본 브라우저 저장소는 마운트 뒤에 읽는다.
  const [treeCollapsed, setTreeCollapsed] = useState<boolean>(() => {
    if (initialTreeCollapsed !== undefined) return initialTreeCollapsed
    if (storage) return parseStoredBoolean(getStoredItem(TREE_COLLAPSED_KEY, storage), false)
    return false
  })
  useEffect(() => {
    if (initialTreeCollapsed !== undefined || storage) return
    setTreeCollapsed(parseStoredBoolean(getStoredItem(TREE_COLLAPSED_KEY, storage), false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const handleToggleTreeCollapsed = () => {
    const next = !treeCollapsed
    setTreeCollapsed(next)
    setStoredItem(TREE_COLLAPSED_KEY, next ? "1" : "0", storage)
  }
  const [treeWidth, setTreeWidth] = useState<number>(() => {
    if (initialTreeWidth !== undefined) {
      return clampSize(initialTreeWidth, TREE_WIDTH_MIN, TREE_WIDTH_MAX)
    }
    return parseStoredNumber(
      getStoredItem("docs.treeWidth", storage),
      TREE_WIDTH_DEFAULT,
      TREE_WIDTH_MIN,
      TREE_WIDTH_MAX,
    )
  })
  const handleTreeWidthChange = (val: number) => {
    const clamped = clampSize(val, TREE_WIDTH_MIN, TREE_WIDTH_MAX)
    setTreeWidth(clamped)
    setStoredItem("docs.treeWidth", String(clamped), storage)
  }
  const [notesWidth, setNotesWidth] = useState<number>(() => {
    if (initialNotesWidth !== undefined) {
      return clampSize(initialNotesWidth, NOTES_WIDTH_MIN, NOTES_WIDTH_MAX)
    }
    return parseStoredNumber(
      getStoredItem("docs.notesWidth", storage),
      NOTES_WIDTH_DEFAULT,
      NOTES_WIDTH_MIN,
      NOTES_WIDTH_MAX,
    )
  })
  const handleNotesWidthChange = (val: number) => {
    const clamped = clampSize(val, NOTES_WIDTH_MIN, NOTES_WIDTH_MAX)
    setNotesWidth(clamped)
    setStoredItem("docs.notesWidth", String(clamped), storage)
  }

  // Doc body + memo panel refs for independent scroll and touch memo flow.
  const docBodyRef = useRef<HTMLDivElement | null>(null)
  const notesPanelRef = useRef<HTMLDivElement | null>(null)
  const lastPointerTypeRef = useRef<string | null>(null)
  const [touchQuote, setTouchQuote] = useState<{ text: string; top: number; left: number } | null>(null)
  const [memoSheetQuote, setMemoSheetQuote] = useState<string | null>(null)

  // Touch devices: `mouseup` never fires on long-press, so watch
  // `selectionchange` and float the memo action below the selection.
  useEffect(() => {
    if (viewMode !== "doc" || typeof window === "undefined" || typeof document === "undefined") return
    let timer: number | undefined
    const onPointerDown = (e: PointerEvent) => {
      lastPointerTypeRef.current = e.pointerType || null
    }
    const onTouchStart = () => {
      lastPointerTypeRef.current = "touch"
    }
    const readSelection = () => {
      const coarse = !!window.matchMedia && window.matchMedia("(pointer: coarse)").matches
      if (!isTouchSelectionMode(lastPointerTypeRef.current, coarse)) return
      const sel = window.getSelection()
      const bodyEl = docBodyRef.current
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !bodyEl) {
        setTouchQuote(null)
        return
      }
      const range = sel.getRangeAt(0)
      if (!bodyEl.contains(range.commonAncestorContainer)) {
        setTouchQuote(null)
        return
      }
      const text = sel.toString().trim()
      if (!text) {
        setTouchQuote(null)
        return
      }
      const rects = range.getClientRects()
      const last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect()
      const pos = computeMemoButtonPosition({
        rect: last,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      })
      setTouchQuote({ text, ...pos })
    }
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(readSelection, 250)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true } as AddEventListenerOptions)
    document.addEventListener("selectionchange", schedule)
    window.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("touchstart", onTouchStart, { capture: true } as EventListenerOptions)
      document.removeEventListener("selectionchange", schedule)
      window.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
    }
  }, [viewMode, currentSource, currentPath])

  // Address hash (#...) scrolls to the matching heading once the body renders.
  useEffect(() => {
    if (typeof window === "undefined") return
    if (viewMode !== "doc" || docLoading || isEditing || !docContent) return
    const hash = window.location.hash
    if (!hash) return
    const timer = window.setTimeout(() => {
      scrollToSection(docBodyRef.current, { hash })
    }, 60)
    return () => window.clearTimeout(timer)
  }, [viewMode, docLoading, isEditing, docContent, currentSource, currentPath])

  const scrollNotesIntoViewOnNarrow = () => {
    if (typeof window === "undefined") return
    if (window.matchMedia && window.matchMedia("(min-width: 1024px)").matches) return
    window.setTimeout(() => {
      notesPanelRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })
    }, 60)
  }
  const openMemoSheetFromTouch = () => {
    if (!touchQuote) return
    setMemoSheetQuote(touchQuote.text)
    setTouchQuote(null)
  }
  const closeMemoSheet = () => {
    setMemoSheetQuote(null)
    try {
      window.getSelection()?.removeAllRanges()
    } catch {}
  }

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

  // Editor preview reuses the same reader renderer (frontmatter, code blocks,
  // diagrams, section anchors) so preview matches the published view.
  const renderPreview = (markdown: string) => {
    return (
      <DocMarkdown
        content={markdown}
        sourceId={currentSource || ""}
        path={currentPath || ""}
        sources={sources}
        activeTab={activeTab}
        sourceTab={sourceTab}
        onNavigate={onNavigate}
      />
    )
  }

  return (
    <div className="space-y-6">
      {/* 1. 회사 설정 전 안내 배너: loading 동안에는 보이지 않는다 */}
      {portalStatus !== "loading" && !hasCompanySource && (
        <div className="p-4 rounded-lg bg-neutral-900 border border-neutral-800 text-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <span className="font-semibold text-neutral-200">{t("docs.noCompanyConfig")}</span>
            <code className="ml-2 px-2 py-1 rounded bg-neutral-950 border border-neutral-800 text-neutral-300 font-mono text-xs">
              {t("docs.companySetupCmd")}
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
          placeholder={t("docs.searchPlaceholder")}
          aria-label={t("docs.searchLabel")}
          className="w-full px-4 py-2 rounded-lg border border-neutral-800 bg-neutral-950 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600"
        />
        <label className="mt-2 inline-flex items-center gap-2 text-xs text-neutral-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => onToggleArchived?.(e.target.checked)}
            className="accent-neutral-500"
          />
          {t("docs.archivedNote")}
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
            {t("docs.docList")}{currentPath ? ` · ${getFileName(currentPath).replace(/\.md$/i, "")}` : ""}
          </span>
          <span className="shrink-0 whitespace-nowrap text-neutral-400">{mobileTreeOpen ? t("docs.collapse") : t("docs.expand")}</span>
        </button>
      </div>

      <div className="flex flex-col md:flex-row gap-4 md:gap-2 items-start">
        {/* 접힌 상태의 펼치기 띠 (md 이상 세로 스트립) */}
        {treeCollapsed && (
          <button
            type="button"
            data-testid="tree-collapse-toggle"
            aria-expanded={false}
            aria-label={t("docs.expandTree")}
            title={t("docs.expandTree")}
            onClick={handleToggleTreeCollapsed}
            className="hidden md:flex shrink-0 w-8 self-stretch items-start justify-center pt-3 rounded-lg border border-neutral-800 bg-neutral-950 text-neutral-400 hover:text-white hover:bg-neutral-900 transition-colors text-xs"
          >
            ▶
          </button>
        )}

        {/* 5. 왼쪽 사이드바 (탭, 즐겨찾기 묶음, 트리 목록) */}
        <aside
          data-testid="docs-tree-aside"
          style={{ "--tree-width": `${treeWidth}px` } as React.CSSProperties}
          className={`w-full md:w-[var(--tree-width)] flex-shrink-0 rounded-lg border border-neutral-800 bg-neutral-950 p-4 space-y-4 md:sticky md:top-[4.5rem] md:max-h-[calc(100dvh-5.5rem)] md:overflow-y-auto ${computeTreeAsideClasses(
            mobileTreeOpen,
            treeCollapsed,
          )}`}
        >
          {/* 상단 접기 단추 (md 이상) */}
          <div className="hidden md:flex justify-between items-center pb-2 border-b border-neutral-800/60">
            <span className="text-xs font-semibold text-neutral-400">{t("docs.docList")}</span>
            <button
              type="button"
              data-testid="tree-collapse-toggle"
              aria-expanded={true}
              aria-label={t("docs.collapseTree")}
              onClick={handleToggleTreeCollapsed}
              className="p-1 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors text-xs flex items-center gap-1"
            >
              <span>◀ {t("docs.collapseTree")}</span>
            </button>
          </div>
          {/* 탭 버튼 */}
          <div role="tablist" aria-label={t("docs.tabsLabel")} className="grid grid-cols-3 gap-1 p-1 rounded-md bg-neutral-900 border border-neutral-800">
            {(["common", "brand", "developer"] as DocTab[]).map((tab) => {
              const label = tabLabel(tab, locale)
              const selected = tab === activeTab
              const canRetain =
                currentSource &&
                currentPath &&
                docVisibleInTab(currentSource, currentPath, tab, undefined, sourceTab)
              const tabHref = canRetain ? docHref(tab, currentSource, currentPath) : docHref(tab)
              return (
                <Link
                  key={tab}
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
                        {t("docs.readOnly")}
                      </span>
                    )}
                    {isMissing && (
                      <span className="text-[10px] font-normal px-1.5 py-0.2 rounded bg-rose-950/60 text-rose-300 border border-rose-900/60">
                        {t("docs.notFound")}
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
            <div className="text-xs text-neutral-400 px-2 py-1">{t("docs.portalLoading")}</div>
          ) : portalStatus === "loading" ? null : (
            tabSections.length === 0 && <div className="text-xs text-neutral-600 px-2 py-1">{t("docs.noDocs")}</div>
          )}
        </aside>

        {!treeCollapsed && (
          <PanelResizer
            className="hidden md:flex self-stretch"
            mode="left-px"
            value={treeWidth}
            min={TREE_WIDTH_MIN}
            max={TREE_WIDTH_MAX}
            step={TREE_WIDTH_STEP}
            defaultValue={TREE_WIDTH_DEFAULT}
            ariaLabel={t("docs.docList")}
            onChange={handleTreeWidthChange}
            data-testid="tree-resizer"
          />
        )}

        {/* 6. 오른쪽 본문 영역 */}
        <article className="flex-1 min-w-0 w-full rounded-lg border border-neutral-800 bg-neutral-950 p-6 sm:p-8">
          {/* 검색 중일 때: 검색 결과 목록 */}
          {searching && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h1 className="text-lg font-semibold text-white">
                  {`"${queryInput}" ${t("docs.searchResults")}`}
                  {hits && <span className="ml-2 text-sm font-normal text-neutral-400">{formatMessage(t("work.count"), { count: hits.length })}</span>}
                </h1>
                {onCloseSearch && (
                  <button type="button" onClick={onCloseSearch} className="text-xs text-neutral-400 hover:text-white">
                    {t("docs.closeSearch")}
                  </button>
                )}
              </div>

              {searchError && (
                <div className="p-4 rounded bg-red-950/40 border border-red-900/60 text-red-300 text-sm">{searchError}</div>
              )}

              {!hits && !searchError && <div className="text-neutral-500 text-sm">{t("docs.searching")}</div>}
              {hits && hits.length === 0 && (
                <div className="text-neutral-500 text-sm">
                  {includeArchived ? t("docs.noResultsAll") : t("docs.noResultsCurrent")}
                </div>
              )}

              {hits && !includeArchived && archivedHidden > 0 && (
                <div className="text-xs text-neutral-500">
                  {formatMessage(t("docs.archivedHidden"), { count: archivedHidden })}
                  <button type="button" onClick={() => onToggleArchived?.(true)} className="underline hover:text-neutral-300">
                    {t("docs.includeArchived")}
                  </button>
                </div>
              )}

              {/* 검색 결과 목록: 보이는 글에는 파일 이름과 출처만 두고 전체 경로(hit.path)는 보이지 않는다 (검수 8번 및 2회차) */}
              <ul className="space-y-2">
                {(hits ?? []).map((hit) => {
                  const badge = archiveBadgeLabel(hit.archive, locale)
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
                            {searchResultTabLabel(hit.source, hit.path, undefined, hitSourceTab, locale)}
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
                <div className="text-neutral-500 py-12 text-center text-sm">{t("docs.loading")}</div>
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
                  linkedCards={linkedCards}
                />
              )}

              {/* (3) 문서 보기 또는 편집 (viewMode === "doc") */}
              {viewMode === "doc" && (
                <div className="space-y-6">
                  {docLoading && (
                    <div className="text-neutral-500 py-12 text-center text-sm">{t("docs.docLoading")}</div>
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
                              {t("docs.forbidden")}
                            </div>
                          )}

                          {/* 문서 상단 헤더: breadcrumbs, 제목, 별, [편집] */}
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-neutral-800">
                            <div className="space-y-1 min-w-0">
                              <nav aria-label={t("docs.docPath")} className="flex items-center gap-1.5 text-xs text-neutral-400 flex-wrap">
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
                                    title={isFavorite ? t("docs.removeFavorite") : t("docs.addFavorite")}
                                    aria-label={isFavorite ? t("docs.removeFavorite") : t("docs.addFavorite")}
                                    className="p-1 rounded hover:bg-neutral-800 text-neutral-400 hover:text-amber-400 transition-colors"
                                  >
                                    <Star className={`w-5 h-5 ${isFavorite ? "fill-amber-400 text-amber-400" : ""}`} />
                                  </button>
                                )}
                                {starError && (
                                  <span className="text-xs text-amber-400 font-normal">{starError}</span>
                                )}
                                {currentSource && currentPath && <ShortLinkButton source={currentSource} path={currentPath} />}
                                <button
                                  type="button"
                                  data-testid="docs-side-panel-toggle"
                                  aria-expanded={sidePanelOpen}
                                  onClick={() => setSidePanelOpen((open) => !open)}
                                  className="px-2.5 py-1.5 rounded-md border border-neutral-800 bg-neutral-900 text-xs text-neutral-300 hover:text-white"
                                >
                                  {sidePanelOpen ? t("docs.hideSidePanel") : t("docs.showSidePanel")}
                                </button>
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
                                  {t("docs.edit")}
                                </button>
                              </div>
                            )}
                          </div>

                          {/* 고른 글 옆 [메모] 단추 (SP-05, 결함 3) */}
                          {activeSelection && (
                            <div className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-blue-950/40 border border-blue-900/60 my-2">
                              <div className="text-xs text-blue-300 truncate min-w-0">
                                <span className="font-semibold text-blue-200 mr-1.5">{t("docs.selectedText")}</span>
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
                                  setSidePanelOpen(true)
                                  const truncated = truncateQuote(activeSelection, 2000)
                                  onQuoteSelect?.(truncated)
                                  scrollNotesIntoViewOnNarrow()
                                }}
                                className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white transition-colors shrink-0"
                              >
                                {t("docs.memo")}
                              </button>
                            </div>
                          )}

                          {/* 문서 본문 + 메모 패널: 본문 스크롤과 메모 스크롤이 분리되어
                              긴 문서를 읽다가도 맨 위로 올리지 않고 메모를 쓸 수 있다 */}
                          <div className={sidePanelOpen ? "flex flex-col lg:flex-row gap-6 items-start" : "block"}>
                            {/* 마크다운 본문 */}
                            <div ref={docBodyRef} data-testid="doc-body-shell" className="flex-1 min-w-0 w-full">
                              <DocMarkdown
                                content={docContent || ""}
                                sourceId={currentSource || ""}
                                path={currentPath || ""}
                                sources={sources}
                                activeTab={activeTab}
                                sourceTab={sourceTab}
                                onNavigate={onNavigate}
                                onMouseUp={handleBodyMouseUp}
                              />
                            </div>

                            {/* 터치 선택 시 뜨는 [메모] 단추와 그 자리 메모 창 */}
                            {touchQuote && !memoSheetQuote && (
                              <MobileMemoButton top={touchQuote.top} left={touchQuote.left} onOpen={openMemoSheetFromTouch} />
                            )}
                            {memoSheetQuote && (
                              <MobileMemoSheet
                                source={currentSource || "adk"}
                                path={currentPath || ""}
                                quote={memoSheetQuote}
                                forbidden={forbidden}
                                forbiddenMessage={t("docs.forbidden")}
                                onClose={closeMemoSheet}
                                onSaved={onNotesChange}
                              />
                            )}

                            {/* 메모 칸 경계 손잡이 (lg 이상) */}
                            {sidePanelOpen && (
                              <PanelResizer
                                className="hidden lg:flex self-stretch"
                                mode="right-px"
                                value={notesWidth}
                                min={NOTES_WIDTH_MIN}
                                max={NOTES_WIDTH_MAX}
                                step={NOTES_WIDTH_STEP}
                                defaultValue={NOTES_WIDTH_DEFAULT}
                                ariaLabel={t("docs.memo")}
                                onChange={handleNotesWidthChange}
                                data-testid="notes-resizer"
                              />
                            )}

                            {/* 연결된 업무 카드 + 메모 목록: lg 이상에서는 본문과 독립적으로 스크롤 */}
                            {sidePanelOpen && <div
                              ref={notesPanelRef}
                              data-testid="notes-panel"
                              style={{ "--notes-width": `${notesWidth}px` } as React.CSSProperties}
                              className="w-full lg:w-[var(--notes-width)] flex-shrink-0 space-y-4 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto">
                              <div role="tablist" data-testid="docs-side-tabs" className="grid grid-cols-2 rounded-lg border border-neutral-800 bg-neutral-900 p-1">
                                <button type="button" role="tab" data-testid="docs-side-tab-notes" aria-selected={sidePanelTab === "notes"} onClick={() => setSidePanelTab("notes")} className="rounded px-2 py-1.5 text-xs text-neutral-300">{t("docs.notesTab")} ({notes.length})</button>
                                <button type="button" role="tab" data-testid="docs-side-tab-cards" aria-selected={sidePanelTab === "cards"} onClick={() => setSidePanelTab("cards")} className="rounded px-2 py-1.5 text-xs text-neutral-300">{t("docs.cardsTab")} ({linkedCards.length})</button>
                              </div>
                              <div hidden={sidePanelTab !== "cards"}><LinkedCardsPanel cards={linkedCards} hideWhenEmpty={false} /></div>
                              <div hidden={sidePanelTab !== "notes"} className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
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
                            </div>}
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
