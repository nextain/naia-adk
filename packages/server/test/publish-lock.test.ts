import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { withPublishLock, isPublishPrivatePath } from "../src/publish-lock.js"
import { withDocWriteLock, buildTree, inspectSecureFile, resolveSecureDir, resolveSecureFile } from "../src/routes/portal.js"
import { FileLockTimeoutError } from "../src/file-lock.js"
import { createServer } from "../src/server.js"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const workerScript = `
  const { withPublishLock } = await import(process.argv[1]);
  const fs = await import('node:fs');
  try {
    process.send({ event: 'attempting' });
    await withPublishLock(async () => {
      process.send({ event: 'entered' });
      await new Promise((resolve) => process.once('message', resolve));
      if (process.argv[3]) {
        const value = Number(fs.readFileSync(process.argv[3], 'utf8'));
        await new Promise((resolve) => setTimeout(resolve, 15));
        fs.writeFileSync(process.argv[3], String(value + 1));
      }
    }, process.argv[2]);
    process.send({ event: 'released' });
    process.disconnect();
  } catch (error) {
    process.send({ event: 'error', name: error.name });
    process.disconnect();
    process.exitCode = 1;
  }
`

describe("게시 자료의 공통 잠금과 비공개 경로", () => {
  let root: string
  let state: string
  const children = new Set<ChildProcess>()
  let app: Awaited<ReturnType<typeof createServer>> | undefined
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-lock-"))
    state = path.join(root, "private-state")
    vi.stubEnv("PUBLISH_STATE_DIR", state)
    vi.stubEnv("PUBLISH_SIGNING_KEY_FILE", undefined)
  })
  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
        child.kill("SIGKILL")
        await exited
      }
    }
    children.clear()
    await app?.close()
    app = undefined
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  })

  function worker(counter = "") {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", workerScript,
      new URL("../src/publish-lock.ts", import.meta.url).href, state, counter], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    })
    children.add(child)
    const events: Array<{ event: string; name?: string }> = []
    const waiters = new Set<() => void>()
    let stderr = ""
    child.stderr!.on("data", (chunk) => { stderr += chunk })
    child.on("message", (message: any) => {
      events.push(message)
      for (const waiter of waiters) waiter()
    })
    return {
      child, events,
      wait(event: string): Promise<{ event: string; name?: string }> {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { waiters.delete(check); reject(new Error(`worker ${event} timeout: ${stderr}`)) }, 8_000)
          const check = () => {
            const found = events.find((value) => value.event === event)
            if (found) { clearTimeout(timeout); waiters.delete(check); resolve(found) }
          }
          waiters.add(check)
          check()
        })
      },
      release() { child.send("release") },
    }
  }

  it("설정이 없으면 보관소를 만들지 않고, 같은 처리 안의 재진입을 허용한다", async () => {
    vi.stubEnv("PUBLISH_STATE_DIR", undefined)
    expect(await withPublishLock(() => 7)).toBe(7)
    expect(fs.existsSync(state)).toBe(false)
    expect(await withPublishLock(() => withPublishLock(() => 9, state), state)).toBe(9)
  })

  it("서로 다른 프로세스가 같은 자료를 동시에 갱신하지 않는다", async () => {
    const counter = path.join(root, "counter")
    fs.writeFileSync(counter, "0")
    const first = worker(counter)
    await first.wait("entered")
    const second = worker(counter)
    await second.wait("attempting")
    await pause(120)
    expect(second.events).toEqual([{ event: "attempting" }])
    first.release()
    await first.wait("released")
    await second.wait("entered")
    second.release()
    await second.wait("released")
    expect(fs.readFileSync(counter, "utf8")).toBe("2")
  })

  it("오래된 잠금 파일이어도 살아 있는 소유자를 빼앗지 않고 제한 시간에 실패한다", async () => {
    const holder = worker()
    await holder.wait("entered")
    const old = new Date(Date.now() - 86_400_000)
    fs.utimesSync(path.join(state, "locks/bundle.lock"), old, old)
    let entered = false
    await expect(withPublishLock(() => { entered = true })).rejects.toBeInstanceOf(FileLockTimeoutError)
    expect(entered).toBe(false)
    expect(holder.child.exitCode).toBeNull()
    holder.release()
    await holder.wait("released")
  }, 10_000)

  it("소유자 강제 종료 뒤 남은 PID·시각과 무관하게 다시 잠근다", async () => {
    const holder = worker()
    await holder.wait("entered")
    const before = fs.readFileSync(path.join(state, "locks/bundle.lock"), "utf8")
    expect(JSON.parse(before).pid).toBe(holder.child.pid)
    const exited = new Promise<void>((resolve) => holder.child.once("exit", () => resolve()))
    holder.child.kill("SIGKILL")
    await exited
    expect(await withPublishLock(() => "recovered")).toBe("recovered")
    expect(JSON.parse(fs.readFileSync(path.join(state, "locks/bundle.lock"), "utf8")).pid).toBe(process.pid)
  })

  it("잠금 파일의 inode나 소유 token이 바뀌면 거절하고 대체 파일을 지우지 않는다", async () => {
    const lockPath = path.join(state, "locks/bundle.lock")
    await expect(withPublishLock(() => {
      fs.renameSync(lockPath, path.join(state, "original-lock"))
      fs.writeFileSync(lockPath, "replacement")
    })).rejects.toThrow("연결이 바뀌었습니다")
    expect(fs.readFileSync(lockPath, "utf8")).toBe("replacement")
    await expect(withPublishLock(() => {
      fs.writeFileSync(lockPath, JSON.stringify({ token: "different-owner" }))
    })).rejects.toThrow("소유자가 바뀌었습니다")
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).token).toBe("different-owner")
  })

  it("문서 저장 잠금이 승인 프로세스의 잠금을 기다린다", async () => {
    const article = path.join(root, "article")
    fs.mkdirSync(article)
    const document = path.join(article, "index.md")
    fs.writeFileSync(document, "# 원고\n")
    const holder = worker()
    await holder.wait("entered")
    let docEntered = false
    const doc = withDocWriteLock(document, async () => { docEntered = true })
    await pause(120)
    expect(docEntered).toBe(false)
    holder.release()
    await Promise.all([holder.wait("released"), doc])
    expect(docEntered).toBe(true)
  })

  it("링크·출처 별칭·미생성 파일의 실제 경로도 비공개로 판정한다", async () => {
    fs.mkdirSync(path.join(state, "objects"), { recursive: true, mode: 0o700 })
    const receipt = path.join(state, "objects/receipt.md")
    fs.writeFileSync(receipt, "private")
    const alias = path.join(root, "alias")
    fs.symlinkSync(state, alias)
    const key = path.join(root, "signing-key.md")
    fs.writeFileSync(key, "private key")
    vi.stubEnv("PUBLISH_SIGNING_KEY_FILE", key)
    fs.symlinkSync(key, path.join(root, "key-alias.md"))
    const source = { id: "alias", title: "별칭", baseDir: alias, allowedPrefixes: null }
    expect(isPublishPrivatePath(path.join(alias, "objects/new/index.md"))).toBe(true)
    expect(isPublishPrivatePath(path.join(root, "key-alias.md"))).toBe(true)
    expect(isPublishPrivatePath(`${state}-ordinary/file.md`)).toBe(false)
    expect(resolveSecureFile(source, "objects/receipt.md")).toEqual({ error: "not_found" })
    expect(resolveSecureDir(source, "")).toEqual({ error: "not_found" })
    expect(inspectSecureFile(receipt).ok).toBe(false)
    expect(buildTree(alias, "")).toEqual([])
  })

  it("일반 문서·그림 API·목록·쓰기에서 승인 보관소와 키를 숨긴다", async () => {
    const docs = path.join(root, "docs")
    state = path.join(docs, "vault")
    vi.stubEnv("PUBLISH_STATE_DIR", state)
    fs.mkdirSync(path.join(state, "reviews"), { recursive: true, mode: 0o700 })
    const receipt = path.join(state, "reviews/receipt.md")
    fs.writeFileSync(receipt, "# 비공개\n")
    fs.writeFileSync(path.join(state, "reviews/image.png"), png)
    const key = path.join(docs, "signing-key.md")
    fs.writeFileSync(key, "private key")
    vi.stubEnv("PUBLISH_SIGNING_KEY_FILE", key)
    fs.writeFileSync(path.join(docs, "public.md"), "# 공개\n")
    fs.symlinkSync(state, path.join(docs, "alias"))
    const company = path.join(root, "data-company/test-company")
    fs.mkdirSync(company, { recursive: true })
    fs.writeFileSync(path.join(company, "adk-company.json"), JSON.stringify({ schemaVersion: 1, title: "회사", docs: { include: [] }, repos: [{ id: "private-alias", path: "docs/vault", remote: "https://example.invalid/test.git", docs: { include: ["reviews"] } }] }))
    app = await createServer({ root, port: 3175, host: "127.0.0.1" })
    const secret = "publish-private-path-test"
    ;(app as any).proxySecret = secret
    const headers = { host: "localhost:3175", "x-naia-proxy-secret": secret, "x-naia-peer": "127.0.0.1", "x-naia-local": "1", "x-naia-origin-ok": "1" }
    for (const [source, relative] of [["adk", "vault/reviews/receipt.md"], ["adk", "alias/reviews/receipt.md"], ["private-alias", "reviews/receipt.md"], ["adk", "signing-key.md"]]) {
      const query = new URLSearchParams({ source, path: relative })
      const read = await app.inject({ url: `/api/portal/doc?${query}`, headers })
      expect(read.statusCode).toBe(404)
      const write = await app.inject({ method: "PUT", url: `/api/portal/doc?${query}`, headers, payload: { content: "overwrite", baseHash: crypto.createHash("sha256").update(fs.readFileSync(relative === "signing-key.md" ? key : receipt)).digest("hex") } })
      expect(write.statusCode).toBe(404)
    }
    const image = await app.inject({ url: "/api/portal/asset?source=adk&path=vault/reviews/image.png", headers })
    expect(image.statusCode).toBe(404)
    const folder = await app.inject({ url: "/api/portal/folder?source=private-alias&path=reviews", headers })
    expect(folder.statusCode).toBe(404)
    expect(buildTree(docs, "").map((entry) => entry.name)).toEqual(["public.md"])
    expect(fs.readFileSync(receipt, "utf8")).toBe("# 비공개\n")
    expect(fs.readFileSync(key, "utf8")).toBe("private key")
  })
})
