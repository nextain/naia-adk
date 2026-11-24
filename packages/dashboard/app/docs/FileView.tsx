"use client"

import React, { useState } from "react"
import Link from "next/link"
import { Star, Download, FileText, Music, File as FileIcon } from "lucide-react"
import {
  createBreadcrumbs,
  formatDimensions,
  formatFileSize,
  formatJsonIfPossible,
  getFileName,
  inferKindFromPath,
  type FileKind,
} from "./kinds"
import { tFor } from "../i18n/index.ts"
import { getActiveLocale } from "../i18n/provider.tsx"
import { docHref, type DocTab } from "./tabs"
import { LinkedCardsPanel } from "./LinkedCardsPanel"
import type { LedgerCardItem } from "../work/work-ledger-view"

export interface FileViewProps {
  sourceId: string
  sourceTitle: string
  path: string
  tab: DocTab
  size?: number
  kind?: FileKind
  textContent?: string | null
  textTruncated?: boolean
  isFavorite?: boolean
  onToggleFavorite?: () => void
  starError?: string | null
  onNavigate?: (targetHref: string) => boolean
  linkedCards?: LedgerCardItem[]
}

export function FileView({
  sourceId,
  sourceTitle,
  path,
  tab,
  size,
  kind: propKind,
  textContent,
  textTruncated,
  isFavorite = false,
  onToggleFavorite,
  starError,
  onNavigate,
  linkedCards = [],
}: FileViewProps) {
  const locale = getActiveLocale()
  const t = tFor(locale)
  const fileName = getFileName(path)
  const kind = propKind || inferKindFromPath(path)
  const breadcrumbs = createBreadcrumbs(sourceTitle, path)
  const [fitToWidth, setFitToWidth] = useState(true)
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null)

  const assetUrl = `/api/portal/asset?source=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(path)}`
  const downloadUrl = `/api/portal/asset?source=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(path)}&download=1`

  const dimensionText = formatDimensions(imageDimensions?.width, imageDimensions?.height)

  return (
    <div className="space-y-6">
      {/* 상단 헤더: 이동 경로, 파일 이름, 별, 크기, 가로세로, 내려받기 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-neutral-800">
        <div className="space-y-1 min-w-0">
          {/* 누를 수 있는 이동 경로 (breadcrumbs) */}
          <nav aria-label={t("docs.filePath")} className="flex items-center gap-1.5 text-xs text-neutral-400 flex-wrap">
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

          {/* 파일 제목과 별 버튼 */}
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-white truncate">{fileName}</h1>
            {onToggleFavorite && (
              <button
                type="button"
                onClick={onToggleFavorite}
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
          </div>
        </div>

        {/* 메타 정보 및 내려받기 */}
        <div className="flex items-center gap-3 shrink-0">
          {Boolean(formatFileSize(size)) && (
            <span className="text-xs text-neutral-400">{formatFileSize(size)}</span>
          )}
          {dimensionText && <span className="text-xs text-neutral-400">{dimensionText}</span>}
          <a
            href={downloadUrl}
            download={fileName}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-neutral-900 border border-neutral-800 hover:bg-neutral-800 text-xs font-medium text-neutral-200 hover:text-white transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            {t("common.download")}
          </a>
        </div>
      </div>

      {/* 본문 보기: 종류별 분기 */}
      <div className="min-w-0">
        {kind === "image" && (
          <div className="space-y-2">
            <div className="overflow-auto max-h-[75vh] flex items-center justify-center p-4 rounded-lg bg-neutral-950 border border-neutral-800">
              <img
                src={assetUrl}
                alt={fileName}
                onClick={() => setFitToWidth(!fitToWidth)}
                onLoad={(e) => {
                  const img = e.currentTarget
                  setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight })
                }}
                className={`rounded transition-all cursor-pointer ${
                  fitToWidth ? "max-w-full h-auto object-contain" : "max-w-none w-auto"
                }`}
                title={fitToWidth ? t("docs.actualSize") : t("docs.fitWidth")}
              />
            </div>
            <p className="text-center text-xs text-neutral-500">
              {fitToWidth ? t("docs.actualSizeTitle") : t("docs.fitWidthTitle")}
            </p>
          </div>
        )}

        {kind === "video" && (
          <div className="p-4 rounded-lg bg-neutral-950 border border-neutral-800 flex justify-center">
            <video src={assetUrl} controls className="max-w-full max-h-[75vh] rounded" preload="metadata">
              {t("docs.videoUnsupported")}
            </video>
          </div>
        )}

        {kind === "audio" && (
          <div className="p-8 rounded-lg bg-neutral-950 border border-neutral-800 flex flex-col items-center gap-4">
            <Music className="w-12 h-12 text-neutral-500" />
            <audio src={assetUrl} controls className="w-full max-w-md" preload="metadata">
              {t("docs.audioUnsupported")}
            </audio>
          </div>
        )}

        {kind === "pdf" && (
          <div className="rounded-lg bg-neutral-950 border border-neutral-800 overflow-hidden">
            <object data={assetUrl} type="application/pdf" className="w-full h-[750px]">
              <div className="p-8 text-center text-neutral-400 space-y-3">
                <FileText className="w-10 h-10 mx-auto text-neutral-500" />
                <p className="text-sm">{t("docs.pdfUnsupported")}</p>
                <a
                  href={downloadUrl}
                  download={fileName}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-neutral-800 text-neutral-200 text-xs hover:bg-neutral-700"
                >
                  <Download className="w-3.5 h-3.5" />
                  {t("common.download")}
                </a>
              </div>
            </object>
          </div>
        )}

        {kind === "text" && (
          <div className="space-y-2">
            {textTruncated && (
              <div className="px-3 py-2 rounded bg-amber-950/40 border border-amber-900/60 text-amber-300 text-xs">
                {t("docs.truncatedText")}
              </div>
            )}
            <pre className="p-4 rounded-lg bg-neutral-900 border border-neutral-800 overflow-x-auto text-xs font-mono text-neutral-200 whitespace-pre-wrap leading-relaxed max-h-[75vh]">
              {formatJsonIfPossible(textContent ?? "")}
            </pre>
          </div>
        )}

        {kind === "other" && (
          <div className="p-12 rounded-lg bg-neutral-950 border border-neutral-800 text-center space-y-4">
            <FileIcon className="w-12 h-12 mx-auto text-neutral-600" />
            <div className="space-y-1">
              <p className="text-sm text-neutral-300">{t("docs.noPreview")}</p>
              <p className="text-xs text-neutral-500">{t("docs.formatUnsupported")}</p>
            </div>
            <a
              href={downloadUrl}
              download={fileName}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-neutral-800 hover:bg-neutral-700 text-xs font-medium text-white transition-colors"
            >
              <Download className="w-4 h-4" />
              {t("common.download")}
            </a>
          </div>
        )}
      </div>

      <LinkedCardsPanel cards={linkedCards} />
    </div>
  )
}
