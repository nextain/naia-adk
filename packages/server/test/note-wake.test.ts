import { describe, it, expect, beforeEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  buildNoteWakeBody,
  chooseWakeRole,
  dashboardDocUrl,
  findRoleInText,
  loadWakeRoles,
  readDocHeader,
  rolesFilePath,
  wakeTimestampKey,
  writeNoteWake,
  type WakeRole,
} from "../src/note-wake.js"

const roles: WakeRole[] = [
  { id: "coordinator", names: ["Coordinator"], wakeDir: "/tmp/wake-coord", inboxDir: "/tmp/inbox-coord" },
  { id: "writer", names: ["Writer"], wakeDir: "/tmp/wake-writer", inboxDir: "/tmp/inbox-writer" },
]

describe("note-wake (generic role routing)", () => {
  it("finds a role by display name or id", () => {
    expect(findRoleInText("please ask the Writer team", roles)?.id).toBe("writer")
    expect(findRoleInText("coordinator, review this", roles)?.id).toBe("coordinator")
    expect(findRoleInText("nobody mentioned", roles)).toBeNull()
  })

  it("matches ASCII ids on word boundaries only", () => {
    expect(findRoleInText("the writers are here", roles)).toBeNull()
    expect(findRoleInText("writer: take this", roles)?.id).toBe("writer")
  })

  it("reads author/owner from doc headers (plain and Korean labels)", () => {
    expect(readDocHeader("---\nauthor: Writer\n---\nbody")).toEqual({ author: "Writer", owner: null })
    expect(readDocHeader("작성: Coordinator\n본문")).toEqual({ author: "Coordinator", owner: null })
    expect(readDocHeader("담당: Writer\n본문")).toEqual({ author: null, owner: "Writer" })
    expect(readDocHeader("no headers here")).toEqual({ author: null, owner: null })
  })

  it("resolves author -> commit author -> owner -> default role", () => {
    expect(chooseWakeRole(roles, "author: Writer", null)?.role.id).toBe("writer")
    expect(chooseWakeRole(roles, "", "Writer <w@x.io>")?.role.id).toBe("writer")
    expect(chooseWakeRole(roles, "담당: Coordinator", null)?.role.id).toBe("coordinator")
    expect(chooseWakeRole(roles, "", null)?.role.id).toBe("coordinator")
    expect(chooseWakeRole(roles, "", null, { ...process.env, NAIA_WAKE_DEFAULT_ROLE: "writer" })?.role.id).toBe("writer")
    expect(chooseWakeRole([], "", null)).toBeNull()
  })

  it("builds a wake body without leaking internals and omits dashboard link when unset", () => {
    const body = buildNoteWakeBody({
      note: { id: "n1", source: "s", path: "a.md", quote: null, body: "hello" },
      choice: { role: roles[0], reason: "r" },
      docRelPath: "docs/a.md",
      dashboardUrl: null,
      now: new Date("2026-11-27T00:00:00.000Z"),
    })
    expect(body).toContain("docs/a.md")
    expect(body).not.toContain("dashboard:")
  })

  it("dashboardDocUrl honors NAIA_DASHBOARD_PUBLIC_URL only", () => {
    expect(dashboardDocUrl({ source: "s", path: "a.md" }, {} as NodeJS.ProcessEnv)).toBeNull()
    expect(
      dashboardDocUrl({ source: "s", path: "a.md" }, { NAIA_DASHBOARD_PUBLIC_URL: "https://ax.example.com/" } as NodeJS.ProcessEnv),
    ).toBe("https://ax.example.com/docs?source=s&path=a.md")
  })

  it("wakeTimestampKey sorts with the backlog cursor shape", () => {
    expect(wakeTimestampKey(new Date("2026-11-27T00:00:00.000Z"))).toBe("20261127000000000")
  })
})

describe("note-wake file writes", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "note-wake-"))
  })

  function writeRolesFile(extra: Record<string, unknown> = {}) {
    const wakeDir = path.join(root, "wake", "writer")
    fs.mkdirSync(wakeDir, { recursive: true })
    const file = {
      roles: [{ id: "writer", names: ["Writer"], wakeDir: "wake/writer" }],
      ...extra,
    }
    fs.writeFileSync(path.join(root, "roles.json"), JSON.stringify(file))
    const env = { ...process.env, NAIA_WAKE_ROLES_FILE: "roles.json" }
    return { wakeDir, env }
  }

  it("loads roles relative to the workspace root and rejects bad ids", () => {
    const { env } = writeRolesFile()
    const loaded = loadWakeRoles(root, env as NodeJS.ProcessEnv)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe("writer")
    expect(loaded[0].wakeDir).toContain("wake")
  })

  it("respects NAIA_WAKE_ROLES_FILE and returns [] when unreadable", () => {
    expect(loadWakeRoles(root, {} as NodeJS.ProcessEnv)).toEqual([])
    expect(rolesFilePath(root, {} as NodeJS.ProcessEnv)).toContain("roles.json")
  })

  it("writeNoteWake writes wake + inbox files and rejects bad note ids", () => {
    const { wakeDir, env } = writeRolesFile()
    const res = writeNoteWake({
      root,
      note: { id: "note-1", source: "adk", path: "a.md", quote: "q", body: "please review" },
      absDocPath: null,
      now: new Date("2026-11-27T00:00:00.000Z"),
      dashboardUrl: null,
      lastCommitAuthor: "Writer",
      env: env as NodeJS.ProcessEnv,
    })
    expect(res?.role).toBe("writer")
    const files = fs.readdirSync(wakeDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toContain("note-note-1")
    expect(
      writeNoteWake({ root, note: { id: "bad id!", source: "s", path: "p", quote: null, body: "b" }, env: env as NodeJS.ProcessEnv }),
    ).toBeNull()
  })
})
