import type { FastifyInstance, FastifyPluginCallback } from "fastify"
import fs from "node:fs"
import path from "node:path"
import { validateCompanyConfig, type CompanyConfig } from "@naia-adk/core"

export interface PortalTreeNode {
  name: string
  path: string
  type: "file" | "directory"
  children?: PortalTreeNode[]
}

export interface PortalSource {
  id: string
  title: string
  tree: PortalTreeNode[]
}

export interface PortalBoardInfo {
  port: number
}

export interface PortalResponse {
  sources: PortalSource[]
  board: PortalBoardInfo | null
}

const ALLOWED_ASSET_EXTS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
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

function buildMdTree(absBaseDir: string, currentRelDir: string): PortalTreeNode[] {
  const currentAbsDir = path.join(absBaseDir, currentRelDir)
  if (!fs.existsSync(currentAbsDir)) return []

  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(currentAbsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const nodes: PortalTreeNode[] = []

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue
    }

    const relPath = currentRelDir ? `${currentRelDir}/${entry.name}` : entry.name
    const absPath = path.join(absBaseDir, relPath)

    if (entry.isDirectory()) {
      const children = buildMdTree(absBaseDir, relPath)
      // 하위에 .md 파일이 하나라도 있는 폴더만 트리에 포함
      if (children.length > 0) {
        nodes.push({
          name: entry.name,
          path: relPath,
          type: "directory",
          children,
        })
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      nodes.push({
        name: entry.name,
        path: relPath,
        type: "file",
      })
    }
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1
    return a.name.localeCompare(b.name, "ko")
  })

  return nodes
}

interface ResolvedSource {
  id: string
  title: string
  baseDir: string
  allowedPrefixes: string[] | null // null means entire baseDir is allowed
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

function getSourcesAndBoard(adkRoot: string): {
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
    const adkTree = buildMdTree(adkDocsDir, "")
    sources.push({
      id: "adk",
      title: "ADK 문서",
      tree: adkTree,
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
      const incTree = buildMdTree(companyDir, inc)
      if (incTree.length > 0) {
        // inc 자체가 디렉터리이므로 트리에 추가
        companyTree.push({
          name: inc,
          path: inc,
          type: "directory",
          children: incTree,
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
            const incTree = buildMdTree(repoAbsDir, inc)
            if (incTree.length > 0) {
              repoTree.push({
                name: inc,
                path: inc,
                type: "directory",
                children: incTree,
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

  return { sources, resolvedSources, board: boardInfo }
}

// 문서가 속한 보여 주기 폴더(ADK 문서는 docs 전체)를 돌려준다. 없으면 null.
function matchingAllowedDir(source: ResolvedSource, normPath: string): string | null {
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

function resolveSecureFile(
  source: ResolvedSource,
  normPath: string,
): { error: "not_found" } | { absPath: string } {
  const allowedDir = matchingAllowedDir(source, normPath)
  if (!allowedDir) return { error: "not_found" }

  const absPath = path.resolve(source.baseDir, normPath)
  if (!fs.existsSync(absPath)) return { error: "not_found" }

  let realPath: string
  let realAllowedDir: string
  try {
    realPath = fs.realpathSync(absPath)
    realAllowedDir = fs.realpathSync(allowedDir)
  } catch {
    return { error: "not_found" }
  }

  // 심볼릭 링크를 따라간 실제 위치가 그 보여 주기 폴더 안이어야 한다.
  // 같은 저장소의 제외 폴더(예: 증빙서류)를 가리키는 링크도 여기서 막힌다.
  if (!isInside(realPath, realAllowedDir)) return { error: "not_found" }

  if (!fs.statSync(realPath).isFile()) return { error: "not_found" }
  return { absPath: realPath }
}

export const portalRoutes: FastifyPluginCallback = (app, _opts, done) => {
  const root = (app as FastifyInstance & { adkRoot: string }).adkRoot

  // GET /api/portal
  app.get("/", async (_req, reply) => {
    const { sources, board } = getSourcesAndBoard(root)
    return reply.send({ sources, board })
  })

  // GET /api/portal/doc?source=<id>&path=<relative path>
  app.get("/doc", async (req, reply) => {
    const query = req.query as Record<string, string | undefined>
    const sourceId = query.source
    const rawPath = query.path

    if (!sourceId || !rawPath) {
      return reply.code(404).send({ error: "Missing source or path" })
    }

    const normPath = normalizeRelativePath(rawPath)
    if (!normPath || !normPath.toLowerCase().endsWith(".md")) {
      return reply.code(404).send({ error: "File not found or not markdown" })
    }

    const { resolvedSources } = getSourcesAndBoard(root)
    const source = resolvedSources.get(sourceId)
    if (!source) {
      return reply.code(404).send({ error: "Source not found" })
    }

    const result = resolveSecureFile(source, normPath)
    if ("error" in result) {
      return reply.code(404).send({ error: "Document not found" })
    }

    try {
      const content = fs.readFileSync(result.absPath, "utf-8")
      return reply.type("text/markdown; charset=utf-8").send(content)
    } catch {
      return reply.code(404).send({ error: "Failed to read document" })
    }
  })

  // GET /api/portal/asset?source=<id>&path=<relative path>
  app.get("/asset", async (req, reply) => {
    const query = req.query as Record<string, string | undefined>
    const sourceId = query.source
    const rawPath = query.path

    if (!sourceId || !rawPath) {
      return reply.code(404).send({ error: "Missing source or path" })
    }

    const normPath = normalizeRelativePath(rawPath)
    if (!normPath) {
      return reply.code(404).send({ error: "Invalid path" })
    }

    const ext = path.extname(normPath).toLowerCase()
    const contentType = ALLOWED_ASSET_EXTS[ext]
    if (!contentType) {
      return reply.code(404).send({ error: "Asset type not allowed" })
    }

    const { resolvedSources } = getSourcesAndBoard(root)
    const source = resolvedSources.get(sourceId)
    if (!source) {
      return reply.code(404).send({ error: "Source not found" })
    }

    const result = resolveSecureFile(source, normPath)
    if ("error" in result) {
      return reply.code(404).send({ error: "Asset not found" })
    }

    try {
      const buffer = fs.readFileSync(result.absPath)
      return reply.type(contentType).send(buffer)
    } catch {
      return reply.code(404).send({ error: "Failed to read asset" })
    }
  })

  done()
}
