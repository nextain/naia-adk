import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createServer } from "../src/server.js"
import {
  getFavoritesFilePath,
  readFavoritesSecure,
  saveFavorites,
} from "../src/favorites.js"

// NAIA_FAVORITES_FILE 회귀 시험: 운영 포털(ProtectSystem=strict,
// ReadOnlyPaths=<repo>)에서 POST /api/portal/favorites가
// '<adkRoot>/.agents/work/doc-favorites.json.lock' EROFS로 500 실패하던 버그.
// 환경변수가 설정되면 읽기 전용 adkRoot에 쓰지 않고 지정 경로(및 같은
// 디렉터리의 .lock)에 읽기/쓰기해야 한다.
describe("NAIA_FAVORITES_FILE env override (ReadOnlyPaths EROFS fix)", () => {
  let tempRoot: string
  let docsDir: string
  let stateDir: string
  let app: Awaited<ReturnType<typeof createServer>>

  const TEST_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  const TRUSTED_HEADERS = {
    host: "localhost:3141",
    "x-naia-proxy-secret": TEST_SECRET,
    "x-naia-peer": "127.0.0.1",
    "x-naia-local": "127.0.0.1",
    "x-naia-origin-ok": "1",
  }

  const ENV_KEY = "NAIA_FAVORITES_FILE"
  let savedEnv: string | undefined

  const defaultFilePath = () => path.join(tempRoot, ".agents", "work", "doc-favorites.json")

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-favenv-root-"))
    docsDir = path.join(tempRoot, "docs")
    fs.mkdirSync(docsDir, { recursive: true })
    fs.writeFileSync(path.join(docsDir, "hello.md"), "# hello\n", "utf-8")

    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "adk-favenv-state-"))

    savedEnv = process.env[ENV_KEY]

    app = await createServer({
      root: tempRoot,
      port: 3141,
      host: "127.0.0.1",
    })
    ;(app as any).proxySecret = TEST_SECRET
  })

  afterAll(async () => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY]
    } else {
      process.env[ENV_KEY] = savedEnv
    }
    try {
      fs.chmodSync(tempRoot, 0o755)
    } catch {}
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch {}
    try {
      fs.rmSync(stateDir, { recursive: true, force: true })
    } catch {}
    await app.close()
  })

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY]
    } else {
      process.env[ENV_KEY] = savedEnv
    }
    try {
      fs.chmodSync(tempRoot, 0o755)
    } catch {}
  })

  describe("getFavoritesFilePath", () => {
    it("절대 경로 env면 그대로 반환한다", () => {
      const custom = path.join(stateDir, "custom-fav.json")
      expect(getFavoritesFilePath(tempRoot, { NAIA_FAVORITES_FILE: custom })).toBe(custom)
    })

    it("상대 경로 env면 adkRoot 기준으로 resolve한다", () => {
      expect(getFavoritesFilePath(tempRoot, { NAIA_FAVORITES_FILE: "state/fav.json" })).toBe(
        path.resolve(tempRoot, "state/fav.json"),
      )
    })

    it("빈/공백/미설정이면 기존 기본 경로로 폴백한다", () => {
      const def = defaultFilePath()
      expect(getFavoritesFilePath(tempRoot, {})).toBe(def)
      expect(getFavoritesFilePath(tempRoot, { NAIA_FAVORITES_FILE: "" })).toBe(def)
      expect(getFavoritesFilePath(tempRoot, { NAIA_FAVORITES_FILE: "   " })).toBe(def)
      expect(getFavoritesFilePath(tempRoot, { NAIA_FAVORITES_FILE: "  \t\n " })).toBe(def)
    })
  })

  describe("readFavoritesSecure / saveFavorites", () => {
    it("env 경로에 저장하고 읽으며 기본 경로 파일은 만들지 않는다", () => {
      const custom = path.join(stateDir, "roundtrip.json")
      try {
        fs.unlinkSync(defaultFilePath())
      } catch {}
      saveFavorites(
        tempRoot,
        { schemaVersion: 1, items: [] },
        { NAIA_FAVORITES_FILE: custom },
      )
      expect(fs.existsSync(custom)).toBe(true)
      expect(fs.existsSync(defaultFilePath())).toBe(false)
      expect(readFavoritesSecure(tempRoot, { NAIA_FAVORITES_FILE: custom })).toEqual({
        ok: true,
        data: { schemaVersion: 1, items: [] },
      })
    })

    it("env 경로가 심볼릭 링크면 거부한다 (O_NOFOLLOW 유지)", () => {
      const real = path.join(stateDir, "real-fav.json")
      fs.writeFileSync(real, JSON.stringify({ schemaVersion: 1, items: [] }), "utf-8")
      const link = path.join(stateDir, "link-fav.json")
      try {
        fs.unlinkSync(link)
      } catch {}
      fs.symlinkSync(real, link)
      expect(readFavoritesSecure(tempRoot, { NAIA_FAVORITES_FILE: link })).toEqual({
        ok: false,
        error: "favorites_file_invalid",
      })
      expect(fs.readFileSync(real, "utf-8")).toBe(
        JSON.stringify({ schemaVersion: 1, items: [] }),
      )
    })
  })

  describe("portal favorites API", () => {
    it("읽기 전용 adkRoot에서도 POST·GET·DELETE가 env 경로에 정상 동작한다", async () => {
      const custom = path.join(stateDir, "portal-fav.json")
      try {
        fs.unlinkSync(custom)
      } catch {}
      try {
        fs.unlinkSync(defaultFilePath())
      } catch {}
      // 앞선 시험이 기본 경로에 만든 디렉터리가 있으면 치워야
      // 읽기 전용 재현이 정확해진다(.agents/work가 남아 있으면 그 안은 쓰기 가능)
      try {
        fs.rmSync(path.join(tempRoot, ".agents"), { recursive: true, force: true })
      } catch {}

      process.env[ENV_KEY] = custom
      try {
        // 운영 ReadOnlyPaths 재현: adkRoot 쓰기 차단
        fs.chmodSync(tempRoot, 0o555)

        const postRes = await app.inject({
          method: "POST",
          url: "/api/portal/favorites",
          headers: {
            ...TRUSTED_HEADERS,
            "content-type": "application/json",
          },
          payload: {
            source: "adk",
            path: "hello.md",
          },
        })
        expect(postRes.statusCode).toBe(200)
        expect(JSON.parse(postRes.payload).ok).toBe(true)
      } finally {
        fs.chmodSync(tempRoot, 0o755)
      }

      // env 파일에 기록되고 기본 경로(및 그 .lock)는 생기지 않는다
      expect(fs.existsSync(custom)).toBe(true)
      expect(JSON.parse(fs.readFileSync(custom, "utf-8")).items.length).toBe(1)
      expect(fs.existsSync(defaultFilePath())).toBe(false)
      expect(fs.existsSync(`${defaultFilePath()}.lock`)).toBe(false)

      const getRes = await app.inject({
        method: "GET",
        url: "/api/portal/favorites",
        headers: TRUSTED_HEADERS,
      })
      expect(getRes.statusCode).toBe(200)
      expect(JSON.parse(getRes.payload).items.length).toBe(1)

      const delRes = await app.inject({
        method: "DELETE",
        url: "/api/portal/favorites",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "hello.md",
        },
      })
      expect(delRes.statusCode).toBe(200)
      expect(JSON.parse(fs.readFileSync(custom, "utf-8")).items).toEqual([])
      expect(fs.existsSync(defaultFilePath())).toBe(false)
    })
  })
})
