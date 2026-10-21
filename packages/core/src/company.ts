import path from "node:path"

export interface CompanyDocsConfig {
  include?: string[]
}

export interface CompanyRepoDocsConfig {
  title?: string
  include?: string[]
}

export interface CompanyRepoConfig {
  id: string
  path: string
  remote: string
  docs?: CompanyRepoDocsConfig
}

export interface CompanyBoardConfig {
  repo: string
  script: string
  port: number
}

export interface CompanyConfig {
  schemaVersion: 1
  title: string
  docs?: CompanyDocsConfig
  repos?: CompanyRepoConfig[]
  board?: CompanyBoardConfig
}

export const COMPANY_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "ADK Company Configuration",
  type: "object",
  required: ["schemaVersion", "title"],
  properties: {
    schemaVersion: { type: "integer", const: 1, description: "Schema version, must be 1" },
    title: { type: "string", description: "Display title for the company documentation source" },
    docs: {
      type: "object",
      description: "Documentation visibility configuration",
      properties: {
        include: {
          type: "array",
          items: { type: "string" },
          description: "List of directory names relative to company repository root to show in dashboard",
        },
      },
    },
    repos: {
      type: "array",
      description: "Company project repositories to clone and expose",
      items: {
        type: "object",
        required: ["id", "path", "remote"],
        properties: {
          id: { type: "string", description: "Unique identifier for the repository" },
          path: {
            type: "string",
            description: "Relative path from ADK root under projects/ or data-company/ without '..'",
          },
          remote: { type: "string", description: "Git clone remote URL" },
          docs: {
            type: "object",
            properties: {
              title: { type: "string", description: "Display title for repository docs" },
              include: {
                type: "array",
                items: { type: "string" },
                description: "List of directory names relative to repository root to show in dashboard",
              },
            },
          },
        },
      },
    },
    board: {
      type: "object",
      description: "Optional company work board server configuration",
      required: ["repo", "script", "port"],
      properties: {
        repo: { type: "string", description: "Target repository ID from repos list" },
        script: { type: "string", description: "Relative script path within the target repository" },
        port: { type: "integer", minimum: 1, maximum: 65535, description: "Listening port number" },
      },
    },
  },
} as const

