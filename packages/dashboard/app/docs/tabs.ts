// 문서 화면을 [공통] [브랜드·마케팅] [개발자] 세 탭으로 나눈다. 공통이 맨 앞이고 기본 탭이다.
// ADK 문서(docs/)는 폴더가 곧 탭이다: docs/common/, docs/brand-marketing/, docs/developer/.
// 회사 문서와 연계 저장소 문서의 탭 규칙은 쓰는 쪽(포크)이 아래 규칙표에 더해 나눈다.
// 규칙은 경로 앞부분(폴더 또는 파일)으로 적고, 가장 길게 맞는 규칙이 이긴다.
// 공통 문서는 공통 탭에만 보이고 직군 탭에 겹쳐 보이지 않는다.
// 규칙에 걸리지 않는 문서는 숨기지 않고 개발자 탭 끝의 [분류 안 됨]에 보인다.

import type { DocTreeNode } from "./markdown.ts"

export type DocTab = "common" | "brand" | "developer"
export type DocTabRule = DocTab

export const DEFAULT_DOC_TAB: DocTab = "common"

export const DOC_TABS: Array<{ id: DocTab; label: string }> = [
  { id: "common", label: "공통" },
  { id: "brand", label: "브랜드·마케팅" },
  { id: "developer", label: "개발자" },
]

// source id → (경로 앞부분 → 탭)
export const DOC_TAB_RULES: Record<string, Record<string, DocTabRule>> = {
  adk: {
    common: "common",
    "brand-marketing": "brand",
    developer: "developer",
    // 첫 화면이자 전체 색인이라 공통 탭에 보인다(VitePress 첫 화면이라 docs 바로 아래에 둔다).
    "index.md": "common",
  },
  // 회사 문서(company:<이름>)와 연계 저장소 문서의 탭 규칙은 쓰는 쪽(포크)이 이 표에 더한다. 규칙이 없는 문서는 개발자 탭의 [분류 안 됨]에 보인다.
}

export function isDocTab(value: string | null | undefined): value is DocTab {
  return value === "common" || value === "brand" || value === "developer"
}

// 문서 하나가 어느 탭에 속하는지. data: 출처는 폴더의 tab(없으면 common), 일반 규칙에 없으면 null(분류 안 됨).
export function classifyDoc(
  sourceId: string,
  docPath: string,
  rules: Record<string, Record<string, DocTabRule>> = DOC_TAB_RULES,
  sourceTab?: DocTab,
): DocTabRule | null {
  if (sourceId.startsWith("data:")) {
    return isDocTab(sourceTab) ? sourceTab : "common"
  }
  const table = rules[sourceId]
  if (!table) return null
  let best: string | null = null
  for (const prefix of Object.keys(table)) {
    const clean = prefix.replace(/\/+$/, "")
    if (docPath === clean || docPath.startsWith(`${clean}/`)) {
      if (best === null || clean.length > best.length) best = clean
    }
  }
  return best === null ? null : table[best] ?? null
}

// 트리에서 조건에 맞는 항목을 남긴다. 자식이 하나도 안 남는 폴더는 뺀다.
// 문서가 아닌 파일도 탭에 맞는 파일이면 남긴다 (RQ-01 AC1).
export function pruneTree(tree: DocTreeNode[], keep: (path: string) => boolean): DocTreeNode[] {
  const out: DocTreeNode[] = []
  for (const node of tree) {
    if (node.type === "file") {
      if (keep(node.path)) out.push(node)
    } else {
      const children = pruneTree(node.children ?? [], keep)
      if (children.length > 0) out.push({ ...node, children })
    }
  }
  return out
}

export interface TabSourceItem {
  id: string
  title: string
  tree: DocTreeNode[]
  tab?: DocTab
  missing?: boolean
  readOnly?: boolean
}

export interface TabSection {
  sourceId: string
  title: string
  tree: DocTreeNode[]
  unclassified: boolean
  missing?: boolean
  readOnly?: boolean
}

