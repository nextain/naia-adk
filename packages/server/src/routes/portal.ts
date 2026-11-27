import type { FastifyInstance, FastifyPluginCallback, FastifyRequest, FastifyReply } from "fastify"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { validateCompanyConfig, type CompanyConfig } from "@naia-adk/core"
import {
  readViewFoldersFile,
  evaluateViewFolder,
  resolveFolderContext,
  type FolderCheckContext,
} from "../view-folders.js"
import {
  isValidNoteId,
  isValidNoteAwaiting,
  generateNoteId,
  readNote,
  saveNote,
  deleteNote,
  listNotes,
  countOpenNotes,
  validateNoteLengths,
  getNoteFilePath,
  type DocNote,
  type NoteAwaiting,
} from "../notes.js"
import {
  readFavorites,
  readFavoritesSecure,
  saveFavorites,
  getFavoritesFilePath,
  type DocFavoriteItem,
} from "../favorites.js"
import { withFileLock, FileLockTimeoutError } from "../file-lock.js"
import { isLedgerRequestAllowed, queryPortalWorkLedger, type LedgerQueryParams } from "../work-ledger-portal.js"
import { messengerEnabled } from "./portal-messenger.js"
import {
  clampDateRange,
  parseStatesQueryParam,
  readCompanySchedules,
} from "../company-schedule.js"
import {
  deleteScheduleComment,
  generateScheduleCommentId,
  getScheduleCommentFilePath,
  getScheduleOverridesFilePath,
  inferTargetRole,
  isValidScheduleCommentId,
  isValidScheduleItemId,
  listScheduleComments,
  readScheduleComment,
  readScheduleOverrides,
  saveScheduleComment,
  saveScheduleOverrides,
  validateScheduleCommentBody,
  validateScheduleOverridePatch,
  type ScheduleComment,
} from "../company-schedule-feedback.js"
import {
  collectDecisions,
  resolveDecisionItem,
} from "../decisions-service.js"
import {
  DocOverlayStore,
  isValidOverlaySource,
  overlayDbPath,
} from "../doc-overlay-store.js"
import { writeNoteWake } from "../note-wake.js"

export type FileKind = "doc" | "image" | "video" | "audio" | "pdf" | "text" | "other"

export interface PortalTreeNode {
  name: string
  path: string
  type: "file" | "directory"
  kind?: FileKind
  size?: number
  children?: PortalTreeNode[]
  truncated?: boolean
}

export interface PortalSource {
  id: string
  title: string
  tree: PortalTreeNode[]
  truncated?: boolean
  tab?: "common" | "brand" | "developer"
  readOnly?: boolean
  missing?: boolean
}

export interface PortalBoardInfo {
  port: number
}

export interface PortalResponse {
  sources: PortalSource[]
  board: PortalBoardInfo | null
  messenger?: { enabled: boolean }
}

export function getFileKind(fileName: string): FileKind {
  const ext = path.extname(fileName).toLowerCase().replace(/^\./, "")
  if (!ext) return "other"
  // 실행될 수 있는 형식(html, htm, xhtml, js, mjs 등)은 other로 다룬다.
  if (["html", "htm", "xhtml", "js", "mjs", "cjs", "jsx", "ts", "tsx"].includes(ext)) {
    return "other"
  }
  switch (ext) {
    case "md":
      return "doc"
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "svg":
    case "avif":
      return "image"
    case "mp4":
    case "webm":
    case "mov":
    case "m4v":
      return "video"
    case "mp3":
    case "wav":
    case "ogg":
    case "m4a":
    case "flac":
      return "audio"
    case "pdf":
      return "pdf"
    case "json":
    case "yaml":
    case "yml":
    case "txt":
    case "csv":
    case "log":
    case "toml":
      return "text"
    default:
      return "other"
  }
}

export function getAssetContentType(fileName: string, kind: FileKind): string {
  const ext = path.extname(fileName).toLowerCase()
  if (kind === "doc" || kind === "text") {
    return "text/plain; charset=utf-8"
  }
  if (kind === "pdf") {
    return "application/pdf"
  }
  if (kind === "image") {
    switch (ext) {
      case ".png": return "image/png"
      case ".jpg":
      case ".jpeg": return "image/jpeg"
      case ".gif": return "image/gif"
      case ".webp": return "image/webp"
      case ".svg": return "image/svg+xml"
      case ".avif": return "image/avif"
      default: return "image/png"
    }
  }
  if (kind === "video") {
    switch (ext) {
      case ".mp4": return "video/mp4"
      case ".webm": return "video/webm"
      case ".mov": return "video/quicktime"
      case ".m4v": return "video/mp4"
      default: return "video/mp4"
    }
  }
  if (kind === "audio") {
    switch (ext) {
      case ".mp3": return "audio/mpeg"
      case ".wav": return "audio/wav"
      case ".ogg": return "audio/ogg"
      case ".m4a": return "audio/mp4"
      case ".flac": return "audio/flac"
      default: return "audio/mpeg"
    }
  }
  return "application/octet-stream"
}

function normalizeRelativePath(rawPath: string): string | null {
  if (!rawPath || typeof rawPath !== "string") return null
  // Fastify가 이미 쿼리를 풀었으므로 다시 풀지 않는다('%'가 든 이름이 오류 나지 않게).
  const decoded = rawPath.replace(/\\/g, "/")
  const segments = decoded.split("/").filter((s) => s.length > 0)
  if (segments.includes("..") || path.isAbsolute(decoded) || decoded.startsWith("/")) {
    return null
  }
  return segments.join("/")
}

// 이름은 소문자로 바꾸고 끝의 점·공백을 뗀 뒤 비교한다. 대소문자를 가리지 않는 Windows·macOS 파일 시스템 대비.
// 숨김(점 시작)·node_modules·data-private이면 제외.
export function isExcludedName(name: string): boolean {
  if (!name || typeof name !== "string") return true
  const trimmed = name.normalize("NFC").replace(/[\s.]+$/, "").toLowerCase()
  if (!trimmed) return true
  if (trimmed.startsWith(".") || trimmed === "node_modules" || trimmed === "data-private") {
    return true
  }
  return false
}

// 출처 루트 안쪽의 상대 경로 조각 중 하나라도 숨김·node_modules·data-private이면 참.
// 빈 경로는 출처 루트(루트 자체)이므로 거짓.
export function isHiddenPath(relPath: string): boolean {
  if (!relPath || typeof relPath !== "string") return false
  const segments = relPath.replace(/\\/g, "/").split("/").filter((s) => s.length > 0)
  return segments.some(isExcludedName)
}

const OPEN_READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)

const loggedHardlinkPaths = new Set<string>()

export function logHardlinkHidden(filePath: string) {
  if (!loggedHardlinkPaths.has(filePath)) {
    loggedHardlinkPaths.add(filePath)
    console.log(`${filePath}: 하드 링크라 숨김`)
  }
}

export function clearLoggedHardlinks() {
  loggedHardlinkPaths.clear()
}

export interface InspectFileResult {
  ok: boolean
  fd?: number
  stat?: fs.Stats
  isHardlink?: boolean
  error?: "hardlink" | "not_file" | "open_failed"
}

/**
 * 실경로(realpath)로 푼 뒤 연 fd의 fstat으로 판정하는 공통 함수.
 * 정규 파일이고 nlink === 1일 때만 ok: true.
 * nlink > 1이면 없는 파일처럼 취급.
 * forListing === true일 때 하드링크이면 API 로그에 1회 '하드 링크라 숨김' 기록.
 * keepFdOpen === true이면 fd를 닫지 않고 반환 (호출자가 사용 후 반드시 closeSync 해야 함).
 */
export function inspectSecureFile(
  realPath: string,
  keepFdOpen = false,
  forListing = false,
): InspectFileResult {
  let fd: number
  try {
    fd = fs.openSync(realPath, OPEN_READ_FLAGS)
  } catch {
    return { ok: false, error: "open_failed" }
  }

  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) {
      fs.closeSync(fd)
      return { ok: false, error: "not_file" }
    }
    if (stat.nlink > 1) {
      fs.closeSync(fd)
      if (forListing) {
        logHardlinkHidden(realPath)
      }
      return { ok: false, isHardlink: true, error: "hardlink" }
    }

    if (keepFdOpen) {
      return { ok: true, fd, stat }
    } else {
      fs.closeSync(fd)
      return { ok: true, stat }
    }
  } catch {
    try {
      fs.closeSync(fd)
    } catch {}
    return { ok: false, error: "open_failed" }
  }
}

