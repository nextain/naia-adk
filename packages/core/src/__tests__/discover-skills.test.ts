/**
 * discoverSkills + validateSkillManifest regression/contract tests.
 *
 * Closes the verification gap (2026-06-23): the central skill-discovery path
 * (`@naia-adk/core` discoverSkills, consumed by `@naia-adk/server` /api/skills)
 * previously had zero unit coverage, and front-matter completeness was not
 * enforced — a SKILL.md missing its skill-spec `name`/`description` was served
 * silently. These tests lock both the happy path (real workspace) and the
 * fail-closed behavior (malformed front-matter throws, naming the file).
 */

import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { discoverSkills, validateSkillManifest } from "../index.js"

const here = path.dirname(fileURLToPath(import.meta.url))
// src/__tests__ -> src -> core -> packages -> repo root
const REPO_ROOT = path.resolve(here, "../../../..")

describe("validateSkillManifest", () => {
  it("accepts a valid manifest (name + description)", () => {
    expect(validateSkillManifest({ name: "weather", description: "Get weather" })).toEqual([])
  })

  it("accepts optional tier/tags when well-formed", () => {
    expect(
      validateSkillManifest({ name: "x", description: "y", tier: "T1", tags: ["a", "b"] }),
    ).toEqual([])
  })

  it("flags missing name", () => {
    const errs = validateSkillManifest({ description: "y" })
    expect(errs.map((e) => e.field)).toContain("name")
  })

  it("flags empty / whitespace name", () => {
    expect(validateSkillManifest({ name: "   ", description: "y" }).map((e) => e.field)).toContain(
      "name",
    )
  })

  it("flags missing description", () => {
    expect(validateSkillManifest({ name: "x" }).map((e) => e.field)).toContain("description")
  })

  it("flags an invalid tier", () => {
    expect(
      validateSkillManifest({ name: "x", description: "y", tier: "T9" }).map((e) => e.field),
    ).toContain("tier")
  })

  it("flags non-object / null front-matter", () => {
    expect(validateSkillManifest(null).length).toBeGreaterThan(0)
    expect(validateSkillManifest("nope").length).toBeGreaterThan(0)
  })

  it("flags non-array tags", () => {
    expect(
      validateSkillManifest({ name: "x", description: "y", tags: "a,b" }).map((e) => e.field),
    ).toContain("tags")
  })

  it("flags tags whose elements are not strings", () => {
    expect(
      validateSkillManifest({ name: "x", description: "y", tags: [1, true] }).map((e) => e.field),
    ).toContain("tags")
  })

  it("flags a non-string name (numeric/boolean)", () => {
    expect(validateSkillManifest({ name: 123, description: "y" }).map((e) => e.field)).toContain(
      "name",
    )
    expect(validateSkillManifest({ name: true, description: "y" }).map((e) => e.field)).toContain(
      "name",
    )
  })
})

describe("discoverSkills — real workspace (regression)", () => {
  it("discovers the operational skill catalog without throwing", () => {
    const skills = discoverSkills(REPO_ROOT)
    expect(Array.isArray(skills)).toBe(true)
    // Floor, not exact — new skills may be added. 19 at time of writing.
    expect(skills.length).toBeGreaterThanOrEqual(19)
  })

  it("every discovered skill has a non-empty name + description", () => {
    for (const s of discoverSkills(REPO_ROOT)) {
      expect(s.name, "name").toBeTypeOf("string")
      expect(s.name.length, `${s.path}: name not empty`).toBeGreaterThan(0)
      expect(s.description.length, `${s.name}: description not empty`).toBeGreaterThan(0)
    }
  })

  it("includes known operational skills", () => {
    const names = new Set(discoverSkills(REPO_ROOT).map((s) => s.name))
    for (const known of ["weather", "email", "read-doc"]) {
      expect(names, `missing skill: ${known}`).toContain(known)
    }
  })
})

describe("discoverSkills — fail-closed on malformed SKILL.md", () => {
  let tmp: string | null = null

  afterEach(() => {
    if (tmp) {
      fs.rmSync(tmp, { recursive: true, force: true })
      tmp = null
    }
  })

  function writeSkill(root: string, dir: string, frontmatter: string) {
    const skillDir = path.join(root, "skills", dir)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\n${frontmatter}---\nbody\n`, "utf-8")
  }

  it("returns valid skills when all front-matter conforms", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adk-skills-ok-"))
    writeSkill(tmp, "good", "name: good\ndescription: a valid skill\ntier: T1\n")
    const skills = discoverSkills(tmp)
    expect(skills).toHaveLength(1)
    // name derives from the directory, not front-matter.
    expect(skills[0]!.name).toBe("good")
  })

  it("throws and names the offending file when front-matter is missing required fields", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adk-skills-bad-"))
    writeSkill(tmp, "good", "name: good\ndescription: a valid skill\n")
    writeSkill(tmp, "bad", "trigger: something\n") // no name, no description
    expect(() => discoverSkills(tmp!)).toThrow(/bad[\\/]SKILL\.md/)
    expect(() => discoverSkills(tmp!)).toThrow(/name|description/)
  })

  it("fails closed and names the offending file for malformed YAML front-matter", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adk-skills-yaml-"))
    writeSkill(tmp, "good", "name: good\ndescription: a valid skill\n")
    writeSkill(tmp, "broken", "name: ok\n bad: indent\n") // bad mapping indentation
    // Invariant (env-independent): a malformed SKILL.md fails discovery closed
    // and the offending file is named. The *path* that catches it differs by
    // runtime — production js-yaml throws on parse (caught by the per-file
    // try/catch, naming the file as "malformed"); a lenient YAML engine yields
    // empty data, caught by the manifest contract check (named as missing
    // name/description). Either way: throws, names `broken`.
    expect(() => discoverSkills(tmp!)).toThrow(/broken[\\/]SKILL\.md/)
  })
})