// 한 탭에 보일 구역들. 출처 순서는 받은 순서를 따른다.
// 개발자 탭 끝에는 어느 규칙에도 걸리지 않은 문서를 [분류 안 됨] 구역으로 붙인다.
// missing: true 출처는 트리가 비어 있어도 해당 탭에 남긴다 (RQ-04 AC4).
export function sectionsForTab(
  sources: TabSourceItem[],
  tab: DocTab,
  rules: Record<string, Record<string, DocTabRule>> = DOC_TAB_RULES,
): TabSection[] {
  const sections: TabSection[] = []
  for (const source of sources) {
    const isData = source.id.startsWith("data:")
    const sTab: DocTab = isData ? (isDocTab(source.tab) ? source.tab : "common") : "common"
    const tree = orderArchiveLast(
      pruneTree(source.tree, (p) => classifyDoc(source.id, p, rules, isData ? sTab : undefined) === tab),
    )
    const matchesTab = isData ? sTab === tab : tab === "common"
    if (tree.length > 0 || (source.missing && matchesTab)) {
      sections.push({
        sourceId: source.id,
        title: source.title,
        tree,
        unclassified: false,
        ...(source.missing ? { missing: true } : {}),
        ...(source.readOnly ? { readOnly: true } : {}),
      })
    }
  }
  if (tab === "developer") {
    for (const source of sources) {
      if (source.id.startsWith("data:")) continue
      const tree = orderArchiveLast(pruneTree(source.tree, (p) => classifyDoc(source.id, p, rules) === null))
      if (tree.length > 0) {
        sections.push({
          sourceId: source.id,
          title: `[분류 안 됨] ${source.title}`,
          tree,
          unclassified: true,
          ...(source.readOnly ? { readOnly: true } : {}),
        })
      }
    }
  }
  return sections
}

// 문서가 목록에 보이는 탭. 분류 안 된 문서는 개발자 탭 끝에 보이므로 개발자 탭이다.
export function tabOfDoc(
  sourceId: string,
  docPath: string,
  rules: Record<string, Record<string, DocTabRule>> = DOC_TAB_RULES,
  sourceTab?: DocTab,
): { tab: DocTab; unclassified: boolean } {
  const rule = classifyDoc(sourceId, docPath, rules, sourceTab)
  return rule === null ? { tab: "developer", unclassified: true } : { tab: rule, unclassified: false }
}

// 주소에 탭이 없을 때(옛 링크) 문서에서 탭을 정한다. 문서가 없으면 기본 탭(공통).
export function inferTab(
  sourceId: string | null,
  docPath: string | null,
  fallback: DocTab = DEFAULT_DOC_TAB,
  rules: Record<string, Record<string, DocTabRule>> = DOC_TAB_RULES,
  sourceTab?: DocTab,
): DocTab {
  if (!sourceId || !docPath) return fallback
  return tabOfDoc(sourceId, docPath, rules, sourceTab).tab
}

// 화면(page.tsx)에서 사용할 activeTab 계산 함수
// 주소의 tab, source, path와 포털 출처 목록을 받아 활성 탭을 계산한다.
export function computeActiveTab(
  tabParam: string | null,
  sourceParam: string | null,
  pathParam: string | null,
  sources: Array<{ id: string; tab?: DocTab }> = [],
  rules: Record<string, Record<string, DocTabRule>> = DOC_TAB_RULES,
): DocTab {
  if (isDocTab(tabParam) && sources.length === 0) {
    return tabParam
  }
  const sourceTab = sources.find((s) => s.id === sourceParam)?.tab
  if (
    isDocTab(tabParam) &&
    (!sourceParam || !pathParam || docVisibleInTab(sourceParam, pathParam, tabParam, rules, sourceTab))
  ) {
    return tabParam
  }
  return inferTab(sourceParam, pathParam, DEFAULT_DOC_TAB, rules, sourceTab)
}

// 탭 이름(검색 결과에 붙인다).
export function tabLabel(tab: DocTab): string {
  return DOC_TABS.find((t) => t.id === tab)?.label ?? tab
}

// 이 문서가 그 탭에 보이는지(분류 안 됨은 개발자 탭에 보인다).
export function docVisibleInTab(
  sourceId: string,
  docPath: string,
  tab: DocTab,
  rules: Record<string, Record<string, DocTabRule>> = DOC_TAB_RULES,
  sourceTab?: DocTab,
): boolean {
  return tabOfDoc(sourceId, docPath, rules, sourceTab).tab === tab
}

// 문서 주소. 탭을 함께 남겨 새로고침·공유해도 같은 탭이 열린다.
export function docHref(tab: DocTab, sourceId?: string | null, docPath?: string | null): string {
  const base = `/docs?tab=${tab}`
  if (!sourceId) return base
  if (!docPath || docPath.trim() === "") return `${base}&source=${encodeURIComponent(sourceId)}`
  return `${base}&source=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(docPath)}`
}

