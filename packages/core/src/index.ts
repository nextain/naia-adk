import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import fg from "fast-glob"
import matter from "gray-matter"
import type { ProjectIndex, SkillMeta, SubmoduleEntry, FileTreeNode, WorkspaceMeta } from "./types.js"
// Re-export the public domain types so consumers (e.g. @naia-adk/server) can import
// them from the package entry point, not only the functions that use them.
export type { ProjectIndex, SkillMeta, SubmoduleEntry, FileTreeNode, WorkspaceMeta } from "./types.js"

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

/** One front-matter contract violation found in a SKILL.md file. */
export interface SkillManifestError {
  field: string
  message: string
}

/**
 * Validate parsed SKILL.md front-matter against the required fields of the
 * `@naia-adk/skill-spec` SkillManifest contract (name + description required;
 * tier/tags constrained when present). Pure — returns [] when valid; callers
 * decide how to react. Kept here (not imported from skill-spec) so `@naia-adk/core`
 * stays consumable from source with no built-dist dependency.
 */
export function validateSkillManifest(data: unknown): SkillManifestError[] {
  if (typeof data !== "object" || data === null) {
    return [{ field: "<frontmatter>", message: "missing or not a YAML object" }]
  }
  const d = data as Record<string, unknown>
  const errors: SkillManifestError[] = []
  if (typeof d.name !== "string" || d.name.trim() === "") {
    errors.push({ field: "name", message: "required non-empty string" })
  }
  if (typeof d.description !== "string" || d.description.trim() === "") {
    errors.push({ field: "description", message: "required non-empty string" })
  }
  if (d.tier !== undefined && !["T0", "T1", "T2", "T3"].includes(d.tier as string)) {
    errors.push({ field: "tier", message: "must be one of T0|T1|T2|T3 when present" })
  }
  if (d.tags !== undefined) {
    if (!Array.isArray(d.tags)) {
      errors.push({ field: "tags", message: "must be a string array when present" })
    } else if (!d.tags.every((t) => typeof t === "string")) {
      errors.push({ field: "tags", message: "every tag must be a string" })
    }
  }
  return errors
}

/**
 * Discover operational skills under `<root>/skills/ ** /SKILL.md`.
 *
 * Fail-closed: if any SKILL.md violates the skill-spec manifest contract
 * (missing name/description front-matter) OR is unreadable / has malformed YAML,
 * throws an aggregated error naming every offending file rather than silently
 * serving a broken entry. On a fully-valid tree this is a no-op (behavior
 * unchanged). NOTE: this is intentionally all-or-nothing — a single bad
 * SKILL.md makes the whole catalog (and the `/api/skills` surface that consumes
 * it) fail, so the operator fixes the manifest rather than shipping a silently
 * incomplete catalog. Correctness-first by design.
 */
export function discoverSkills(root: string): SkillMeta[] {
  const pattern = path.join(root, "skills", "**", "SKILL.md").replace(/\\/g, "/")
  const files = fg.sync(pattern)
  const skills: SkillMeta[] = []
  const invalid: string[] = []
  for (const filePath of files) {
    const relPath = path.relative(root, filePath)
    let data: Record<string, unknown>
    let content: string
    try {
      const parsed = matter(fs.readFileSync(filePath, "utf-8"))
      data = parsed.data
      content = parsed.content
    } catch (err) {
      invalid.push(`${relPath}: unreadable or malformed front-matter (${(err as Error).message})`)
      continue
    }
    const manifestErrors = validateSkillManifest(data)
    if (manifestErrors.length > 0) {
      invalid.push(`${relPath}: ${manifestErrors.map((e) => `${e.field} (${e.message})`).join(", ")}`)
      continue
    }
    const parts = relPath.split(path.sep)
    const name = parts.length > 1 ? parts[parts.length - 2] : path.basename(filePath, ".md")
    skills.push({
      name,
      path: relPath,
      description: data.description as string,
      trigger: data.trigger as string | undefined,
      management: data.management as string | undefined,
      frontmatter: data,
      content,
    })
  }
  if (invalid.length > 0) {
    throw new Error(
      `discoverSkills: ${invalid.length} SKILL.md file(s) violate the skill-spec manifest contract:\n` +
        invalid.map((s) => `  - ${s}`).join("\n"),
    )
  }
  return skills
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
