// 나이아 워크스페이스 문서 화면 상호작용 핸들러 및 데이터 준비 모듈 (UI1c)

import {
  inferKindFromPath,
  MSG_CONFIRM_DISCARD,
  MSG_FORBIDDEN,
  type FileKind,
  type FolderGridEntry,
} from "./kinds"
import { type DocTab } from "./tabs"
import { type Source, type TreeNode } from "./DocsView"

export interface DocsViewState {
  activeTab: DocTab
  currentSource: string | null
  currentPath: string | null
  viewMode: "grid" | "doc" | "file"
  folderData: { entries: FolderGridEntry[]; total: number; truncated: boolean } | null
  docContent: string | null
  docBaseHash: string
  docLoading: boolean
  docError: string | null
  fileData: { kind?: FileKind; size?: number; textContent?: string | null; textTruncated?: boolean } | null
  forbidden: boolean
}

// 트리에서 특정 경로의 노드 탐색
function findNodeByPath(nodes: TreeNode[], targetPath: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === targetPath) return node
    if (node.children) {
      const found = findNodeByPath(node.children, targetPath)
      if (found) return found
    }
  }
  return null
}

// ── 1. 페이지 데이터 준비 함수 (검수 반영 2·3번) ──────────────────────
export async function loadDocsViewState(params: {
  tab: DocTab
  source: string | null
  path: string | null
  sources: Source[]
  fetchFn?: typeof fetch
}): Promise<DocsViewState> {
  const { tab, source, path, sources } = params
  const fetcher = params.fetchFn ?? fetch

  const state: DocsViewState = {
    activeTab: tab,
    currentSource: source,
    currentPath: path,
    viewMode: "doc",
    folderData: null,
    docContent: null,
    docBaseHash: "",
    docLoading: false,
    docError: null,
    fileData: null,
    forbidden: false,
  }

  if (!source) {
    return state
  }

  const currentSourceObj = sources.find((s) => s.id === source)
  const tree = currentSourceObj?.tree ?? []

  // 출처 루트 (path가 없거나 "")인 경우 -> 항상 격자(grid)
  if (!path || path.trim() === "") {
    state.viewMode = "grid"
    try {
      const res = await fetcher(`/api/portal/folder?source=${encodeURIComponent(source)}&path=`)
      if (res.status === 403) state.forbidden = true
      if (res.ok) {
        const data = await res.json()
        state.folderData = {
          entries: data.entries || [],
          total: data.total ?? (data.entries || []).length,
          truncated: Boolean(data.truncated),
        }
      }
    } catch {}
    return state
  }

  // 트리에서 해당 경로 탐색
  const treeNode = findNodeByPath(tree, path)

  if (treeNode) {
    if (treeNode.type === "directory") {
      state.viewMode = "grid"
      try {
        const res = await fetcher(`/api/portal/folder?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`)
        if (res.status === 403) state.forbidden = true
        if (res.ok) {
          const data = await res.json()
          state.folderData = {
            entries: data.entries || [],
            total: data.total ?? (data.entries || []).length,
            truncated: Boolean(data.truncated),
          }
        }
      } catch {}
      return state
    }

    // 파일인 경우
    const kind: FileKind = (treeNode.kind as FileKind) || inferKindFromPath(path)
    if (kind === "doc" || path.toLowerCase().endsWith(".md")) {
      state.viewMode = "doc"
      try {
        const res = await fetcher(`/api/portal/doc?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`)
        if (res.status === 403) {
          state.forbidden = true
          state.docError = MSG_FORBIDDEN
        } else if (res.ok) {
          const etag = res.headers.get("etag")?.replace(/^"(.*)"$/, "$1") ?? ""
          state.docBaseHash = etag
          state.docContent = await res.text()
        } else {
          state.docError = `문서를 찾을 수 없습니다 (${res.status})`
        }
      } catch (err: any) {
        state.docError = err?.message || "문서를 불러오지 못했습니다"
      }
      return state
    }

    // 그 밖의 파일
    state.viewMode = "file"
    const size = treeNode.size
    if (kind === "text") {
      try {
        const res = await fetcher(`/api/portal/text?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`)
        if (res.status === 403) state.forbidden = true
        if (res.ok) {
          const data = await res.json()
          state.fileData = {
            kind,
            size,
            textContent: data.content,
            textTruncated: Boolean(data.truncated),
          }
        } else {
          state.fileData = { kind, size, textContent: null }
        }
      } catch {
        state.fileData = { kind, size, textContent: null }
      }
    } else {
      state.fileData = { kind, size }
    }
    return state
  }

  // ── 트리에 노드가 없는 경우 (빈 폴더 v1.2, 500개 초과 잘린 파일 등) ──────
  // 검수 3번 대체: 트리에 없는 경로에서 /folder가 403이면
  // - 확장자가 .md면 GET /doc으로 문서를 연다(GET /doc이 403일 때만 SP-06 문장)
  // - 그림 확장자면 파일 보기로 연다(/asset)
  // - 그 밖(확장자 없음 등 폴더로 볼 경로)만 격자 자리에 SP-06 한 줄. 기타 파일 보기로는 넘기지 않는다.
  try {
    const folderRes = await fetcher(`/api/portal/folder?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`)
    if (folderRes.status === 200) {
      state.viewMode = "grid"
      const data = await folderRes.json()
      state.folderData = {
        entries: data.entries || [],
        total: data.total ?? (data.entries || []).length,
        truncated: Boolean(data.truncated),
      }
      return state
    }
    if (folderRes.status === 403) {
      const fileKind = inferKindFromPath(path)
      if (fileKind === "doc" || path.toLowerCase().endsWith(".md")) {
        state.viewMode = "doc"
        try {
          const res = await fetcher(`/api/portal/doc?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`)
          if (res.status === 403) {
            state.forbidden = true
            state.docError = MSG_FORBIDDEN
          } else if (res.ok) {
            const etag = res.headers.get("etag")?.replace(/^"(.*)"$/, "$1") ?? ""
            state.docBaseHash = etag
            state.docContent = await res.text()
          } else {
            state.docError = `문서를 찾을 수 없습니다 (${res.status})`
          }
        } catch (err: any) {
          state.docError = err?.message || "문서를 불러오지 못했습니다"
        }
        return state
      }

      if (fileKind === "image") {
        state.viewMode = "file"
        state.fileData = { kind: "image" }
        return state
      }

      state.viewMode = "grid"
      state.forbidden = true
      state.folderData = { entries: [], total: 0, truncated: false }
      return state
    }
  } catch {}

  // 404이거나 폴더가 아닌 경우 파일/문서로 판정
  const fileKind = inferKindFromPath(path)
  if (fileKind === "doc" || path.toLowerCase().endsWith(".md")) {
    state.viewMode = "doc"
    try {
      const res = await fetcher(`/api/portal/doc?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`)
      if (res.status === 403) {
        state.forbidden = true
        state.docError = MSG_FORBIDDEN
      } else if (res.ok) {
        const etag = res.headers.get("etag")?.replace(/^"(.*)"$/, "$1") ?? ""
        state.docBaseHash = etag
        state.docContent = await res.text()
      } else {
        state.docError = `문서를 찾을 수 없습니다 (${res.status})`
      }
    } catch (err: any) {
      state.docError = err?.message || "문서를 불러오지 못했습니다"
    }
    return state
  }

  state.viewMode = "file"
  let size: number | undefined = undefined

  // 부모 경로의 /folder 항목에서 크기 조회 시도 (2번 보강: 루트 파일도 부모 path=""로 조회)
  const segments = path.split("/").filter(Boolean)
  const parentPath = segments.length > 1 ? segments.slice(0, -1).join("/") : ""
  try {
    const parentRes = await fetcher(`/api/portal/folder?source=${encodeURIComponent(source)}&path=${encodeURIComponent(parentPath)}`)
    if (parentRes.ok) {
      const pData = await parentRes.json()
      const fileName = segments[segments.length - 1]
      const entry = (pData.entries || []).find((e: FolderGridEntry) => e.path === path || e.name === path || e.name === fileName)
      if (entry && typeof entry.size === "number") {
        size = entry.size
      }
    }
  } catch {}

  if (fileKind === "text") {
    try {
      const res = await fetcher(`/api/portal/text?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`)
      if (res.status === 403) state.forbidden = true
      if (res.ok) {
        const data = await res.json()
        state.fileData = {
          kind: fileKind,
          size,
          textContent: data.content,
          textTruncated: Boolean(data.truncated),
        }
      } else {
        state.fileData = { kind: fileKind, size, textContent: null }
      }
    } catch {
      state.fileData = { kind: fileKind, size, textContent: null }
    }
  } else {
    state.fileData = { kind: fileKind, size }
  }

  return state
}

// ── 2. 이동 확인 도우미 함수 (더러운 편집 상태에서 이동 시 MSG_CONFIRM_DISCARD) ──
export function canNavigateWithDiscardConfirm(params: {
  isDirty: boolean
  targetHref: string
  confirmFn?: (message: string) => boolean
  navigateFn?: (url: string) => void
}): boolean {
  if (params.isDirty) {
    const confirmer = params.confirmFn ?? (typeof window !== "undefined" ? window.confirm : () => true)
    const ok = confirmer(MSG_CONFIRM_DISCARD)
    if (!ok) return false
  }
  if (params.navigateFn) {
    params.navigateFn(params.targetHref)
  }
  return true
}
