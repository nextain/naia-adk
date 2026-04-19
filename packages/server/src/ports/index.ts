import type { WorkspaceMeta, SubmoduleEntry, SkillMeta, FileTreeNode } from "@naia-adk/core"

export interface WorkspacePort {
  getMeta(): Promise<WorkspaceMeta | null>
  getIndex(): Promise<Record<string, unknown> | null>
  getTree(path?: string, depth?: number): Promise<FileTreeNode[]>
  classify(): Promise<Record<string, string>>
}

export interface SkillPort {
  list(): Promise<SkillMeta[]>
  get(name: string): Promise<SkillMeta | null>
  getContent(name: string): Promise<{ raw: string; frontmatter: Record<string, unknown> } | null>
}

export interface FilePort {
  read(relPath: string): Promise<{ type: string; content?: string; base64?: string }>
  list(relPath: string): Promise<{ name: string; type: string }[]>
}

export interface WatchPort {
  subscribe(relPath: string, callback: (event: WatchEvent) => void): () => void
}

export interface WatchEvent {
  event: string
  path: string
  timestamp: string
}
