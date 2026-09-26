// 나이아 워크스페이스 문서 화면 공용 도우미 및 순수 함수 (SP-01 ~ SP-06, FE 9장)

export type FileKind = "doc" | "image" | "video" | "audio" | "pdf" | "text" | "other"

export interface FolderGridEntry {
  name: string
  path: string
  type: "directory" | "file"
  kind?: FileKind
  size?: number
  cover?: string
}

export interface DocNoteItem {
  id: string
  source: string
  path: string
  quote: string | null
  body: string
  status: "open" | "resolved"
  reply: string | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export interface FavoriteItem {
  source: string
  path: string
  type: "file" | "directory"
  addedAt: string
  exists?: boolean
}

export interface BreadcrumbItem {
  name: string
  path: string
}

// ── 고정 화면 문구 (SP, 검수 반영) ──────────────────────────────────────────
export const MSG_TRUNCATED_GRID = "500개까지만 보입니다"
export const MSG_TRUNCATED_TEXT = "앞 1MB만 보입니다"
export const MSG_FORBIDDEN = "이 주소에서는 문서만 볼 수 있습니다"
export const MSG_CONFLICT_DOC = "편집을 연 뒤 이 문서가 바뀌었습니다. 쓰신 글은 그대로 두었으니 복사해 두고 새로 고쳐 주세요."
export const MSG_SAVED_DOC = "저장했습니다. 아직 저장소에는 올리지 않았습니다."
export const MSG_ARCHIVED_DOC = "보관 문서입니다"
export const MSG_UNSUPPORTED_PREVIEW = "미리 볼 수 없는 파일입니다"
export const MSG_CONFIRM_DISCARD = "고친 내용이 사라집니다. 나갈까요?"
export const MSG_FAVORITES_INVALID = "즐겨찾기 파일을 읽을 수 없어 바꾸지 않았습니다"
export const MSG_RETRY_LATER = "잠시 뒤 다시 해 주세요"
export const MSG_FAVORITES_LIMIT = "즐겨찾기는 200개까지입니다"
export const MSG_READ_ONLY = "보기 전용"
export const MSG_NOT_FOUND = "찾을 수 없음"
export const MSG_QUOTE_WHOLE_DOC = "문서 전체"

export function getOpenNotesBannerText(count: number): string {
  return `열린 메모 ${count}건 · AI에게 '메모 처리해'라고 말하면 처리합니다`
}

// ── 파일 종류 판정 ──────────────────────────────────────────────────────────
const KIND_EXT_MAP: Record<string, FileKind> = {
  md: "doc",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  avif: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  m4v: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  m4a: "audio",
  flac: "audio",
  pdf: "pdf",
  json: "text",
  yaml: "text",
  yml: "text",
  txt: "text",
  csv: "text",
  log: "text",
  toml: "text",
}

export function inferKindFromPath(path: string, serverKind?: string): FileKind {
  if (serverKind && serverKind in { doc: 1, image: 1, video: 1, audio: 1, pdf: 1, text: 1, other: 1 }) {
    return serverKind as FileKind
  }
  const clean = path.split("?")[0].split("#")[0]
  const ext = clean.split(".").pop()?.toLowerCase() ?? ""
  return KIND_EXT_MAP[ext] ?? "other"
}

export const MSG_READ_ONLY_DOC = "이 출처는 보기 전용이라 문서를 고칠 수 없습니다"

// ── 파일 크기 사람 단위 변환 (SP-03) ─────────────────────────────────────────
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || isNaN(bytes) || bytes < 0) return ""
  if (bytes === 0) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let val = bytes
  let u = -1
  while (val >= 1024 && u < units.length - 1) {
    val /= 1024
    u++
  }
  const formatted = val >= 10 || Number.isInteger(val) ? val.toFixed(0) : val.toFixed(1)
  return `${formatted} ${units[u]}`
}

// ── 인용 문자열 자르기 (SP-05, 최대 2000자) ─────────────────────────────────
export function truncateQuote(text: string | null | undefined, maxLength = 2000): string {
  if (!text) return ""
  return text.slice(0, maxLength)
}

export function formatDimensions(width?: number | null, height?: number | null): string | null {
  if (!width || !height) return null
  return `${width}×${height}`
}

// ── 격자 항목 정렬 및 500개 자르기 (SP-02) ──────────────────────────────────
export function sortGridEntries(entries: FolderGridEntry[]): FolderGridEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1
    }
    return a.name.localeCompare(b.name, "ko")
  })
}

export function limitGridEntries(
  entries: FolderGridEntry[],
  limit = 500,
): { entries: FolderGridEntry[]; truncated: boolean; total: number } {
  const sorted = sortGridEntries(entries)
  const total = sorted.length
  if (total <= limit) {
    return { entries: sorted, truncated: false, total }
  }
  return { entries: sorted.slice(0, limit), truncated: true, total }
}

