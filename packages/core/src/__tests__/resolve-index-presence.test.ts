/**
 * resolveIndexPresence tests (nextain/naia-adk#11).
 *
 * The dashboard previously counted submodules/projects straight from
 * project-index.yaml without checking whether each entry's path existed on disk,
 * so an empty workspace carrying an example catalog reported phantom counts.
 * resolveIndexPresence stamps each entry with `present`; these tests lock that
 * existing paths → true, phantom/empty paths → false, and the input is not mutated.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveIndexPresence } from "../index.js"
import type { ProjectIndex, SubmoduleEntry } from "../types.js"

const entry = (over: Partial<SubmoduleEntry> & Pick<SubmoduleEntry, "name" | "path">): SubmoduleEntry => ({
  type: "project",
  description: "",
  visibility: "private",
  status: "active",
  ...over,
})

describe("resolveIndexPresence", () => {
  let root: string

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "adk-presence-"))
    fs.mkdirSync(path.join(root, "real-sub"), { recursive: true })
    fs.mkdirSync(path.join(root, "projects", "real-proj"), { recursive: true })
  })

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const makeIndex = (): ProjectIndex => ({
    version: "2.0",
    workspace: { root, name: "t", owner: "o", org: "o", repo: "o/t", visibility: "public", type: "workspace_adk" },
    submodules: {
      "real-sub": entry({ name: "real-sub", path: "./real-sub", type: "docs" }),
      "ghost-sub": entry({ name: "ghost-sub", path: "./ghost-sub", type: "reference" }),
      "nopath-sub": entry({ name: "nopath-sub", path: "" }),
    },
    local_projects: {
      "real-proj": entry({ name: "real-proj", path: "./projects/real-proj" }),
      "ghost-proj": entry({ name: "ghost-proj", path: "./ghost-proj" }),
    },
  })

  it("stamps present=true for existing paths", () => {
    const out = resolveIndexPresence(root, makeIndex())
    expect(out.submodules["real-sub"].present).toBe(true)
    expect(out.local_projects["real-proj"].present).toBe(true)
  })

  it("stamps present=false for phantom paths", () => {
    const out = resolveIndexPresence(root, makeIndex())
    expect(out.submodules["ghost-sub"].present).toBe(false)
    expect(out.local_projects["ghost-proj"].present).toBe(false)
  })

  it("treats an empty path as not present", () => {
    const out = resolveIndexPresence(root, makeIndex())
    expect(out.submodules["nopath-sub"].present).toBe(false)
  })

  it("does not mutate the input index", () => {
    const index = makeIndex()
    resolveIndexPresence(root, index)
    expect(index.submodules["real-sub"].present).toBeUndefined()
    expect(index.local_projects["real-proj"].present).toBeUndefined()
  })

  it("preserves all original entry fields", () => {
    const out = resolveIndexPresence(root, makeIndex())
    expect(out.submodules["real-sub"]).toMatchObject({
      name: "real-sub",
      path: "./real-sub",
      type: "docs",
      visibility: "private",
      status: "active",
      present: true,
    })
  })

  it("tolerates missing submodules/local_projects maps", () => {
    const out = resolveIndexPresence(root, {
      version: "2.0",
      workspace: makeIndex().workspace,
    } as ProjectIndex)
    expect(out.submodules).toEqual({})
    expect(out.local_projects).toEqual({})
  })

  it("treats a non-string/undefined path as not present", () => {
    const out = resolveIndexPresence(root, {
      version: "2.0",
      workspace: makeIndex().workspace,
      submodules: {
        // entry with no `path` key at all (cast around the required-path type)
        weird: { name: "weird", type: "docs", description: "", visibility: "private", status: "active" } as unknown as SubmoduleEntry,
      },
      local_projects: {},
    } as ProjectIndex)
    expect(out.submodules["weird"].present).toBe(false)
  })

  it("passes non-entry index fields through untouched (shallow clone preserves siblings)", () => {
    const index: ProjectIndex = {
      ...makeIndex(),
      github_only_repos: { gh: entry({ name: "gh", path: "./projects/real-proj" }) },
      namingConventions: { projects: "project-*" },
    }
    const out = resolveIndexPresence(root, index)
    // github_only_repos is not a dashboard surface → passed through, not stamped
    expect(out.github_only_repos).toBe(index.github_only_repos)
    expect(out.github_only_repos!["gh"].present).toBeUndefined()
    expect(out.namingConventions).toEqual({ projects: "project-*" })
  })
})