export function buildTree(absBaseDir: string, currentRelDir: string): PortalTreeNode[] {
  const currentAbsDir = path.join(absBaseDir, currentRelDir)
  if (!fs.existsSync(currentAbsDir)) return []

  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(currentAbsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const validEntries = entries.filter((e) => !isExcludedName(e.name))

  const dirEntries: fs.Dirent[] = []
  const fileEntries: fs.Dirent[] = []

  for (const entry of validEntries) {
    if (entry.isDirectory()) {
      dirEntries.push(entry)
    } else if (entry.isFile()) {
      fileEntries.push(entry)
    }
  }

  dirEntries.sort((a, b) => a.name.localeCompare(b.name, "ko"))

  const dirNodes: PortalTreeNode[] = []
  let nonEmptyDirCount = 0

  for (const dirEntry of dirEntries) {
    // W1b-2: 비어 있지 않은 폴더가 이미 500개일 때만 그 뒤 폴더를 열지 않는다.
    if (nonEmptyDirCount >= 500) {
      break
    }

    const relPath = currentRelDir ? `${currentRelDir}/${dirEntry.name}` : dirEntry.name
    const children = buildTree(absBaseDir, relPath)
    // 파일 하나라도 있는 폴더는 넣는다.
    if (children.length > 0) {
      nonEmptyDirCount++
      const truncated = children.length > 500
      dirNodes.push({
        name: dirEntry.name,
        path: relPath,
        type: "directory",
        children: truncated ? children.slice(0, 500) : children,
        ...(truncated ? { truncated: true } : {}),
      })
    }
  }

  const fileNodes: PortalTreeNode[] = []
  for (const fileEntry of fileEntries) {
    const relPath = currentRelDir ? `${currentRelDir}/${fileEntry.name}` : fileEntry.name
    const absPath = path.join(absBaseDir, relPath)
    try {
      let realPath: string
      try {
        realPath = fs.realpathSync.native(absPath)
      } catch {
        continue
      }
      let stat: fs.Stats
      try {
        stat = fs.statSync(realPath)
      } catch {
        continue
      }
      if (!stat.isFile()) {
        continue
      }
      if (stat.nlink > 1) {
        logHardlinkHidden(realPath)
        continue
      }
      const kind = getFileKind(fileEntry.name)
      fileNodes.push({
        name: fileEntry.name,
        path: relPath,
        type: "file",
        kind,
        size: stat.size,
      })
    } catch {
      // 읽을 수 없는 파일 무시
    }
  }

  fileNodes.sort((a, b) => a.name.localeCompare(b.name, "ko"))

  return [...dirNodes, ...fileNodes]
}

// 하위 호환성 및 기존 호출 호환을 위해 buildMdTree도 유지하되 내부적으로 buildTree를 호출할 수 있게 하거나 buildTree를 기본으로 둠
export const buildMdTree = buildTree

export interface ResolvedSource {
  id: string
  title: string
  baseDir: string
  allowedPrefixes: string[] | null // null means entire baseDir is allowed
  readOnly?: boolean
  tab?: "common" | "brand" | "developer"
}

function loadCompanyConfigs(adkRoot: string): Array<{
  companyName: string
  companyDir: string
  config: CompanyConfig
}> {
  const dataCompanyDir = path.join(adkRoot, "data-company")
  if (!fs.existsSync(dataCompanyDir)) return []

  const list: Array<{ companyName: string; companyDir: string; config: CompanyConfig }> = []
  try {
    const entries = fs.readdirSync(dataCompanyDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const configPath = path.join(dataCompanyDir, entry.name, "adk-company.json")
      if (!fs.existsSync(configPath)) continue

      try {
        const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"))
        const validation = validateCompanyConfig(raw)
        if (validation.valid) {
          list.push({
            companyName: entry.name,
            companyDir: path.join(dataCompanyDir, entry.name),
            config: validation.data,
          })
        }
      } catch {
        // Skip malformed configs
      }
    }
  } catch {
    // Ignore directory read errors
  }

  return list
}

export function getSourcesAndBoard(
  adkRoot: string,
  context?: FolderCheckContext,
): {
  sources: PortalSource[]
  resolvedSources: Map<string, ResolvedSource>
  board: PortalBoardInfo | null
} {
  const sources: PortalSource[] = []
  const resolvedSources = new Map<string, ResolvedSource>()
  let boardInfo: PortalBoardInfo | null = null

  // 1. ADK docs
  const adkDocsDir = path.join(adkRoot, "docs")
  if (fs.existsSync(adkDocsDir)) {
    const adkTree = buildTree(adkDocsDir, "")
    const truncated = adkTree.length > 500
    sources.push({
      id: "adk",
      title: "ADK 문서",
      tree: truncated ? adkTree.slice(0, 500) : adkTree,
      ...(truncated ? { truncated: true } : {}),
    })
    resolvedSources.set("adk", {
      id: "adk",
      title: "ADK 문서",
      baseDir: adkDocsDir,
      allowedPrefixes: null,
    })
  }

  // 2. Company docs and repos
  const companyList = loadCompanyConfigs(adkRoot)

  for (const { companyName, companyDir, config } of companyList) {
    const companyId = `company:${companyName}`
    const includeDirs = config.docs?.include || []
    const companyTree: PortalTreeNode[] = []

    for (const inc of includeDirs) {
      const incTree = buildTree(companyDir, inc)
      if (incTree.length > 0) {
        const truncated = incTree.length > 500
        companyTree.push({
          name: inc,
          path: inc,
          type: "directory",
          children: truncated ? incTree.slice(0, 500) : incTree,
          ...(truncated ? { truncated: true } : {}),
        })
      }
    }

    sources.push({
      id: companyId,
      title: config.title || "회사 문서",
      tree: companyTree,
    })

    resolvedSources.set(companyId, {
      id: companyId,
      title: config.title || "회사 문서",
      baseDir: companyDir,
      allowedPrefixes: includeDirs,
    })

    // Repos
    if (Array.isArray(config.repos)) {
      for (const repo of config.repos) {
        const repoPathNorm = repo.path.replace(/\\/g, "/")
        const repoAbsDir = path.resolve(adkRoot, repoPathNorm)
        const repoIncludeDirs = repo.docs?.include || []
        const repoTree: PortalTreeNode[] = []

        if (fs.existsSync(repoAbsDir)) {
          for (const inc of repoIncludeDirs) {
            const incTree = buildTree(repoAbsDir, inc)
            if (incTree.length > 0) {
              const truncated = incTree.length > 500
              repoTree.push({
                name: inc,
                path: inc,
                type: "directory",
                children: truncated ? incTree.slice(0, 500) : incTree,
                ...(truncated ? { truncated: true } : {}),
              })
            }
          }
        }

        sources.push({
          id: repo.id,
          title: repo.docs?.title || repo.id,
          tree: repoTree,
        })

        resolvedSources.set(repo.id, {
          id: repo.id,
          title: repo.docs?.title || repo.id,
          baseDir: repoAbsDir,
          allowedPrefixes: repoIncludeDirs,
        })
      }
    }

    // Board info
    if (!boardInfo && config.board && config.board.port) {
      boardInfo = { port: config.board.port }
    }
  }

  // 3. View folders (data:<id>)
  const resolvedCtx = resolveFolderContext(adkRoot, context)
  const { folders, errors } = readViewFoldersFile(adkRoot)
  if (errors.length > 0) {
    for (const err of errors) {
      console.warn(`[view-folders] ${err}`)
    }
  }

  for (const folder of folders) {
    const evalResult = evaluateViewFolder(folder, resolvedCtx)
    const sourceId = `data:${folder.id}`
    const tab = folder.tab || "common"

    if (evalResult.status === "forbidden") {
      console.warn(`[view-folders] Skipping forbidden folder ${folder.id}: ${evalResult.reason}`)
      continue
    }

    if (evalResult.status === "missing") {
      sources.push({
        id: sourceId,
        title: folder.label,
        tree: [],
        tab,
        readOnly: true,
        missing: true,
      })
      continue
    }

    const realPath = evalResult.realPath
    const folderTree = buildTree(realPath, "")
    const truncated = folderTree.length > 500

    sources.push({
      id: sourceId,
      title: folder.label,
      tree: truncated ? folderTree.slice(0, 500) : folderTree,
      ...(truncated ? { truncated: true } : {}),
      tab,
      readOnly: true,
    })

    resolvedSources.set(sourceId, {
      id: sourceId,
      title: folder.label,
      baseDir: realPath,
      allowedPrefixes: null,
      readOnly: true,
      tab,
    })
  }

  return { sources, resolvedSources, board: boardInfo }
}

// 트리를 만들지 않고 출처 id에서 허용 폴더 목록만 푼다. 파일·글자·폴더·편집·메모 API가 쓴다.
export function resolveSourceBase(
  adkRoot: string,
  sourceId: string,
  context?: FolderCheckContext,
): ResolvedSource | null {
  if (!sourceId || typeof sourceId !== "string") return null

  // 1. ADK docs
  if (sourceId === "adk") {
    const adkDocsDir = path.join(adkRoot, "docs")
    if (fs.existsSync(adkDocsDir)) {
      return {
        id: "adk",
        title: "ADK 문서",
        baseDir: adkDocsDir,
        allowedPrefixes: null,
      }
    }
    return null
  }

  // 2. Company config (company:<name> or repo id)
  const companyList = loadCompanyConfigs(adkRoot)
  for (const { companyName, companyDir, config } of companyList) {
    const companyId = `company:${companyName}`
    if (sourceId === companyId) {
      return {
        id: companyId,
        title: config.title || "회사 문서",
        baseDir: companyDir,
        allowedPrefixes: config.docs?.include || [],
      }
    }

    if (Array.isArray(config.repos)) {
      for (const repo of config.repos) {
        if (repo.id === sourceId) {
          const repoPathNorm = repo.path.replace(/\\/g, "/")
          const repoAbsDir = path.resolve(adkRoot, repoPathNorm)
          return {
            id: repo.id,
            title: repo.docs?.title || repo.id,
            baseDir: repoAbsDir,
            allowedPrefixes: repo.docs?.include || [],
          }
        }
      }
    }
  }

  // 3. View folders (data:<id>)
  if (sourceId.startsWith("data:")) {
    const dataId = sourceId.slice(5)
    const { folders } = readViewFoldersFile(adkRoot)
    const folder = folders.find((f) => f.id === dataId)
    if (!folder) return null

    const resolvedCtx = resolveFolderContext(adkRoot, context)
    const evalResult = evaluateViewFolder(folder, resolvedCtx)
    if (evalResult.status !== "ok") {
      return null
    }

    return {
      id: sourceId,
      title: folder.label,
      baseDir: evalResult.realPath,
      allowedPrefixes: null,
      readOnly: true,
      tab: folder.tab || "common",
    }
  }

  return null
}

// 문서가 속한 보여 주기 폴더(ADK 문서는 docs 전체)를 돌려준다. 없으면 null.
export function matchingAllowedDir(source: ResolvedSource, normPath: string): string | null {
  if (source.allowedPrefixes === null) return source.baseDir
  for (const prefix of source.allowedPrefixes) {
    const cleanPrefix = prefix.replace(/\\/g, "/").replace(/\/+$/, "")
    if (normPath === cleanPrefix || normPath.startsWith(`${cleanPrefix}/`)) {
      return path.resolve(source.baseDir, cleanPrefix)
    }
  }
  return null
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function isInsideOrEqual(child: string, parent: string): boolean {
  if (child === parent) return true
  const relative = path.relative(parent, child)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

export interface SecureFileResult {
  absPath: string
  fd?: number
  stat: fs.Stats
}

export function resolveSecureFile(
  source: ResolvedSource,
  normPath: string,
  options?: { keepFdOpen?: boolean; forListing?: boolean },
): { error: "not_found" } | SecureFileResult {
  if (isHiddenPath(normPath)) return { error: "not_found" }

  const allowedDir = matchingAllowedDir(source, normPath)
  if (!allowedDir) return { error: "not_found" }

  const absPath = path.resolve(source.baseDir, normPath)
  if (!fs.existsSync(absPath)) return { error: "not_found" }

  let realPath: string
  let realAllowedDir: string
  let realBaseDir: string
  try {
    realPath = fs.realpathSync.native(absPath)
    realAllowedDir = fs.realpathSync.native(allowedDir)
    realBaseDir = fs.realpathSync.native(source.baseDir)
  } catch {
    return { error: "not_found" }
  }

  // 심볼릭 링크를 따라간 실제 위치가 그 보여 주기 폴더 안이어야 한다.
  // 같은 저장소의 제외 폴더(예: 증빙서류)를 가리키는 링크도 여기서 막힌다.
  if (!isInside(realPath, realAllowedDir)) return { error: "not_found" }

  // 출처 루트 실경로 기준 상대 경로 조각 검사 (숨김·node_modules·data-private 차단)
  const realRelPath = path.relative(realBaseDir, realPath)
  if (isHiddenPath(realRelPath)) return { error: "not_found" }

  const check = inspectSecureFile(realPath, options?.keepFdOpen, options?.forListing)
  if (!check.ok || !check.stat) {
    return { error: "not_found" }
  }

  return { absPath: realPath, fd: check.fd, stat: check.stat }
}

// 빈 경로는 출처 루트. 실경로(realpath)가 출처의 허용 폴더 안(또는 같음)이고 폴더인지 확인한다.
// 심볼릭 링크로 밖을 가리키면 거절. 폴더 격자·대표 그림·폴더 즐겨찾기가 이것을 쓴다.
export function resolveSecureDir(
  source: ResolvedSource,
  relPath: string,
): { error: "not_found" } | { absPath: string } {
  const normPath = relPath === "" ? "" : normalizeRelativePath(relPath)
  if (normPath === null) return { error: "not_found" }
  if (isHiddenPath(normPath)) return { error: "not_found" }

  let absPath: string
  let targetAllowedDir: string

  if (normPath === "") {
    // 빈 경로는 출처 루트
    absPath = source.baseDir
    if (source.allowedPrefixes === null) {
      targetAllowedDir = source.baseDir
    } else {
      // 회사·repo 출처는 출처 루트가 허용 폴더 밖이므로 거절 (FE 53행)
      return { error: "not_found" }
    }
  } else {
    const allowedDir = matchingAllowedDir(source, normPath)
    if (!allowedDir) return { error: "not_found" }
    targetAllowedDir = allowedDir
    absPath = path.resolve(source.baseDir, normPath)
  }

  if (!fs.existsSync(absPath)) return { error: "not_found" }

  let realPath: string
  let realAllowedDir: string
  let realBaseDir: string
  try {
    realPath = fs.realpathSync.native(absPath)
    realAllowedDir = fs.realpathSync.native(targetAllowedDir)
    realBaseDir = fs.realpathSync.native(source.baseDir)
  } catch {
    return { error: "not_found" }
  }

  // 실경로가 출처의 허용 폴더 안(또는 같음)인지 확인
  if (!isInsideOrEqual(realPath, realAllowedDir)) return { error: "not_found" }

  // 출처 루트 실경로 기준 상대 경로 조각 검사
  const realRelPath = path.relative(realBaseDir, realPath)
  if (isHiddenPath(realRelPath)) return { error: "not_found" }

  if (!fs.statSync(realPath).isDirectory()) return { error: "not_found" }
  return { absPath: realPath }
}

export interface PortalArchiveInfo {
  // 첫 줄 표시의 종류. 표시 없이 보관 폴더에만 있으면 null.
  kind: "대체됨" | "보관" | null
  date: string | null
}

export interface PortalSearchHit {
  source: string
  path: string
  title: string
  snippet: string
  // 보관 문서면 채운다. 현행 문서는 null.
  archive: PortalArchiveInfo | null
}

export interface PortalSearchResult {
  results: PortalSearchHit[]
  // 보관 문서 포함을 끈 채 찾았을 때 숨긴 보관 문서 수.
  archivedHidden: number
}

// 옛 판을 모아 두는 폴더 이름. ADK는 archive/, 회사 문서는 "지난 기록/"을 쓴다.
const ARCHIVE_DIR_NAMES = new Set(["archive", "지난 기록"])

export function isArchiveDirName(name: string): boolean {
  return ARCHIVE_DIR_NAMES.has(name.normalize("NFC").trim().toLowerCase())
}

// 경로의 폴더 가운데 하나라도 보관 폴더면 보관 문서다(파일 이름은 보지 않는다).
export function isArchivedPath(relPath: string): boolean {
  const segments = relPath.split("/").filter((s) => s.length > 0)
  return segments.slice(0, -1).some(isArchiveDirName)
}

// 옮긴 옛 판의 첫 줄 "> 대체됨|보관 YYYY-MM-DD · 이유: … · 현행: …"을 읽는다(앞머리 YAML은 건너뛴다).
const ARCHIVE_HEADER_RE = /^>\s*(대체됨|보관)\s+(\d{4}-\d{2}-\d{2})\b/

export function parseArchiveHeader(content: string): PortalArchiveInfo | null {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/)
  let i = 0
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, idx) => idx > 0 && /^(---|\.\.\.)\s*$/.test(l))
    if (end > 0) i = end + 1
  }
  while (i < lines.length && lines[i].trim() === "") i++
  const m = (lines[i] ?? "").normalize("NFC").match(ARCHIVE_HEADER_RE)
  return m ? { kind: m[1] as "대체됨" | "보관", date: m[2] } : null
}

