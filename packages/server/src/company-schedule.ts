import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import matter from "gray-matter"

export const MAX_COMPANY_SCHEDULE_BYTES = 2 * 1024 * 1024
export const MAX_COMPANY_RANGE_DAYS = 62

export const DEFAULT_COMPANY_SCHEDULE_CANDIDATES = [
  "docs/common/alpha/schedule.md",
  "docs/common/schedule.md",
] as const

export const DEFAULT_REGULAR_SCHEDULE_CANDIDATES = [
  "docs/common/team/regular-schedule.yaml",
] as const

export const DEFAULT_ALLOWED_REGULAR_STATES = ["있음", "새로"] as const
const ALL_KNOWN_REGULAR_STATES = new Set(["있음", "새로", "부분", "사람", "제안", "보류"])
const FORBIDDEN_PATH_SEGMENTS = new Set(["data-private", ".git", "node_modules"])

export type CompanyScheduleKind = "company" | "regular"

export interface CompanyScheduleItem {
  id: string
  title: string
  startDate: string
  endDate: string
  startTime?: string
  endTime?: string
  times?: string[]
  role?: string
  roleLabel?: string
  status: string
  state?: string
  sourceDocPath: string | null
  kind: CompanyScheduleKind
  repeatSummary?: string
  isDaily?: boolean
}

export interface CompanyScheduleResponse {
  from: string
  to: string
  items: CompanyScheduleItem[]
  sources: {
    companyDocPath: string | null
    regularDocPath: string | null
  }
}

export interface ReadCompanyScheduleOptions {
  adkRoot: string
  from?: string
  to?: string
  today?: string
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  includeCanceled?: boolean
  allowedRegularStates?: readonly string[]
}

const yamlEngine = (
  matter as unknown as {
    engines: { yaml: { parse: (input: string) => unknown } }
  }
).engines.yaml

// ── 날짜 유틸리티 ──────────────────────────────────────────────────────────