// ── 메모 정렬 (SP-05, 열린 것 먼저, 최신 순) ─────────────────────────────────
export function sortNotes(notes: DocNoteItem[]): DocNoteItem[] {
  return [...notes].sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === "open" ? -1 : 1
    }
    const tA = new Date(a.createdAt).getTime() || 0
    const tB = new Date(b.createdAt).getTime() || 0
    return tB - tA
  })
}

// ── 즐겨찾기 없어진 항목 판정 (SP-01, RQ-07) ────────────────────────────────
export function isFavoriteMissing(item: { exists?: boolean }): boolean {
  return item.exists === false
}

// ── 편집 가능 여부 판정 (SP-04, RQ-05) ──────────────────────────────────────
export function canEditDoc(sourceId: string | null | undefined, readOnly?: boolean, missing?: boolean): boolean {
  if (!sourceId) return false
  if (missing) return false
  if (readOnly) return false
  if (sourceId.startsWith("data:")) return false
  return true
}

// ── 주소 및 노드 정보에서 보기 종류 결정 (FE 9장) ───────────────────────────
export function determineDocViewMode(params: {
  path: string | null
  type?: "directory" | "file"
  kind?: FileKind
}): "grid" | "doc" | "file" {
  const { path, type, kind } = params
  if (!path || path.trim() === "" || type === "directory") {
    return "grid"
  }
  if (kind === "doc" || (!kind && path.toLowerCase().endsWith(".md"))) {
    return "doc"
  }
  return "file"
}

// ── 오류 문구 매핑 (검수 반영 6번) ──────────────────────────────────────────
export function mapDocSaveError(status: number, data?: { error?: string }): string {
  if (status === 409 && data?.error === "changed") {
    return MSG_CONFLICT_DOC
  }
  if (status === 403) {
    if (data?.error === "Source is read-only") {
      return MSG_READ_ONLY_DOC
    }
    return MSG_FORBIDDEN
  }
  return "문서를 저장하지 못했습니다. 다시 시도해 주세요."
}

export function mapFavoritesError(status: number, data?: { error?: string }): string {
  if (status === 403) {
    return MSG_FORBIDDEN
  }
  if (status === 409) {
    if (data?.error === "favorites_file_invalid") {
      return MSG_FAVORITES_INVALID
    }
    return MSG_RETRY_LATER
  }
  if (status === 400) {
    if (data?.error === "Favorites limit reached (200)") {
      return MSG_FAVORITES_LIMIT
    }
    return "즐겨찾기를 변경하지 못했습니다. 다시 시도해 주세요."
  }
  return "즐겨찾기를 변경하지 못했습니다. 다시 시도해 주세요."
}

export function mapNotesError(status: number, data?: { error?: string }): string {
  if (status === 403) {
    return MSG_FORBIDDEN
  }
  if (status === 409) {
    return MSG_RETRY_LATER
  }
  return "메모를 처리하지 못했습니다. 다시 시도해 주세요."
}

// ── 경로 도우미 ─────────────────────────────────────────────────────────────
export function getFileName(path: string): string {
  if (!path) return ""
  const segments = path.split("/").filter(Boolean)
  return segments[segments.length - 1] || path
}

export function createBreadcrumbs(sourceTitle: string, path: string): BreadcrumbItem[] {
  const crumbs: BreadcrumbItem[] = [{ name: sourceTitle, path: "" }]
  if (!path) return crumbs
  const segments = path.split("/").filter(Boolean)
  let accumulated = ""
  for (const seg of segments) {
    accumulated = accumulated ? `${accumulated}/${seg}` : seg
    crumbs.push({ name: seg, path: accumulated })
  }
  return crumbs
}

// ── JSON 들여쓰기 (SP-03) ───────────────────────────────────────────────────
export function formatJsonIfPossible(raw: string): string {
  try {
    const obj = JSON.parse(raw)
    return JSON.stringify(obj, null, 2)
  } catch {
    return raw
  }
}

// ── 화면 텍스트 안전성 검사 (화면 글 규칙: 경로·명령어·API 이름·해시 없음) ────
export function isSafeVisibleText(text: string): boolean {
  // 1. API 경로 (/api/portal...)
  if (/\/api\/[a-zA-Z0-9_\-\/]+/.test(text)) {
    return false
  }
  // 2. 64자리 SHA256 해시
  if (/\b[a-f0-9]{64}\b/i.test(text)) {
    return false
  }
  // 3. 파일 시스템 절대 경로 (/var/home, /run/user, /tmp/... 등)
  if (/(?:^|\s)(\/(?:var|home|usr|etc|opt|tmp|run|root)\/[^\s]+)/.test(text)) {
    return false
  }
  return true
}
