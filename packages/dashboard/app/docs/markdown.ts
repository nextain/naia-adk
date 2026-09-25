// 문서 화면이 마크다운을 그리기 전에 쓰는 순수 함수들.
// 회사 문서는 Obsidian으로도 편집하므로 머리말(frontmatter)과 [[문서 이름]] 링크를 함께 다룬다.

export interface DocTreeNode {
  name: string
  path: string
  type: "file" | "directory"
  children?: DocTreeNode[]
}

export const WIKI_HREF_PREFIX = "#wiki:"

// 맨 앞의 --- 로 둘러싼 머리말을 떼어 낸다. 없으면 meta는 null.
export function splitFrontmatter(text: string): { meta: string | null; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { meta: null, body: text }
  return { meta: match[1], body: text.slice(match[0].length) }
}

// [[대상]], [[대상|보이는 글]], [[대상#제목]]을 일반 마크다운 링크로 바꾼다.
// 그림 끼워 넣기(![[...]])는 문서 화면에서 다루지 않으므로 보이는 글로만 남긴다.
// 코드 블록 안은 바꾸지 않는다.
export function convertWikiLinks(body: string): string {
  const parts = body.split(/(```[\s\S]*?```|`[^`\n]*`)/)
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part
      return part.replace(/(!?)\[\[([^\]\n]+)\]\]/g, (_whole, bang: string, inner: string) => {
        const [targetWithHeading, label] = inner.split("|")
        const target = targetWithHeading.split("#")[0].trim()
        const text = (label ?? targetWithHeading).trim()
        if (bang || !target) return text
        return `[${text.replace(/[[\]]/g, "")}](${WIKI_HREF_PREFIX}${encodeURIComponent(target)})`
      })
    })
    .join("")
}

function stripMd(value: string): string {
  return value.replace(/\.md$/i, "")
}

// [[대상]]이 가리키는 문서를 같은 출처의 트리에서 찾는다.
// 경로까지 적었으면 경로 끝이 맞는 문서만, 이름만 적었으면 이름이 같은 첫 문서.
export function findWikiTarget(tree: DocTreeNode[], target: string): string | null {
  const wanted = stripMd(target.replace(/\\/g, "/").replace(/^\/+/, ""))
  const files: string[] = []
  const walk = (nodes: DocTreeNode[]) => {
    for (const node of nodes) {
      if (node.type === "file") files.push(node.path)
      else if (node.children) walk(node.children)
    }
  }
  walk(tree)
  const byPath = files.find((file) => {
    const bare = stripMd(file)
    return bare === wanted || bare.endsWith(`/${wanted}`)
  })
  if (byPath) return byPath
  // 경로까지 적었는데 없으면 다른 폴더의 같은 이름 문서로 잇지 않는다.
  if (wanted.includes("/")) return null
  const baseName = wanted.split("/").pop() ?? wanted
  return files.find((file) => stripMd(file.split("/").pop() ?? "") === baseName) ?? null
}

// 문서 안 상대 링크를 출처 기준 경로로 푼다. 링크의 %20 같은 인코딩도 푼다.
export function resolveRelativePath(currentDocPath: string, targetHref: string): string {
  const currentDir = currentDocPath.includes("/")
    ? currentDocPath.substring(0, currentDocPath.lastIndexOf("/"))
    : ""
  const parts = currentDir ? currentDir.split("/") : []
  let decoded = targetHref
  try {
    decoded = decodeURIComponent(targetHref)
  } catch {
    // 잘못된 인코딩이면 적힌 그대로 쓴다.
  }
  for (const seg of decoded.replace(/\\/g, "/").split("#")[0].split("/")) {
    if (seg === "." || seg === "") continue
    if (seg === "..") {
      if (parts.length > 0) parts.pop()
    } else {
      parts.push(seg)
    }
  }
  return parts.join("/")
}

// 회사 문서를 맨 위에, 프로젝트 문서를 다음에, ADK(개발자용) 문서를 맨 아래에 둔다.
export function orderSources<T extends { id: string }>(sources: T[]): T[] {
  const rank = (id: string) => (id.startsWith("company:") ? 0 : id === "adk" ? 2 : 1)
  return [...sources].sort((a, b) => rank(a.id) - rank(b.id))
}

// 트리 순서대로 처음 나오는 문서. 문서 화면에 처음 들어왔을 때 열어 줄 문서를 고른다.
export function firstDoc(tree: DocTreeNode[]): string | null {
  for (const node of tree) {
    if (node.type === "file") return node.path
    const inner = node.children ? firstDoc(node.children) : null
    if (inner) return inner
  }
  return null
}
