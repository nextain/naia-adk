import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { createServer } from "../src/server.js"

describe("Portal doc overlay (/api/portal/doc + /api/portal/docs)", () => {
  const TEST_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  const READ_HEADERS = {
    host: "localhost:3141",
    "x-naia-proxy-secret": TEST_SECRET,
    "x-naia-peer": "127.0.0.1",
    "x-naia-local": "127.0.0.1",
  }
  const WRITE_HEADERS = {
    ...READ_HEADERS,
    "x-naia-origin-ok": "1",
    "content-type": "application/json",
  }

  let tempRoot: string
  let overlayFile: string
  let app: Awaited<ReturnType<typeof createServer>>
  let prevOverlayEnv: string | undefined

  const ORIGINAL = "# 원본 문서\n원본 내용\n"

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-overlay-"))
    overlayFile = path.join(tempRoot, "overlay.sqlite")
    fs.mkdirSync(path.join(tempRoot, "docs"), { recursive: true })
    fs.writeFileSync(path.join(tempRoot, "docs", "guide.md"), ORIGINAL, "utf-8")

    prevOverlayEnv = process.env.NAIA_AX_DOC_STORE
    process.env.NAIA_AX_DOC_STORE = overlayFile
    app = await createServer({ root: tempRoot, port: 3141, host: "127.0.0.1" })
    ;(app as any).proxySecret = TEST_SECRET
  })

  afterAll(async () => {
    await app.close()
    if (prevOverlayEnv === undefined) delete process.env.NAIA_AX_DOC_STORE
    else process.env.NAIA_AX_DOC_STORE = prevOverlayEnv
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  const putDoc = (content: string, baseHash: string) =>
    app.inject({
      method: "PUT",
      url: "/api/portal/doc?source=adk&path=guide.md",
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ content, baseHash }),
    })

  const putDocAt = (source: string, docPath: string, content: string, baseHash: string) =>
    app.inject({
      method: "PUT",
      url: `/api/portal/doc?source=${encodeURIComponent(source)}&path=${encodeURIComponent(docPath)}`,
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ content, baseHash }),
    })

  const getDocAt = (source: string, docPath: string, headers = READ_HEADERS) =>
    app.inject({
      method: "GET",
      url: `/api/portal/doc?source=${encodeURIComponent(source)}&path=${encodeURIComponent(docPath)}`,
      headers,
    })

  const sha256 = (text: string) => crypto.createHash("sha256").update(text, "utf-8").digest("hex")

  it("PUT writes git + overlay; GET serves the overlay first", async () => {
    const baseHash = crypto.createHash("sha256").update(ORIGINAL, "utf-8").digest("hex")
    const updated = "# 고친 문서\n고친 내용\n"
    const put = await putDoc(updated, baseHash)
    expect(put.statusCode).toBe(200)

    const get = await app.inject({ method: "GET", url: "/api/portal/doc?source=adk&path=guide.md", headers: READ_HEADERS })
    expect(get.statusCode).toBe(200)
    expect(get.body).toBe(updated)
    expect(get.headers["x-doc-source"]).toBe("overlay")
    expect(typeof get.headers["x-overlay-updated-at"]).toBe("string")
  })

  it("a git reset underneath never loses the AX edit; revisions accumulate", async () => {
    // Simulate `git reset --hard`: the checkout baseline is clobbered.
    fs.writeFileSync(path.join(tempRoot, "docs", "guide.md"), ORIGINAL, "utf-8")

    const get = await app.inject({ method: "GET", url: "/api/portal/doc?source=adk&path=guide.md", headers: READ_HEADERS })
    expect(get.statusCode).toBe(200)
    expect(get.body).toBe("# 고친 문서\n고친 내용\n")
    expect(get.headers["x-doc-source"]).toBe("overlay")

    const second = "# 두 번째 고침\n추가 내용\n"
    const overlayHash = crypto.createHash("sha256").update("# 고친 문서\n고친 내용\n", "utf-8").digest("hex")
    const put = await putDoc(second, overlayHash)
    expect(put.statusCode).toBe(200)

    const list = await app.inject({ method: "GET", url: "/api/portal/docs", headers: READ_HEADERS })
    expect(list.statusCode).toBe(200)
    const json = JSON.parse(list.body)
    expect(json.overlays).toHaveLength(1)
    expect(json.overlays[0]).toMatchObject({ source: "adk", path: "guide.md", revision: 2 })
  })

  it("unavailable overlay store fails closed (5xx, never 200)", async () => {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "adk-overlay-down-"))
    fs.mkdirSync(path.join(root2, "docs"), { recursive: true })
    fs.writeFileSync(path.join(root2, "docs", "seed.md"), "# 씨앗\n", "utf-8")
    const blocker = path.join(root2, "blocker")
    fs.writeFileSync(blocker, "not a directory", "utf-8")
    const prev = process.env.NAIA_AX_DOC_STORE
    process.env.NAIA_AX_DOC_STORE = path.join(blocker, "overlay.sqlite")
    let app2: Awaited<ReturnType<typeof createServer>> | null = null
    try {
      app2 = await createServer({ root: root2, port: 3141, host: "127.0.0.1" })
      ;(app2 as any).proxySecret = TEST_SECRET
      const put = await app2.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=seed.md",
        headers: WRITE_HEADERS,
        payload: JSON.stringify({ content: "# 고침\n", baseHash: sha256("# 씨앗\n") }),
      })
      expect([500, 503]).toContain(put.statusCode)
      expect(put.statusCode).not.toBe(200)
      const get = await app2.inject({ method: "GET", url: "/api/portal/doc?source=adk&path=seed.md", headers: READ_HEADERS })
      expect([500, 503]).toContain(get.statusCode)
      expect(get.statusCode).not.toBe(200)
    } finally {
      if (app2) await app2.close()
      if (prev === undefined) delete process.env.NAIA_AX_DOC_STORE
      else process.env.NAIA_AX_DOC_STORE = prev
      fs.rmSync(root2, { recursive: true, force: true })
    }
  })

  it("empty string saves, serves, and re-edits cleanly (200, zero 409)", async () => {
    fs.writeFileSync(path.join(tempRoot, "docs", "empty.md"), "초기 본문\n", "utf-8")
    const putEmpty = await putDocAt("adk", "empty.md", "", sha256("초기 본문\n"))
    expect(putEmpty.statusCode).toBe(200)
    expect(putEmpty.headers["x-doc-source"]).toBe("overlay")
    expect(typeof putEmpty.headers["x-overlay-updated-at"]).toBe("string")
    const get = await getDocAt("adk", "empty.md")
    expect(get.statusCode).toBe(200)
    expect(get.body).toBe("")
    expect(get.headers["x-doc-source"]).toBe("overlay")
    expect(get.headers["etag"]).toBe(sha256(""))
    expect(typeof get.headers["x-overlay-updated-at"]).toBe("string")
    // Baseline was overwritten underneath; editing again from the overlay ETag works.
    fs.writeFileSync(path.join(tempRoot, "docs", "empty.md"), "초기 본문\n", "utf-8")
    const reedit = await putDocAt("adk", "empty.md", "다시 채움\n", sha256(""))
    expect(reedit.statusCode).toBe(200)
    const get2 = await getDocAt("adk", "empty.md")
    expect(get2.statusCode).toBe(200)
    expect(get2.body).toBe("다시 채움\n")
  })

  it("stale overlay rows stop serving when a source or folder is gone", async () => {
    const coDir = path.join(tempRoot, "data-company", "co-bound")
    fs.mkdirSync(path.join(coDir, "allowed"), { recursive: true })
    fs.mkdirSync(path.join(coDir, "other"), { recursive: true })
    const config = (include: string[]) =>
      fs.writeFileSync(path.join(coDir, "adk-company.json"), JSON.stringify({ schemaVersion: 1, title: "경계", docs: { include } }))
    config(["allowed"])
    fs.writeFileSync(path.join(coDir, "allowed", "note.md"), "원본\n", "utf-8")
    const put = await putDocAt("company:co-bound", "allowed/note.md", "고침\n", sha256("원본\n"))
    expect(put.statusCode).toBe(200)
    const get1 = await getDocAt("company:co-bound", "allowed/note.md")
    expect(get1.statusCode).toBe(200)
    expect(get1.body).toBe("고침\n")
    // Restrict the allowed folder: the cached row must disappear (404, not overlay).
    config(["other"])
    const get2 = await getDocAt("company:co-bound", "allowed/note.md")
    expect(get2.statusCode).toBe(404)
    expect(get2.body).not.toContain("고침")
    const list = await app.inject({ method: "GET", url: "/api/portal/docs", headers: READ_HEADERS })
    expect(list.statusCode).toBe(200)
    const rows = JSON.parse(list.body).overlays as any[]
    expect(rows.some((r) => r.source === "company:co-bound")).toBe(false)
    // Untouched sources keep serving.
    const adk = await getDocAt("adk", "guide.md")
    expect(adk.statusCode).toBe(200)
    // Removing the source entirely also hides its rows.
    fs.rmSync(coDir, { recursive: true, force: true })
    const get3 = await getDocAt("company:co-bound", "allowed/note.md")
    expect(get3.statusCode).toBe(404)
  })

  it("failed overlay write returns 5xx with zero checkout writes", async () => {
    const docPath = path.join(tempRoot, "docs", "fragile.md")
    fs.writeFileSync(docPath, "원본\n", "utf-8")
    const baseHash = sha256("원본\n")
    // 이력 insert를 막는 트리거: overlay 트랜잭션이 값 검증 뒤에 실패한다.
    const raw = new DatabaseSync(overlayFile)
    raw.exec("CREATE TRIGGER no_history BEFORE INSERT ON doc_revisions BEGIN SELECT RAISE(ABORT, 'history blocked'); END;")
    try {
      const put = await putDocAt("adk", "fragile.md", "바뀜\n", baseHash)
      expect([500, 503]).toContain(put.statusCode)
      expect(put.statusCode).not.toBe(200)
      // 거절된 편집이 체크아웃에 남지 않는다.
      expect(fs.readFileSync(docPath, "utf-8")).toBe("원본\n")
      expect(fs.readdirSync(path.join(tempRoot, "docs")).filter((n) => n.startsWith(".tmp-"))).toEqual([])
    } finally {
      raw.exec("DROP TRIGGER IF EXISTS no_history")
      raw.close()
    }
    // 트리거를 걷으면 같은 PUT이 그대로 성공한다.
    const retry = await putDocAt("adk", "fragile.md", "바뀜\n", baseHash)
    expect(retry.statusCode).toBe(200)
    expect(retry.headers["x-doc-source"]).toBe("overlay")
  })

  it("stale overlay CAS conflict returns 409 with zero checkout writes", async () => {
    const docPath = path.join(tempRoot, "docs", "cas-guard.md")
    fs.writeFileSync(docPath, "원본\n", "utf-8")
    const first = await putDocAt("adk", "cas-guard.md", "첫 고침\n", sha256("원본\n"))
    expect(first.statusCode).toBe(200)
    // 낡은 baseHash로 다시 저장: 오버레이 CAS에서 409, 체크아웃은 첫 고침 그대로.
    const stale = await putDocAt("adk", "cas-guard.md", "낡은 고침\n", sha256("원본\n"))
    expect(stale.statusCode).toBe(409)
    expect(fs.readFileSync(docPath, "utf-8")).toBe("첫 고침\n")
  })

  it("before-rename race 409 rolls back the overlay: checkout and GET keep the external edit", async () => {
    const docPath = path.join(tempRoot, "docs", "race-rollback.md")
    const initialStr = "1234567890\n"
    fs.writeFileSync(docPath, initialStr, "utf-8")
    const baseHash = sha256(initialStr)
    const tamperedStr = "abcdefghij\n"
    // rename 직전 훅이 같은 길이의 다른 바이트를 덮어쓴다: PUT은 409이고
    // 오버레이 커밋까지 되돌려 다음 GET이 거부된 AX 편집이 아니라 외부 편집을 내놓는다.
    const hookApp = await createServer({
      root: tempRoot,
      port: 3177,
      host: "127.0.0.1",
      beforeRenameHook: async () => {
        fs.writeFileSync(docPath, tamperedStr, "utf-8")
      },
    })
    ;(hookApp as any).proxySecret = TEST_SECRET
    try {
      const put = await hookApp.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=race-rollback.md",
        headers: { ...WRITE_HEADERS, host: "localhost:3177" },
        payload: JSON.stringify({ content: "rejected ax edit\n", baseHash }),
      })
      expect(put.statusCode).toBe(409)
      expect(JSON.parse(put.body)).toEqual({ error: "changed" })
      expect(fs.readFileSync(docPath, "utf-8")).toBe(tamperedStr)
      const get = await hookApp.inject({
        method: "GET",
        url: "/api/portal/doc?source=adk&path=race-rollback.md",
        headers: { ...READ_HEADERS, host: "localhost:3177" },
      })
      expect(get.statusCode).toBe(200)
      expect(get.body).toBe(tamperedStr)
      expect(get.headers["x-doc-source"]).toBe("git")
    } finally {
      await hookApp.close()
    }
  })

  it("a failed overlay rollback answers 500, never a clean 409", async () => {
    const docPath = path.join(tempRoot, "docs", "rollback-fail.md")
    const initialStr = "1234567890\n"
    fs.writeFileSync(docPath, initialStr, "utf-8")
    const baseHash = sha256(initialStr)
    const tamperedStr = "abcdefghij\n"
    // 이력 삭제를 막는 트리거: 되돌림이 값 검증 뒤에 실패한다.
    const raw = new DatabaseSync(overlayFile)
    raw.exec("CREATE TRIGGER no_rollback_delete BEFORE DELETE ON doc_revisions BEGIN SELECT RAISE(ABORT, 'delete blocked'); END;")
    const hookApp = await createServer({
      root: tempRoot,
      port: 3178,
      host: "127.0.0.1",
      beforeRenameHook: async () => {
        fs.writeFileSync(docPath, tamperedStr, "utf-8")
      },
    })
    ;(hookApp as any).proxySecret = TEST_SECRET
    try {
      const put = await hookApp.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=rollback-fail.md",
        headers: { ...WRITE_HEADERS, host: "localhost:3178" },
        payload: JSON.stringify({ content: "rejected ax edit\n", baseHash }),
      })
      expect(put.statusCode).toBe(500)
      expect(JSON.parse(put.body).error).toBe("overlay_rollback_failed")
    } finally {
      try {
        await hookApp.close()
      } catch {}
      raw.exec("DROP TRIGGER IF EXISTS no_rollback_delete")
      raw.close()
    }
  })

  it("PUT to a restricted folder returns 403 even with a stale baseHash, never 409", async () => {
    const coDir = path.join(tempRoot, "data-company", "co-locked")
    fs.mkdirSync(path.join(coDir, "allowed"), { recursive: true })
    fs.mkdirSync(path.join(coDir, "other"), { recursive: true })
    const config = (include: string[]) =>
      fs.writeFileSync(path.join(coDir, "adk-company.json"), JSON.stringify({ schemaVersion: 1, title: "잠금", docs: { include } }))
    try {
      config(["allowed"])
      fs.writeFileSync(path.join(coDir, "allowed", "note.md"), "원본\n", "utf-8")
      const put = await putDocAt("company:co-locked", "allowed/note.md", "고침\n", sha256("원본\n"))
      expect(put.statusCode).toBe(200)
      // 허용 폴더를 좁히면 낡은 오버레이 행이 있어도 403이다(ETag 409 누출 금지).
      config(["other"])
      const stale = await putDocAt("company:co-locked", "allowed/note.md", "바꿈\n", sha256("낡은해시\n"))
      expect(stale.statusCode).toBe(403)
      const current = await putDocAt("company:co-locked", "allowed/note.md", "바꿈\n", sha256("고침\n"))
      expect(current.statusCode).toBe(403)
      // 좁혀진 뒤에는 체크아웃도 건드리지 않는다.
      expect(fs.readFileSync(path.join(coDir, "allowed", "note.md"), "utf-8")).toBe("고침\n")
    } finally {
      fs.rmSync(coDir, { recursive: true, force: true })
    }
  })

  it("PUT rejects a symlinked checkout target even when an overlay row exists", async () => {
    const docPath = path.join(tempRoot, "docs", "link-guard.md")
    fs.writeFileSync(docPath, "원본\n", "utf-8")
    const first = await putDocAt("adk", "link-guard.md", "오버레이\n", sha256("원본\n"))
    expect(first.statusCode).toBe(200)
    const overlayHash = sha256("오버레이\n")
    // 체크아웃 파일을 바깥 파일을 가리키는 심볼릭 링크로 바꾼다.
    fs.rmSync(docPath)
    fs.writeFileSync(path.join(tempRoot, "outside-target.md"), "바깥\n", "utf-8")
    fs.symlinkSync(path.join(tempRoot, "outside-target.md"), docPath)
    try {
      const put = await putDocAt("adk", "link-guard.md", "바꿈\n", overlayHash)
      expect(put.statusCode).toBe(404)
      // 링크는 그대로 두고 바깥 파일에도 쓰지 않는다.
      expect(fs.lstatSync(docPath).isSymbolicLink()).toBe(true)
      expect(fs.readFileSync(path.join(tempRoot, "outside-target.md"), "utf-8")).toBe("바깥\n")
    } finally {
      fs.rmSync(docPath)
      fs.rmSync(path.join(tempRoot, "outside-target.md"))
    }
  })

  it("read-only fallback still verifies the checkout descriptor when an overlay row exists", async () => {
    const docPath = path.join(tempRoot, "docs", "ro-guard.md")
    fs.writeFileSync(docPath, "원본\n", "utf-8")
    const first = await putDocAt("adk", "ro-guard.md", "오버레이\n", sha256("원본\n"))
    expect(first.statusCode).toBe(200)
    const overlayHash = sha256("오버레이\n")
    // 읽을 수 없게 막으면 주 분기가 EACCES로 떨어지고 대체 분기로 간다.
    fs.chmodSync(docPath, 0o000)
    try {
      const put = await putDocAt("adk", "ro-guard.md", "바꿈\n", overlayHash)
      // 오버레이 행이 있어도 기술자 검사를 건너뛰지 않으므로 200이 아니다.
      expect(put.statusCode).not.toBe(200)
      expect(put.statusCode).toBe(404)
    } finally {
      fs.chmodSync(docPath, 0o644)
    }
  })

  it("rejects path traversal and hides overlay/docs/decisions from untrusted callers", async () => {
    const evil = await app.inject({
      method: "PUT",
      url: "/api/portal/doc?source=adk&path=../outside.md",
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ content: "x", baseHash: "y" }),
    })
    expect([400, 403, 404]).toContain(evil.statusCode)

    const publicDocs = await app.inject({ method: "GET", url: "/api/portal/docs", headers: { host: "localhost:3141" } })
    expect(publicDocs.statusCode).toBe(403)

    const publicDecisions = await app.inject({ method: "GET", url: "/api/portal/decisions", headers: { host: "localhost:3141" } })
    expect(publicDecisions.statusCode).toBe(403)
  })
})