export function isValidDateStr(value: unknown): value is string {
  if (typeof value !== "string") return false
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

function makeDateStr(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

export function formatUtcDate(dt: Date): string {
  const y = dt.getUTCFullYear()
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0")
  const d = String(dt.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

export function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number)
  return formatUtcDate(new Date(Date.UTC(y, m - 1, d + delta)))
}

export function daysBetween(startStr: string, endStr: string): number {
  const [y1, m1, d1] = startStr.split("-").map(Number)
  const [y2, m2, d2] = endStr.split("-").map(Number)
  const a = Date.UTC(y1, m1 - 1, d1)
  const b = Date.UTC(y2, m2 - 1, d2)
  return Math.round((b - a) / 86_400_000)
}

export function clampDateRange(
  rawFrom?: string,
  rawTo?: string,
  todayStr?: string,
): { ok: true; from: string; to: string; clamped: boolean } | { ok: false; error: string } {
  const today = isValidDateStr(todayStr) ? todayStr : formatUtcDate(new Date())
  const defaultFrom = `${today.slice(0, 8)}01`

  if (rawFrom !== undefined && !isValidDateStr(rawFrom)) {
    return { ok: false, error: "Invalid 'from' date; expected YYYY-MM-DD" }
  }
  if (rawTo !== undefined && !isValidDateStr(rawTo)) {
    return { ok: false, error: "Invalid 'to' date; expected YYYY-MM-DD" }
  }

  const from = rawFrom ?? (rawTo ? addDays(rawTo, -31) : defaultFrom)
  const initialTo = rawTo ?? (rawFrom ? addDays(rawFrom, 31) : addDays(defaultFrom, 41))

  if (from > initialTo) {
    return { ok: false, error: "'from' must not be after 'to'" }
  }

  const span = daysBetween(from, initialTo)
  if (span >= MAX_COMPANY_RANGE_DAYS) {
    return {
      ok: true,
      from,
      to: addDays(from, MAX_COMPANY_RANGE_DAYS - 1),
      clamped: true,
    }
  }

  return { ok: true, from, to: initialTo, clamped: false }
}

// ── 파일 보안 검사 및 읽기 (심볼릭 링크·하드 링크·경로 탈출 차단) ─────────

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function hasUnsafeRelativeSegment(relPath: string): boolean {
  const segments = relPath.replace(/\\/g, "/").split("/").filter((s) => s.length > 0)
  for (const seg of segments) {
    const trimmed = seg.normalize("NFC").replace(/[\s.]+$/, "").toLowerCase()
    if (!trimmed || trimmed === "." || trimmed === "..") return true
    if (trimmed.startsWith(".") || FORBIDDEN_PATH_SEGMENTS.has(trimmed)) return true
  }
  return false
}

function hasSymlinkAlongSubpath(baseDir: string, targetPath: string): boolean {
  const rel = path.relative(baseDir, targetPath)
  const segments = rel.split(path.sep).filter((s) => s.length > 0)
  let current = baseDir
  for (const seg of segments) {
    current = path.join(current, seg)
    try {
      const st = fs.lstatSync(current)
      if (st.isSymbolicLink()) return true
    } catch {
      return false
    }
  }
  return false
}

interface SecureReadResult {
  content: string
  sourceDocPath: string | null
}

function readSecureCandidate(
  adkRoot: string,
  rawCandidate: string,
  expectedExts: readonly string[],
  isEnvOverride: boolean,
): SecureReadResult | null {
  if (!rawCandidate || rawCandidate.includes("\0")) return null
  const normalizedInput = rawCandidate.trim()
  if (!normalizedInput) return null

  const inputSegments = normalizedInput.replace(/\\/g, "/").split("/")
  if (inputSegments.includes("..")) return null

  let realAdkRoot: string
  try {
    realAdkRoot = fs.realpathSync.native(path.resolve(adkRoot))
  } catch {
    return null
  }

  const realAdkDocsDir = (() => {
    try {
      return fs.realpathSync.native(path.join(realAdkRoot, "docs"))
    } catch {
      return null
    }
  })()

  const isAbs = path.isAbsolute(normalizedInput)
  if (!isEnvOverride && isAbs) return null

  const absCandidate = isAbs ? path.resolve(normalizedInput) : path.resolve(adkRoot, normalizedInput)

  const ext = path.extname(absCandidate).toLowerCase()
  if (!expectedExts.includes(ext)) return null

  if (!isAbs) {
    const relFromRoot = path.relative(path.resolve(adkRoot), absCandidate)
    if (!relFromRoot || relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) return null
    if (hasUnsafeRelativeSegment(relFromRoot)) return null
    if (hasSymlinkAlongSubpath(path.resolve(adkRoot), absCandidate)) return null
  } else {
    const baseName = path.basename(absCandidate)
    if (baseName.startsWith(".")) return null
    if (
      absCandidate
        .replace(/\\/g, "/")
        .split("/")
        .some((seg) => FORBIDDEN_PATH_SEGMENTS.has(seg.trim().toLowerCase()))
    ) {
      return null
    }
  }

  let lstat: fs.Stats
  try {
    lstat = fs.lstatSync(absCandidate)
  } catch {
    return null
  }
  if (lstat.isSymbolicLink() || !lstat.isFile()) return null

  let realFile: string
  try {
    realFile = fs.realpathSync.native(absCandidate)
  } catch {
    return null
  }

  if (!isAbs) {
    if (!isInside(realFile, realAdkRoot)) return null
    const realRel = path.relative(realAdkRoot, realFile)
    if (hasUnsafeRelativeSegment(realRel)) return null
  } else {
    // 절대 경로 환경변수라도 리프 또는 직계 폴더의 심볼릭 링크를 허용하지 않는다.
    let realParent: string
    try {
      realParent = fs.realpathSync.native(path.dirname(absCandidate))
    } catch {
      return null
    }
    if (realFile !== path.join(realParent, path.basename(absCandidate))) return null
    if (isInside(realFile, realAdkRoot) && hasUnsafeRelativeSegment(path.relative(realAdkRoot, realFile))) {
      return null
    }
  }

  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  let fd: number
  try {
    fd = fs.openSync(realFile, openFlags)
  } catch {
    return null
  }

  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1) return null
    if (stat.dev !== lstat.dev || stat.ino !== lstat.ino) return null
    if (stat.size > MAX_COMPANY_SCHEDULE_BYTES) return null

    const buf = Buffer.alloc(stat.size)
    let totalRead = 0
    while (totalRead < stat.size) {
      const n = fs.readSync(fd, buf, totalRead, stat.size - totalRead, totalRead)
      if (n === 0) break
      totalRead += n
    }

    const content = buf.subarray(0, totalRead).toString("utf-8")
    const sourceDocPath =
      realAdkDocsDir && isInside(realFile, realAdkDocsDir)
        ? path.relative(realAdkDocsDir, realFile).replace(/\\/g, "/")
        : null

    return { content, sourceDocPath }
  } catch {
    return null
  } finally {
    try {
      fs.closeSync(fd)
    } catch {}
  }
}

