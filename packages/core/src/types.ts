export interface WorkspaceMeta {
  root: string
  name: string
  owner: string
  org: string
  repo: string
  visibility: string
  type: string
}

export interface SubmoduleEntry {
  name: string
  path: string
  type: string
  description: string
  repo?: string
  source?: string
  visibility: string
  rulesEntrypoint?: string
  status: string
  notes?: string
}

export interface ProjectIndex {
  version: string
  workspace: WorkspaceMeta
  submodules: Record<string, SubmoduleEntry>
  local_projects: Record<string, SubmoduleEntry>
  github_only_repos?: Record<string, SubmoduleEntry>
  namingConventions?: Record<string, string>
  contextFiles?: Record<string, ContextFileEntry>
  entrypointPriority?: string[]
}

export interface ContextFileEntry {
  path: string
  description: string
  mirrors?: Record<string, string>
}

export interface SkillMeta {
  name: string
  path: string
  description: string
  trigger?: string
  management?: string
  frontmatter: Record<string, unknown>
  content: string
}

export interface FileTreeNode {
  name: string
  path: string
  type: "file" | "directory"
  category?: string
  visibility?: string
  entryPoint?: string
  children?: FileTreeNode[]
}
