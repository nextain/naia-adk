"use client"

import React from "react"
import Link from "next/link"
import { Star, X, Folder, File as FileIcon, BookOpen } from "lucide-react"
import {
  getFileName,
  isFavoriteMissing,
  mapFavoritesError,
  type FavoriteItem,
} from "./kinds"
import { docHref, type DocTab } from "./tabs"

// ── 즐겨찾기 API 함수 ───────────────────────────────────────────────────────
export async function addFavorite(params: {
  source: string
  path: string
  fetchFn?: typeof fetch
}): Promise<{ ok: boolean; status: number; error?: string }> {
  const fetcher = params.fetchFn ?? fetch
  try {
    const res = await fetcher("/api/portal/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: params.source,
        path: params.path,
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (res.ok) {
      return { ok: true, status: res.status }
    }
    return { ok: false, status: res.status, error: mapFavoritesError(res.status, json) }
  } catch {
    return { ok: false, status: 0, error: "즐겨찾기에 추가하지 못했습니다." }
  }
}

export async function removeFavorite(params: {
  source: string
  path: string
  fetchFn?: typeof fetch
}): Promise<{ ok: boolean; status: number; error?: string }> {
  const fetcher = params.fetchFn ?? fetch
  try {
    const res = await fetcher("/api/portal/favorites", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: params.source,
        path: params.path,
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (res.ok) {
      return { ok: true, status: res.status }
    }
    return { ok: false, status: res.status, error: mapFavoritesError(res.status, json) }
  } catch {
    return { ok: false, status: 0, error: "즐겨찾기에서 빼지 못했습니다." }
  }
}

// ── 트리 상단 즐겨찾기 묶음 (SP-01) ──────────────────────────────────────────
export interface FavoritesGroupProps {
  favorites: FavoriteItem[]
  tab: DocTab
  currentSource?: string | null
  currentPath?: string | null
  errorMessage?: string | null
  onRemoveFavorite?: (source: string, path: string) => void
  onNavigate?: (targetHref: string) => boolean
}

export function FavoritesGroup({
  favorites,
  tab,
  currentSource,
  currentPath,
  errorMessage,
  onRemoveFavorite,
  onNavigate,
}: FavoritesGroupProps) {
  // 비어 있으면 묶음을 숨긴다 (SP-01)
  if (!favorites || favorites.length === 0) {
    return null
  }

  return (
    <div className="space-y-1 pb-3 mb-2 border-b border-neutral-800/80">
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-bold tracking-wider text-neutral-400">
        <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
        <span>즐겨찾기</span>
      </div>

      {errorMessage && (
        <div className="px-2 py-1 text-xs text-amber-400 bg-amber-950/40 border border-amber-900/60 rounded">
          {errorMessage}
        </div>
      )}

      <div className="space-y-0.5">
        {favorites.map((item) => {
          const isMissing = isFavoriteMissing(item)
          const isSelected = !isMissing && currentSource === item.source && currentPath === item.path
          const itemName = item.path ? getFileName(item.path) : item.source
          const isDir = item.type === "directory"

          if (isMissing) {
            // 없어진 항목은 흐린 글씨 + 빼기만 가능 (SP-01, RQ-07)
            return (
              <div
                key={`${item.source}:${item.path}`}
                className="flex items-center justify-between py-1 px-2 rounded text-xs text-neutral-500 opacity-60"
              >
                <div className="flex items-center gap-1.5 truncate">
                  <FileIcon className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate line-through" title="없어진 항목입니다">
                    {itemName}
                  </span>
                </div>
                {onRemoveFavorite && (
                  <button
                    type="button"
                    onClick={() => onRemoveFavorite(item.source, item.path)}
                    title="즐겨찾기에서 빼기"
                    aria-label={`${itemName} 즐겨찾기에서 빼기`}
                    className="p-0.5 rounded hover:bg-neutral-800 text-neutral-500 hover:text-neutral-300"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )
          }

          const targetHref = docHref(tab, item.source, item.path)

          return (
            <div
              key={`${item.source}:${item.path}`}
              className={`group flex items-center justify-between rounded text-xs transition-colors ${
                isSelected
                  ? "bg-neutral-800 text-white font-medium border-l-2 border-amber-400"
                  : "text-neutral-300 hover:text-white hover:bg-neutral-900"
              }`}
            >
              <Link
                href={targetHref}
                onClick={(e) => {
                  if (onNavigate && !onNavigate(targetHref)) {
                    e.preventDefault()
                  }
                }}
                className="flex items-center gap-1.5 py-1 px-2 min-w-0 flex-1 truncate"
              >
                {isDir ? (
                  <Folder className="w-3.5 h-3.5 text-amber-500/80 shrink-0" />
                ) : (
                  <BookOpen className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                )}
                <span className="truncate">{itemName}</span>
              </Link>

              {onRemoveFavorite && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onRemoveFavorite(item.source, item.path)
                  }}
                  title="즐겨찾기에서 빼기"
                  aria-label={`${itemName} 즐겨찾기에서 빼기`}
                  className="p-1 mr-1 rounded opacity-0 group-hover:opacity-100 hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-opacity"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