function resolveAndReadSource(
  adkRoot: string,
  envValue: string | undefined,
  defaultCandidates: readonly string[],
  expectedExts: readonly string[],
): SecureReadResult | null {
  const trimmedEnv = typeof envValue === "string" ? envValue.trim() : ""
  if (trimmedEnv) {
    return readSecureCandidate(adkRoot, trimmedEnv, expectedExts, true)
  }
  for (const rel of defaultCandidates) {
    const absPath = path.resolve(adkRoot, rel)
    let exists = false
    try {
      fs.lstatSync(absPath)
      exists = true
    } catch {
      exists = false
    }
    if (!exists) continue
    const loaded = readSecureCandidate(adkRoot, rel, expectedExts, false)
    if (loaded) return loaded
  }
  return null
}

// ── 마크다운(schedule.md) 파서 ─────────────────────────────────────────────

function splitMarkdownRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|")) return null
  const cells: string[] = []
  let current = ""
  let inCode = false
  let start = 1

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === "\\" && i + 1 < trimmed.length && trimmed[i + 1] === "|") {
      current += "|"
      i++
      continue
    }
    if (ch === "`") {
      inCode = !inCode
      current += ch
      continue
    }
    if (ch === "|" && !inCode) {
      cells.push(current.trim())
      current = ""
      continue
    }
    current += ch
  }

  const tail = current.trim()
  if (tail.length > 0) {
    cells.push(tail)
  }
  return cells.length > 0 ? cells : null
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c.trim()))
}

function stripInlineMarkdown(raw: string): string {
  return raw
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function isWholeCellStuckThrough(raw: string): boolean {
  const unwrapped = raw
    .trim()
    .replace(/^\*\*|\*\*$/g, "")
    .trim()
  return /^~~[\s\S]+~~$/.test(unwrapped)
}

function detectDocumentBaseDate(markdown: string, fallbackYear: number): { year: number; month: number | null } {
  const normalized = markdown.replace(/^\uFEFF/, "")
  const headerMatch = normalized.match(/^(?:갱신|기준일?|작성일?|업데이트)\s*:\s*(\d{4})[-./](\d{1,2})[-./](\d{1,2})/m)
  if (headerMatch) {
    const year = Number(headerMatch[1])
    const month = Number(headerMatch[2])
    if (year >= 1970 && year <= 2100) {
      return { year, month: month >= 1 && month <= 12 ? month : null }
    }
  }

  const fmMatch = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fmMatch) {
    const fmDate = fmMatch[1].match(/(?:updated|date)\s*:\s*['"]?(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/i)
    if (fmDate) {
      return { year: Number(fmDate[1]), month: Number(fmDate[2]) }
    }
  }

  const headingMatch = normalized.match(/^#\s+[^\n]*?(\d{4})\s*년/m)
  if (headingMatch) {
    return { year: Number(headingMatch[1]), month: null }
  }

  return { year: fallbackYear, month: null }
}

interface ParsedDateToken {
  year: number | null
  month: number
  day: number
  rest: string
}

function matchDateTokenAtStart(text: string): ParsedDateToken | null {
  const s = text.trimStart()
  // 1) YYYY-MM-DD, YYYY.MM.DD, YYYY/MM/DD
  let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:\s*[(\[（][일월화수목금토][)\]）])?/)
  if (m) {
    return {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      rest: s.slice(m[0].length),
    }
  }
  // 2) YYYY년 M월 D일
  m = s.match(/^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\s*[(\[（][일월화수목금토][)\]）])?/)
  if (m) {
    return {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      rest: s.slice(m[0].length),
    }
  }
  // 3) M/D or M.D (단, 숫자 뒤 콜론(:)으로 이어지는 시각(10:00)은 날짜가 아님)
  m = s.match(/^(\d{1,2})[/.](\d{1,2})(?![\d:])(?:\s*[(\[（][일월화수목금토][)\]）])?/)
  if (m) {
    return {
      year: null,
      month: Number(m[1]),
      day: Number(m[2]),
      rest: s.slice(m[0].length),
    }
  }
  // 4) M월 D일
  m = s.match(/^(\d{1,2})월\s*(\d{1,2})일(?:\s*[(\[（][일월화수목금토][)\]）])?/)
  if (m) {
    return {
      year: null,
      month: Number(m[1]),
      day: Number(m[2]),
      rest: s.slice(m[0].length),
    }
  }
  return null
}

