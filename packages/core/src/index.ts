import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import fg from "fast-glob"
import matter from "gray-matter"
import type { ProjectIndex, SkillMeta, SubmoduleEntry, FileTreeNode, WorkspaceMeta } from "./types.js"

export function loadProjectIndex(root: string): ProjectIndex | null {
  const indexPath = path.join(root, ".agents", "context", "project-index.yaml")
  if (!fs.existsSync(indexPath)) return null
  const raw = fs.readFileSync(indexPath, "utf-8")
  return YAML.parse(raw) as ProjectIndex
}

export function loadAgentsRules(root: string): Record<string, unknown> | null {
  const rulesPath = path.join(root, ".agents", "context", "agents-rules.json")
  if (!fs.existsSync(rulesPath)) return null
  return JSON.parse(fs.readFileSync(rulesPath, "utf-8"))
}

export function detectAdkRoot(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    const agentsMd = path.join(dir, "AGENTS.md")
    const claudeMd = path.join(dir, "CLAUDE.md")
    const rulesJson = path.join(dir, ".agents", "context", "agents-rules.json")
    const hasEntry = fs.existsSync(agentsMd) || fs.existsSync(claudeMd)
    const hasRules = fs.existsSync(rulesJson)
    if (hasEntry && hasRules) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function discoverSkills(root: string): SkillMeta[] {
  const pattern = path.join(root, "skills", "**", "SKILL.md").replace(/\\/g, "/")
  const files = fg.sync(pattern)
  return files.map((filePath) => {
    const raw = fs.readFileSync(filePath, "utf-8")
    const { data, content } = matter(raw)
    const relPath = path.relative(root, filePath)
    const parts = relPath.split(path.sep)
    const name = parts.length > 1 ? parts[parts.length - 2] : path.basename(filePath, ".md")
    return {
      name,
      path: relPath,
      description: (data.description as string) || "",
      trigger: data.trigger as string | undefined,
      management: data.management as string | undefined,
      frontmatter: data,
      content,
    }
  })
}

export function classifySubmodules(index: ProjectIndex): Map<string, string> {
  const categories = new Map<string, string>()
  const allEntries: Record<string, SubmoduleEntry> = {
    ...(index.submodules || {}),
    ...(index.local_projects || {}),
  }
  for (const [name, entry] of Object.entries(allEntries)) {
    categories.set(name, entry.type || "other")
  }
  return categories
}

export function buildFileTree(root: string, dirPath: string, depth: number = 2): FileTreeNode[] {
  const absPath = path.join(root, dirPath)
  if (!fs.existsSync(absPath)) return []
  const entries = fs.readdirSync(absPath, { withFileTypes: true })
  return entries
    .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => {
      const relPath = path.join(dirPath, e.name)
      if (e.isDirectory()) {
        const node: FileTreeNode = {
          name: e.name,
          path: relPath,
          type: "directory",
        }
        if (depth > 1) {
          node.children = buildFileTree(root, relPath, depth - 1)
        }
        return node
      }
      return {
        name: e.name,
        path: relPath,
        type: "file" as const,
      }
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

export function getWorkspaceMeta(root: string): WorkspaceMeta | null {
  const index = loadProjectIndex(root)
  if (!index) return null
  return index.workspace
}
