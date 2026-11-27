import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { createServer } from "../src/server.js"
import { DOC_ASSET_BODY_LIMIT, DOC_ASSET_BUNDLE_LIMIT } from "../src/doc-assets.js"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")
const secret = "portal-doc-asset-test-secret"
const headers = { host: "localhost:3175", "content-type": "application/octet-stream", "x-naia-proxy-secret": secret, "x-naia-peer": "127.0.0.1", "x-naia-local": "1", "x-naia-origin-ok": "1" }
const isExistingRead = (target: unknown, flags: unknown) => typeof target === "string" && path.basename(target) === "my-picture.png"
  && typeof flags === "number" && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND)) === 0

describe("문서 그림 올리기", () => {
  let root: string
  let folder: string
  let app: Awaited<ReturnType<typeof createServer>>
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "portal-doc-asset-"))
    folder = path.join(root, "docs", "article")
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, "index.md"), "# 원고\n")
    app = await createServer({ root, port: 3175, host: "127.0.0.1" })
    ;(app as any).proxySecret = secret
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await app.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const url = (name = "My Picture.png", doc = "article/index.md", source = "adk") => `/api/portal/doc-assets?${new URLSearchParams({ source, path: doc, name })}`
  const upload = (name?: string, payload = png, doc?: string) => app.inject({ method: "POST", url: url(name, doc), headers, payload })

  it("그림을 만들고 문서 기준 상대 경로·크기·지문을 돌려준다", async () => {
    const response = await upload()
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ path: "assets/my-picture.png", size: png.length, sha256: crypto.createHash("sha256").update(png).digest("hex") })
    expect(fs.readFileSync(path.join(folder, "assets/my-picture.png"))).toEqual(png)
    expect(fs.readFileSync(path.join(folder, "index.md"), "utf8")).toBe("# 원고\n")
    expect(fs.readdirSync(path.join(folder, "assets"))).toEqual(["my-picture.png"])
    const preview = await app.inject({ url: "/api/portal/asset?source=adk&path=article/assets/my-picture.png", headers })
    expect(preview.statusCode).toBe(200)
    expect(preview.rawPayload).toEqual(png)
  })
  it("같은 이름과 바이트는 기존 파일을 재사용한다", async () => {
    const first = await upload()
    const second = await upload()
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual(first.json())
    expect(fs.readdirSync(path.join(folder, "assets"))).toEqual(["my-picture.png"])
  })
  it.each(["다른 파일", "링크"])("쓰기 직후 임시 이름이 %s로 바뀌면 연결하지 않고 대체 파일을 보존한다", async (replacement) => {
    const moved = path.join(root, "original-upload.png")
    const other = path.join(root, "other.png")
    const different = Buffer.from(png)
    different[different.length - 1] ^= 1
    fs.writeFileSync(other, different)
    const open = fs.openSync
    const write = fs.writeFileSync
    let temporary: string | undefined
    let temporaryFd: number | undefined
    let swapped = false
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      const fd = open(target, flags, mode)
      if (typeof target === "string" && path.basename(target).startsWith(".upload-")) { temporary = target; temporaryFd = fd }
      return fd
    })
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
      write(target, data, options)
      if (target === temporaryFd) {
        swapped = true
        fs.renameSync(temporary!, moved)
        if (replacement === "다른 파일") write(temporary!, different)
        else fs.symlinkSync(other, temporary!)
      }
    })
    const link = vi.spyOn(fs, "linkSync")
    const response = await upload()
    expect(swapped).toBe(true)
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: "path_escape", message: expect.stringContaining("확인한 뒤 다시 올려 주세요") })
    expect(link).not.toHaveBeenCalled()
    expect(fs.readFileSync(moved)).toEqual(png)
    expect(fs.readFileSync(other)).toEqual(different)
    const replacementPath = path.join(folder, "assets", path.basename(temporary!))
    expect(fs.readFileSync(replacementPath)).toEqual(different)
    expect(fs.lstatSync(replacementPath).isSymbolicLink()).toBe(replacement === "링크")
    expect(fs.readdirSync(path.join(folder, "assets"))).toEqual([path.basename(temporary!)])
    expect(() => fs.fstatSync(temporaryFd!)).toThrow()
  })
  it.each([
    ["연결 전", "다른 파일"], ["연결 전", "링크"],
    ["연결 후", "다른 파일"], ["연결 후", "링크"],
  ])("임시 이름이 검사 뒤 %s %s로 바뀌면 성공을 거절하고 이번 연결만 정리한다", async (timing, replacement) => {
    const moved = path.join(root, "original-upload.png")
    const other = path.join(root, "other.png")
    const different = Buffer.from(png)
    different[different.length - 1] ^= 1
    fs.writeFileSync(other, different)
    const open = fs.openSync
    const link = fs.linkSync
    let temporary: string | undefined
    let temporaryFd: number | undefined
    let openedDuringLink = false
    let swapped = false
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      const fd = open(target, flags, mode)
      if (typeof target === "string" && path.basename(target).startsWith(".upload-")) temporaryFd = fd
      return fd
    })
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      temporary = source as string
      try { openedDuringLink = fs.fstatSync(temporaryFd!).isFile() } catch {}
      const swap = () => {
        swapped = true
        fs.renameSync(source, moved)
        if (replacement === "다른 파일") fs.writeFileSync(source, different)
        else fs.symlinkSync(other, source)
      }
      if (timing === "연결 전") swap()
      link(source, destination)
      if (timing === "연결 후") swap()
    })
    const response = await upload()
    expect(swapped).toBe(true)
    expect(response.statusCode).toBe(403)
    expect(openedDuringLink).toBe(true)
    expect(response.json()).toMatchObject({ error: "path_escape", message: expect.stringContaining("확인한 뒤 다시 올려 주세요") })
    expect(fs.readFileSync(moved)).toEqual(png)
    expect(fs.readFileSync(other)).toEqual(different)
    const replacementPath = path.join(folder, "assets", path.basename(temporary!))
    expect(fs.readFileSync(replacementPath)).toEqual(different)
    expect(fs.lstatSync(replacementPath).isSymbolicLink()).toBe(replacement === "링크")
    expect(fs.readdirSync(path.join(folder, "assets"))).toEqual([path.basename(temporary!)])
    expect(() => fs.fstatSync(temporaryFd!)).toThrow()
  })
  it.each(["다른 파일", "링크", "삭제"])("연결 직후 완성 이름이 %s로 바뀌면 거절하고 다른 요청의 이름을 보존한다", async (replacement) => {
    const moved = path.join(root, "original-upload.png")
    const other = path.join(root, "other.png")
    const different = Buffer.from(png)
    different[different.length - 1] ^= 1
    fs.writeFileSync(other, different)
    const link = fs.linkSync
    let swapped = false
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      link(source, destination)
      swapped = true
      fs.renameSync(destination, moved)
      if (replacement === "다른 파일") fs.writeFileSync(destination, different)
      if (replacement === "링크") fs.symlinkSync(other, destination)
    })
    const response = await upload()
    expect(swapped).toBe(true)
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: "path_escape", message: expect.stringContaining("확인한 뒤 다시 올려 주세요") })
    expect(fs.readFileSync(moved)).toEqual(png)
    expect(fs.readFileSync(other)).toEqual(different)
    const destination = path.join(folder, "assets/my-picture.png")
    if (replacement === "삭제") expect(fs.readdirSync(path.join(folder, "assets"))).toEqual([])
    else {
      expect(fs.readdirSync(path.join(folder, "assets"))).toEqual(["my-picture.png"])
      expect(fs.readFileSync(destination)).toEqual(different)
      expect(fs.lstatSync(destination).isSymbolicLink()).toBe(replacement === "링크")
    }
  })
  it.each(["다른 파일", "링크"])("연결 identity를 확인한 뒤 완성 이름이 %s로 바뀌어도 재검사하고 보존한다", async (replacement) => {
    const destination = path.join(folder, "assets/my-picture.png")
    const moved = path.join(root, "original-upload.png")
    const other = path.join(root, "other.png")
    const different = Buffer.from(png)
    different[different.length - 1] ^= 1
    fs.writeFileSync(other, different)
    const open = fs.openSync
    const link = fs.linkSync
    const fstat = fs.fstatSync
    let temporaryFd: number | undefined
    let linked = false
    let swapped = false
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      const fd = open(target, flags, mode)
      if (typeof target === "string" && path.basename(target).startsWith(".upload-")) temporaryFd = fd
      return fd
    })
    vi.spyOn(fs, "linkSync").mockImplementation((source, target) => { link(source, target); linked = true })
    vi.spyOn(fs, "fstatSync").mockImplementation((fd: any, options?: any): any => {
      const stat = fstat(fd, options)
      if (!swapped && linked && fd === temporaryFd) {
        swapped = true
        fs.renameSync(destination, moved)
        if (replacement === "다른 파일") fs.writeFileSync(destination, different)
        else fs.symlinkSync(other, destination)
      }
      return stat
    })
    const response = await upload()
    expect(swapped).toBe(true)
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: "path_escape", message: expect.stringContaining("확인한 뒤 다시 올려 주세요") })
    expect(fs.readFileSync(moved)).toEqual(png)
    expect(fs.readFileSync(other)).toEqual(different)
    expect(fs.readFileSync(destination)).toEqual(different)
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(replacement === "링크")
    expect(fs.readdirSync(path.join(folder, "assets"))).toEqual(["my-picture.png"])
    expect(() => fs.fstatSync(temporaryFd!)).toThrow()
  })
  it("기존 파일을 나누어 읽어도 모든 바이트를 비교하고 파일을 닫는다", async () => {
    await upload()
    const open = fs.openSync
    const read = fs.readSync
    let existingFd: number | undefined
    let existingFlags = 0
    let readBytes = 0
    let readCalls = 0
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      const fd = open(target, flags, mode)
      if (existingFd === undefined && isExistingRead(target, flags)) { existingFd = fd; existingFlags = flags as number }
      return fd
    })
    vi.spyOn(fs, "readSync").mockImplementation((fd: any, buffer: any, offset?: any, length?: any, position?: any): any => {
      const count = read(fd, buffer, offset, fd === existingFd ? Math.min(length, 7) : length, position)
      if (fd === existingFd) { readCalls++; readBytes += count }
      return count
    })
    const response = await upload()
    expect(response.statusCode).toBe(200)
    expect(response.json().path).toBe("assets/my-picture.png")
    expect(readCalls).toBeGreaterThan(1)
    expect(readBytes).toBe(png.length)
    expect(existingFd).toBeTypeOf("number")
    expect(existingFlags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK)
    if (fs.constants.O_NOFOLLOW) expect(existingFlags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW)
    expect(() => fs.fstatSync(existingFd!)).toThrow()
  })
  it.each(["다른 파일", "추가 하드 링크"])("열기 직전 %s로 바뀐 파일은 읽거나 재사용하지 않는다", async (replacement) => {
    await upload()
    const destination = path.join(folder, "assets/my-picture.png")
    const open = fs.openSync
    let existingFd: number | undefined
    let swapped = false
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      if (!swapped && isExistingRead(target, flags)) {
        swapped = true
        if (replacement === "다른 파일") {
          fs.renameSync(destination, path.join(root, "original.png"))
          fs.writeFileSync(destination, png)
        } else fs.linkSync(destination, path.join(root, "linked.png"))
        existingFd = open(target, flags, mode)
        return existingFd
      }
      return open(target, flags, mode)
    })
    const read = vi.spyOn(fs, "readSync")
    const readFile = vi.spyOn(fs, "readFileSync")
    const response = await upload()
    expect(swapped).toBe(true)
    expect(response.statusCode).toBe(200)
    expect(response.json().path).toBe("assets/my-picture-2.png")
    expect(existingFd).toBeTypeOf("number")
    expect(read.mock.calls.some(([fd]) => fd === existingFd)).toBe(false)
    expect(readFile.mock.calls.some(([fd]) => fd === existingFd)).toBe(false)
    expect(() => fs.fstatSync(existingFd!)).toThrow()
    expect(fs.readFileSync(destination)).toEqual(png)
    expect(fs.readFileSync(path.join(folder, "assets/my-picture-2.png"))).toEqual(png)
  })
  it.each(["다른 파일", "링크", "삭제"])("중복 파일을 연 뒤 이름 자리가 %s로 바뀌면 다음 이름을 쓴다", async (replacement) => {
    await upload()
    const destination = path.join(folder, "assets/my-picture.png")
    const moved = path.join(root, "original.png")
    const different = Buffer.concat([png, Buffer.from("다른 그림")])
    const open = fs.openSync
    let existingFd: number | undefined
    let swapped = false
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      const fd = open(target, flags, mode)
      if (!swapped && isExistingRead(target, flags)) {
        swapped = true
        existingFd = fd
        fs.renameSync(destination, moved)
        if (replacement === "다른 파일") fs.writeFileSync(destination, different)
        if (replacement === "링크") fs.symlinkSync(moved, destination)
      }
      return fd
    })
    const response = await upload()
    expect(swapped).toBe(true)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ path: "assets/my-picture-2.png", size: png.length, sha256: crypto.createHash("sha256").update(png).digest("hex") })
    expect(fs.readFileSync(moved)).toEqual(png)
    expect(fs.readFileSync(path.join(folder, "assets/my-picture-2.png"))).toEqual(png)
    expect(() => fs.fstatSync(existingFd!)).toThrow()
    if (replacement === "다른 파일") expect(fs.readFileSync(destination)).toEqual(different)
    if (replacement === "링크") expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true)
    if (replacement === "삭제") expect(fs.existsSync(destination)).toBe(false)
  })
  it.each(["증가", "감소"])("열린 파일의 크기가 %s하면 읽기 전에 다음 이름으로 저장한다", async (change) => {
    await upload()
    const destination = path.join(folder, "assets/my-picture.png")
    const open = fs.openSync
    let existingFd: number | undefined
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      const fd = open(target, flags, mode)
      if (existingFd === undefined && isExistingRead(target, flags)) {
        existingFd = fd
        if (change === "증가") fs.appendFileSync(destination, "추가")
        else fs.truncateSync(destination, png.length - 1)
      }
      return fd
    })
    const read = vi.spyOn(fs, "readSync")
    const readFile = vi.spyOn(fs, "readFileSync")
    const response = await upload()
    expect(response.statusCode).toBe(200)
    expect(response.json().path).toBe("assets/my-picture-2.png")
    expect(existingFd).toBeTypeOf("number")
    expect(read.mock.calls.some(([fd]) => fd === existingFd)).toBe(false)
    expect(readFile.mock.calls.some(([fd]) => fd === existingFd)).toBe(false)
    expect(() => fs.fstatSync(existingFd!)).toThrow()
    expect(fs.statSync(destination).size).toBe(change === "증가" ? png.length + Buffer.byteLength("추가") : png.length - 1)
    expect(fs.readFileSync(path.join(folder, "assets/my-picture-2.png"))).toEqual(png)
  })
  it.each(["열린 크기 확인 직후", "읽는 도중"])("%s 커져도 업로드 길이만 읽고 기존 파일을 재사용하지 않는다", async (timing) => {
    await upload()
    const destination = path.join(folder, "assets/my-picture.png")
    const open = fs.openSync
    const fstat = fs.fstatSync
    const read = fs.readSync
    let existingFd: number | undefined
    let grown = false
    const reads: { capacity: number; offset: number; length: number; position: number; count: number }[] = []
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      const fd = open(target, flags, mode)
      if (existingFd === undefined && isExistingRead(target, flags)) existingFd = fd
      return fd
    })
    vi.spyOn(fs, "fstatSync").mockImplementation((fd: any, options?: any): any => {
      const stat = fstat(fd, options)
      if (fd === existingFd && !grown && timing === "열린 크기 확인 직후") {
        grown = true
        fs.appendFileSync(destination, Buffer.alloc(png.length, 120))
      }
      return stat
    })
    vi.spyOn(fs, "readSync").mockImplementation((fd: any, buffer: any, offset?: any, length?: any, position?: any): any => {
      if (fd !== existingFd) return read(fd, buffer, offset, length, position)
      const count = read(fd, buffer, offset, Math.min(length, 7), position)
      reads.push({ capacity: buffer.byteLength, offset, length, position, count })
      if (timing === "읽는 도중") {
        grown = true
        fs.appendFileSync(destination, Buffer.alloc(png.length, 120))
      }
      return count
    })
    const readFile = vi.spyOn(fs, "readFileSync")
    const response = await upload()
    expect(grown).toBe(true)
    expect(response.statusCode).toBe(200)
    expect(response.json().path).toBe("assets/my-picture-2.png")
    expect(reads.length).toBeGreaterThan(1)
    expect(reads.reduce((total, entry) => total + entry.count, 0)).toBe(png.length)
    for (const entry of reads) {
      expect(entry.capacity).toBe(png.length)
      expect(entry.position).toBe(entry.offset)
      expect(entry.position + entry.length).toBeLessThanOrEqual(png.length)
    }
    expect(readFile.mock.calls.some(([fd]) => fd === existingFd)).toBe(false)
    expect(() => fs.fstatSync(existingFd!)).toThrow()
    expect(fs.statSync(destination).size).toBeGreaterThan(png.length)
    expect(fs.readFileSync(path.join(folder, "assets/my-picture-2.png"))).toEqual(png)
  })
  it("기존 파일을 읽다가 짧아지면 부분 내용으로 재사용하지 않고 닫는다", async () => {
    await upload()
    const destination = path.join(folder, "assets/my-picture.png")
    const open = fs.openSync
    const read = fs.readSync
    let existingFd: number | undefined
    let shortened = false
    let reachedEnd = false
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      const fd = open(target, flags, mode)
      if (existingFd === undefined && isExistingRead(target, flags)) existingFd = fd
      return fd
    })
    vi.spyOn(fs, "readSync").mockImplementation((fd: any, buffer: any, offset?: any, length?: any, position?: any): any => {
      if (fd !== existingFd) return read(fd, buffer, offset, length, position)
      const count = read(fd, buffer, offset, Math.min(length, 7), position)
      if (!shortened) { shortened = true; fs.truncateSync(destination, count) }
      if (!count) reachedEnd = true
      return count
    })
    const response = await upload()
    expect(shortened).toBe(true)
    expect(reachedEnd).toBe(true)
    expect(response.statusCode).toBe(200)
    expect(response.json().path).toBe("assets/my-picture-2.png")
    expect(() => fs.fstatSync(existingFd!)).toThrow()
    expect(fs.readFileSync(destination)).toEqual(png.subarray(0, 7))
    expect(fs.readFileSync(path.join(folder, "assets/my-picture-2.png"))).toEqual(png)
  })
  it("검사한 파일이 이름 붙은 파이프로 바뀌어도 요청이 제한시간 안에 끝난다", async () => {
    await upload()
    // 동기 열기가 다시 상대를 기다리더라도 시험 실행기까지 멈추지 않게 별도 프로세스에서 요청한다.
    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { execFileSync } from "node:child_process";
      import { createServer } from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
      const root = process.env.DOC_ASSET_TEST_ROOT;
      const destination = path.join(root, "docs/article/assets/my-picture.png");
      const app = await createServer({ root, port: 3175, host: "127.0.0.1" });
      app.proxySecret = ${JSON.stringify(secret)};
      const open = fs.openSync;
      let swapped = false;
      let existingFd;
      let existingFlags = 0;
      fs.openSync = (target, flags, mode) => {
        if (!swapped && typeof target === "string" && path.basename(target) === "my-picture.png" && typeof flags === "number"
          && !(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND))) {
          swapped = true;
          fs.unlinkSync(destination);
          execFileSync("mkfifo", [destination], { timeout: 1000 });
          existingFlags = flags;
          existingFd = open(target, flags, mode);
          return existingFd;
        }
        return open(target, flags, mode);
      };
      try {
        const response = await app.inject({ method: "POST", url: ${JSON.stringify(url())}, headers: ${JSON.stringify(headers)}, payload: Buffer.from(${JSON.stringify(png.toString("base64"))}, "base64") });
        let closed = false;
        try { fs.fstatSync(existingFd); } catch { closed = true; }
        console.log("DOC_ASSET_FIFO_RESULT=" + JSON.stringify({ status: response.statusCode, body: response.json(), swapped, closed,
          nonblock: Boolean(existingFlags & fs.constants.O_NONBLOCK),
          nofollow: !fs.constants.O_NOFOLLOW || Boolean(existingFlags & fs.constants.O_NOFOLLOW),
          fifo: fs.lstatSync(destination).isFIFO() }));
      } finally { fs.openSync = open; await app.close(); }
    `
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", env: { ...process.env, DOC_ASSET_TEST_ROOT: root },
    })
    expect(child.error, child.stderr).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
    const resultLine = child.stdout.split("\n").find((line) => line.startsWith("DOC_ASSET_FIFO_RESULT="))
    expect(resultLine).toBeTypeOf("string")
    const result = JSON.parse(resultLine!.slice("DOC_ASSET_FIFO_RESULT=".length))
    expect(result).toMatchObject({ status: 200, body: { path: "assets/my-picture-2.png" }, swapped: true, closed: true, nonblock: true, nofollow: true, fifo: true })
    expect(fs.readFileSync(path.join(folder, "assets/my-picture-2.png"))).toEqual(png)
  }, 10000)
  it.each(["ELOOP", "ENOENT", "ENXIO"])("검사 뒤 열기가 %s로 실패하면 한국어 고칠점으로 거절한다", async (code) => {
    await upload()
    const open = fs.openSync
    let rejected = false
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      if (isExistingRead(target, flags)) {
        rejected = true
        throw Object.assign(new Error(`원시 파일 오류 ${code}`), { code })
      }
      return open(target, flags, mode)
    })
    const response = await upload()
    expect(rejected).toBe(true)
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: "forbidden", message: expect.stringMatching(/[가-힣]/) })
    expect(response.body).not.toContain(code)
    expect(fs.readdirSync(path.join(folder, "assets"))).toEqual(["my-picture.png"])
  })
  it("다른 바이트는 번호를 붙이고 기존 바이트를 보존한다", async () => {
    await upload()
    const second = await upload(undefined, Buffer.concat([png, Buffer.from("2")]))
    const third = await upload(undefined, Buffer.concat([png, Buffer.from("3")]))
    expect(second.json().path).toBe("assets/my-picture-2.png")
    expect(third.json().path).toBe("assets/my-picture-3.png")
    expect(fs.readFileSync(path.join(folder, "assets/my-picture.png"))).toEqual(png)
    expect((await upload(undefined, Buffer.concat([png, Buffer.from("2")]))).json()).toEqual(second.json())
  })
  it.each([
    ["사진.JPEG", Buffer.from([255, 216, 255, 224]), "사진.jpg"],
    ["a.gif", Buffer.from("GIF89a"), "a.gif"],
    ["a.webp", Buffer.from("RIFF0000WEBP"), "a.webp"],
    ["!!!.png", png, "image.png"],
  ])("실제 형식과 안전한 이름을 사용한다: %s", async (name, bytes, expected) => {
    const response = await upload(name, bytes)
    expect(response.statusCode).toBe(200)
    expect(response.json().path).toBe(`assets/${expected}`)
  })
  it("원시 본문의 개별 크기 한도를 적용한다", async () => {
    const response = await upload("huge.png", Buffer.alloc(DOC_ASSET_BODY_LIMIT + 1))
    expect(response.statusCode).toBe(413)
    expect(response.json().error).toBe("too_large")
  })
  it("묶음 한도까지 허용하고 초과한 새 파일만 거절한다", async () => {
    const assets = path.join(folder, "assets")
    fs.mkdirSync(assets)
    const fd = fs.openSync(path.join(assets, "existing.bin"), "w")
    fs.ftruncateSync(fd, DOC_ASSET_BUNDLE_LIMIT - png.length)
    fs.closeSync(fd)
    expect((await upload()).statusCode).toBe(200)
    expect((await upload()).statusCode).toBe(200)
    const rejected = await upload("new.png")
    expect(rejected.statusCode).toBe(413)
    expect(rejected.json().error).toBe("bundle_limit")
    expect(fs.existsSync(path.join(assets, "new.png"))).toBe(false)
  })
  it("동시 요청도 묶음 한도를 넘지 않는다", async () => {
    fs.mkdirSync(path.join(folder, "assets"))
    const fd = fs.openSync(path.join(folder, "assets/existing.bin"), "w")
    fs.ftruncateSync(fd, DOC_ASSET_BUNDLE_LIMIT - png.length)
    fs.closeSync(fd)
    const responses = await Promise.all([upload("a.png"), upload("b.png")])
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 413])
  })
  it.each(["../index.md", "article/../../index.md", ".hidden/index.md", "article/..\\index.md"])("경로 이탈·숨김을 거절한다: %s", async (doc) => {
    const response = await upload(undefined, png, doc)
    expect(response.json().error).toBe("path_escape")
    expect(response.statusCode).toBe(400)
  })
  it("폴더 밖을 가리키는 그림 폴더 링크를 거절한다", async () => {
    const outside = path.join(root, "outside")
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(folder, "assets"))
    const response = await upload()
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe("path_escape")
    expect(fs.readdirSync(outside)).toEqual([])
  })
  it("임시 파일 생성 직전 폴더가 교체되어도 바깥에 쓰지 않고 생성 파일을 정리한다", async () => {
    const assets = path.join(folder, "assets")
    const moved = path.join(root, "moved-assets")
    const outside = path.join(root, "outside")
    fs.mkdirSync(assets)
    fs.mkdirSync(outside)
    const open = fs.openSync
    let swapped = false
    let createdOutside = false
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      if (!swapped && typeof target === "string" && path.basename(target).startsWith(".upload-")) {
        swapped = true
        fs.renameSync(assets, moved)
        fs.symlinkSync(outside, assets)
      }
      const fd = open(target, flags, mode)
      if (swapped) createdOutside ||= fs.readdirSync(outside).length > 0
      return fd
    })
    const response = await upload()
    expect(swapped).toBe(true)
    expect(createdOutside).toBe(false)
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: "path_escape", message: expect.stringMatching(/[가-힣]/) })
    expect(fs.readdirSync(outside)).toEqual([])
    expect(fs.readdirSync(moved)).toEqual([])
  })
  it.each([
    ["연결 전", "파일 링크"], ["연결 전", "새 폴더"],
    ["연결 후", "파일 링크"], ["연결 후", "새 폴더"],
  ])("완성 파일 %s %s로 폴더 교체 시 생성 파일을 정리한다", async (timing, replacement) => {
    const assets = path.join(folder, "assets")
    const moved = path.join(root, "moved-assets")
    const outside = path.join(root, "outside")
    fs.mkdirSync(outside)
    const link = fs.linkSync
    let swapped = false
    const swap = () => {
      swapped = true
      fs.renameSync(assets, moved)
      if (replacement === "파일 링크") fs.symlinkSync(outside, assets)
      else fs.mkdirSync(assets)
    }
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      if (timing === "연결 전") swap()
      link(source, destination)
      if (timing === "연결 후") swap()
    })
    const response = await upload()
    expect(swapped).toBe(true)
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe("path_escape")
    expect(fs.readdirSync(assets)).toEqual([])
    expect(fs.readdirSync(outside)).toEqual([])
    expect(fs.readdirSync(moved)).toEqual([])
  })
  it("같은 파일을 읽는 동안 그림 폴더가 바뀌어도 성공으로 응답하지 않는다", async () => {
    expect((await upload()).statusCode).toBe(200)
    const assets = path.join(folder, "assets")
    const moved = path.join(root, "moved-assets")
    const outside = path.join(root, "outside")
    fs.mkdirSync(outside)
    const read = fs.readSync
    let swapped = false
    vi.spyOn(fs, "readSync").mockImplementation((fd: any, buffer: any, offset?: any, length?: any, position?: any): any => {
      const count = read(fd, buffer, offset, length, position)
      if (!swapped && Buffer.isBuffer(buffer) && count === png.length && buffer.equals(png)) {
        swapped = true
        fs.renameSync(assets, moved)
        fs.symlinkSync(outside, assets)
      }
      return count
    })
    const response = await upload()
    expect(swapped).toBe(true)
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe("path_escape")
    expect(fs.readdirSync(outside)).toEqual([])
    expect(fs.readdirSync(moved)).toEqual(["my-picture.png"])
    expect(fs.readFileSync(path.join(moved, "my-picture.png"))).toEqual(png)
  })
  it("배타 생성 후 쓰기가 실패해도 파일을 닫고 임시 파일을 지운다", async () => {
    const open = fs.openSync
    const write = fs.writeFileSync
    let temporaryFd: number | undefined
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      const fd = open(target, flags, mode)
      if (typeof target === "string" && path.basename(target).startsWith(".upload-")) temporaryFd = fd
      return fd
    })
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
      if (target === temporaryFd) {
        fs.writeSync(target as number, png.subarray(0, 4))
        throw Object.assign(new Error("공간 부족"), { code: "ENOSPC" })
      }
      return write(target, data, options)
    })
    const close = vi.spyOn(fs, "closeSync")
    const response = await upload()
    expect(temporaryFd).toBeTypeOf("number")
    expect(close).toHaveBeenCalledWith(temporaryFd)
    expect(() => fs.fstatSync(temporaryFd!)).toThrow()
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: "forbidden", message: expect.stringMatching(/[가-힣]/) })
    expect(fs.readdirSync(path.join(folder, "assets"))).toEqual([])
    vi.restoreAllMocks()
    expect((await upload()).statusCode).toBe(200)
    expect(fs.readdirSync(path.join(folder, "assets"))).toEqual(["my-picture.png"])
  })
  it("기존 그림 이름의 심볼릭 링크를 따라가지 않는다", async () => {
    fs.mkdirSync(path.join(folder, "assets"))
    const outside = path.join(root, "outside.png")
    fs.writeFileSync(outside, png)
    fs.symlinkSync(outside, path.join(folder, "assets/my-picture.png"))
    expect((await upload()).json().error).toBe("path_escape")
    expect(fs.readFileSync(outside)).toEqual(png)
  })
  it("문서 자체가 허용 폴더 밖을 가리키면 거절한다", async () => {
    fs.writeFileSync(path.join(root, "outside.md"), "# 밖")
    fs.symlinkSync(path.join(root, "outside.md"), path.join(folder, "linked.md"))
    expect((await upload(undefined, png, "article/linked.md")).json().error).toBe("path_escape")
  })
  it("허용 폴더 안의 다른 문서를 가리키는 문서 링크도 거절한다", async () => {
    const other = path.join(root, "docs", "other")
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, "index.md"), "# 다른 원고\n")
    fs.symlinkSync("../other/index.md", path.join(folder, "linked.md"))
    const response = await upload(undefined, png, "article/linked.md")
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: "path_escape", message: expect.stringContaining("실제 문서를 열어") })
    expect(fs.existsSync(path.join(folder, "assets"))).toBe(false)
    expect(fs.existsSync(path.join(other, "assets"))).toBe(false)
  })
  it.each([{}, { "x-naia-origin-ok": "0" }])("믿지 않는 요청과 다른 출처 요청을 거절한다", async (overrides) => {
    const response = await app.inject({ method: "POST", url: url(), headers: Object.keys(overrides).length ? { ...headers, ...overrides } : { host: headers.host, "content-type": headers["content-type"] }, payload: png })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: "forbidden", message: expect.any(String) })
  })
  it("없는 문서를 거절한다", async () => {
    const response = await upload(undefined, png, "article/missing.md")
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe("doc_not_found")
  })
  it("그림 이외 경로에는 원시 본문 해석기가 등록되지 않는다", async () => {
    const response = await app.inject({ method: "PUT", url: "/api/portal/doc?source=adk&path=article/index.md", headers, payload: png })
    expect(response.statusCode).toBe(415)
  })
})