function matchTimeTokenAtStart(text: string): { time: string; rest: string } | null {
  const s = text.trimStart()
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?(?:Z)?(?=\s|$|[~–—),/])/)
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
  return {
    time: `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`,
    rest: s.slice(m[0].length),
  }
}

export interface ParsedKoreanDateCell {
  startDate: string
  endDate: string
  startTime?: string
  endTime?: string
  canceled: boolean
}

export function parseKoreanDateExpression(
  rawDateCell: string,
  baseYear: number,
): ParsedKoreanDateCell | null {
  const hadStrike = /~~[\s\S]*?~~/.test(rawDateCell)
  const withoutStrike = rawDateCell.replace(/~~[\s\S]*?~~/g, " ")
  const cleaned = stripInlineMarkdown(withoutStrike).replace(/^~+\s*/, "")

  if (!cleaned) {
    return null
  }

  const startTok = matchDateTokenAtStart(cleaned)
  if (!startTok) {
    return null
  }

  const startYear = startTok.year ?? baseYear
  const startDate = makeDateStr(startYear, startTok.month, startTok.day)
  if (!startDate) return null

  let rest = startTok.rest
  let startTime: string | undefined
  let endTime: string | undefined
  let endDate = startDate

  const t1 = matchTimeTokenAtStart(rest)
  if (t1) {
    startTime = t1.time
    rest = t1.rest
  }

  const rangeMatch = rest.match(/^\s*[~–—-]\s*/)
  if (rangeMatch) {
    const afterRange = rest.slice(rangeMatch[0].length)
    const endTok = matchDateTokenAtStart(afterRange)
    if (endTok) {
      const endYear =
        endTok.year !== null
          ? endTok.year
          : endTok.month < startTok.month
            ? startYear + 1
            : startYear
      const candidateEnd = makeDateStr(endYear, endTok.month, endTok.day)
      if (!candidateEnd || candidateEnd < startDate) return null
      endDate = candidateEnd
      const t2 = matchTimeTokenAtStart(endTok.rest)
      if (t2) {
        endTime = t2.time
      }
    } else {
      const t2 = matchTimeTokenAtStart(afterRange)
      if (t2) {
        endTime = t2.time
      }
    }
  }

  return {
    startDate,
    endDate,
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
    canceled: false,
  }
}

interface TableColumnMap {
  dateIdx: number
  titleIdx: number
  roleIdx: number | null
  statusIdx: number | null
}

function mapTableHeaders(headers: string[]): TableColumnMap | null {
  if (headers.length < 2) return null
  const norm = headers.map((h) => stripInlineMarkdown(h).toLowerCase())

  let dateIdx = norm.findIndex((h) => /날짜|일시|기한|기간|date/.test(h))
  if (dateIdx < 0) dateIdx = 0

  let titleIdx = norm.findIndex((h, idx) => idx !== dateIdx && /^(일|일정|제목|내용|할\s*일|title)$/.test(h))
  if (titleIdx < 0) {
    titleIdx = norm.findIndex((h, idx) => idx !== dateIdx && /일정|제목|내용/.test(h))
  }
  if (titleIdx < 0) {
    titleIdx = dateIdx === 0 ? 1 : 0
  }

  const roleIdxFound = norm.findIndex((h, idx) => idx !== dateIdx && idx !== titleIdx && /담당|역할|role|assignee/.test(h))
  const roleIdx = roleIdxFound >= 0 ? roleIdxFound : null

  let statusIdxFound = norm.findIndex((h, idx) => idx !== dateIdx && idx !== titleIdx && /^(상태|status)$/.test(h))
  if (statusIdxFound < 0) {
    statusIdxFound = norm.findIndex((h, idx) => idx !== dateIdx && idx !== titleIdx && /준비\s*상태|진행\s*상태|상태|status/.test(h))
  }
  const statusIdx = statusIdxFound >= 0 ? statusIdxFound : null

  return { dateIdx, titleIdx, roleIdx, statusIdx }
}

function stableCompanyMdId(
  sourceDocPath: string | null,
  startDate: string,
  endDate: string,
  startTime: string | undefined,
  endTime: string | undefined,
  title: string,
): string {
  const key = [sourceDocPath ?? "company.md", startDate, endDate, startTime ?? "", endTime ?? "", title].join("\0")
  const hash = crypto.createHash("sha256").update(key, "utf-8").digest("hex").slice(0, 12)
  return `company:md:${hash}`
}

