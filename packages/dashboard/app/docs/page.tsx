"use client"

import React, { Suspense, useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { orderSources } from "./markdown"
import {
  computeActiveTab,
  docHref,
  firstCurrentDoc,
  searchApiUrl,
  sectionsForTab,
  shouldAutoOpenFirstDoc,
  type DocTab,
} from "./tabs"
import {
  determineDocViewMode,
  inferKindFromPath,
  MSG_FORBIDDEN,
  MSG_SAVED_DOC,
  type DocNoteItem,
  type FavoriteItem,
  type FileKind,
  type FolderGridEntry,
} from "./kinds"
import { addFavorite, removeFavorite } from "./Favorites"
import { DocsView, type SearchHit, type Source } from "./DocsView"
import { canNavigateWithDiscardConfirm, loadDocsViewState } from "./docs-handlers"

interface PortalResponse {
  sources: Source[]
  board: { port: number } | null
}

function DocsViewer() {
  const searchParams = useSearchParams()
  const router = useRouter()

  const sourceParam = searchParams.get("source")
  const pathParam = searchParams.get("path")
  const tabParam = searchParams.get("tab")
  const queryParam = searchParams.get("q") ?? ""
  const searching = queryParam.trim().length > 0
  const includeArchived = searchParams.get("archived") === "1"

  const [portalStatus, setPortalStatus] = useState<"loading" | "ok" | "error">("loading")
  const [portal, setPortal] = useState<PortalResponse | null>(null)
  const sources = orderSources(portal?.sources || [])
  const activeTab: DocTab = computeActiveTab(tabParam, sourceParam, pathParam, sources)

  // 보기 모드 및 출처 탭 결정
  const currentSourceObj = sources.find((s) => s.id === sourceParam)
  const currentSourceTab = currentSourceObj?.tab

  const initialKind = pathParam ? inferKindFromPath(pathParam) : undefined
  const initialViewMode = determineDocViewMode({ path: pathParam, kind: initialKind })
  const [viewMode, setViewMode] = useState<"grid" | "doc" | "file">(initialViewMode)

  // 문서 데이터
  const [docContent, setDocContent] = useState<string | null>(null)
  const [docBaseHash, setDocBaseHash] = useState<string>("")
  const [docLoading, setDocLoading] = useState(false)
  const [docError, setDocError] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState<string | null>(null)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [starError, setStarError] = useState<string | null>(null)
  const [groupFavoriteError, setGroupFavoriteError] = useState<string | null>(null)

  // 더러운 편집 상태 판정
  const isDirty = isEditing && editContent !== null && editContent !== docContent

  // 단일 이동 함수 (확인 취소 시 고친 글 유지, 확인 승인 또는 미수정 시 이동)
  const handleNavigate = (targetHref: string): boolean => {
    return canNavigateWithDiscardConfirm({
      isDirty,
      targetHref,
      confirmFn: (msg) => (typeof window !== "undefined" ? window.confirm(msg) : true),
      navigateFn: (url) => {
        setIsEditing(false)
        setEditContent(null)
        setSaveMessage(null)
        setStarError(null)
        router.push(url)
      },
    })
  }

  const isEditingRef = useRef(isEditing)
  isEditingRef.current = isEditing
  const handleNavigateRef = useRef(handleNavigate)
  handleNavigateRef.current = handleNavigate
  const lastAddressRef = useRef<string | null>(null)

  // 폴더 격자 데이터
  const [folderData, setFolderData] = useState<{
    entries: FolderGridEntry[]
    total: number
    truncated: boolean
  } | null>(null)

  // 파일 데이터
  const [fileData, setFileData] = useState<{
    kind?: FileKind
    size?: number
    textContent?: string | null
    textTruncated?: boolean
  } | null>(null)

  // 메모 데이터
  const [notes, setNotes] = useState<DocNoteItem[]>([])
  const [allOpenNotes, setAllOpenNotes] = useState<DocNoteItem[]>([])
  const [noteCounts, setNoteCounts] = useState<Record<string, number>>({})
  const [selectedQuote, setSelectedQuote] = useState<string | null>(null)

  // 즐겨찾기 데이터
  const [favorites, setFavorites] = useState<FavoriteItem[]>([])

  // 권한 제한 여부 (SP-06 403)
  const [forbidden, setForbidden] = useState(false)

  // 검색 상태
  const [queryInput, setQueryInput] = useState(queryParam)
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [archivedHidden, setArchivedHidden] = useState(0)
  const [searchError, setSearchError] = useState<string | null>(null)

  // 모바일 사이드바
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false)

  const lastApplied = useRef(queryParam)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 1. 포털 정보 불러오기
  const refreshPortal = () => {
    setPortalStatus("loading")
    fetch("/api/portal")
      .then((res) => {
        if (!res.ok) throw new Error("포털 정보를 불러오지 못했습니다")
        return res.json()
      })
      .then((data: PortalResponse) => {
        setPortal(data)
        setPortalStatus("ok")
      })
      .catch(() => {
        setPortal(null)
        setPortalStatus("error")
      })
  }

  useEffect(() => {
    refreshPortal()
  }, [])

  // 2. 전체 메모 및 카운트 불러오기
  const refreshNotes = () => {
    // 트리 카운트
    fetch("/api/portal/notes/counts")
      .then((res) => (res.ok ? res.json() : {}))
      .then((counts) => setNoteCounts(counts))
      .catch(() => {})

    // 전체 열린 메모 (배너용)
    fetch("/api/portal/notes?status=open")
      .then((res) => (res.ok ? res.json() : { notes: [] }))
      .then((data) => setAllOpenNotes(data.notes || []))
      .catch(() => {})

    // 현재 문서 메모
    if (sourceParam && pathParam && viewMode === "doc") {
      fetch(`/api/portal/notes?source=${encodeURIComponent(sourceParam)}&path=${encodeURIComponent(pathParam)}`)
        .then((res) => (res.ok ? res.json() : { notes: [] }))
        .then((data) => setNotes(data.notes || []))
        .catch(() => {})
    } else {
      setNotes([])
    }
  }

  useEffect(() => {
    refreshNotes()
  }, [sourceParam, pathParam, viewMode])

  // 3. 즐겨찾기 목록 불러오기
  const refreshFavorites = () => {
    fetch("/api/portal/favorites")
      .then((res) => {
        if (res.status === 403) {
          setForbidden(true)
          return { items: [] }
        }
        return res.ok ? res.json() : { items: [] }
      })
      .then((data) => setFavorites(data.items || []))
      .catch(() => {})
  }

  useEffect(() => {
    refreshFavorites()
  }, [])

  // 4. 주소에 따른 보기 상태 및 데이터 통합 로딩 (loadDocsViewState, 1·2번 보강)
  useEffect(() => {
    let canceled = false
    const currentAddress = (sourceParam ?? "") + "\u0000" + (pathParam ?? "")
    const addressChanged = lastAddressRef.current !== currentAddress
    lastAddressRef.current = currentAddress

    if (addressChanged) {
      setIsEditing(false)
      setEditContent(null)
      setSaveMessage(null)
    }
    setStarError(null)
    setGroupFavoriteError(null)

    if (portalStatus === "loading") {
      setDocLoading(true)
      return
    }

    if (!sourceParam) {
      setViewMode("grid")
      setFolderData(null)
      setDocContent(null)
      setDocBaseHash("")
      setDocError(null)
      setFileData(null)
      setDocLoading(false)
      return
    }

    setDocLoading(true)

    loadDocsViewState({
      tab: activeTab,
      source: sourceParam,
      path: pathParam,
      sources,
    })
      .then((state) => {
        if (canceled) return
        setViewMode(state.viewMode)
        setFolderData(state.folderData)
        const skipDocContent = (isEditing || isEditingRef.current) && !addressChanged
        if (!skipDocContent) {
          setDocContent(state.docContent)
          setDocBaseHash(state.docBaseHash)
        }
        setDocError(state.docError)
        setFileData(state.fileData)
        if (state.forbidden) setForbidden(true)
        setDocLoading(false)
      })
      .catch((err) => {
        if (canceled) return
        setDocError(err?.message || "데이터를 불러오지 못했습니다")
        setDocLoading(false)
      })

    return () => {
      canceled = true
    }
  }, [sourceParam, pathParam, portal, activeTab, portalStatus])

  // 7. 검색 쿼리 적용 (주소 변경 시 이동 확인 함수 경유)
  const applyQuery = (value: string) => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current)
      debounceTimer.current = null
    }
    const params = new URLSearchParams(window.location.search)
    if (value.trim()) params.set("q", value)
    else params.delete("q")
    if (!params.get("tab")) params.set("tab", activeTab)
    const targetHref = `/docs?${params.toString()}`

    const ok = handleNavigateRef.current(targetHref)
    if (!ok) {
      setQueryInput(queryParam)
      return
    }
    lastApplied.current = value.trim() ? value : ""
  }

  useEffect(() => {
    if (queryParam === lastApplied.current) return
    lastApplied.current = queryParam
    setQueryInput(queryParam)
  }, [queryParam])

  useEffect(() => {
    if (queryInput === lastApplied.current) return
    const timer = setTimeout(() => applyQuery(queryInput), 300)
    debounceTimer.current = timer
    return () => {
      clearTimeout(timer)
      if (debounceTimer.current === timer) debounceTimer.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryInput])

  useEffect(() => {
    if (!searching) {
      setHits(null)
      setArchivedHidden(0)
      setSearchError(null)
      return
    }
    const controller = new AbortController()
    setHits(null)
    setArchivedHidden(0)
    setSearchError(null)
    fetch(searchApiUrl(queryParam, includeArchived), { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`검색하지 못했습니다 (${res.status})`)
        return res.json()
      })
      .then((data: { results: SearchHit[]; archivedHidden?: number }) => {
        setHits(data.results)
        setArchivedHidden(data.archivedHidden ?? 0)
      })
      .catch((err) => {
        if (err.name !== "AbortError") setSearchError(err.message)
      })
    return () => controller.abort()
  }, [queryParam, searching, includeArchived])

  // 8. 첫 문서 자동 열기
  useEffect(() => {
    if (portalStatus !== "ok" || !portal || !shouldAutoOpenFirstDoc({ query: queryParam, sourceId: sourceParam, docPath: pathParam, portalLoaded: true })) return
    const sections = sectionsForTab(orderSources(portal.sources), activeTab)
    const section = sections.find((s) => s.sourceId.startsWith("company:")) ?? sections[0]
    const first = section ? firstCurrentDoc(section.tree) : null
    if (section && first) {
      router.replace(docHref(activeTab, section.sourceId, first))
    }
  }, [portalStatus, portal, sourceParam, pathParam, queryParam, activeTab, router])

  // 즐겨찾기 판정 및 토글 (alert 제거, 실패 시 별 근처 안내, docError 오염 방지)
  const isFavorite = favorites.some((f) => f.source === sourceParam && (f.path || "") === (pathParam || ""))
  const handleToggleFavorite = async () => {
    if (!sourceParam) return
    if (forbidden) {
      setStarError(MSG_FORBIDDEN)
      return
    }
    setStarError(null)
    const currentP = pathParam || ""
    if (isFavorite) {
      const res = await removeFavorite({ source: sourceParam, path: currentP })
      if (res.ok) refreshFavorites()
      else setStarError(res.error || "즐겨찾기에서 빼지 못했습니다.")
    } else {
      const res = await addFavorite({ source: sourceParam, path: currentP })
      if (res.ok) refreshFavorites()
      else setStarError(res.error || "즐겨찾기에 추가하지 못했습니다.")
    }
  }

  const handleRemoveFavorite = async (src: string, p: string) => {
    setGroupFavoriteError(null)
    const res = await removeFavorite({ source: src, path: p })
    if (res.ok) refreshFavorites()
    else setGroupFavoriteError(res.error || "즐겨찾기에서 빼지 못했습니다.")
  }

  const tabSections = sectionsForTab(sources, activeTab)
  const hasCompanySource = sources.some((s) => s.id.startsWith("company:"))

  return (
    <DocsView
      portalStatus={portalStatus}
      activeTab={activeTab}
      sources={sources}
      tabSections={tabSections}
      currentSource={sourceParam}
      currentPath={pathParam}
      sourceTab={currentSourceTab}
      noteCounts={noteCounts}
      mobileTreeOpen={mobileTreeOpen}
      onToggleMobileTree={() => setMobileTreeOpen(!mobileTreeOpen)}
      allOpenNotes={allOpenNotes}
      favorites={favorites}
      onRemoveFavorite={handleRemoveFavorite}
      isFavorite={isFavorite}
      onToggleFavorite={handleToggleFavorite}
      starError={starError}
      groupFavoriteError={groupFavoriteError}
      onNavigate={handleNavigate}
      editContent={editContent}
      onChangeEditContent={setEditContent}
      queryInput={queryInput}
      searching={searching}
      hits={hits}
      includeArchived={includeArchived}
      archivedHidden={archivedHidden}
      searchError={searchError}
      onQueryChange={setQueryInput}
      onSearchSubmit={() => applyQuery(queryInput)}
      onToggleArchived={(on) => {
        const params = new URLSearchParams(window.location.search)
        if (on) params.set("archived", "1")
        else params.delete("archived")
        if (!params.get("tab")) params.set("tab", activeTab)
        handleNavigate(`/docs?${params.toString()}`)
      }}
      onCloseSearch={() => {
        const params = new URLSearchParams(window.location.search)
        params.delete("q")
        if (!params.get("tab")) params.set("tab", activeTab)
        handleNavigate(`/docs?${params.toString()}`)
      }}
      viewMode={viewMode}
      forbidden={forbidden}
      folderData={folderData}
      docContent={docContent}
      docBaseHash={docBaseHash}
      docLoading={docLoading}
      docError={docError}
      isEditing={isEditing}
      saveMessage={saveMessage}
      onStartEdit={() => {
        if (forbidden) return
        setIsEditing(true)
        setEditContent(docContent)
        setSaveMessage(null)
      }}
      onCancelEdit={() => {
        setIsEditing(false)
        setEditContent(null)
      }}
      onSaveDocSuccess={(newContent, newHash) => {
        setDocContent(newContent)
        setDocBaseHash(newHash)
        setEditContent(null)
        setIsEditing(false)
        setSaveMessage(MSG_SAVED_DOC)
      }}
      notes={notes}
      selectedQuote={selectedQuote}
      onQuoteSelect={(q) => setSelectedQuote(q)}
      onClearQuote={() => setSelectedQuote(null)}
      onNotesChange={refreshNotes}
      fileData={fileData}
      hasCompanySource={hasCompanySource}
    />
  )
}

export default function DocsPage() {
  return (
    <Suspense fallback={<div className="text-neutral-500 py-12 text-center text-sm">문서 포털 로딩 중...</div>}>
      <DocsViewer />
    </Suspense>
  )
}
