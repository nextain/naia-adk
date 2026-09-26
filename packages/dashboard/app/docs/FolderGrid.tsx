"use client"

import React from "react"
import Link from "next/link"
import {
  Folder,
  Star,
  Video,
  Music,
  FileText,
  FileCode,
  File as FileIcon,
  BookOpen,
} from "lucide-react"
import {
  createBreadcrumbs,
  formatFileSize,
  getFileName,
  MSG_FORBIDDEN,
  MSG_TRUNCATED_GRID,
  sortGridEntries,
  type FileKind,
  type FolderGridEntry,
} from "./kinds"
import { docHref, type DocTab } from "./tabs"

export interface FolderGridProps {
  sourceId: string
  sourceTitle: string
  path: string // 출처 기준 상대 경로, 루트는 ""
  tab: DocTab
  entries: FolderGridEntry[]
  total?: number
  truncated?: boolean
  isFavorite?: boolean
  onToggleFavorite?: () => void
  starError?: string | null
  forbidden?: boolean // SP-06 403 상태
  onNavigate?: (targetHref: string) => boolean
}

function GridItemIcon({ kind }: { kind?: FileKind }) {
  switch (kind) {
    case "doc":
      return <BookOpen className="w-10 h-10 text-blue-400" />
    case "video":
      return <Video className="w-10 h-10 text-purple-400" />
    case "audio":
      return <Music className="w-10 h-10 text-emerald-400" />
    case "pdf":
      return <FileText className="w-10 h-10 text-rose-400" />
    case "text":
      return <FileCode className="w-10 h-10 text-sky-400" />
    default:
      return <FileIcon className="w-10 h-10 text-neutral-400" />
  }
}

export function FolderGrid({
  sourceId,
  sourceTitle,
  path,
  tab,
  entries,
  total,
  truncated = false,
  isFavorite = false,
  onToggleFavorite,
  starError,
  forbidden = false,
  onNavigate,
}: FolderGridProps) {
  const breadcrumbs = createBreadcrumbs(sourceTitle, path)
  const currentTitle = path ? getFileName(path) : sourceTitle
  const sortedEntries = sortGridEntries(entries)
  const itemCount = total !== undefined ? total : entries.length

  // SP-06: 403 Forbidden이면 격자 대신 안내 한 줄 표시
  if (forbidden) {
    return (
      <div className="space-y-6">
        <div className="pb-4 border-b border-neutral-800">
          <nav aria-label="폴더 경로" className="flex items-center gap-1.5 text-xs text-neutral-400 flex-wrap">
            {breadcrumbs.map((crumb, idx) => {
              const isLast = idx === breadcrumbs.length - 1
              return (
                <span key={crumb.path || "root"} className="flex items-center gap-1.5">
                  <span className={isLast ? "font-medium text-neutral-200" : ""}>{crumb.name}</span>
                  {!isLast && <span className="text-neutral-600">/</span>}
                </span>
              )
            })}
          </nav>
          <h1 className="text-xl font-bold text-white mt-1 truncate">{currentTitle}</h1>
        </div>
        <div className="p-8 text-center text-sm text-neutral-400 bg-neutral-900/40 rounded-lg border border-neutral-800">
          {MSG_FORBIDDEN}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 상단 헤더: 이동 경로, 폴더 이름, 별, 항목 수 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-neutral-800">
        <div className="space-y-1 min-w-0">
          {/* 누를 수 있는 이동 경로 (breadcrumbs) */}
          <nav aria-label="폴더 경로" className="flex items-center gap-1.5 text-xs text-neutral-400 flex-wrap">
            {breadcrumbs.map((crumb, idx) => {
              const isLast = idx === breadcrumbs.length - 1
              if (isLast) {
                return (
                  <span key={crumb.path || "root"} className="font-medium text-neutral-200 truncate">
                    {crumb.name}
                  </span>
                )
              }
              return (
                <span key={crumb.path || "root"} className="flex items-center gap-1.5">
                  <Link
                    href={docHref(tab, sourceId, crumb.path)}
                    onClick={(e) => {
                      const href = docHref(tab, sourceId, crumb.path)
                      if (onNavigate && !onNavigate(href)) {
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
            <h1 className="text-xl font-bold text-white truncate">{currentTitle}</h1>
            {onToggleFavorite && (
              <button
                type="button"
                onClick={onToggleFavorite}
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

        {/* 항목 수 */}
        <div className="shrink-0 text-xs text-neutral-400">
          <span>{`${itemCount}개 항목`}</span>
        </div>
      </div>

      {/* 500개 초과 문구 (truncated가 true일 때만 표시) */}
      {truncated && (
        <div className="px-3 py-2 rounded bg-amber-950/40 border border-amber-900/60 text-amber-300 text-xs">
          {MSG_TRUNCATED_GRID}
        </div>
      )}

      {/* 격자 칸 목록: 휴대폰 2칸, 넓으면 늘어남, 가로 스크롤 없음 */}
      {sortedEntries.length === 0 ? (
        <div className="p-12 text-center text-sm text-neutral-500 bg-neutral-900/30 rounded-lg border border-neutral-800">
          폴더가 비어 있습니다.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {sortedEntries.map((entry) => {
            const isDir = entry.type === "directory"
            const href = docHref(tab, sourceId, entry.path)
            const entryName = getFileName(entry.name)

            if (isDir) {
              const coverUrl = entry.cover
                ? `/api/portal/asset?source=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(entry.cover)}`
                : null

              return (
                <Link
                  key={entry.path}
                  href={href}
                  onClick={(e) => {
                    if (onNavigate && !onNavigate(href)) {
                      e.preventDefault()
                    }
                  }}
                  className="group flex flex-col rounded-lg border border-neutral-800 bg-neutral-900/40 hover:bg-neutral-900 hover:border-neutral-700 p-2.5 transition-all text-left"
                >
                  <div className="w-full h-28 rounded bg-neutral-950 flex items-center justify-center overflow-hidden mb-2 relative">
                    {coverUrl ? (
                      <img
                        src={coverUrl}
                        loading="lazy"
                        alt=""
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                      />
                    ) : (
                      <Folder className="w-12 h-12 text-amber-500/80 group-hover:scale-110 transition-transform duration-200" />
                    )}
                  </div>
                  <span className="font-medium text-xs text-neutral-200 group-hover:text-white truncate" title={entryName}>
                    {entryName}
                  </span>
                </Link>
              )
            }

            // 파일 칸
            const isImage = entry.kind === "image"
            const assetUrl = `/api/portal/asset?source=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(entry.path)}`

            return (
              <Link
                key={entry.path}
                href={href}
                onClick={(e) => {
                  if (onNavigate && !onNavigate(href)) {
                    e.preventDefault()
                  }
                }}
                className="group flex flex-col rounded-lg border border-neutral-800 bg-neutral-900/40 hover:bg-neutral-900 hover:border-neutral-700 p-2.5 transition-all text-left"
              >
                <div className="w-full h-28 rounded bg-neutral-950 flex items-center justify-center overflow-hidden mb-2 relative">
                  {isImage ? (
                    <img
                      src={assetUrl}
                      loading="lazy"
                      alt=""
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    />
                  ) : (
                    <div className="group-hover:scale-110 transition-transform duration-200">
                      <GridItemIcon kind={entry.kind} />
                    </div>
                  )}
                </div>
                <span className="font-medium text-xs text-neutral-200 group-hover:text-white truncate" title={entryName}>
                  {entryName}
                </span>
                <span className="text-[10px] text-neutral-500 mt-0.5">{formatFileSize(entry.size)}</span>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
