import { describe, expect, it, vi, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  allCategoryFields,
  kindsForTarget,
  languagesForTarget,
  loadPublishTargets,
  normalizeTargetProfile,
  parseTargetsJson,
  profileStyle,
  requireKnownTargets,
} from "../src/publish-targets.js"
import { PUBLISH_FIXTURE_TARGETS_JSON, PUBLISH_FIXTURE_PROFILES, SITE_ALPHA, SITE_BETA } from "./publish-fixtures.js"

afterEach(() => vi.unstubAllEnvs())

describe("게시 대상 설정", () => {
  it("JSON 문자열과 파일과 adk config 폴백에서 읽는다", async () => {
    const fromJson = loadPublishTargets(undefined, { NAIA_PUBLISH_TARGETS_JSON: PUBLISH_FIXTURE_TARGETS_JSON } as any)
    expect(Object.keys(fromJson).sort()).toEqual([SITE_ALPHA, SITE_BETA])
    expect(fromJson[SITE_ALPHA]!.defaultCanonicalBase).toBe(`https://${SITE_ALPHA}/ko/blog`)
  })

  it("알 수 없는 대상은 fail-closed로 거절한다", () => {
    const profiles = parseTargetsJson(PUBLISH_FIXTURE_TARGETS_JSON)
    for (const ids of [[SITE_ALPHA, "unknown.example"], ["anything.example"]] as string[][]) {
      try {
        requireKnownTargets(ids, ids[0] === SITE_ALPHA ? profiles : {})
        expect.unreachable(`거절되어야 합니다: ${ids.join(",")}`)
      } catch (error: any) {
        expect(error?.status).toBe(422)
        expect(error?.code).toBe("invalid_bundle")
      }
    }
    expect(requireKnownTargets([SITE_BETA, SITE_ALPHA], profiles)).toEqual([SITE_ALPHA, SITE_BETA])
  })

  it("설정이 없으면 빈 대상으로 모든 게시 요청을 거절한다", () => {
    expect(loadPublishTargets("/nonexistent-adk-root", {} as any)).toEqual({})
  })

  it("읽기 순서: 명시 파일이 인라인·대체 파일보다 먼저다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-targets-order-"))
    try {
      const fileOnly = path.join(dir, "file.json")
      fs.writeFileSync(fileOnly, JSON.stringify({ targets: [{ id: "file-only.example" }] }))
      const fallbackDir = path.join(dir, "adk")
      fs.mkdirSync(path.join(fallbackDir, "config"), { recursive: true })
      fs.writeFileSync(path.join(fallbackDir, "config", "publish-targets.json"), JSON.stringify({ targets: [{ id: "fallback-only.example" }] }))
      const fromFile = loadPublishTargets(fallbackDir, {
        NAIA_PUBLISH_TARGETS_FILE: fileOnly,
        NAIA_PUBLISH_TARGETS_JSON: JSON.stringify({ targets: [{ id: "inline-only.example" }] }),
      } as any)
      expect(Object.keys(fromFile)).toEqual(["file-only.example"])
      const fromInline = loadPublishTargets(fallbackDir, {
        NAIA_PUBLISH_TARGETS_JSON: JSON.stringify({ targets: [{ id: "inline-only.example" }] }),
      } as any)
      expect(Object.keys(fromInline)).toEqual(["inline-only.example"])
      const fromFallback = loadPublishTargets(fallbackDir, {} as any)
      expect(Object.keys(fromFallback)).toEqual(["fallback-only.example"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("명시 파일이 없거나 정규 파일이 아니면 실패한다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-targets-file-"))
    try {
      expect(() => loadPublishTargets(undefined, { NAIA_PUBLISH_TARGETS_FILE: path.join(dir, "missing.json") } as any)).toThrow()
      expect(() => loadPublishTargets(undefined, { NAIA_PUBLISH_TARGETS_FILE: dir } as any)).toThrow()
      expect(() => loadPublishTargets(undefined, { NAIA_PUBLISH_TARGETS_FILE: "relative/path.json" } as any)).toThrow()
      const link = path.join(dir, "link.json")
      fs.writeFileSync(path.join(dir, "real.json"), JSON.stringify({ targets: [{ id: "real.example" }] }))
      fs.symlinkSync(path.join(dir, "real.json"), link)
      expect(() => loadPublishTargets(undefined, { NAIA_PUBLISH_TARGETS_FILE: link } as any)).toThrow()
      const big = path.join(dir, "big.json")
      fs.writeFileSync(big, JSON.stringify({ targets: [{ id: "big.example" }] }))
      fs.truncateSync(big, 1024 * 1024 + 1)
      expect(() => loadPublishTargets(undefined, { NAIA_PUBLISH_TARGETS_FILE: big } as any)).toThrow()
      const broken = path.join(dir, "broken.json")
      fs.writeFileSync(broken, "{ not json")
      expect(() => loadPublishTargets(undefined, { NAIA_PUBLISH_TARGETS_FILE: broken } as any)).toThrow()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("고장 난 대체 파일은 빈 대상으로 끝난다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-targets-fallback-"))
    try {
      const adk = path.join(dir, "adk")
      fs.mkdirSync(path.join(adk, "config"), { recursive: true })
      const fallback = path.join(adk, "config", "publish-targets.json")
      fs.writeFileSync(fallback, "{ broken")
      expect(loadPublishTargets(adk, {} as any)).toEqual({})
      fs.rmSync(fallback)
      fs.mkdirSync(fallback)
      expect(loadPublishTargets(adk, {} as any)).toEqual({})
      fs.rmSync(fallback, { recursive: true })
      const real = path.join(dir, "real.json")
      fs.writeFileSync(real, JSON.stringify({ targets: [{ id: "real.example" }] }))
      fs.symlinkSync(real, fallback)
      expect(loadPublishTargets(adk, {} as any)).toEqual({})
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("물려받은 이름은 설정 조회에서 거절된다", () => {
    for (const id of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(() => requireKnownTargets([id], {} as any)).toThrow()
      expect(() => requireKnownTargets([id], parseTargetsJson(PUBLISH_FIXTURE_TARGETS_JSON))).toThrow()
    }
    expect(() => parseTargetsJson(JSON.stringify({ targets: [{ id: "__proto__" }] }))).toThrow()
    // 리터럴 `{ __proto__: … }`은 원형을 바꾸므로 JSON으로 읽은 own 속성으로 시험한다.
    expect(() => normalizeTargetProfile({ id: "a.example", kindLanguages: JSON.parse('{"__proto__":["ko"]}') })).toThrow()
    expect(() => normalizeTargetProfile({ id: "a.example", previewFieldMap: JSON.parse('{"__proto__":"title"}') })).toThrow()
    // 직접 만든 일반 객체 프로필에서도 물려받은 이름은 언어로 새지 않는다.
    const plain = PUBLISH_FIXTURE_PROFILES[SITE_ALPHA]!
    expect(languagesForTarget(plain, "toString")).toEqual(["ko", "en"])
    expect(languagesForTarget(plain, "constructor")).toEqual(["ko", "en"])
    expect(languagesForTarget(plain, "__proto__")).toEqual(["ko", "en"])
    expect(languagesForTarget(plain, "post")).toContain("ja")
  })

  it("잘못된 설정은 시작 전에 실패한다", () => {
    expect(() => parseTargetsJson("not json")).toThrow()
    expect(() => parseTargetsJson(JSON.stringify({ targets: [{ id: "" }] }))).toThrow()
    expect(() => parseTargetsJson(JSON.stringify({ targets: [{ id: "a.example" }, { id: "a.example" }] }))).toThrow()
    expect(() => parseTargetsJson(JSON.stringify({ targets: [{ id: "a.example", previewStyle: "fancy" }] }))).toThrow()
    expect(() => normalizeTargetProfile({ id: "a.example", defaultCanonicalBase: "http://plain.example/x" })).toThrow()
  })

  it("종류·언어·표시 방식을 프로필에서 읽는다", () => {
    const profiles = PUBLISH_FIXTURE_PROFILES
    expect(kindsForTarget(profiles[SITE_ALPHA]!)).toEqual(["post", "episode"])
    expect(kindsForTarget(profiles[SITE_BETA]!)).toEqual(["post"])
    expect(languagesForTarget(profiles[SITE_ALPHA]!, "post")).toContain("ja")
    expect(languagesForTarget(profiles[SITE_BETA]!, "post")).toEqual(["ko", "en"])
    expect(profileStyle(profiles[SITE_ALPHA]!)).toBe("standard")
    expect(profileStyle(profiles[SITE_BETA]!)).toBe("mapped")
    expect(allCategoryFields(profiles)).toEqual(new Set(["category", "site_beta_category"]))
  })

  it("제품 소스에는 회사 도메인 리터럴이 없다", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const roots = ["src/publish-targets.ts", "src/publish-bundle.ts", "src/publish-preview.ts", "src/publish-service.ts", "src/publish-store.ts", "src/routes/portal-publish.ts"]
    for (const relative of roots) {
      const content = fs.readFileSync(path.join(import.meta.dirname, "..", relative), "utf8")
      expect(content).not.toMatch(/naia\.land|cafelua|onmam|minho|luke/i)
    }
  })
})