export function parseCompanyScheduleMarkdown(
  markdown: string,
  opts: {
    sourceDocPath: string | null
    from?: string
    to?: string
    fallbackYear?: number
    includeCanceled?: boolean
  },
): CompanyScheduleItem[] {
  const fallbackYear =
    opts.fallbackYear ??
    (opts.from && isValidDateStr(opts.from) ? Number(opts.from.slice(0, 4)) : new Date().getUTCFullYear())

  const { year: baseYear } = detectDocumentBaseDate(markdown, fallbackYear)
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r?\n/)

  const items: CompanyScheduleItem[] = []
  const seenKeys = new Set<string>()
  let currentSection = ""

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/)
    if (headingMatch) {
      currentSection = stripInlineMarkdown(headingMatch[1])
      i++
      continue
    }

    const headerCells = splitMarkdownRow(line)
    if (headerCells && i + 1 < lines.length) {
      const sepCells = splitMarkdownRow(lines[i + 1])
      if (sepCells && isSeparatorRow(sepCells)) {
        const colMap = mapTableHeaders(headerCells)
        i += 2
        while (i < lines.length) {
          const rowCells = splitMarkdownRow(lines[i])
          if (!rowCells) break
          i++
          if (!colMap) continue

          const rawDateCell = rowCells[colMap.dateIdx] ?? ""
          const rawTitleCell = rowCells[colMap.titleIdx] ?? ""
          if (!rawDateCell || !rawTitleCell) continue

          const titleStruck = isWholeCellStuckThrough(rawTitleCell)
          const dateStruckOnly =
            !titleStruck &&
            /~~[\s\S]*~~/.test(rawDateCell) &&
            parseKoreanDateExpression(rawDateCell, baseYear) === null

          if (titleStruck || dateStruckOnly) {
            if (!opts.includeCanceled) continue
            const canceledParsed = parseKoreanDateExpression(rawDateCell.replace(/~~/g, ""), baseYear)
            if (!canceledParsed) continue
            const cleanTitle = stripInlineMarkdown(rawTitleCell.replace(/~~/g, ""))
            if (!cleanTitle) continue
            if (opts.from && opts.to && (canceledParsed.endDate < opts.from || canceledParsed.startDate > opts.to)) {
              continue
            }
            const role = colMap.roleIdx !== null ? stripInlineMarkdown(rowCells[colMap.roleIdx] ?? "") : ""
            const id = stableCompanyMdId(
              opts.sourceDocPath,
              canceledParsed.startDate,
              canceledParsed.endDate,
              canceledParsed.startTime,
              canceledParsed.endTime,
              cleanTitle,
            )
            items.push({
              id,
              title: cleanTitle,
              startDate: canceledParsed.startDate,
              endDate: canceledParsed.endDate,
              ...(canceledParsed.startTime ? { startTime: canceledParsed.startTime } : {}),
              ...(canceledParsed.endTime ? { endTime: canceledParsed.endTime } : {}),
              ...(role ? { role } : {}),
              status: "canceled",
              sourceDocPath: opts.sourceDocPath,
              kind: "company",
            })
            continue
          }

          const parsedDate = parseKoreanDateExpression(rawDateCell, baseYear)
          if (!parsedDate) continue

          if (opts.from && opts.to && (parsedDate.endDate < opts.from || parsedDate.startDate > opts.to)) {
            continue
          }

          const cleanTitle = stripInlineMarkdown(rawTitleCell)
          if (!cleanTitle) continue

          const role = colMap.roleIdx !== null ? stripInlineMarkdown(rowCells[colMap.roleIdx] ?? "") : ""
          const rawStatus = colMap.statusIdx !== null ? stripInlineMarkdown(rowCells[colMap.statusIdx] ?? "") : ""
          const defaultStatus = /지난/.test(currentSection) ? "완료" : "예정"
          const status = rawStatus || defaultStatus

          const dedupKey = `${parsedDate.startDate}\0${parsedDate.endDate}\0${parsedDate.startTime ?? ""}\0${parsedDate.endTime ?? ""}\0${cleanTitle}`
          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          const id = stableCompanyMdId(
            opts.sourceDocPath,
            parsedDate.startDate,
            parsedDate.endDate,
            parsedDate.startTime,
            parsedDate.endTime,
            cleanTitle,
          )

          items.push({
            id,
            title: cleanTitle,
            startDate: parsedDate.startDate,
            endDate: parsedDate.endDate,
            ...(parsedDate.startTime ? { startTime: parsedDate.startTime } : {}),
            ...(parsedDate.endTime ? { endTime: parsedDate.endTime } : {}),
            ...(role ? { role } : {}),
            status,
            sourceDocPath: opts.sourceDocPath,
            kind: "company",
          })
        }
        continue
      }
    }
    i++
  }

  return items
}