// 검색 결과를 누르면 그 문서가 목록에 보이는 탭에서 연다(검색어는 주소에서 뺀다).
export function searchResultHref(
  sourceId: string,
  docPath: string,
  rules: Record<string, Record<string, DocTabRule>> = DOC_TAB_RULES,
  sourceTab?: DocTab,
): string {
  return docHref(tabOfDoc(sourceId, docPath, rules, sourceTab).tab, sourceId, docPath)
}

// 검색 결과에 붙일 탭 이름. 분류 안 된 문서는 개발자 탭 끝에 보이므로 그렇게 알린다.
export function searchResultTabLabel(
  sourceId: string,
  docPath: string,
  rules: Record<string, Record<string, DocTabRule>> = DOC_TAB_RULES,
  sourceTab?: DocTab,
): string {
  const { tab, unclassified } = tabOfDoc(sourceId, docPath, rules, sourceTab)
  return unclassified ? `${tabLabel(tab)}(분류 안 됨)` : tabLabel(tab)
}

// 주소에 문서가 없을 때 그 탭의 첫 문서를 자동으로 열지. 검색어가 있으면 결과를 지우지 않도록 열지 않는다.
export function shouldAutoOpenFirstDoc(state: {
  query: string | null
  sourceId: string | null
  docPath: string | null
  portalLoaded: boolean
}): boolean {
  if (state.query && state.query.trim().length > 0) return false
  return state.portalLoaded && !state.sourceId && !state.docPath
}

// ── 보관 문서 ─────────────────────────────────────────────────────────────
// 옛 판은 archive/(ADK)·"지난 기록/"(회사 문서) 폴더에 둔다. 목록에서는 접어 두고 맨 아래로 보내며,
// 검색에서는 "보관 문서 포함"을 켰을 때만 현행 문서 아래에 보인다.

const ARCHIVE_DIR_NAMES = new Set(["archive", "지난 기록"])

export function isArchiveDirName(name: string): boolean {
  return ARCHIVE_DIR_NAMES.has(name.normalize("NFC").trim().toLowerCase())
}

// 문서 경로가 보관 폴더 안에 있는지(폴더만 본다, 파일 이름은 보지 않는다).
export function isArchivedDocPath(docPath: string): boolean {
  const segments = docPath.split("/").filter((s) => s.length > 0)
  return segments.slice(0, -1).some(isArchiveDirName)
}

// 같은 층에서 보관 폴더를 맨 아래로 보낸다. 나머지 순서는 그대로 둔다.
export function orderArchiveLast(tree: DocTreeNode[]): DocTreeNode[] {
  const plain: DocTreeNode[] = []
  const archived: DocTreeNode[] = []
  for (const node of tree) {
    const next = node.type === "directory" ? { ...node, children: orderArchiveLast(node.children ?? []) } : node
    if (node.type === "directory" && isArchiveDirName(node.name)) archived.push(next)
    else plain.push(next)
  }
  return [...plain, ...archived]
}

export interface SearchArchiveInfo {
  kind: "대체됨" | "보관" | null
  date: string | null
}

// 검색 결과에 붙일 보관 표시. 현행 문서면 null.
export function archiveBadgeLabel(archive: SearchArchiveInfo | null | undefined): string | null {
  if (!archive) return null
  if (archive.kind === "대체됨" && archive.date) return `보관 · 대체됨 ${archive.date}`
  if (archive.date) return `보관 ${archive.date}`
  return "보관"
}

// 검색 API 주소. 보관 문서 포함을 켰을 때만 archived=1을 붙인다.
export function searchApiUrl(query: string, includeArchived: boolean): string {
  return `/api/portal/search?q=${encodeURIComponent(query)}${includeArchived ? "&archived=1" : ""}`
}

// 탭을 처음 열 때 보여 줄 문서. 현행 문서를 먼저 고르고, 보관 문서뿐이면 그중 첫 문서.
// 문서 화면: kind === "doc"만 고른다.
export function firstCurrentDoc(tree: DocTreeNode[]): string | null {
  let fallback: string | null = null
  const walk = (nodes: DocTreeNode[]): string | null => {
    for (const node of nodes) {
      if (node.type === "file") {
        if (node.kind && node.kind !== "doc") continue
        if (!isArchivedDocPath(node.path)) return node.path
        fallback ??= node.path
      } else if (node.children) {
        const inner = walk(node.children)
        if (inner) return inner
      }
    }
    return null
  }
  return walk(tree) ?? fallback
}