export function validateCompanyConfig(
  raw: unknown,
): { valid: true; data: CompanyConfig } | { valid: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, error: "adk-company.json: must be a JSON object" }
  }

  const obj = raw as Record<string, unknown>

  if (obj.schemaVersion !== 1) {
    return { valid: false, error: "adk-company.json: schemaVersion must be 1" }
  }

  if (typeof obj.title !== "string" || obj.title.trim() === "") {
    return { valid: false, error: "adk-company.json: title must be a non-empty string" }
  }

  if (obj.docs !== undefined) {
    if (typeof obj.docs !== "object" || obj.docs === null || Array.isArray(obj.docs)) {
      return { valid: false, error: "adk-company.json: docs must be an object" }
    }
    const docsObj = obj.docs as Record<string, unknown>
    if (docsObj.include !== undefined) {
      if (!Array.isArray(docsObj.include)) {
        return { valid: false, error: "adk-company.json: docs.include must be an array of strings" }
      }
      for (let i = 0; i < docsObj.include.length; i++) {
        const item = docsObj.include[i]
        if (typeof item !== "string" || item.trim() === "") {
          return { valid: false, error: `adk-company.json: docs.include[${i}] must be a non-empty string` }
        }
        const norm = item.replace(/\\/g, "/")
        if (norm.split("/").includes("..") || path.isAbsolute(item) || norm.startsWith("/")) {
          return { valid: false, error: `adk-company.json: docs.include[${i}] must not contain '..' or absolute paths` }
        }
      }
    }
  }

  const repoIds = new Set<string>()
  if (obj.repos !== undefined) {
    if (!Array.isArray(obj.repos)) {
      return { valid: false, error: "adk-company.json: repos must be an array" }
    }
    for (let i = 0; i < obj.repos.length; i++) {
      const repo = obj.repos[i]
      if (typeof repo !== "object" || repo === null || Array.isArray(repo)) {
        return { valid: false, error: `adk-company.json: repos[${i}] must be an object` }
      }
      const r = repo as Record<string, unknown>
      if (typeof r.id !== "string" || r.id.trim() === "") {
        return { valid: false, error: `adk-company.json: repos[${i}].id must be a non-empty string` }
      }
      repoIds.add(r.id)

      if (typeof r.remote !== "string" || r.remote.trim() === "") {
        return { valid: false, error: `adk-company.json: repos[${i}].remote must be a non-empty string` }
      }

      if (typeof r.path !== "string" || r.path.trim() === "") {
        return { valid: false, error: `adk-company.json: repos[${i}].path must be a non-empty string` }
      }

      const pNorm = r.path.replace(/\\/g, "/")
      const isAbsolute = path.isAbsolute(r.path) || pNorm.startsWith("/") || /^[a-zA-Z]:/.test(pNorm)
      const hasDotDot = pNorm.split("/").includes("..")
      const isAllowedPrefix = pNorm.startsWith("projects/") || pNorm.startsWith("data-company/")

      if (isAbsolute || hasDotDot || !isAllowedPrefix) {
        return {
          valid: false,
          error: `adk-company.json: repos[${i}].path must be under projects/ or data-company/ without '..'`,
        }
      }

      if (r.docs !== undefined) {
        if (typeof r.docs !== "object" || r.docs === null || Array.isArray(r.docs)) {
          return { valid: false, error: `adk-company.json: repos[${i}].docs must be an object` }
        }
        const rDocs = r.docs as Record<string, unknown>
        if (rDocs.title !== undefined && typeof rDocs.title !== "string") {
          return { valid: false, error: `adk-company.json: repos[${i}].docs.title must be a string` }
        }
        if (rDocs.include !== undefined) {
          if (!Array.isArray(rDocs.include)) {
            return { valid: false, error: `adk-company.json: repos[${i}].docs.include must be an array of strings` }
          }
          for (let j = 0; j < rDocs.include.length; j++) {
            const inc = rDocs.include[j]
            if (typeof inc !== "string" || inc.trim() === "") {
              return { valid: false, error: `adk-company.json: repos[${i}].docs.include[${j}] must be a non-empty string` }
            }
            const norm = inc.replace(/\\/g, "/")
            if (norm.split("/").includes("..") || path.isAbsolute(inc) || norm.startsWith("/")) {
              return { valid: false, error: `adk-company.json: repos[${i}].docs.include[${j}] must not contain '..' or absolute paths` }
            }
          }
        }
      }
    }
  }

  if (obj.board !== undefined) {
    if (typeof obj.board !== "object" || obj.board === null || Array.isArray(obj.board)) {
      return { valid: false, error: "adk-company.json: board must be an object" }
    }
    const b = obj.board as Record<string, unknown>
    if (typeof b.repo !== "string" || b.repo.trim() === "") {
      return { valid: false, error: "adk-company.json: board.repo must be a non-empty string" }
    }
    if (!repoIds.has(b.repo)) {
      return { valid: false, error: `adk-company.json: board.repo '${b.repo}' not found in repos` }
    }
    if (typeof b.script !== "string" || b.script.trim() === "") {
      return { valid: false, error: "adk-company.json: board.script must be a non-empty string" }
    }
    const scriptNorm = b.script.replace(/\\/g, "/")
    if (scriptNorm.split("/").includes("..") || path.isAbsolute(b.script) || scriptNorm.startsWith("/")) {
      return { valid: false, error: "adk-company.json: board.script must not contain '..' or absolute paths" }
    }
    if (
      typeof b.port !== "number" ||
      !Number.isInteger(b.port) ||
      b.port < 1 ||
      b.port > 65535
    ) {
      return { valid: false, error: "adk-company.json: board.port must be a valid port number (1-65535)" }
    }
  }

  return { valid: true, data: obj as unknown as CompanyConfig }
}

export function parseCompanyConfig(
  rawJson: string,
): { valid: true; data: CompanyConfig } | { valid: false; error: string } {
  try {
    const parsed = JSON.parse(rawJson)
    return validateCompanyConfig(parsed)
  } catch (err) {
    return { valid: false, error: `adk-company.json: invalid JSON syntax (${(err as Error).message})` }
  }
}