export function archiveInfoOf(relPath: string, content: string): PortalArchiveInfo | null {
  const header = parseArchiveHeader(content)
  if (header) return header
  return isArchivedPath(relPath.normalize("NFC")) ? { kind: null, date: null } : null
}

// 쿼리의 archived 값을 읽는다. "1"·"true"만 켠 것으로 본다.
export function includeArchivedParam(raw: unknown): boolean {
  return raw === "1" || raw === "true"
}

const SEARCH_MAX_RESULTS = 50
const SEARCH_MAX_QUERY = 100
const SEARCH_MAX_FILE_BYTES = 1024 * 1024
const SNIPPET_RADIUS = 60

function fold(text: string): string {
  return text.normalize("NFC").toLowerCase()
}

function* treeFiles(nodes: PortalTreeNode[]): Generator<PortalTreeNode> {
  for (const node of nodes) {
    if (node.type === "file") yield node
    else if (node.children) yield* treeFiles(node.children)
  }
}

function docTitle(body: string, fileName: string): string {
  const m = body.match(/^#\s+(.+)$/m)
  return (m ? m[1] : fileName.replace(/\.md$/i, "")).trim()
}

// 원문 줄에서 검색어 둘레를 잘라 한 줄 구절을 만든다. 위치는 줄마다 소문자로 바꿔 찾되,
// 소문자로 바꾸며 길이가 바뀌는 글자가 있으면 줄 앞부분을 쓴다.
function snippetFrom(line: string, term: string): string {
  const clean = line.replace(/\s+/g, " ").trim()
  const lower = clean.toLowerCase()
  let at = lower.length === clean.length ? lower.indexOf(term) : -1
  if (at < 0) at = 0
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(clean.length, at + term.length + SNIPPET_RADIUS)
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`
}

// 문서 목록 트리에 있는 파일만 찾는다. 트리는 심볼릭 링크·점 폴더·node_modules를 넣지 않으므로
// 디스크를 직접 훑지 않는다. 파일마다 문서 열기와 같은 안전 확인을 거친다.
// FE 2장: 검색은 doc만 본다.
export function searchDocs(
  sources: PortalSource[],
  resolved: Map<string, ResolvedSource>,
  rawQuery: unknown,
  includeArchived = false,
): PortalSearchResult {
  const empty: PortalSearchResult = { results: [], archivedHidden: 0 }
  if (typeof rawQuery !== "string") return empty
  const terms = fold(rawQuery.slice(0, SEARCH_MAX_QUERY)).split(/\s+/).filter((t) => t.length > 0)
  if (terms.length === 0) return empty
  let archivedHidden = 0

  const scored: Array<PortalSearchHit & { score: number; order: number }> = []
  let order = 0
  for (const source of sources) {
    const resolvedSource = resolved.get(source.id)
    if (!resolvedSource) continue
    for (const file of treeFiles(source.tree)) {
      if (file.kind !== "doc") continue
      if (isExcludedName(file.name) || isHiddenPath(file.path)) continue
      const secure = resolveSecureFile(resolvedSource, file.path, { keepFdOpen: true, forListing: true })
      if ("error" in secure) continue
      const fd = secure.fd
      if (fd === undefined) continue
      let content: string
      try {
        if (secure.stat.size > SEARCH_MAX_FILE_BYTES) continue
        const buf = Buffer.alloc(secure.stat.size)
        let totalRead = 0
        while (totalRead < secure.stat.size) {
          const bytesRead = fs.readSync(fd, buf, totalRead, secure.stat.size - totalRead, totalRead)
          if (bytesRead === 0) break
          totalRead += bytesRead
        }
        content = buf.subarray(0, totalRead).toString("utf-8").normalize("NFC")
      } catch {
        continue
      } finally {
        try {
          fs.closeSync(fd)
        } catch {}
      }
      const title = docTitle(content, file.name.normalize("NFC"))
      const titleF = fold(title)
      const pathF = fold(file.path)
      const bodyF = content.toLowerCase()
      if (!terms.every((t) => titleF.includes(t) || pathF.includes(t) || bodyF.includes(t))) continue

      let score = 0
      for (const t of terms) {
        if (titleF.includes(t)) score += 1000
        if (pathF.includes(t)) score += 100
        score += Math.min(bodyF.split(t).length - 1, 50)
      }
      const lines = content.split(/\r?\n/)
      const bodyLines = lines.filter((l) => l.trim().length > 0 && !/^#\s/.test(l))
      // 본문에 든 첫 검색어의 줄을 보여 준다. 제목·경로에만 든 검색어는 건너뛴다.
      let snippet = snippetFrom(bodyLines[0] ?? "", "")
      for (const t of terms) {
        const hitLine = lines.find((l) => l.trim().length > 0 && l.toLowerCase().includes(t) && !/^#\s/.test(l))
        if (hitLine) {
          snippet = snippetFrom(hitLine, t)
          break
        }
      }
      const archive = archiveInfoOf(file.path, content)
      if (archive && !includeArchived) {
        archivedHidden++
        continue
      }
      scored.push({ source: source.id, path: file.path, title, snippet, archive, score, order: order++ })
    }
  }
  // 현행 문서를 먼저, 보관 문서는 그 아래에 둔다. 같은 무리 안에서는 점수 순.
  scored.sort(
    (a, b) => Number(a.archive !== null) - Number(b.archive !== null) || b.score - a.score || a.order - b.order,
  )
  return {
    results: scored.slice(0, SEARCH_MAX_RESULTS).map(({ score: _s, order: _o, ...hit }) => hit),
    archivedHidden,
  }
}

// FE 8장 117행: 믿음 판정이 새 보기를 허용하지 않으면 각 출처에서 kind가 doc·image가 아닌 파일 노드를 빼고
// 그 결과 파일이 없는 폴더는 넣지 않는다.
export function filterUntrustedTree(nodes: PortalTreeNode[]): PortalTreeNode[] {
  const filtered: PortalTreeNode[] = []
  for (const node of nodes) {
    if (node.type === "directory") {
      const children = node.children ? filterUntrustedTree(node.children) : []
      if (children.length > 0) {
        filtered.push({
          ...node,
          children,
        })
      }
    } else if (node.type === "file") {
      if (node.kind === "doc" || node.kind === "image") {
        filtered.push(node)
      }
    }
  }
  return filtered
}

export interface FolderEntry {
  name: string
  path: string
  type: "file" | "directory"
  kind?: FileKind
  size?: number
  cover?: string
}

// 폴더 안 첫 그림의 경로(너비 우선, 깊이 3까지, 이름 순, 찾은 파일 2000개에서 중단)
export function findFolderCover(
  source: ResolvedSource,
  folderRelPath: string,
  folderAbsPath: string,
): string | undefined {
  const queue: Array<{ absPath: string; relPath: string; depth: number }> = [
    { absPath: folderAbsPath, relPath: folderRelPath, depth: 1 },
  ]
  let inspectedFiles = 0

  while (queue.length > 0) {
    const current = queue.shift()!
    let dirents: fs.Dirent[] = []
    try {
      dirents = fs.readdirSync(current.absPath, { withFileTypes: true })
    } catch {
      continue
    }

    const validDirents = dirents.filter((d) => !isExcludedName(d.name))
    validDirents.sort((a, b) => a.name.localeCompare(b.name, "ko"))

    const subDirs: fs.Dirent[] = []

    // 파일 먼저 검사하여 첫 그림을 찾으면 즉시 반환
    for (const dirent of validDirents) {
      const itemRelPath = current.relPath ? `${current.relPath}/${dirent.name}` : dirent.name

      if (dirent.isDirectory()) {
        if (current.depth < 3) {
          const secCheck = resolveSecureDir(source, itemRelPath)
          if (!("error" in secCheck)) {
            subDirs.push(dirent)
          }
        }
      } else if (dirent.isFile()) {
        inspectedFiles++
        if (inspectedFiles > 2000) {
          return undefined
        }
        const kind = getFileKind(dirent.name)
        if (kind === "image") {
          const secCheck = resolveSecureFile(source, itemRelPath, { forListing: true })
          if (!("error" in secCheck)) {
            return itemRelPath
          }
        }
      }
    }

    for (const subDir of subDirs) {
      const subRel = current.relPath ? `${current.relPath}/${subDir.name}` : subDir.name
      const subAbs = path.join(current.absPath, subDir.name)
      queue.push({ absPath: subAbs, relPath: subRel, depth: current.depth + 1 })
    }
  }

  return undefined
}

interface RawFolderEntry {
  name: string
  path: string
  type: "file" | "directory"
  kind?: FileKind
  size?: number
  absPath?: string
}

function collectFolderEntries(
  source: ResolvedSource,
  currentRelPath: string,
  absDir: string,
): RawFolderEntry[] {
  let dirents: fs.Dirent[] = []
  try {
    dirents = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return []
  }

  const entries: RawFolderEntry[] = []
  for (const dirent of dirents) {
    if (isExcludedName(dirent.name)) continue

    const entryRelPath = currentRelPath ? `${currentRelPath}/${dirent.name}` : dirent.name

    if (dirent.isDirectory()) {
      const secureCheck = resolveSecureDir(source, entryRelPath)
      if ("error" in secureCheck) continue
      entries.push({
        name: dirent.name,
        path: entryRelPath,
        type: "directory",
        absPath: secureCheck.absPath,
      })
    } else if (dirent.isFile()) {
      const secureCheck = resolveSecureFile(source, entryRelPath, { forListing: true })
      if ("error" in secureCheck) continue
      try {
        const kind = getFileKind(dirent.name)
        entries.push({
          name: dirent.name,
          path: entryRelPath,
          type: "file",
          kind,
          size: secureCheck.stat.size,
        })
      } catch {
        // ignore
      }
    }
  }

  return entries
}

export function isDataSourceId(sourceId: string): boolean {
  return typeof sourceId === "string" && sourceId.startsWith("data:")
}

export function isSourceAllowedForUntrusted(sourceId: string, isTrusted: boolean): boolean {
  if (isDataSourceId(sourceId) && !isTrusted) {
    return false
  }
  return true
}

/**
 * 공개 모드 프록시가 붙인 표시. 대시보드는 공개 모드에서 검증한 메일만
 * `x-naia-user-email` 로 넘기고, 내부 모드에서는 이 머리글을 항상 지운다.
 * 루프백 비밀 값만으로는 이 표시를 우회할 수 없다: decisions 보관함은
 * 이 표시가 있으면 403.
 */
export function isPublicProxyRequest(req: FastifyRequest): boolean {
  const raw = req.headers["x-naia-user-email"]
  const first = Array.isArray(raw) ? raw[0] : raw
  return typeof first === "string" && first.trim() !== ""
}

export interface PortalOptions {
  beforeRename?: () => Promise<void> | void
  /** Messenger state shared with portal-messenger; off when disabled or its initialization failed. */
  messengerStatus?: { enabled: boolean }
}

// 로그인 게이트가 확인한 사람 계정 키 모양(메신저 게이트와 같은 규칙).
const VERIFIED_ACCOUNT_KEY_RE = /^[a-z][a-z0-9-]{1,31}$/

const docWriteLocks = new Map<string, Promise<void>>()

export async function withDocWriteLock<T>(realPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = docWriteLocks.get(realPath) ?? Promise.resolve()
  let release: () => void
  const current = new Promise<void>((r) => {
    release = r
  })
  docWriteLocks.set(realPath, prev.then(() => current, () => current))
  try {
    await prev
    return await fn()
  } finally {
    release!()
    if (docWriteLocks.get(realPath) === current) {
      docWriteLocks.delete(realPath)
    }
  }
}

export const portalRoutes: FastifyPluginCallback<PortalOptions> = (app, opts, done) => {
  const root = (app as FastifyInstance & { adkRoot: string }).adkRoot
  const getFolderCtx = (): FolderCheckContext | undefined => (app as any).folderCheckContext
  const beforeRenameHook = opts?.beforeRename

  // Non-git AX doc overlay: dashboard edits survive `git reset --hard` and
  // read-only mounts. Reads prefer the overlay; writes record it.
  // 저장소가 준비되지 않으면 쓰기는 절대 200으로 속이지 않는다(fail closed).
  const overlayConfigured =
    typeof process.env.NAIA_AX_DOC_STORE === "string" && process.env.NAIA_AX_DOC_STORE.trim() !== ""
  let overlayStore: DocOverlayStore | null = null
  let overlayInitError: string | null = null
  try {
    overlayStore = new DocOverlayStore(overlayDbPath(root))
  } catch (error) {
    overlayInitError = String((error as any)?.message ?? error)
    app.log.warn({ error: overlayInitError }, "Doc overlay store unavailable; doc writes fail closed")
    overlayStore = null
  }
  app.addHook("onClose", async () => {
    try {
      overlayStore?.close()
    } catch {}
  })

  const dashboardActor = (req: FastifyRequest): string => {
    const headerName = (process.env.NAIA_NOTE_USER_HEADER || "x-ax-user").toLowerCase()
    const raw = req.headers[headerName]
    if (typeof raw === "string" && raw && !raw.includes(",")) {
      try {
        const name = decodeURIComponent(raw).trim()
        if (name && name.length <= 128 && !/[\x00-\x1f\x7f]/.test(name)) return name
      } catch {}
    }
    return "dashboard"
  }

  // 메신저 승인 게이트와 같은 사람 신원 확인. 대시보드는 로그인 게이트를
  // 통과한 요청에만 이 표시와 계정 키를 붙여 넘긴다. 표시 이름·합성 값은
  // 신원 근거가 아니라서 여기서 읽지 않는다.
  const verifiedMessengerAccount = (req: FastifyRequest): string | null => {
    const mark = req.headers["x-naia-gate-verified"]
    if (mark !== "1") return null
    const raw = req.headers["x-ax-account-key"]
    const account = Array.isArray(raw) ? raw[0] : raw
    if (typeof account !== "string" || !VERIFIED_ACCOUNT_KEY_RE.test(account)) return null
    return account
  }

  // GET /api/portal
  app.get("/", async (req, reply) => {
    // The dashboard hides its messages tab when NAIA_MESSENGER_ENABLED turns the messenger routes off or they failed to start.
    const messenger = { enabled: opts?.messengerStatus?.enabled ?? messengerEnabled() }
    const { sources, board } = getSourcesAndBoard(root, getFolderCtx())
    const isTrusted = (req as any).trust?.trusted === true
    const resultSources = isTrusted
      ? sources
      : sources
          .filter((s) => !isDataSourceId(s.id))
          .map((s) => ({
            ...s,
            tree: filterUntrustedTree(s.tree),
          }))
    return reply.send({ sources: resultSources, board, messenger })
  })

  // GET /api/portal/workspace
  app.get("/workspace", async (_req, reply) => {
    let resolved = path.resolve(root)
    try {
      resolved = fs.realpathSync.native(resolved)
    } catch {
      // 실제 경로를 못 얻으면 받은 경로를 그대로 알린다.
    }
    return reply.send({ root: resolved })
  })

  // GET /api/portal/schedule/company?from=YYYY-MM-DD&to=YYYY-MM-DD
  app.get("/schedule/company", async (req, reply) => {
    const secFetchSite = req.headers["sec-fetch-site"]
    if (typeof secFetchSite === "string" && secFetchSite.toLowerCase() === "cross-site") {
      return reply.code(403).send({ error: "Forbidden" })
    }

    const query = req.query as Record<string, unknown>
    const rawFrom = typeof query.from === "string" && query.from.trim() ? query.from.trim() : undefined
    const rawTo = typeof query.to === "string" && query.to.trim() ? query.to.trim() : undefined

    const range = clampDateRange(rawFrom, rawTo)
    if (!range.ok) {
      return reply.code(400).send({ error: range.error })
    }

    const includeCanceled = query.includeCanceled === "1" || query.includeCanceled === "true"
    const allowedRegularStates = parseStatesQueryParam(query.states)

    const result = readCompanySchedules({
      adkRoot: root,
      from: range.from,
      to: range.to,
      includeCanceled,
      allowedRegularStates,
    })

    return reply.send(result)
  })

  function buildScheduleFeedback(
    scheduleId: string,
    action: "comment" | "edit" | "delete",
    input: { body: string; scheduleTitle?: unknown; targetRole?: unknown; sourceDocPath?: unknown },
  ): ScheduleComment {
    const now = new Date().toISOString()
    const scheduleTitle =
      typeof input.scheduleTitle === "string" ? input.scheduleTitle.slice(0, 500) : ""
    const sourceDocPath =
      typeof input.sourceDocPath === "string" && input.sourceDocPath.trim()
        ? input.sourceDocPath.trim().slice(0, 500)
        : null
    return {
      schemaVersion: 1,
      id: generateScheduleCommentId(),
      scheduleId,
      scheduleTitle,
      targetRole: inferTargetRole({ role: input.targetRole, sourceDocPath }),
      sourceDocPath,
      author: "portal",
      action,
      body: input.body,
      createdAt: now,
    }
  }

  // GET /api/portal/schedule/company/:id/comments — 해당 회사 일정 댓글 목록
  app.get("/schedule/company/:id/comments", async (req, reply) => {
    if (!isNewViewAllowed(req)) {
      return reply.code(403).send({ error: "Forbidden" })
    }
    const { id } = req.params as { id: string }
    if (!isValidScheduleItemId(id)) {
      return reply.code(400).send({ error: "Invalid schedule id" })
    }
    const comments = listScheduleComments(root, id, process.env)
    return reply.send({ comments })
  })

  // POST /api/portal/schedule/company/:id/comments — 댓글 작성 + 담당 AI 피드백 레코드
  app.post("/schedule/company/:id/comments", async (req, reply) => {
    if (!checkWriteSecurity(req, reply, true)) {
      return
    }
    const { id } = req.params as { id: string }
    if (!isValidScheduleItemId(id)) {
      return reply.code(400).send({ error: "Invalid schedule id" })
    }
    const body = req.body as
      | { body?: unknown; scheduleTitle?: unknown; targetRole?: unknown; sourceDocPath?: unknown }
      | undefined
    const lengthCheck = validateScheduleCommentBody(body?.body)
    if (!lengthCheck.valid) {
      return reply.code(400).send({ error: lengthCheck.error })
    }
    const comment = buildScheduleFeedback(id, "comment", {
      body: body!.body as string,
      scheduleTitle: body?.scheduleTitle,
      targetRole: body?.targetRole,
      sourceDocPath: body?.sourceDocPath,
    })
    const filePath = getScheduleCommentFilePath(root, comment.id, process.env)
    try {
      await withFileLock(filePath, () => {
        saveScheduleComment(root, comment, process.env)
      })
      return reply.code(201).send({ ok: true, comment })
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        return reply.code(409).send({ error: "changed" })
      }
      throw err
    }
  })

  // DELETE /api/portal/schedule/company/:id/comments/:commentId — 댓글 삭제
  app.delete("/schedule/company/:id/comments/:commentId", async (req, reply) => {
    if (!checkWriteSecurity(req, reply, false)) {
      return
    }
    const { id, commentId } = req.params as { id: string; commentId: string }
    if (!isValidScheduleItemId(id) || !isValidScheduleCommentId(commentId)) {
      return reply.code(400).send({ error: "Invalid id" })
    }
    const filePath = getScheduleCommentFilePath(root, commentId, process.env)
    try {
      const deleted = await withFileLock(filePath, () => {
        const existing = readScheduleComment(root, commentId, process.env)
        if (!existing || existing.scheduleId !== id) return false
        deleteScheduleComment(root, commentId, process.env)
        return true
      })
      if (!deleted) {
        return reply.code(404).send({ error: "Comment not found" })
      }
      return reply.send({ ok: true })
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        return reply.code(409).send({ error: "changed" })
      }
      throw err
    }
  })

  // PATCH /api/portal/schedule/company/:id — 회사 일정 직접 수정(오버레이) + edit 피드백 레코드
  app.patch("/schedule/company/:id", async (req, reply) => {
    if (!checkWriteSecurity(req, reply, true)) {
      return
    }
    const { id } = req.params as { id: string }
    if (!isValidScheduleItemId(id)) {
      return reply.code(400).send({ error: "Invalid schedule id" })
    }
    const current = readCompanySchedules({ adkRoot: root })
    const existing = current.items.find((item) => item.id === id)
    if (!existing) {
      return reply.code(404).send({ error: "Schedule not found" })
    }
    const check = validateScheduleOverridePatch(req.body, existing)
    if (!check.valid) {
      return reply.code(400).send({ error: check.error })
    }
    const now = new Date().toISOString()
    const filePath = getScheduleOverridesFilePath(root, process.env)
    let previousOverride: ReturnType<typeof readScheduleOverrides>["overrides"][string] | undefined
    try {
      const override = await withFileLock(filePath, () => {
        const data = readScheduleOverrides(root, process.env)
        previousOverride = data.overrides[id]
        const prev = previousOverride ?? {
          updatedAt: now,
          updatedBy: "portal",
        }
        data.overrides[id] = {
          ...prev,
          ...check.patch,
          deleted: false,
          updatedAt: now,
          updatedBy: "portal",
        }
        saveScheduleOverrides(root, data, process.env)
        return data.overrides[id]
      })

      const feedbackBody = req.body as
        | { scheduleTitle?: unknown; targetRole?: unknown; sourceDocPath?: unknown }
        | undefined
      const changedKeys = Object.keys(check.patch).join(", ")
      const feedback = buildScheduleFeedback(id, "edit", {
        body: `일정 직접 수정: ${changedKeys}`,
        scheduleTitle: feedbackBody?.scheduleTitle,
        targetRole: feedbackBody?.targetRole,
        sourceDocPath: feedbackBody?.sourceDocPath,
      })
      const feedbackPath = getScheduleCommentFilePath(root, feedback.id, process.env)
      try {
        await withFileLock(feedbackPath, () => {
          saveScheduleComment(root, feedback, process.env)
        })
      } catch (err) {
        await withFileLock(filePath, () => {
          const data = readScheduleOverrides(root, process.env)
          if (previousOverride) data.overrides[id] = previousOverride
          else delete data.overrides[id]
          saveScheduleOverrides(root, data, process.env)
        })
        throw err
      }

      return reply.send({ ok: true, id, override })
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        return reply.code(409).send({ error: "changed" })
      }
      throw err
    }
  })

  // DELETE /api/portal/schedule/company/:id — 회사 일정 직접 삭제(오버레이) + delete 피드백 레코드
  app.delete("/schedule/company/:id", async (req, reply) => {
    if (!checkWriteSecurity(req, reply, false)) {
      return
    }
    const { id } = req.params as { id: string }
    if (!isValidScheduleItemId(id)) {
      return reply.code(400).send({ error: "Invalid schedule id" })
    }
    const current = readCompanySchedules({ adkRoot: root })
    if (!current.items.some((item) => item.id === id)) {
      return reply.code(404).send({ error: "Schedule not found" })
    }
    const now = new Date().toISOString()
    const filePath = getScheduleOverridesFilePath(root, process.env)
    let previousOverride: ReturnType<typeof readScheduleOverrides>["overrides"][string] | undefined
    try {
      await withFileLock(filePath, () => {
        const data = readScheduleOverrides(root, process.env)
        previousOverride = data.overrides[id]
        data.overrides[id] = {
          deleted: true,
          updatedAt: now,
          updatedBy: "portal",
        }
        saveScheduleOverrides(root, data, process.env)
      })

      const feedbackBody = req.body as
        | { scheduleTitle?: unknown; targetRole?: unknown; sourceDocPath?: unknown }
        | undefined
      const feedback = buildScheduleFeedback(id, "delete", {
        body: "일정 직접 삭제",
        scheduleTitle: feedbackBody?.scheduleTitle,
        targetRole: feedbackBody?.targetRole,
        sourceDocPath: feedbackBody?.sourceDocPath,
      })
      const feedbackPath = getScheduleCommentFilePath(root, feedback.id, process.env)
      try {
        await withFileLock(feedbackPath, () => {
          saveScheduleComment(root, feedback, process.env)
        })
      } catch (err) {
        await withFileLock(filePath, () => {
          const data = readScheduleOverrides(root, process.env)
          if (previousOverride) data.overrides[id] = previousOverride
          else delete data.overrides[id]
          saveScheduleOverrides(root, data, process.env)
        })
        throw err
      }

      return reply.send({ ok: true, id })
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        return reply.code(409).send({ error: "changed" })
      }
      throw err
    }
  })

  // GET /api/portal/search?q=<검색어>[&archived=1]
  app.get("/search", async (req, reply) => {
    const query = req.query as Record<string, unknown>
    const { sources, resolvedSources } = getSourcesAndBoard(root, getFolderCtx())
    const isTrusted = (req as any).trust?.trusted === true
    const targetSources = isTrusted ? sources : sources.filter((s) => !isDataSourceId(s.id))
    return reply.send(searchDocs(targetSources, resolvedSources, query.q, includeArchivedParam(query.archived)))
  })

  // GET /api/portal/doc?source=<id>&path=<relative path>
  app.get("/doc", async (req, reply) => {
    const query = req.query as Record<string, string | undefined>
    const sourceId = query.source
    const rawPath = query.path

    if (!sourceId || !rawPath) {
      return reply.code(404).send({ error: "Missing source or path" })
    }

    const isTrusted = (req as any).trust?.trusted === true
    if (!isSourceAllowedForUntrusted(sourceId, isTrusted)) {
      return reply.code(403).send({ error: "Forbidden" })
    }

    const normPath = normalizeRelativePath(rawPath)
    if (!normPath || isHiddenPath(normPath) || !normPath.toLowerCase().endsWith(".md")) {
      return reply.code(404).send({ error: "File not found or not markdown" })
    }

    // 출처·폴더 경계를 먼저 확인한다. 출처가 사라지거나 허용 폴더가
    // 좁혀지면 낡은 오버레이 행을 절대 내놓지 않는다(403/404).
    const source = resolveSourceBase(root, sourceId, getFolderCtx())
    if (!source) {
      return reply.code(404).send({ error: "Source not found" })
    }
    if (!matchingAllowedDir(source, normPath)) {
      return reply.code(404).send({ error: "Document not found" })
    }

    // Overlay wins over the git checkout baseline, so a periodic
    // `git reset --hard` never loses dashboard edits. 존재 검사는 엄격한
    // null 비교로 한다(빈 문자열 ""도 유효한 오버레이 본문이다).
    if (overlayStore !== null) {
      try {
        const overlayHit = isValidOverlaySource(sourceId) ? overlayStore.get(sourceId, normPath) : null
        if (overlayHit !== null) {
          return reply
            .header("X-Content-Type-Options", "nosniff")
            .header("ETag", crypto.createHash("sha256").update(overlayHit.content, "utf-8").digest("hex"))
            .header("X-Doc-Source", "overlay")
            .header("X-Overlay-Updated-At", overlayHit.updatedAt)
            .type("text/markdown; charset=utf-8")
            .send(overlayHit.content)
        }
      } catch {
        return reply.code(503).send({ error: "Overlay unavailable" })
      }
    } else if (overlayConfigured) {
      return reply.code(503).send({ error: "Overlay unavailable" })
    }

    const result = resolveSecureFile(source, normPath, { keepFdOpen: true })
    if ("error" in result) {
      return reply.code(404).send({ error: "Document not found" })
    }

    // W1b-2: 실경로 확장자가 md일 때만 본문을 주고, 아니면 404(본문 없음)
    const realExt = path.extname(result.absPath).toLowerCase()
    if (realExt !== ".md") {
      if (result.fd !== undefined) {
        try { fs.closeSync(result.fd) } catch {}
      }
      return reply.code(404).send()
    }

    try {
      const buf = Buffer.alloc(result.stat.size)
      fs.readSync(result.fd!, buf, 0, result.stat.size, 0)
      const content = buf.toString("utf-8")
      const hash = crypto.createHash("sha256").update(buf).digest("hex")
      return reply
        .header("X-Content-Type-Options", "nosniff")
        .header("ETag", hash)
        .header("X-Doc-Source", "git")
        .type("text/markdown; charset=utf-8")
        .send(content)
    } catch {
      return reply.code(404).send({ error: "Failed to read document" })
    } finally {
      if (result.fd !== undefined) {
        try { fs.closeSync(result.fd) } catch {}
      }
    }
  })

  // GET /api/portal/asset?source=<id>&path=<relative path>[&download=1]
  app.get("/asset", async (req, reply) => {
    // FE 8장 9번: Sec-Fetch-Site: cross-site 거절
    const secFetchSite = req.headers["sec-fetch-site"]
    if (typeof secFetchSite === "string" && secFetchSite.toLowerCase() === "cross-site") {
      return reply.code(403).send({ error: "Forbidden" })
    }

    const query = req.query as Record<string, string | undefined>
    const sourceId = query.source
    const rawPath = query.path

    if (!sourceId || !rawPath) {
      return reply.code(404).send({ error: "Missing source or path" })
    }

    const isTrusted = (req as any).trust?.trusted === true
    if (!isSourceAllowedForUntrusted(sourceId, isTrusted)) {
      return reply.code(403).send({ error: "Forbidden" })
    }

    const normPath = normalizeRelativePath(rawPath)
    if (!normPath || isHiddenPath(normPath)) {
      return reply.code(404).send({ error: "Invalid path" })
    }

    const source = resolveSourceBase(root, sourceId, getFolderCtx())
    if (!source) {
      return reply.code(404).send({ error: "Source not found" })
    }

    const result = resolveSecureFile(source, normPath, { keepFdOpen: true })
    if ("error" in result) {
      return reply.code(404).send({ error: "Asset not found" })
    }

    const reqKind = getFileKind(normPath)
    const realKind = getFileKind(result.absPath)

    // FE 8장 116행 & W1b-2: 요청 이름과 실경로 이름이 둘 다 doc 또는 image일 때만 믿지 않는 요청에 200이고, 하나라도 아니면 403
    if (!isTrusted) {
      const reqAllowed = reqKind === "doc" || reqKind === "image"
      const realAllowed = realKind === "doc" || realKind === "image"
      if (!reqAllowed || !realAllowed) {
        if (result.fd !== undefined) {
          try { fs.closeSync(result.fd) } catch {}
        }
        return reply.code(403).send({ error: "Forbidden" })
      }
    }

    reply.header("X-Content-Type-Options", "nosniff")
    if (realKind === "pdf") {
      reply.header(
        "Content-Security-Policy",
        "default-src 'none'; object-src 'self'; plugin-types application/pdf",
      )
    } else {
      reply.header("Content-Security-Policy", "sandbox")
    }

    // Content-Type·CSP·attachment·download 파일 이름은 실경로 확장자의 종류만 따른다.
    const contentType = getAssetContentType(result.absPath, realKind)
    reply.type(contentType)

    const isDownload = query.download === "1"
    const isOther = realKind === "other"
    if (isDownload || isOther) {
      const fileName = path.basename(result.absPath)
      const encoded = encodeURIComponent(fileName)
      reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encoded}`)
    }

    const totalSize = result.stat.size
    reply.header("Accept-Ranges", "bytes")

    const rangeHeader = req.headers.range
    if (rangeHeader && typeof rangeHeader === "string") {
      const rangeMatch = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/)
      if (!rangeMatch || totalSize === 0) {
        if (result.fd !== undefined) {
          try { fs.closeSync(result.fd) } catch {}
        }
        return reply.code(416).header("Content-Range", `bytes */${totalSize}`).send()
      }

      let start: number
      let end: number
      const startStr = rangeMatch[1]
      const endStr = rangeMatch[2]

      if (startStr && endStr) {
        start = parseInt(startStr, 10)
        end = parseInt(endStr, 10)
      } else if (startStr) {
        start = parseInt(startStr, 10)
        end = totalSize - 1
      } else if (endStr) {
        const suffix = parseInt(endStr, 10)
        start = Math.max(0, totalSize - suffix)
        end = totalSize - 1
      } else {
        if (result.fd !== undefined) {
          try { fs.closeSync(result.fd) } catch {}
        }
        return reply.code(416).header("Content-Range", `bytes */${totalSize}`).send()
      }

      if (isNaN(start) || isNaN(end) || start > end || start >= totalSize) {
        if (result.fd !== undefined) {
          try { fs.closeSync(result.fd) } catch {}
        }
        return reply.code(416).header("Content-Range", `bytes */${totalSize}`).send()
      }

      if (end >= totalSize) {
        end = totalSize - 1
      }

      const contentLength = end - start + 1
      reply.code(206)
      reply.header("Content-Range", `bytes ${start}-${end}/${totalSize}`)
      reply.header("Content-Length", contentLength)
      return reply.send(fs.createReadStream(result.absPath, { fd: result.fd, start, end, autoClose: true }))
    }

    reply.header("Content-Length", totalSize)
    return reply.send(fs.createReadStream(result.absPath, { fd: result.fd, autoClose: true }))
  })

  // GET /api/portal/text?source=<id>&path=<relative path>
  app.get("/text", async (req, reply) => {
    // FE 8장 9번: Sec-Fetch-Site: cross-site 거절
    const secFetchSite = req.headers["sec-fetch-site"]
    if (typeof secFetchSite === "string" && secFetchSite.toLowerCase() === "cross-site") {
      return reply.code(403).send({ error: "Forbidden" })
    }

    const isTrusted = (req as any).trust?.trusted === true
    if (!isTrusted) {
      return reply.code(403).send({ error: "Forbidden" })
    }

    const query = req.query as Record<string, string | undefined>
    const sourceId = query.source
    const rawPath = query.path

    if (!sourceId || !rawPath) {
      return reply.code(404).send({ error: "Missing source or path" })
    }

    if (!isSourceAllowedForUntrusted(sourceId, isTrusted)) {
      return reply.code(403).send({ error: "Forbidden" })
    }

    const normPath = normalizeRelativePath(rawPath)
    if (!normPath || isHiddenPath(normPath)) {
      return reply.code(404).send({ error: "Invalid path" })
    }

    const source = resolveSourceBase(root, sourceId, getFolderCtx())
    if (!source) {
      return reply.code(404).send({ error: "Source not found" })
    }

    const result = resolveSecureFile(source, normPath, { keepFdOpen: true })
    if ("error" in result) {
      return reply.code(404).send({ error: "File not found" })
    }

    try {
      const MAX_TEXT_BYTES = 1024 * 1024
      const truncated = result.stat.size > MAX_TEXT_BYTES
      const bytesToRead = truncated ? MAX_TEXT_BYTES : result.stat.size
      const buffer = Buffer.alloc(bytesToRead)
      fs.readSync(result.fd!, buffer, 0, bytesToRead, 0)
      const content = buffer.toString("utf-8")
      return reply.send({ content, truncated })
    } catch {
      return reply.code(404).send({ error: "File not found" })
    } finally {
      if (result.fd !== undefined) {
        try { fs.closeSync(result.fd) } catch {}
      }
    }
  })

  // GET /api/portal/folder?source=<id>[&path=<relative path>]
  app.get("/folder", async (req, reply) => {
    // FE 8장 9번: Sec-Fetch-Site: cross-site 거절
    const secFetchSite = req.headers["sec-fetch-site"]
    if (typeof secFetchSite === "string" && secFetchSite.toLowerCase() === "cross-site") {
      return reply.code(403).send({ error: "Forbidden" })
    }

    // FE 8장 116행: 새 보기 보호
    const isTrusted = (req as any).trust?.trusted === true
    if (!isTrusted) {
      return reply.code(403).send({ error: "Forbidden" })
    }

    const query = req.query as Record<string, string | undefined>
    const sourceId = query.source
    if (!sourceId) {
      return reply.code(404).send({ error: "Missing source" })
    }

    if (!isSourceAllowedForUntrusted(sourceId, isTrusted)) {
      return reply.code(403).send({ error: "Forbidden" })
    }

    const source = resolveSourceBase(root, sourceId, getFolderCtx())
    if (!source) {
      return reply.code(404).send({ error: "Source not found" })
    }

    const rawPath = query.path ?? ""
    const normPath = rawPath === "" ? "" : normalizeRelativePath(rawPath)
    if (normPath === null || (rawPath !== "" && isHiddenPath(normPath))) {
      return reply.code(404).send({ error: "Invalid path" })
    }

    let allRawEntries: RawFolderEntry[] = []

    if (normPath === "") {
      if (source.allowedPrefixes !== null) {
        for (const prefix of source.allowedPrefixes) {
          const cleanPrefix = prefix.replace(/\\/g, "/").replace(/\/+$/, "")
          if (isHiddenPath(cleanPrefix)) continue
          const absPrefix = path.resolve(source.baseDir, cleanPrefix)
          if (fs.existsSync(absPrefix) && fs.statSync(absPrefix).isDirectory()) {
            const secureCheck = resolveSecureDir(source, cleanPrefix)
            if (!("error" in secureCheck)) {
              allRawEntries.push({
                name: cleanPrefix,
                path: cleanPrefix,
                type: "directory",
                absPath: secureCheck.absPath,
              })
            }
          }
        }
      } else {
        const secureResult = resolveSecureDir(source, "")
        if ("error" in secureResult) {
          return reply.code(404).send({ error: "Folder not found" })
        }
        allRawEntries = collectFolderEntries(source, "", secureResult.absPath)
      }
    } else {
      const secureResult = resolveSecureDir(source, normPath)
      if ("error" in secureResult) {
        return reply.code(404).send({ error: "Folder not found" })
      }
      allRawEntries = collectFolderEntries(source, normPath, secureResult.absPath)
    }

    allRawEntries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name, "ko")
    })

    const total = allRawEntries.length
    const truncated = total > 500
    const sliced = truncated ? allRawEntries.slice(0, 500) : allRawEntries

    const entries: FolderEntry[] = []
    for (const item of sliced) {
      if (item.type === "directory") {
        const cover = item.absPath ? findFolderCover(source, item.path, item.absPath) : undefined
        entries.push({
          name: item.name,
          path: item.path,
          type: "directory",
          ...(cover ? { cover } : {}),
        })
      } else {
        entries.push({
          name: item.name,
          path: item.path,
          type: "file",
          kind: item.kind,
          size: item.size,
        })
      }
    }

    return reply.send({ entries, total, truncated })
  })

  // 보안 가드 헬퍼 (FE 8장)
  function isNewViewAllowed(req: FastifyRequest): boolean {
    const secFetchSite = req.headers["sec-fetch-site"]
    if (typeof secFetchSite === "string" && secFetchSite.toLowerCase() === "cross-site") {
      return false
    }
    return (req as any).trust?.trusted === true
  }

  function checkWriteSecurity(
    req: FastifyRequest,
    reply: FastifyReply,
    hasBody = true,
  ): boolean {
    const isTrusted = (req as any).trust?.trusted === true
    const originOk = (req as any).trust?.originOk === true
    if (!isTrusted || !originOk) {
      reply.code(403).send({ error: "Forbidden" })
      return false
    }

    if (hasBody) {
      const contentType = req.headers["content-type"]
      if (!contentType || !contentType.toLowerCase().includes("application/json")) {
        reply.code(415).send({ error: "Unsupported Media Type: application/json required" })
        return false
      }
    }

    return true
  }

  // PUT /api/portal/doc (FE 5장)
  app.put(
    "/doc",
    {
      bodyLimit: 3 * 1024 * 1024,
    },
    async (req, reply) => {
      if (!checkWriteSecurity(req, reply, true)) {
        return
      }

      const query = req.query as Record<string, string | undefined>
      const sourceId = query.source
      const rawPath = query.path

      if (!sourceId || !rawPath) {
        return reply.code(404).send({ error: "Missing source or path" })
      }

      const body = req.body as { content?: unknown; baseHash?: unknown } | undefined
      if (!body || typeof body.content !== "string" || typeof body.baseHash !== "string") {
        return reply.code(400).send({ error: "Invalid body: content and baseHash are required" })
      }

      const bodyContent = body.content
      const bodyBaseHash = body.baseHash

      const contentBytes = Buffer.byteLength(bodyContent, "utf-8")
      const MAX_DOC_BYTES = 2 * 1024 * 1024
      if (contentBytes > MAX_DOC_BYTES) {
        return reply.code(400).send({ error: "Content exceeds 2MB limit" })
      }

      const source = resolveSourceBase(root, sourceId, getFolderCtx())
      if (!source) {
        return reply.code(404).send({ error: "Source not found" })
      }

      if (source.readOnly) {
        return reply.code(403).send({ error: "Source is read-only" })
      }

      const normPath = normalizeRelativePath(rawPath)
      if (!normPath || isHiddenPath(normPath) || !normPath.toLowerCase().endsWith(".md")) {
        return reply.code(404).send({ error: "File not found or not markdown" })
      }

      // 오버레이 저장소가 없으면 쓰기를 절대 200으로 속이지 않는다.
      const store = overlayStore
      if (store === null) {
        return reply.code(503).send({ error: "Overlay unavailable" })
      }

      const absPath = path.resolve(source.baseDir, normPath)
      if (!fs.existsSync(absPath)) {
        return reply.code(404).send({ error: "Document not found" })
      }

      let realPath: string
      try {
        realPath = fs.realpathSync.native(absPath)
      } catch {
        return reply.code(404).send({ error: "Document not found" })
      }

      const cleanBaseHash = bodyBaseHash.trim().replace(/^"|"$/g, "")

      // 오버레이 우선 베이스: 대시보드는 오버레이 우선으로 읽으므로, 오버레이
      // 리비전이 있으면 baseHash는 그 내용을 가리킨다. git 체크아웃이 리셋돼도
      // baseHash가 오버레이와 맞으면 409가 아니라 저장으로 간다.
      // 존재 검사는 엄격한 null 비교로 한다(빈 문자열 ""도 유효한 본문이다).
      let overlayBase: string | null = null
      try {
        const existing = isValidOverlaySource(sourceId) ? store.get(sourceId, normPath) : null
        if (existing !== null) {
          if (crypto.createHash("sha256").update(existing.content, "utf-8").digest("hex") !== cleanBaseHash) {
            return reply.code(409).send({ error: "changed" })
          }
          overlayBase = existing.content
        }
      } catch {
        return reply.code(503).send({ error: "Overlay unavailable" })
      }

      // 프로세스 안 잠금 (realpath 하나 단위 Promise 사슬)이 첫 열기부터 rename까지 감싼다.
      // 읽기 전용 체크아웃(EROFS/EACCES/EPERM)에서는 git 쓰기 대신 오버레이에만 저장한다.
      try {
        return await withDocWriteLock(realPath, async () => {
        // 오버레이가 있으면 잠금 안에서 다시 견준다 (동시 PUT 충돌 보호).
        // 엄격한 null 비교: 빈 문자열 ""도 유효한 오버레이 본문이다.
        let overlayNow: string | null = null
        try {
          overlayNow = isValidOverlaySource(sourceId) ? (store.get(sourceId, normPath)?.content ?? null) : null
        } catch {
          return reply.code(503).send({ error: "Overlay unavailable" })
        }
        if (overlayNow !== null) {
          if (crypto.createHash("sha256").update(overlayNow, "utf-8").digest("hex") !== cleanBaseHash) {
            return reply.code(409).send({ error: "changed" })
          }
          overlayBase = overlayNow
        } else {
          overlayBase = null
        }
        // 경로 및 허용 폴더 검사
        const allowedDir = matchingAllowedDir(source, normPath)
        if (!allowedDir) return reply.code(404).send({ error: "Document not found" })

        let realAllowedDir: string
        let realBaseDir: string
        try {
          realAllowedDir = fs.realpathSync.native(allowedDir)
          realBaseDir = fs.realpathSync.native(source.baseDir)
        } catch {
          return reply.code(404).send({ error: "Document not found" })
        }

        if (!isInside(realPath, realAllowedDir)) {
          return reply.code(404).send({ error: "Document not found" })
        }

        const realRelPath = path.relative(realBaseDir, realPath)
        if (isHiddenPath(realRelPath)) {
          return reply.code(404).send({ error: "Document not found" })
        }

        if (path.extname(realPath).toLowerCase() !== ".md") {
          return reply.code(404).send({ error: "Document not found" })
        }

        // 대상은 O_NOFOLLOW fd로 한 번 열고 rename까지 닫지 않는다.
        let targetFd: number
        try {
          targetFd = fs.openSync(realPath, OPEN_READ_FLAGS)
        } catch (err: any) {
          if (err?.code === "ELOOP") {
            return reply.code(409).send({ error: "changed" })
          }
          return reply.code(404).send({ error: "Document not found" })
        }

        try {
          let initialStat: fs.Stats
          try {
            initialStat = fs.fstatSync(targetFd)
          } catch {
            return reply.code(404).send({ error: "Document not found" })
          }

          // 정규 파일·nlink === 1 판정
          if (!initialStat.isFile() || initialStat.nlink > 1) {
            return reply.code(404).send({ error: "Document not found" })
          }

          // 2MB 판정 (넘치면 더 읽지 않고 지금의 2MB 초과 거절과 같은 상태·본문)
          if (initialStat.size > MAX_DOC_BYTES) {
            return reply.code(400).send({ error: "Content exceeds 2MB limit" })
          }

          // 그 fd에서 읽은 최대 2MB로만 해시·CRLF 판정
          const readBuf = Buffer.alloc(initialStat.size)
          let totalRead = 0
          while (totalRead < initialStat.size) {
            const n = fs.readSync(targetFd, readBuf, totalRead, initialStat.size - totalRead, totalRead)
            if (n === 0) break
            totalRead += n
          }

          const initialContentBuf = readBuf.subarray(0, totalRead)
          const currentHash = crypto.createHash("sha256").update(initialContentBuf).digest("hex")

          // 오버레이가 baseHash와 맞았으면 git 쪽 해시는 리셋으로 어긋나 있을 수 있어 견주지 않는다.
          if (overlayBase === null && currentHash !== cleanBaseHash) {
            return reply.code(409).send({ error: "changed" })
          }

          const originalStr = overlayBase ?? initialContentBuf.toString("utf-8")
          const isCRLF = originalStr.includes("\r\n")
          const finalContent = isCRLF
            ? bodyContent.replace(/\r?\n/g, "\r\n")
            : bodyContent.replace(/\r\n/g, "\n")

          // 4번: 실제로 쓸 바이트(CRLF 변환 뒤)가 2MB를 넘으면 임시 파일을 만들지 않거나 지우고 거절
          const finalBuf = Buffer.from(finalContent, "utf-8")
          if (finalBuf.byteLength > MAX_DOC_BYTES) {
            return reply.code(400).send({ error: "Content exceeds 2MB limit" })
          }

          const targetDir = path.dirname(realPath)
          const tempPath = path.join(
            targetDir,
            `.tmp-${path.basename(realPath)}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
          )
          fs.writeFileSync(tempPath, finalBuf)

          let renameCompleted = false
          try {
            // 시험 훅: "해시 확인과 rename 사이에 끼워 넣는 시험을 위해, 라우트가 부르는 'rename 직전 단계' 앞에 시험에서만 넘기는 비동기 훅 인자"
            if (beforeRenameHook) {
              await beforeRenameHook()
            }

            // "rename 직전 단계":
            // (가) 같은 fd를 처음부터 다시 읽어(2MB에서 끊음) sha256이 baseHash와 같고 fstat의 dev·ino·nlink가 처음과 같은지
            let reStat: fs.Stats
            try {
              reStat = fs.fstatSync(targetFd)
            } catch {
              return reply.code(404).send({ error: "Document not found" })
            }

            if (!reStat.isFile() || reStat.nlink > 1) {
              return reply.code(404).send({ error: "Document not found" })
            }

            if (
              reStat.dev !== initialStat.dev ||
              reStat.ino !== initialStat.ino ||
              reStat.nlink !== initialStat.nlink
            ) {
              return reply.code(409).send({ error: "changed" })
            }

            if (reStat.size > MAX_DOC_BYTES) {
              return reply.code(409).send({ error: "changed" })
            }

            const reReadBuf = Buffer.alloc(reStat.size)
            let reReadTotal = 0
            while (reReadTotal < reStat.size) {
              const n = fs.readSync(targetFd, reReadBuf, reReadTotal, reStat.size - reReadTotal, reReadTotal)
              if (n === 0) break
              reReadTotal += n
            }

            const reHash = crypto.createHash("sha256").update(reReadBuf.subarray(0, reReadTotal)).digest("hex")
            if (overlayBase === null && reHash !== cleanBaseHash) {
              return reply.code(409).send({ error: "changed" })
            }

            // (나) 경로를 O_NOFOLLOW로 다시 열어 같은 dev·ino인지 확인하고, 둘 다 맞을 때만 즉시 rename한다.
            let verifyFd: number
            try {
              verifyFd = fs.openSync(realPath, OPEN_READ_FLAGS)
            } catch (err: any) {
              if (err?.code === "ELOOP") {
                return reply.code(409).send({ error: "changed" })
              }
              return reply.code(404).send({ error: "Document not found" })
            }

            try {
              const pathStat = fs.fstatSync(verifyFd)
              if (!pathStat.isFile() || pathStat.nlink > 1) {
                return reply.code(404).send({ error: "Document not found" })
              }
              if (pathStat.dev !== initialStat.dev || pathStat.ino !== initialStat.ino) {
                return reply.code(409).send({ error: "changed" })
              }
            } finally {
              try {
                fs.closeSync(verifyFd)
              } catch {}
            }

            // 둘 다 맞을 때만 즉시 rename한다.
            fs.renameSync(tempPath, realPath)
            renameCompleted = true

            // git 쓰기가 끝났으니 오버레이에도 같은 리비전을 남긴다.
            // CAS 기대값으로 잠금 밖 경합까지 막고, 실패는 절대 삼키지 않는다.
            let overlayUpdatedAt: string
            try {
              const entry = store.put({
                source: sourceId,
                path: normPath,
                content: finalContent,
                updatedBy: dashboardActor(req),
                baseGitSha: cleanBaseHash,
                expectedBaseHash: overlayBase !== null ? cleanBaseHash : null,
              })
              overlayUpdatedAt = entry.updatedAt
            } catch (err: any) {
              if (err?.statusCode === 409) {
                return reply.code(409).send({ error: "changed" })
              }
              return reply.code(500).send({ error: "Overlay unavailable" })
            }

            const newHash = crypto.createHash("sha256").update(finalBuf).digest("hex")
            return reply
              .header("ETag", newHash)
              .header("X-Doc-Source", "overlay")
              .header("X-Overlay-Updated-At", overlayUpdatedAt)
              .send({ ok: true, sha256: newHash })
          } finally {
            if (!renameCompleted) {
              try {
                fs.unlinkSync(tempPath)
              } catch {}
            }
          }
        } finally {
          try {
            fs.closeSync(targetFd)
          } catch {}
        }
        })
      } catch (err: any) {
        const readOnly = err && (err.code === "EROFS" || err.code === "EACCES" || err.code === "EPERM")
        if (!readOnly) throw err
        // 읽기 전용 체크아웃: 잠금 안에서 경로·폴더 경계를 다시 확인하고,
        // 오버레이 우선 현재 본문과 baseHash를 견준 뒤 오버레이에만 저장한다.
        // 잠금 밖 평범한 읽기나 경계 없는 되돌림은 절대 쓰지 않는다.
        return await withDocWriteLock(realPath, async () => {
          const allowedDir = matchingAllowedDir(source, normPath)
          if (!allowedDir) return reply.code(404).send({ error: "Document not found" })
          let realAllowedDir: string
          let realBaseDir: string
          try {
            realAllowedDir = fs.realpathSync.native(allowedDir)
            realBaseDir = fs.realpathSync.native(source.baseDir)
          } catch {
            return reply.code(404).send({ error: "Document not found" })
          }
          let freshReal: string
          try {
            freshReal = fs.realpathSync.native(absPath)
          } catch {
            return reply.code(404).send({ error: "Document not found" })
          }
          if (!isInside(freshReal, realAllowedDir)) {
            return reply.code(404).send({ error: "Document not found" })
          }
          if (isHiddenPath(path.relative(realBaseDir, freshReal))) {
            return reply.code(404).send({ error: "Document not found" })
          }
          if (path.extname(freshReal).toLowerCase() !== ".md") {
            return reply.code(404).send({ error: "Document not found" })
          }
          let overlayNow: string | null = null
          try {
            overlayNow = isValidOverlaySource(sourceId) ? (store.get(sourceId, normPath)?.content ?? null) : null
          } catch {
            return reply.code(503).send({ error: "Overlay unavailable" })
          }
          let currentContent: string
          if (overlayNow !== null) {
            currentContent = overlayNow
          } else {
            let fd: number
            try {
              fd = fs.openSync(freshReal, OPEN_READ_FLAGS)
            } catch (openErr: any) {
              if (openErr?.code === "ELOOP") return reply.code(409).send({ error: "changed" })
              return reply.code(404).send({ error: "Document not found" })
            }
            try {
              const stat = fs.fstatSync(fd)
              if (!stat.isFile() || stat.nlink > 1) {
                return reply.code(404).send({ error: "Document not found" })
              }
              if (stat.size > MAX_DOC_BYTES) {
                return reply.code(409).send({ error: "changed" })
              }
              const buf = Buffer.alloc(stat.size)
              let totalRead = 0
              while (totalRead < stat.size) {
                const n = fs.readSync(fd, buf, totalRead, stat.size - totalRead, totalRead)
                if (n === 0) break
                totalRead += n
              }
              currentContent = buf.subarray(0, totalRead).toString("utf-8")
            } catch {
              return reply.code(404).send({ error: "Document not found" })
            } finally {
              try {
                fs.closeSync(fd)
              } catch {}
            }
          }
          const currentHash = crypto.createHash("sha256").update(currentContent, "utf-8").digest("hex")
          if (currentHash !== cleanBaseHash) {
            return reply.code(409).send({ error: "changed" })
          }
          const isCRLF = currentContent.includes("\r\n")
          const fallbackContent = isCRLF ? bodyContent.replace(/\r?\n/g, "\r\n") : bodyContent.replace(/\r\n/g, "\n")
          if (Buffer.byteLength(fallbackContent, "utf-8") > MAX_DOC_BYTES) {
            return reply.code(400).send({ error: "Content exceeds 2MB limit" })
          }
          let updatedAt: string
          try {
            updatedAt = store.put({
              source: sourceId,
              path: normPath,
              content: fallbackContent,
              updatedBy: dashboardActor(req),
              baseGitSha: cleanBaseHash,
              expectedBaseHash: overlayNow !== null ? cleanBaseHash : null,
            }).updatedAt
          } catch (putErr: any) {
            if (putErr?.statusCode === 409) {
              return reply.code(409).send({ error: "changed" })
            }
            return reply.code(503).send({ error: "Overlay unavailable" })
          }
          const newHash = crypto.createHash("sha256").update(fallbackContent, "utf-8").digest("hex")
          return reply
            .header("ETag", newHash)
            .header("X-Doc-Source", "overlay")
            .header("X-Overlay-Updated-At", updatedAt)
            .send({ ok: true, sha256: newHash })
        })
      }
    },
  )

  // GET /api/portal/notes (FE 6장)
  app.get("/notes", async (req, reply) => {
    if (!isNewViewAllowed(req)) {
      return reply.code(403).send({ error: "Forbidden" })
    }

    const query = req.query as Record<string, string | undefined>
    const notes = listNotes(root, {
      source: query.source,
      path: query.path,
      status: query.status,
    })

    return reply.send({ notes })
  })

  // GET /api/portal/notes/counts (FE 6장)
  app.get("/notes/counts", async (req, reply) => {
    if (!isNewViewAllowed(req)) {
      return reply.code(403).send({ error: "Forbidden" })
    }

    const counts = countOpenNotes(root)
    return reply.send(counts)
  })

  // GET /api/portal/notes/:id (단건 조회: 링크이거나 64KB 초과 시 404)
  app.get("/notes/:id", async (req, reply) => {
    if (!isNewViewAllowed(req)) {
      return reply.code(403).send({ error: "Forbidden" })
    }

    const { id } = req.params as { id: string }
    if (!isValidNoteId(id)) {
      return reply.code(400).send({ error: "Invalid note id" })
    }

    const note = readNote(root, id)
    if (!note) {
      return reply.code(404).send({ error: "Note not found" })
    }

    return reply.send({ note })
  })

  // POST /api/portal/notes (FE 6장)
  app.post("/notes", async (req, reply) => {
    if (!checkWriteSecurity(req, reply, true)) {
      return
    }

    const body = req.body as {
      source?: unknown
      path?: unknown
      quote?: unknown
      body?: unknown
      reply?: unknown
      awaiting?: unknown
      authorKind?: unknown
    } | undefined

    if (!body || typeof body.source !== "string" || typeof body.path !== "string") {
      return reply.code(400).send({ error: "Invalid body: source and path are required strings" })
    }

    // 다음 차례: 명시한 값이 있으면 그대로, 없으면 작성 주체 기본값.
    // 사람이 남긴 피드백은 담당 차례("agent"), 담당이 남긴 질문·요청은
    // 사람 차례("human")가 기본이다.
    let awaiting: NoteAwaiting
    if (body.awaiting === undefined || body.awaiting === null) {
      awaiting = body.authorKind === "agent" ? "human" : "agent"
    } else if (isValidNoteAwaiting(body.awaiting)) {
      awaiting = body.awaiting
    } else {
      return reply.code(400).send({ error: "Invalid body: awaiting must be 'human' or 'agent'" })
    }
    if (body.authorKind !== undefined && body.authorKind !== "human" && body.authorKind !== "agent") {
      return reply.code(400).send({ error: "Invalid body: authorKind must be 'human' or 'agent'" })
    }

    const lengthCheck = validateNoteLengths({
      body: body.body,
      quote: body.quote,
      reply: body.reply,
      requireBody: true,
    })
    if (!lengthCheck.valid) {
      return reply.code(400).send({ error: lengthCheck.error })
    }

    // 문서 실재 확인 (readOnly 출처도 메모 작성 가능)
    const source = resolveSourceBase(root, body.source, getFolderCtx())
    if (!source) {
      return reply.code(404).send({ error: "Source not found" })
    }

    const normPath = normalizeRelativePath(body.path)
    if (!normPath || isHiddenPath(normPath) || !normPath.toLowerCase().endsWith(".md")) {
      return reply.code(404).send({ error: "File not found or not markdown" })
    }

    const result = resolveSecureFile(source, normPath)
    if ("error" in result) {
      return reply.code(404).send({ error: "Document not found" })
    }

    const realExt = path.extname(result.absPath).toLowerCase()
    if (realExt !== ".md") {
      return reply.code(404).send({ error: "Document not found" })
    }

    const noteId = generateNoteId()
    const now = new Date().toISOString()
    const note: DocNote = {
      schemaVersion: 1,
      id: noteId,
      source: body.source,
      path: normPath,
      quote: typeof body.quote === "string" ? body.quote : null,
      body: body.body as string,
      status: "open",
      createdAt: now,
      updatedAt: now,
      reply: null,
      resolvedAt: null,
      awaiting,
    }

    const filePath = getNoteFilePath(root, noteId)
    try {
      await withFileLock(filePath, () => {
        saveNote(root, note)
      })
      // Route the memo to the responsible role's wake (best-effort: memo writes survive).
      try {
        writeNoteWake({ root, note, absDocPath: result.absPath })
      } catch {}
      return reply.code(201).send({ ok: true, note })
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        return reply.code(409).send({ error: "changed" })
      }
      throw err
    }
  })

  // PATCH /api/portal/notes/:id (FE 6장)
  app.patch("/notes/:id", async (req, reply) => {
    if (!checkWriteSecurity(req, reply, true)) {
      return
    }

    const { id } = req.params as { id: string }
    if (!isValidNoteId(id)) {
      return reply.code(400).send({ error: "Invalid note id" })
    }

    const body = req.body as {
      body?: unknown
      status?: unknown
      reply?: unknown
      quote?: unknown
      awaiting?: unknown
    } | undefined

    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "Invalid request body" })
    }

    if (body.awaiting !== undefined && body.awaiting !== null && !isValidNoteAwaiting(body.awaiting)) {
      return reply.code(400).send({ error: "Invalid body: awaiting must be 'human' or 'agent'" })
    }

    const lengthCheck = validateNoteLengths({
      body: body.body,
      quote: body.quote,
      reply: body.reply,
      requireBody: false,
    })
    if (!lengthCheck.valid) {
      return reply.code(400).send({ error: lengthCheck.error })
    }

    if (body.status !== undefined) {
      if (body.status !== "open" && body.status !== "resolved") {
        return reply.code(400).send({ error: "status must be 'open' or 'resolved'" })
      }
    }

    const filePath = getNoteFilePath(root, id)
    try {
      const updatedNote = await withFileLock(filePath, async () => {
        const existing = readNote(root, id)
        if (!existing) {
          return null
        }

        if (body.body !== undefined) {
          existing.body = body.body as string
        }

        if (body.quote !== undefined) {
          existing.quote = body.quote === null ? null : (body.quote as string)
        }

        if (body.status !== undefined) {
          existing.status = body.status as "open" | "resolved"
          if (body.status === "resolved") {
            existing.resolvedAt = existing.resolvedAt || new Date().toISOString()
          } else {
            existing.resolvedAt = null
          }
        }

        if (body.reply !== undefined) {
          existing.reply = body.reply === null ? null : (body.reply as string)
        }

        if (body.awaiting !== undefined) {
          existing.awaiting = body.awaiting === null ? null : (body.awaiting as NoteAwaiting)
        }

        existing.updatedAt = new Date().toISOString()
        saveNote(root, existing)
        return existing
      })

      if (!updatedNote) {
        return reply.code(404).send({ error: "Note not found" })
      }

      return reply.send({ ok: true, note: updatedNote })
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        return reply.code(409).send({ error: "changed" })
      }
      throw err
    }
  })

  // DELETE /api/portal/notes/:id (FE 6장: 본문 없음, Content-Type 검사 없음)
  app.delete("/notes/:id", async (req, reply) => {
    if (!checkWriteSecurity(req, reply, false)) {
      return
    }

    const { id } = req.params as { id: string }
    if (!isValidNoteId(id)) {
      return reply.code(400).send({ error: "Invalid note id" })
    }

    const filePath = getNoteFilePath(root, id)
    try {
      const deleted = await withFileLock(filePath, async () => {
        const existing = readNote(root, id)
        if (!existing) {
          return false
        }
        deleteNote(root, id)
        return true
      })

      if (!deleted) {
        return reply.code(404).send({ error: "Note not found" })
      }

      return reply.send({ ok: true })
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        return reply.code(409).send({ error: "changed" })
      }
      throw err
    }
  })

  // GET /api/portal/favorites (FE 7장)
  app.get("/favorites", async (req, reply) => {
    if (!isNewViewAllowed(req)) {
      return reply.code(403).send({ error: "Forbidden" })
    }

    const favResult = readFavoritesSecure(root)
    if (!favResult.ok) {
      return reply.code(409).send({ error: "favorites_file_invalid" })
    }

    const data = favResult.data
    const itemsWithExists = data.items.map((item) => {
      const source = resolveSourceBase(root, item.source, getFolderCtx())
      if (!source) {
        return { ...item, exists: false }
      }

      if (item.path === "") {
        return { ...item, exists: true }
      }

      if (item.type === "file") {
        const check = resolveSecureFile(source, item.path)
        return { ...item, exists: !("error" in check) }
      } else {
        const check = resolveSecureDir(source, item.path)
        return { ...item, exists: !("error" in check) }
      }
    })

    return reply.send({ items: itemsWithExists })
  })

  // POST /api/portal/favorites (FE 7장)
  app.post("/favorites", async (req, reply) => {
    if (!checkWriteSecurity(req, reply, true)) {
      return
    }

    const body = req.body as { source?: unknown; path?: unknown } | undefined
    if (!body || typeof body.source !== "string" || typeof body.path !== "string") {
      return reply.code(400).send({ error: "source and path are required strings" })
    }

    const source = resolveSourceBase(root, body.source, getFolderCtx())
    if (!source) {
      return reply.code(404).send({ error: "Source not found" })
    }

    let type: "file" | "directory"
    let targetPath: string

    if (body.path === "") {
      // 빈 경로는 출처 루트 (디렉터리)
      type = "directory"
      targetPath = ""
    } else {
      const normPath = normalizeRelativePath(body.path)
      if (!normPath || isHiddenPath(normPath)) {
        return reply.code(400).send({ error: "Invalid path" })
      }
      targetPath = normPath

      // 실재 확인: 파일 또는 폴더
      const fileSec = resolveSecureFile(source, normPath)
      if (!("error" in fileSec)) {
        type = "file"
      } else {
        const dirSec = resolveSecureDir(source, normPath)
        if (!("error" in dirSec)) {
          type = "directory"
        } else {
          return reply.code(404).send({ error: "File or directory not found" })
        }
      }
    }

    const filePath = getFavoritesFilePath(root)
    try {
      const result = await withFileLock(filePath, async () => {
        const favResult = readFavoritesSecure(root)
        if (!favResult.ok) {
          return { errorStatus: 409, error: "favorites_file_invalid" } as const
        }
        const data = favResult.data

        const existing = data.items.find(
          (it) => it.source === body.source && it.path === targetPath,
        )
        if (existing) {
          return { ok: true, item: existing } as const
        }

        if (data.items.length >= 200) {
          return { errorStatus: 400, error: "Favorites limit reached (200)" } as const
        }

        const newItem: DocFavoriteItem = {
          source: body.source as string,
          path: targetPath,
          type,
          addedAt: new Date().toISOString(),
        }

        data.items.push(newItem)
        saveFavorites(root, data)

        return { ok: true, item: newItem } as const
      })

      if ("errorStatus" in result && typeof result.errorStatus === "number") {
        return reply.code(result.errorStatus).send({ error: result.error })
      }

      if ("item" in result) {
        return reply.send({ ok: true, item: result.item })
      }
      return reply.send({ ok: true })
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        return reply.code(409).send({ error: "changed" })
      }
      throw err
    }
  })

  // DELETE /api/portal/favorites (FE 7장: 본문 { source, path } 있음, JSON 형식)
  app.delete("/favorites", async (req, reply) => {
    if (!checkWriteSecurity(req, reply, true)) {
      return
    }

    const body = req.body as { source?: unknown; path?: unknown } | undefined
    if (!body || typeof body.source !== "string" || typeof body.path !== "string") {
      return reply.code(400).send({ error: "source and path are required strings" })
    }

    const targetPath = body.path === "" ? "" : normalizeRelativePath(body.path)
    if (targetPath === null) {
      return reply.code(400).send({ error: "Invalid path" })
    }

    const filePath = getFavoritesFilePath(root)
    try {
      const result = await withFileLock(filePath, async () => {
        const favResult = readFavoritesSecure(root)
        if (!favResult.ok) {
          return { errorStatus: 409, error: "favorites_file_invalid" } as const
        }
        const data = favResult.data
        const initialLength = data.items.length
        data.items = data.items.filter(
          (it) => !(it.source === body.source && it.path === targetPath),
        )

        if (data.items.length !== initialLength) {
          saveFavorites(root, data)
        }
        return { ok: true } as const
      })

      if ("errorStatus" in result && typeof result.errorStatus === "number") {
        return reply.code(result.errorStatus).send({ error: result.error })
      }

      return reply.send({ ok: true })
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        return reply.code(409).send({ error: "changed" })
      }
      throw err
    }
  })

  // GET /api/portal/ledger (읽기 전용 업무 장부 조회)
  app.get("/ledger", async (req, reply) => {
    if (!isLedgerRequestAllowed(req.headers, (req as any).trust)) {
      return reply.code(403).send({ error: "Forbidden" })
    }
    const query = (req.query || {}) as LedgerQueryParams
    const data = await queryPortalWorkLedger(root, {
      folderCtx: getFolderCtx(),
      query,
    })
    return reply.header("cache-control", "no-store").send(data)
  })

  // GET /api/portal/docs — overlay entries: dashboard edits that survive git resets.
  // 출처·폴더 경계 검증을 통과한 행만 내놓는다. 출처가 사라지거나 허용
  // 폴더가 좁혀진 낡은 행은 버린다.
  app.get("/docs", async (req, reply) => {
    if (!isNewViewAllowed(req)) {
      return reply.code(403).send({ error: "Forbidden" })
    }
    if (overlayStore === null) {
      return reply.code(503).send({ error: "Overlay unavailable" })
    }
    try {
      const rows = overlayStore.list()
      const live = rows.filter((row) => {
        const source = resolveSourceBase(root, row.source, getFolderCtx())
        return source !== null && matchingAllowedDir(source, row.path) !== null
      })
      return reply.send({ overlays: live })
    } catch {
      return reply.code(503).send({ error: "Overlay unavailable" })
    }
  })

  // GET /api/portal/decisions — unified human-review inbox (single source of truth).
  // Trusted dashboard sessions only: public-domain requests never see decisions.
  app.get("/decisions", async (req, reply) => {
    if (!isNewViewAllowed(req)) {
      return reply.code(403).send({ error: "Forbidden" })
    }
    if (isPublicProxyRequest(req)) {
      return reply.code(403).send({ error: "Forbidden" })
    }
    const snapshot = await collectDecisions(root)
    return reply.header("cache-control", "no-store").send(snapshot)
  })

  // POST /api/portal/decisions/:id/resolve — confirm / reject / acknowledge.
  // 승인 항목은 메신저 승인 게이트와 같은 검증을 거친다: 로그인 게이트가
  // 확인한 계정 키(`x-ax-account-key` + `x-naia-gate-verified: 1`)만 사람
  // 행위자로 믿고, 합성 `"dashboard"`·표시 이름은 절대 쓰지 않는다.
  app.post("/decisions/:id/resolve", async (req, reply) => {
    if (!checkWriteSecurity(req, reply, true)) {
      return
    }
    if (isPublicProxyRequest(req)) {
      return reply.code(403).send({ error: "Forbidden" })
    }
    const { id } = req.params as { id: string }
    if (!id || typeof id !== "string" || id.length > 512) {
      return reply.code(400).send({ error: "Invalid id" })
    }
    const body = req.body as { action?: unknown; comment?: unknown } | undefined
    let actor = dashboardActor(req)
    let actorKind = "dashboard"
    if (id.startsWith("approval:")) {
      const verified = verifiedMessengerAccount(req)
      if (!verified) {
        return reply.code(401).send({ error: "Human identity required" })
      }
      actor = verified
      actorKind = "human"
    }
    try {
      const item = await resolveDecisionItem(root, id, {
        action: body?.action as "approve" | "reject" | "acknowledge",
        actor,
        actorKind,
        via: "portal-decisions",
        comment: typeof body?.comment === "string" ? body.comment : undefined,
      })
      return reply.send({ ok: true, item })
    } catch (err: any) {
      const status = typeof err?.statusCode === "number" ? err.statusCode : 500
      if (status === 500) throw err
      return reply.code(status).send({ error: err?.message ?? "Failed to resolve" })
    }
  })

  done()
}
