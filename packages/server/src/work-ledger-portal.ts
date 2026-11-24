import fs from "node:fs"
import path from "node:path"
import {
  formatDateInTimeZone,
  loadWorkLedgers,
  resolveTimeZone,
  summarizeWorkLedgerItems,
  type WorkLedgerNormalizedItem,
  type WorkLedgerStatus,
  type WorkLedgerSummary,
} from "@naia-adk/core"
import {
  getSourcesAndBoard,
  isHiddenPath,
  type ResolvedSource,
} from "./routes/portal.js"
import type { FolderCheckContext } from "./view-folders.js"

export interface PublicLedgerResultLink {
  kind: "doc" | "url" | "unlinked"
  label: string
  displayPath: string | null
  href: string | null
  source: string | null
  path: string | null
}

export interface PublicWorkLedgerItem {
  id: string
  role: string
  title: string
  status: WorkLedgerStatus
  due: string | null
  dueDate: string | null
  overdue: boolean
  isTodo: boolean
  createdAt: string | null
  checkedAt: string | null
  note: string
  channel: string
  msgId: string
  quote: string
  sourceUrl: string | null
  resultLinks: PublicLedgerResultLink[]
  workerName: string | null
  hasDrive: boolean
}

export interface LedgerDueDateBucket {
  date: string
  overdueCount: number
  todoCount: number
  totalCount: number
  items: PublicWorkLedgerItem[]
}

export interface LedgerApiResponse {
  configured: boolean
  available: boolean
  view: "board" | "due"
  observedAt: string
  todayDate: string
  timezone: string
  roles: string[]
  summary: WorkLedgerSummary
  filteredSummary: WorkLedgerSummary
  maxSubagents: number | null
  dates?: LedgerDueDateBucket[]
  items: PublicWorkLedgerItem[]
  warnings: string[]
}

export interface LedgerQueryParams {
  view?: string
  role?: string
  status?: string
  overdue?: string
  source?: string
  path?: string
  tz?: string
  includeClosed?: string
}

function inferPortalTab(source: ResolvedSource, relPath: string): "common" | "brand" | "developer" {
  if (source.id.startsWith("data:")) {
    return source.tab === "brand" || source.tab === "developer" ? source.tab : "common"
  }
  if (source.id === "adk") {
    if (relPath === "index.md" || relPath === "common" || relPath.startsWith("common/")) return "common"
    if (relPath === "brand-marketing" || relPath.startsWith("brand-marketing/")) return "brand"
    return "developer"
  }
  return "developer"
}

function buildPortalDocHref(source: ResolvedSource, relPath: string): string {
  const tab = inferPortalTab(source, relPath)
  return `/docs?tab=${tab}&source=${encodeURIComponent(source.id)}&path=${encodeURIComponent(relPath)}`
}

function normalizeDocRelPath(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null
  const clean = raw.replace(/\\/g, "/").replace(/^\/+/, "")
  const segments = clean.split("/").filter((s) => s.length > 0)
  if (segments.length === 0 || segments.includes(".") || segments.includes("..")) return null
  const joined = segments.join("/")
  if (isHiddenPath(joined)) return null
  return joined
}