// ── 정기 일정(regular-schedule.yaml) 파서 및 날짜 투영 ──────────────────────

const WEEKDAY_MAP: Record<string, number> = {
  sun: 0,
  sunday: 0,
  일: 0,
  mon: 1,
  monday: 1,
  월: 1,
  tue: 2,
  tuesday: 2,
  화: 2,
  wed: 3,
  wednesday: 3,
  수: 3,
  thu: 4,
  thursday: 4,
  목: 4,
  fri: 5,
  friday: 5,
  금: 5,
  sat: 6,
  saturday: 6,
  토: 6,
}

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"] as const

function normalizeYamlDate(value: unknown): string | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null
    const str = formatUtcDate(value)
    return isValidDateStr(str) ? str : null
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    return isValidDateStr(trimmed) ? trimmed : null
  }
  return null
}

function normalizeYamlTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1440) {
    const h = Math.floor(value / 60)
    const m = value % 60
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
  }
  if (typeof value === "string") {
    const m = value.trim().match(/^(\d{1,2}):(\d{2})$/)
    if (!m) return null
    const h = Number(m[1])
    const mi = Number(m[2])
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`
  }
  return null
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number | "last"): number | null {
  const totalDays = daysInMonth(year, month)
  if (nth === "last") {
    for (let d = totalDays; d >= 1; d--) {
      if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === weekday) return d
    }
    return null
  }
  if (!Number.isInteger(nth) || nth < 1 || nth > 5) return null
  let count = 0
  for (let d = 1; d <= totalDays; d++) {
    if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === weekday) {
      count++
      if (count === nth) return d
    }
  }
  return null
}

function enumerateRangeDates(from: string, to: string): string[] {
  const span = daysBetween(from, to)
  const out: string[] = []
  for (let i = 0; i <= span; i++) {
    out.push(addDays(from, i))
  }
  return out
}

function enumerateMonthsInRange(from: string, to: string): Array<{ year: number; month: number }> {
  const [fy, fm] = from.split("-").map(Number)
  const [ty, tm] = to.split("-").map(Number)
  const months: Array<{ year: number; month: number }> = []
  let y = fy
  let m = fm
  while (y < ty || (y === ty && m <= tm)) {
    months.push({ year: y, month: m })
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return months
}

function projectRepeatDates(
  repeatRaw: unknown,
  hasExplicitTime: boolean,
  from: string,
  to: string,
): { dates: string[]; repeatSummary: string; isDaily: boolean } {
  if (!repeatRaw || typeof repeatRaw !== "object" || Array.isArray(repeatRaw)) {
    if (hasExplicitTime) {
      return { dates: enumerateRangeDates(from, to), repeatSummary: "매일", isDaily: true }
    }
    return { dates: [], repeatSummary: "", isDaily: false }
  }

  const repeat = repeatRaw as Record<string, unknown>

  if (repeat.once !== undefined) {
    const onceDate = normalizeYamlDate(repeat.once)
    if (!onceDate || onceDate < from || onceDate > to) {
      return { dates: [], repeatSummary: "1회", isDaily: false }
    }
    return { dates: [onceDate], repeatSummary: `1회 (${onceDate})`, isDaily: false }
  }

  const every = typeof repeat.every === "string" ? repeat.every.trim().toLowerCase() : ""

  if (every === "day") {
    return { dates: enumerateRangeDates(from, to), repeatSummary: "매일", isDaily: true }
  }

  if (every === "week") {
    if (!Array.isArray(repeat.days) || repeat.days.length === 0) {
      return { dates: [], repeatSummary: "매주(요일 미정)", isDaily: false }
    }
    const weekdays = new Set<number>()
    for (const rawDay of repeat.days) {
      if (typeof rawDay !== "string") continue
      const dow = WEEKDAY_MAP[rawDay.trim().toLowerCase()]
      if (dow !== undefined) weekdays.add(dow)
    }
    if (weekdays.size === 0) return { dates: [], repeatSummary: "", isDaily: false }
    const dates = enumerateRangeDates(from, to).filter((d) => {
      const [y, m, day] = d.split("-").map(Number)
      return weekdays.has(new Date(Date.UTC(y, m - 1, day)).getUTCDay())
    })
    const dayLabels = Array.from(weekdays)
      .sort((a, b) => a - b)
      .map((d) => WEEKDAY_KO[d])
      .join("·")
    return { dates, repeatSummary: `매주 ${dayLabels}`, isDaily: false }
  }

  if (every === "month") {
    const months = enumerateMonthsInRange(from, to)
    const matched: string[] = []

    if (repeat.day === "last") {
      for (const { year, month } of months) {
        const d = daysInMonth(year, month)
        const dateStr = makeDateStr(year, month, d)
        if (dateStr && dateStr >= from && dateStr <= to) matched.push(dateStr)
      }
      return { dates: matched, repeatSummary: "매월 말일", isDaily: false }
    }

    if (typeof repeat.day === "number" && Number.isInteger(repeat.day) && repeat.day >= 1 && repeat.day <= 31) {
      for (const { year, month } of months) {
        const dateStr = makeDateStr(year, month, repeat.day)
        if (dateStr && dateStr >= from && dateStr <= to) matched.push(dateStr)
      }
      return { dates: matched, repeatSummary: `매월 ${repeat.day}일`, isDaily: false }
    }

    if (repeat.nth !== undefined && typeof repeat.weekday === "string") {
      const dow = WEEKDAY_MAP[repeat.weekday.trim().toLowerCase()]
      const nth = repeat.nth === "last" ? "last" : typeof repeat.nth === "number" ? repeat.nth : NaN
      if (dow === undefined || (nth !== "last" && !Number.isInteger(nth))) {
        return { dates: [], repeatSummary: "", isDaily: false }
      }
      for (const { year, month } of months) {
        const d = nthWeekdayOfMonth(year, month, dow, nth)
        if (d === null) continue
        const dateStr = makeDateStr(year, month, d)
        if (dateStr && dateStr >= from && dateStr <= to) matched.push(dateStr)
      }
      const nthLabel = nth === "last" ? "마지막" : `${nth}번째`
      return { dates: matched, repeatSummary: `매월 ${nthLabel} ${WEEKDAY_KO[dow]}요일`, isDaily: false }
    }

    if (typeof repeat.week === "number" && Number.isInteger(repeat.week) && repeat.week >= 1 && repeat.week <= 5) {
      for (const { year, month } of months) {
        const d = nthWeekdayOfMonth(year, month, 1, repeat.week)
        if (d === null) continue
        const dateStr = makeDateStr(year, month, d)
        if (dateStr && dateStr >= from && dateStr <= to) matched.push(dateStr)
      }
      return { dates: matched, repeatSummary: `매월 ${repeat.week}주차 월요일`, isDaily: false }
    }

    return { dates: [], repeatSummary: "매월(날 미정)", isDaily: false }
  }

  if (every === "quarter") {
    const startFrom = normalizeYamlDate(repeat.from)
    if (!startFrom) return { dates: [], repeatSummary: "분기마다(날 미정)", isDaily: false }
    const [sy, sm, sd] = startFrom.split("-").map(Number)
    const dates: string[] = []
    for (let k = 0; k < 200; k++) {
      const totalMonths = sy * 12 + (sm - 1) + k * 3
      const y = Math.floor(totalMonths / 12)
      const m = (totalMonths % 12) + 1
      const d = Math.min(sd, daysInMonth(y, m))
      const dateStr = makeDateStr(y, m, d)
      if (!dateStr) break
      if (dateStr > to) break
      if (dateStr >= from) dates.push(dateStr)
    }
    return { dates, repeatSummary: "분기마다", isDaily: false }
  }

  return { dates: [], repeatSummary: "", isDaily: false }
}

function sanitizeRegItemId(rawId: string): string {
  const trimmed = rawId.trim()
  const cleaned = trimmed.replace(/[^A-Za-z0-9._\-가-힣]/g, "-")
  return cleaned || "item"
}

export function parseRegularScheduleYaml(
  yamlText: string,
  opts: {
    sourceDocPath: string | null
    from: string
    to: string
    allowedStates?: readonly string[]
  },
): CompanyScheduleItem[] {
  const clamped = clampDateRange(opts.from, opts.to)
  if (!clamped.ok) return []
  const { from, to } = clamped

  let parsed: unknown
  try {
    parsed = yamlEngine.parse(yamlText)
  } catch {
    return []
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
  const doc = parsed as Record<string, unknown>

  const roleLabels = new Map<string, string>()
  if (doc.roles && typeof doc.roles === "object" && !Array.isArray(doc.roles)) {
    for (const [roleId, roleMeta] of Object.entries(doc.roles as Record<string, unknown>)) {
      if (roleMeta && typeof roleMeta === "object" && typeof (roleMeta as Record<string, unknown>).label === "string") {
        roleLabels.set(roleId, ((roleMeta as Record<string, unknown>).label as string).trim())
      }
    }
  }

  const rawItems = Array.isArray(doc.items) ? doc.items : []
  const allowedStates = new Set(opts.allowedStates ?? DEFAULT_ALLOWED_REGULAR_STATES)
  const out: CompanyScheduleItem[] = []

  for (const rawEntry of rawItems) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue
    const entry = rawEntry as Record<string, unknown>

    const rawId = typeof entry.id === "string" ? entry.id.trim() : ""
    const title = typeof entry.title === "string" ? entry.title.trim() : ""
    const state = typeof entry.state === "string" ? entry.state.trim() : ""
    if (!rawId || !title || !allowedStates.has(state)) continue

    const timesList: string[] = []
    if (Array.isArray(entry.times)) {
      for (const t of entry.times) {
        const norm = normalizeYamlTime(t)
        if (norm) timesList.push(norm)
      }
    }
    const singleTime = normalizeYamlTime(entry.time)
    if (singleTime && !timesList.includes(singleTime)) {
      timesList.unshift(singleTime)
    }

    const hasTimeOrRepeat = timesList.length > 0 || entry.repeat !== undefined
    if (!hasTimeOrRepeat) continue

    const projection = projectRepeatDates(entry.repeat, timesList.length > 0, from, to)
    if (projection.dates.length === 0) continue

    const role = typeof entry.role === "string" ? entry.role.trim() : ""
    const roleLabel = role ? roleLabels.get(role) : undefined
    const safeId = sanitizeRegItemId(rawId)
    const startTime = timesList[0]

    for (const dateStr of projection.dates) {
      out.push({
        id: `company:reg:${safeId}:${dateStr}`,
        title,
        startDate: dateStr,
        endDate: dateStr,
        ...(startTime ? { startTime } : {}),
        ...(timesList.length > 1 ? { times: timesList } : {}),
        ...(role ? { role } : {}),
        ...(roleLabel ? { roleLabel } : {}),
        status: state,
        state,
        sourceDocPath: opts.sourceDocPath,
        kind: "regular",
        ...(projection.repeatSummary ? { repeatSummary: projection.repeatSummary } : {}),
        ...(projection.isDaily ? { isDaily: true } : {}),
      })
    }
  }

  return out
}

export function parseStatesQueryParam(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined
  const states = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => ALL_KNOWN_REGULAR_STATES.has(s))
  return states.length > 0 ? states : undefined
}

export function readCompanySchedules(options: ReadCompanyScheduleOptions): CompanyScheduleResponse {
  const env = options.env ?? process.env
  const range = clampDateRange(options.from, options.to, options.today)
  if (!range.ok) {
    throw new Error(range.error)
  }

  const companyDoc = resolveAndReadSource(
    options.adkRoot,
    env.NAIA_COMPANY_SCHEDULE_FILE,
    DEFAULT_COMPANY_SCHEDULE_CANDIDATES,
    [".md"],
  )

  const regularDoc = resolveAndReadSource(
    options.adkRoot,
    env.NAIA_REGULAR_SCHEDULE_FILE,
    DEFAULT_REGULAR_SCHEDULE_CANDIDATES,
    [".yaml", ".yml"],
  )

  const mdItems = companyDoc
    ? parseCompanyScheduleMarkdown(companyDoc.content, {
        sourceDocPath: companyDoc.sourceDocPath,
        from: range.from,
        to: range.to,
        fallbackYear: Number(range.from.slice(0, 4)),
        includeCanceled: options.includeCanceled,
      })
    : []

  const regItems = regularDoc
    ? parseRegularScheduleYaml(regularDoc.content, {
        sourceDocPath: regularDoc.sourceDocPath,
        from: range.from,
        to: range.to,
        allowedStates: options.allowedRegularStates,
      })
    : []

  const items = [...mdItems, ...regItems].sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) ||
      (a.startTime ?? "").localeCompare(b.startTime ?? "") ||
      a.kind.localeCompare(b.kind) ||
      a.title.localeCompare(b.title, "ko"),
  )

  return {
    from: range.from,
    to: range.to,
    items,
    sources: {
      companyDocPath: companyDoc?.sourceDocPath ?? null,
      regularDocPath: regularDoc?.sourceDocPath ?? null,
    },
  }
}