function readShortLinkMap(adkRoot: string, env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, { source: string; path: string }> {
  const candidateFile = env.NAIA_SHORT_LINKS_FILE
    ? path.resolve(adkRoot, env.NAIA_SHORT_LINKS_FILE)
    : path.join(adkRoot, "packages", "dashboard", "data", "short-links.json")
  try {
    if (!fs.existsSync(candidateFile)) return {}
    const lstat = fs.lstatSync(candidateFile)
    if (lstat.isSymbolicLink() || !lstat.isFile() || lstat.size > 4 * 1024 * 1024) return {}
    const parsed = JSON.parse(fs.readFileSync(candidateFile, "utf8")) as { links?: Record<string, { source?: unknown; path?: unknown }> }
    if (!parsed || typeof parsed !== "object" || !parsed.links || typeof parsed.links !== "object") return {}
    const out: Record<string, { source: string; path: string }> = {}
    for (const [key, entry] of Object.entries(parsed.links)) {
      if (entry && typeof entry.source === "string" && typeof entry.path === "string") {
        out[key] = { source: entry.source, path: entry.path }
      }
    }
    return out
  } catch {
    return {}
  }
}

function extractPortalTargetFromUrlOrRoute(
  rawUrl: string,
  shortLinks: Record<string, { source: string; path: string }>,
): { source: string; path: string } | null {
  let u: URL
  try {
    u = new URL(rawUrl, "http://placeholder.invalid")
  } catch {
    return null
  }
  if (u.pathname === "/docs") {
    const src = u.searchParams.get("source")?.trim() ?? ""
    const docPath = normalizeDocRelPath(u.searchParams.get("path")?.trim() ?? "")
    if (src && docPath) return { source: src, path: docPath }
  }
  if (u.pathname.startsWith("/d/")) {
    const rest = u.pathname.slice(3).split("/").filter(Boolean)
    if (rest.length === 1 && /^[0-9a-f]{6,16}$/.test(rest[0]) && shortLinks[rest[0]]) {
      const hit = shortLinks[rest[0]]
      const docPath = normalizeDocRelPath(hit.path)
      if (docPath) return { source: hit.source, path: docPath }
    }
    if (rest.length >= 2) {
      try {
        const src = decodeURIComponent(rest[0]).trim()
        const docPath = normalizeDocRelPath(rest.slice(1).map((s) => decodeURIComponent(s)).join("/"))
        if (src && docPath) return { source: src, path: docPath }
      } catch {
        return null
      }
    }
  }
  return null
}

function matchesSourcePrefix(source: ResolvedSource, relPath: string): boolean {
  if (source.allowedPrefixes === null) return true
  return source.allowedPrefixes.some((prefix) => {
    const clean = prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
    return relPath === clean || relPath.startsWith(`${clean}/`)
  })
}

function resolveCandidateAgainstSources(
  candidateAbs: string,
  sourceEntries: Array<{ source: ResolvedSource; realBase: string }>,
): { source: ResolvedSource; relPath: string } | null {
  let targetReal: string
  try {
    if (fs.existsSync(candidateAbs)) {
      const stat = fs.statSync(candidateAbs)
      if (!stat.isFile() || stat.nlink > 1) return null
      targetReal = fs.realpathSync.native(candidateAbs)
    } else {
      const parentDir = path.dirname(candidateAbs)
      const parentReal = fs.existsSync(parentDir) ? fs.realpathSync.native(parentDir) : path.resolve(parentDir)
      targetReal = path.join(parentReal, path.basename(candidateAbs))
    }
  } catch {
    return null
  }

  for (const { source, realBase } of sourceEntries) {
    const rel = path.relative(realBase, targetReal)
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue
    const normRel = normalizeDocRelPath(rel)
    if (!normRel) continue
    if (!matchesSourcePrefix(source, normRel)) continue
    return { source, relPath: normRel }
  }
  return null
}

function resolveResultLinks(
  rawResults: string[],
  adkRoot: string,
  ledgerRoot: string | null,
  sourceEntries: Array<{ source: ResolvedSource; realBase: string }>,
  resolvedSources: Map<string, ResolvedSource>,
  shortLinks: Record<string, { source: string; path: string }>,
): PublicLedgerResultLink[] {
  const out: PublicLedgerResultLink[] = []
  const seenKeys = new Set<string>()

  const pushLink = (link: PublicLedgerResultLink) => {
    const key = `${link.kind}\0${link.source ?? ""}\0${link.path ?? ""}\0${link.href ?? link.label}`
    if (!seenKeys.has(key)) {
      seenKeys.add(key)
      out.push(link)
    }
  }

  for (const raw of rawResults) {
    if (/^https?:\/\//i.test(raw)) {
      let parsed: URL | null = null
      try {
        parsed = new URL(raw)
      } catch {
        parsed = null
      }
      if (!parsed) continue
      const target = extractPortalTargetFromUrlOrRoute(raw, shortLinks)
      const validSource = target && resolvedSources.has(target.source) ? target : null
      pushLink({
        kind: "url",
        label: validSource ? path.posix.basename(validSource.path) : `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`,
        displayPath: validSource ? validSource.path : null,
        href: raw,
        source: validSource ? validSource.source : target?.source ?? null,
        path: validSource ? validSource.path : target?.path ?? null,
      })
      continue
    }

    if (raw.startsWith("/docs") || raw.startsWith("/d/")) {
      const target = extractPortalTargetFromUrlOrRoute(raw, shortLinks)
      if (target) {
        const src = resolvedSources.get(target.source)
        if (src && matchesSourcePrefix(src, target.path)) {
          pushLink({
            kind: "doc",
            label: path.posix.basename(target.path),
            displayPath: target.path,
            href: buildPortalDocHref(src, target.path),
            source: src.id,
            path: target.path,
          })
          continue
        }
      }
    }

    const candidates: string[] = []
    if (path.isAbsolute(raw)) {
      candidates.push(path.resolve(raw))
    } else {
      if (ledgerRoot) candidates.push(path.resolve(ledgerRoot, raw))
      candidates.push(path.resolve(adkRoot, raw))
    }

    let matched: { source: ResolvedSource; relPath: string } | null = null
    for (const candidate of [...new Set(candidates)]) {
      matched = resolveCandidateAgainstSources(candidate, sourceEntries)
      if (matched) break
    }
    if (!matched && !path.isAbsolute(raw)) {
      for (const entry of sourceEntries) {
        const candidateInSource = path.resolve(entry.source.baseDir, raw)
        if (!fs.existsSync(candidateInSource)) continue
        const hit = resolveCandidateAgainstSources(candidateInSource, [entry])
        if (hit) {
          matched = hit
          break
        }
      }
    }

    if (matched) {
      pushLink({
        kind: "doc",
        label: path.posix.basename(matched.relPath),
        displayPath: matched.relPath,
        href: buildPortalDocHref(matched.source, matched.relPath),
        source: matched.source.id,
        path: matched.relPath,
      })
    } else {
      // Never expose raw server filesystem paths (e.g. /home/...) in unlinked text.
      const safeLabel = path.isAbsolute(raw) ? path.posix.basename(raw.replace(/\\/g, "/")) : raw
      pushLink({
        kind: "unlinked",
        label: safeLabel,
        displayPath: path.isAbsolute(raw) ? null : raw,
        href: null,
        source: null,
        path: null,
      })
    }
  }

  return out
}

function toPublicItem(
  item: WorkLedgerNormalizedItem,
  timeZone: string,
  resultLinks: PublicLedgerResultLink[],
): PublicWorkLedgerItem {
  return {
    id: item.id,
    role: item.role,
    title: item.title,
    status: item.status,
    due: item.due,
    dueDate: formatDateInTimeZone(item.dueMs, timeZone),
    overdue: item.overdue,
    isTodo: item.isTodo,
    createdAt: item.createdAt,
    checkedAt: item.checkedAt,
    note: item.note,
    channel: item.channel,
    msgId: item.msgId,
    quote: item.quote,
    sourceUrl: item.sourceUrl,
    resultLinks,
    workerName: item.workerName,
    hasDrive: item.hasDrive,
  }
}

export function isProcessingPortalItem(item: Pick<PublicWorkLedgerItem, "status" | "workerName">): boolean {
  return item.status === "open" && Boolean(item.workerName)
}

function parseStatusFilter(rawStatus: string | undefined): {
  statuses: Set<WorkLedgerStatus>
  includeProcessing: boolean
} | null {
  if (!rawStatus || rawStatus.trim() === "" || rawStatus.trim() === "all") return null
  const tokens = rawStatus
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (tokens.length === 0 || tokens.includes("all")) return null
  const allowed = new Set<WorkLedgerStatus>()
  let includeProcessing = false
  for (const t of tokens) {
    if (t === "todo") {
      allowed.add("open")
      allowed.add("waiting_human")
    } else if (t === "processing") {
      includeProcessing = true
    } else if (
      t === "open"
      || t === "waiting_human"
      || t === "escalated_human"
      || t === "done"
      || t === "dropped"
    ) {
      allowed.add(t)
    }
  }
  if (allowed.size === 0 && !includeProcessing) return null
  return { statuses: allowed, includeProcessing }
}

function buildDueBuckets(items: PublicWorkLedgerItem[]): LedgerDueDateBucket[] {
  const byDate = new Map<string, PublicWorkLedgerItem[]>()
  for (const item of items) {
    if (!item.dueDate) continue
    const list = byDate.get(item.dueDate)
    if (list) list.push(item)
    else byDate.set(item.dueDate, [item])
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucketItems]) => ({
      date,
      overdueCount: bucketItems.filter((i) => i.overdue).length,
      todoCount: bucketItems.filter((i) => i.isTodo).length,
      totalCount: bucketItems.length,
      items: bucketItems,
    }))
}

export async function queryPortalWorkLedger(
  adkRoot: string,
  options: {
    folderCtx?: FolderCheckContext
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>
    now?: number
    query?: LedgerQueryParams
  } = {},
): Promise<LedgerApiResponse> {
  const nowMs = options.now ?? Date.now()
  const env = options.env ?? process.env
  const q = options.query ?? {}
  const view: "board" | "due" = q.view === "due" ? "due" : "board"
  const timezone = resolveTimeZone(q.tz)
  const observedAt = new Date(nowMs).toISOString()
  const todayDate = formatDateInTimeZone(nowMs, timezone) ?? observedAt.slice(0, 10)

  const loaded = await loadWorkLedgers(adkRoot, { env, now: nowMs })
  if (!loaded.configured) {
    return {
      configured: false,
      available: false,
      view,
      observedAt,
      todayDate,
      timezone,
      roles: [],
      summary: loaded.summary,
      filteredSummary: loaded.summary,
      maxSubagents: loaded.maxSubagents,
      ...(view === "due" ? { dates: [] } : {}),
      items: [],
      warnings: [],
    }
  }

  const { resolvedSources } = getSourcesAndBoard(adkRoot, options.folderCtx)
  const sourceEntries = [...resolvedSources.values()].map((source) => {
    let realBase = path.resolve(source.baseDir)
    try {
      if (fs.existsSync(source.baseDir)) realBase = fs.realpathSync.native(source.baseDir)
    } catch {
      // keep resolved path
    }
    return { source, realBase }
  })
  const shortLinks = readShortLinkMap(adkRoot, env)

  const allPublicItems = loaded.items.map((item) => {
    const links = resolveResultLinks(
      item.rawResults,
      adkRoot,
      loaded.root,
      sourceEntries,
      resolvedSources,
      shortLinks,
    )
    return toPublicItem(item, timezone, links)
  })

  const roleFilter = typeof q.role === "string" && q.role.trim() ? q.role.trim() : null
  const statusCriterion = parseStatusFilter(q.status)
  const overdueOnly = q.overdue === "1" || q.overdue === "true"
  const docSourceFilter = typeof q.source === "string" && q.source.trim() ? q.source.trim() : null
  const docPathFilter = typeof q.path === "string" && q.path.trim() ? normalizeDocRelPath(q.path.trim()) : null
  const includeClosed = q.includeClosed !== "0" && q.includeClosed !== "false"

  const filteredItems = allPublicItems.filter((item) => {
    if (roleFilter && item.role !== roleFilter) return false
    if (statusCriterion) {
      const matchesStatus = statusCriterion.statuses.size > 0 && statusCriterion.statuses.has(item.status)
      const matchesProcessing = statusCriterion.includeProcessing && isProcessingPortalItem(item)
      if (!matchesStatus && !matchesProcessing) return false
    }
    if (!includeClosed && (item.status === "done" || item.status === "dropped")) return false
    if (overdueOnly && !item.overdue) return false
    if (docSourceFilter && docPathFilter) {
      const hasMatch = item.resultLinks.some(
        (link) => link.source === docSourceFilter && link.path === docPathFilter,
      )
      if (!hasMatch) return false
    } else if (docSourceFilter || docPathFilter) {
      return false
    }
    return true
  })

  // Keep filteredSummary accurate on public items using the same status/todo/overdue rules.
  const filteredSummary: WorkLedgerSummary = {
    total: filteredItems.length,
    todoCount: filteredItems.filter((i) => i.isTodo).length,
    open: filteredItems.filter((i) => i.status === "open").length,
    waiting_human: filteredItems.filter((i) => i.status === "waiting_human").length,
    escalated_human: filteredItems.filter((i) => i.status === "escalated_human").length,
    done: filteredItems.filter((i) => i.status === "done").length,
    dropped: filteredItems.filter((i) => i.status === "dropped").length,
    overdue: filteredItems.filter((i) => i.overdue).length,
    processing: filteredItems.filter((i) => isProcessingPortalItem(i)).length,
  }

  return {
    configured: loaded.configured,
    available: loaded.available,
    view,
    observedAt,
    todayDate,
    timezone,
    roles: loaded.roles,
    summary: loaded.summary,
    filteredSummary,
    maxSubagents: loaded.maxSubagents,
    ...(view === "due" ? { dates: buildDueBuckets(filteredItems) } : {}),
    items: filteredItems,
    warnings: loaded.warnings,
  }
}

export function isLedgerRequestAllowed(headers: Record<string, string | string[] | undefined>, trust?: { trusted?: boolean } | null): boolean {
  const secFetchSite = headers["sec-fetch-site"]
  if (typeof secFetchSite === "string" && secFetchSite.toLowerCase() === "cross-site") {
    return false
  }
  return trust?.trusted === true
}
