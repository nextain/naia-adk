import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createServer } from "../src/server.js"
import {
  readNote as serverReadNote,
  listNotes as serverListNotes,
  readNoteSecure as serverReadNoteSecure,
  generateNoteId,
  type DocNote,
} from "../src/notes.js"
import {
  readNote as cliReadNote,
  listNotes as cliListNotes,
  readNoteSecure as cliReadNoteSecure,
} from "../../../scripts/doc-notes.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DOC_NOTES_MJS = path.resolve(__dirname, "../../../scripts/doc-notes.mjs")
const REPO_ROOT = path.resolve(__dirname, "../../..")

describe("W1d-2 검수 결함 수정 포괄 시험 (1~8번)", () => {
  let tempRoot: string
  let docsDir: string
  let workDir: string
  let notesDir: string
  let app: Awaited<ReturnType<typeof createServer>>

  const TEST_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  const TRUSTED_HEADERS = {
    host: "localhost:3141",
    "x-naia-proxy-secret": TEST_SECRET,
    "x-naia-peer": "127.0.0.1",
    "x-naia-local": "127.0.0.1",
    "x-naia-origin-ok": "1",
  }

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-w1d2-root-"))
    docsDir = path.join(tempRoot, "docs")
    fs.mkdirSync(docsDir, { recursive: true })

    workDir = path.join(tempRoot, ".agents", "work")
    notesDir = path.join(workDir, "doc-notes")
    fs.mkdirSync(notesDir, { recursive: true })

    // 기본 md 문서 생성
    fs.writeFileSync(path.join(docsDir, "sample.md"), "# 샘플 문서\n내용입니다.\n", "utf-8")

    app = await createServer({
      root: tempRoot,
      port: 3141,
      host: "127.0.0.1",
    })
    ;(app as any).proxySecret = TEST_SECRET
  })

  afterAll(async () => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch {}
    await app.close()
  })

  // 1번: 검색 keepFdOpen 재오픈 방지 및 fd 누수 검사
  describe("1. 검색 keepFdOpen 및 모든 분기 fd 닫기", () => {
    it("알려진 문자열이 검색에 걸리고, 1MB 초과 파일은 걸리지 않으며, fd 누수가 없고 중복 오픈이 0번이다", async () => {
      const searchDoc = path.join(docsDir, "search-target.md")
      fs.writeFileSync(searchDoc, "# 검색 대상\n알려진문자열검색키워드123\n", "utf-8")

      const largeSearchDoc = path.join(docsDir, "search-large.md")
      // 1MB + 100바이트 크기의 문서
      const largeContent = "# 대형 검색 문서\n알려진문자열검색키워드123\n" + "A".repeat(1024 * 1024 + 100)
      fs.writeFileSync(largeSearchDoc, largeContent, "utf-8")

      // 1) 웜업 1회
      const warmupRes = await app.inject({
        method: "GET",
        url: "/api/portal/search?q=알려진문자열검색키워드123",
        headers: TRUSTED_HEADERS,
      })
      expect(warmupRes.statusCode).toBe(200)
      const warmupBody = JSON.parse(warmupRes.payload)
      // 정상 파일은 걸림
      expect(warmupBody.results.some((r: any) => r.path === "search-target.md")).toBe(true)
      // 1MB 초과 파일은 걸리지 않음
      expect(warmupBody.results.some((r: any) => r.path === "search-large.md")).toBe(false)

      // 2) 검색 50번 뒤 프로세스 열린 fd 수 (/proc/self/fd 개수) 확인
      const initialFdCount = fs.readdirSync("/proc/self/fd").length
      for (let i = 0; i < 50; i++) {
        const res = await app.inject({
          method: "GET",
          url: "/api/portal/search?q=알려진문자열검색키워드123",
          headers: TRUSTED_HEADERS,
        })
        expect(res.statusCode).toBe(200)
      }
      const finalFdCount = fs.readdirSync("/proc/self/fd").length
      expect(finalFdCount).toBeLessThanOrEqual(initialFdCount)

      // 3) fs.openSync · fs.readFileSync · fs.readFile 감시:
      // 검색 요청 동안 같은 문서 경로를 두 번 이상 열거나 경로로 읽는 호출이 0번
      const openedPaths = new Map<string, number>()
      const readFileSyncPaths: string[] = []
      const readFilePaths: string[] = []

      const origOpenSync = fs.openSync
      const origReadFileSync = fs.readFileSync
      const origReadFile = fs.readFile

      const openSpy = vi.spyOn(fs, "openSync").mockImplementation((filePath, flags, mode) => {
        if (typeof filePath === "string" && (filePath.includes("search-target.md") || filePath.includes("search-large.md"))) {
          openedPaths.set(filePath, (openedPaths.get(filePath) || 0) + 1)
        }
        return origOpenSync(filePath, flags, mode)
      })

      const readFileSyncSpy = vi.spyOn(fs, "readFileSync").mockImplementation((filePath, options) => {
        if (typeof filePath === "string" && (filePath.includes("search-target.md") || filePath.includes("search-large.md"))) {
          readFileSyncPaths.push(filePath)
        }
        return origReadFileSync(filePath, options as any)
      })

      const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation((...args: any[]) => {
        const filePath = args[0]
        if (typeof filePath === "string" && (filePath.includes("search-target.md") || filePath.includes("search-large.md"))) {
          readFilePaths.push(filePath)
        }
        return (origReadFile as any)(...args)
      })

      try {
        const testRes = await app.inject({
          method: "GET",
          url: "/api/portal/search?q=알려진문자열검색키워드123",
          headers: TRUSTED_HEADERS,
        })
        expect(testRes.statusCode).toBe(200)

        // 같은 문서 경로를 2번 이상 연 호출이 없어야 함 (각 파일당 최대 1번)
        for (const [p, count] of openedPaths.entries()) {
          expect(count).toBeLessThanOrEqual(1)
        }
        // 경로로 읽은 readFileSync, readFile 호출은 0번이어야 함 (fd로만 직접 읽음)
        expect(readFileSyncPaths.length).toBe(0)
        expect(readFilePaths.length).toBe(0)
      } finally {
        openSpy.mockRestore()
        readFileSyncSpy.mockRestore()
        readFileSpy.mockRestore()
      }
    })
  })

  // 2번: PUT /doc 프로세스 잠금, O_NOFOLLOW fd 유지, rename 직전 검증 및 시험 훅
  describe("2. PUT /doc 해시·rename 사이 틈 방지 및 시험 훅", () => {
    it("같은 길이로 내용을 바꾼 파일에 옛 해시로 PUT -> 409, 바뀐 바이트 유지", async () => {
      const docPath = path.join(docsDir, "put-hash-tamper.md")
      const originalStr = "abcdefghij\n" // 11 bytes
      fs.writeFileSync(docPath, originalStr, "utf-8")
      const oldHash = crypto.createHash("sha256").update(Buffer.from(originalStr, "utf-8")).digest("hex")

      // 외부에서 같은 길이로 내용 변경
      const tamperedStr = "0123456789\n" // 11 bytes
      fs.writeFileSync(docPath, tamperedStr, "utf-8")

      const res = await app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=put-hash-tamper.md",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          content: "new content\n",
          baseHash: oldHash,
        },
      })
      expect(res.statusCode).toBe(409)
      expect(JSON.parse(res.payload)).toEqual({ error: "changed" })
      expect(fs.readFileSync(docPath, "utf-8")).toBe(tamperedStr)
    })

    it("시험 훅으로 해시 확인 뒤·rename 전에 같은 길이의 다른 바이트를 써 넣으면 409이고 그 바이트 유지", async () => {
      const docPath = path.join(docsDir, "put-hook-tamper.md")
      const initialStr = "1234567890\n"
      fs.writeFileSync(docPath, initialStr, "utf-8")
      const baseHash = crypto.createHash("sha256").update(Buffer.from(initialStr, "utf-8")).digest("hex")

      const tamperedStr = "abcdefghij\n"

      // 시험 훅을 주입한 새 앱 인스턴스 생성
      const hookApp = await createServer({
        root: tempRoot,
        port: 3177,
        host: "127.0.0.1",
        beforeRenameHook: async () => {
          // rename 직전 단계 전에 같은 길이의 다른 바이트를 파일에 덮어씀
          fs.writeFileSync(docPath, tamperedStr, "utf-8")
        },
      })
      ;(hookApp as any).proxySecret = TEST_SECRET

      try {
        const res = await hookApp.inject({
          method: "PUT",
          url: "/api/portal/doc?source=adk&path=put-hook-tamper.md",
          headers: {
            ...TRUSTED_HEADERS,
            host: "localhost:3177",
            "content-type": "application/json",
          },
          payload: {
            content: "updated by put\n",
            baseHash,
          },
        })
        expect(res.statusCode).toBe(409)
        expect(JSON.parse(res.payload)).toEqual({ error: "changed" })
        expect(fs.readFileSync(docPath, "utf-8")).toBe(tamperedStr)
      } finally {
        await hookApp.close()
      }
    })

    it("시험 훅으로 같은 자리에서 경로를 다른 파일로 바꾸면 409이고 바꾼 파일 유지", async () => {
      const docPath = path.join(docsDir, "put-hook-swap.md")
      const otherFile = path.join(docsDir, "put-other-file.md")
      const initialStr = "initial doc\n"
      const otherStr = "swapped replacement\n"
      fs.writeFileSync(docPath, initialStr, "utf-8")
      fs.writeFileSync(otherFile, otherStr, "utf-8")
      const baseHash = crypto.createHash("sha256").update(Buffer.from(initialStr, "utf-8")).digest("hex")

      // 시험 훅으로 rename 직전에 docPath를 otherFile(다른 inode)로 교체
      const swapApp = await createServer({
        root: tempRoot,
        port: 3178,
        host: "127.0.0.1",
        beforeRenameHook: async () => {
          fs.unlinkSync(docPath)
          fs.copyFileSync(otherFile, docPath)
        },
      })
      ;(swapApp as any).proxySecret = TEST_SECRET

      try {
        const res = await swapApp.inject({
          method: "PUT",
          url: "/api/portal/doc?source=adk&path=put-hook-swap.md",
          headers: {
            ...TRUSTED_HEADERS,
            host: "localhost:3178",
            "content-type": "application/json",
          },
          payload: {
            content: "new put content\n",
            baseHash,
          },
        })
        expect(res.statusCode).toBe(409)
        expect(JSON.parse(res.payload)).toEqual({ error: "changed" })
        expect(fs.readFileSync(docPath, "utf-8")).toBe(otherStr)
      } finally {
        await swapApp.close()
      }
    })

    it("시험 훅으로 원본을 다른 이름으로 rename하고 그 자리에 다른 파일을 두면 409이고 바이트 유지", async () => {
      const docPath = path.join(docsDir, "put-hook-rename-swap.md")
      const movedDocPath = path.join(docsDir, "put-hook-original-moved.md")
      const replacementFile = path.join(docsDir, "put-hook-replacement.md")
      const initialStr = "initial doc before rename\n"
      const replacementStr = "replacement doc in place\n"
      fs.writeFileSync(docPath, initialStr, "utf-8")
      fs.writeFileSync(replacementFile, replacementStr, "utf-8")
      const baseHash = crypto.createHash("sha256").update(Buffer.from(initialStr, "utf-8")).digest("hex")

      // 시험 훅으로 rename 직전에 docPath를 movedDocPath로 이동(nlink 1 유지)하고,
      // 그 자리에 replacementFile을 복사하여 배치(새로운 inode)
      const renameSwapApp = await createServer({
        root: tempRoot,
        port: 3179,
        host: "127.0.0.1",
        beforeRenameHook: async () => {
          fs.renameSync(docPath, movedDocPath)
          fs.copyFileSync(replacementFile, docPath)
        },
      })
      ;(renameSwapApp as any).proxySecret = TEST_SECRET

      try {
        const res = await renameSwapApp.inject({
          method: "PUT",
          url: "/api/portal/doc?source=adk&path=put-hook-rename-swap.md",
          headers: {
            ...TRUSTED_HEADERS,
            host: "localhost:3179",
            "content-type": "application/json",
          },
          payload: {
            content: "new put content\n",
            baseHash,
          },
        })
        expect(res.statusCode).toBe(409)
        expect(JSON.parse(res.payload)).toEqual({ error: "changed" })
        expect(fs.readFileSync(docPath, "utf-8")).toBe(replacementStr)
        expect(fs.readFileSync(movedDocPath, "utf-8")).toBe(initialStr)
      } finally {
        await renameSwapApp.close()
      }
    })

    it("beforeRenameHook 예외 시 원문 inode·바이트 유지하고 임시 파일 없이 500 반환", async () => {
      const docPath = path.join(docsDir, "put-hook-exception.md")
      const initialStr = "initial text before hook exception\n"
      fs.writeFileSync(docPath, initialStr, "utf-8")
      const initialStat = fs.statSync(docPath)
      const baseHash = crypto.createHash("sha256").update(Buffer.from(initialStr, "utf-8")).digest("hex")

      const failHookApp = await createServer({
        root: tempRoot,
        port: 3180,
        host: "127.0.0.1",
        beforeRenameHook: async () => {
          throw new Error("Simulated hook failure before rename")
        },
      })
      ;(failHookApp as any).proxySecret = TEST_SECRET

      try {
        const res = await failHookApp.inject({
          method: "PUT",
          url: "/api/portal/doc?source=adk&path=put-hook-exception.md",
          headers: {
            ...TRUSTED_HEADERS,
            host: "localhost:3180",
            "content-type": "application/json",
          },
          payload: {
            content: "attempted update content\n",
            baseHash,
          },
        })
        expect(res.statusCode).toBe(500)

        // 원문 inode·바이트 유지 단언
        const currentStat = fs.statSync(docPath)
        expect(currentStat.ino).toBe(initialStat.ino)
        expect(fs.readFileSync(docPath, "utf-8")).toBe(initialStr)

        // .tmp-* 없음 단언
        const dirFiles = fs.readdirSync(docsDir)
        expect(dirFiles.some((f) => f.startsWith(".tmp-"))).toBe(false)
      } finally {
        await failHookApp.close()
      }
    })

    it("같은 파일에 PUT 두 개 동시 -> 하나 200·하나 409, 파일은 200 쪽 내용", async () => {
      const docPath = path.join(docsDir, "put-concurrent.md")
      const initialStr = "concurrent base content\n"
      fs.writeFileSync(docPath, initialStr, "utf-8")
      const baseHash = crypto.createHash("sha256").update(Buffer.from(initialStr, "utf-8")).digest("hex")

      const p1 = app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=put-concurrent.md",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          content: "first write wins\n",
          baseHash,
        },
      })

      const p2 = app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=put-concurrent.md",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          content: "second write fails\n",
          baseHash,
        },
      })

      const [r1, r2] = await Promise.all([p1, p2])
      const codes = [r1.statusCode, r2.statusCode].sort()
      expect(codes).toEqual([200, 409])

      const finalDisk = fs.readFileSync(docPath, "utf-8")
      const winnerPayload = r1.statusCode === 200 ? "first write wins\n" : "second write fails\n"
      expect(finalDisk).toBe(winnerPayload)
    })

    it("원본 2MB 초과 파일 PUT -> 거절(400), 원본 바이트 유지", async () => {
      const docPath = path.join(docsDir, "put-orig-large.md")
      // 원본 크기 2MB + 100바이트
      const largeContent = "# 큰 원본\n" + "B".repeat(2 * 1024 * 1024 + 100)
      fs.writeFileSync(docPath, largeContent, "utf-8")
      const baseHash = crypto.createHash("sha256").update(Buffer.from(largeContent, "utf-8")).digest("hex")

      const res = await app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=put-orig-large.md",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          content: "# 수정 시도\n짧은 내용\n",
          baseHash,
        },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload)).toEqual({ error: "Content exceeds 2MB limit" })
      expect(fs.readFileSync(docPath, "utf-8")).toBe(largeContent)
    })
  })

  // 3번: 메모 생성 시 body 검증
  describe("3. 본문 없는 메모 저장 방지", () => {
    it("body 없음·빈 문자열·4001자·숫자 -> 400, 파일 안 생김", async () => {
      const filesBefore = fs.readdirSync(notesDir)

      // 1) body 없음
      const resNoBody = await app.inject({
        method: "POST",
        url: "/api/portal/notes",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "sample.md",
          quote: "인용",
        },
      })
      expect(resNoBody.statusCode).toBe(400)

      // 2) 빈 문자열
      const resEmpty = await app.inject({
        method: "POST",
        url: "/api/portal/notes",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "sample.md",
          body: "",
        },
      })
      expect(resEmpty.statusCode).toBe(400)

      // 3) 4001자
      const resLong = await app.inject({
        method: "POST",
        url: "/api/portal/notes",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "sample.md",
          body: "x".repeat(4001),
        },
      })
      expect(resLong.statusCode).toBe(400)

      // 4) 숫자
      const resNum = await app.inject({
        method: "POST",
        url: "/api/portal/notes",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "sample.md",
          body: 123456,
        },
      })
      expect(resNum.statusCode).toBe(400)

      // 파일 생성 확인 -> 하나도 생기지 않음
      const filesAfter = fs.readdirSync(notesDir)
      expect(filesAfter.length).toBe(filesBefore.length)
    })
  })

  // 4번: CRLF 복원 뒤 2MB 초과 판정
  describe("4. CRLF 변환 뒤 2MB 초과 거절", () => {
    it("CRLF 원본에 LF만 든 본문(변환 뒤 2MB 초과, 변환 전 2MB 이하) -> 거절(400), 원본 바이트 그대로", async () => {
      const docPath = path.join(docsDir, "crlf-overflow.md")
      const crlfInitial = "# CRLF 원본\r\n줄바꿈\r\n"
      fs.writeFileSync(docPath, crlfInitial, "utf-8")
      const baseHash = crypto.createHash("sha256").update(Buffer.from(crlfInitial, "utf-8")).digest("hex")

      // LF만 1,500,000개: 문자열 길이 약 1.5MB (<= 2MB)
      // CRLF로 변환되면 \r이 붙어 3,000,000바이트 (~3MB, > 2MB)가 됨
      const lfBody = "\n".repeat(1500000)
      expect(Buffer.byteLength(lfBody, "utf-8")).toBeLessThanOrEqual(2 * 1024 * 1024)

      const res = await app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=crlf-overflow.md",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          content: lfBody,
          baseHash,
        },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload)).toEqual({ error: "Content exceeds 2MB limit" })
      expect(fs.readFileSync(docPath, "utf-8")).toBe(crlfInitial)
    })
  })

  // 5번: .claude/skills/doc-notes 포인터 파일 검증
  describe("5. 스킬 미러 파일 포인터 형식 검증", () => {
    it(".claude/skills/doc-notes가 정규 파일이고 다른 미러(view-folders)와 같은 형식이다", () => {
      const targetPointer = path.resolve(REPO_ROOT, ".claude/skills/doc-notes")
      const refPointer = path.resolve(REPO_ROOT, ".claude/skills/view-folders")

      const stat = fs.lstatSync(targetPointer)
      expect(stat.isFile()).toBe(true)
      expect(stat.isSymbolicLink()).toBe(false)
      expect(stat.isDirectory()).toBe(false)

      const targetContent = fs.readFileSync(targetPointer, "utf-8")
      const refContent = fs.readFileSync(refPointer, "utf-8")

      expect(targetContent).toBe("../../.agents/skills/doc-notes\n")
      expect(targetContent.trim()).toBe("../../.agents/skills/doc-notes")
      expect(refContent.trim()).toBe("../../.agents/skills/view-folders")
    })
  })

  // 6번: 파일 잠금 동시성 및 복구
  describe("6. 파일 잠금 동시 쓰기, 200개 상한, 만료 및 CLI 연동", () => {
    it("한 메모에 reply가 서로 다른 PATCH 10개 동시 -> 모두 200이고 최종 파일은 유효 JSON, reply는 그중 하나", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/portal/notes",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "sample.md",
          body: "동시성 테스트 메모",
        },
      })
      expect(createRes.statusCode).toBe(201)
      const noteId = JSON.parse(createRes.payload).note.id

      const patchReqs = Array.from({ length: 10 }, (_, i) =>
        app.inject({
          method: "PATCH",
          url: `/api/portal/notes/${noteId}`,
          headers: {
            ...TRUSTED_HEADERS,
            "content-type": "application/json",
          },
          payload: {
            reply: `답변 번호 ${i}`,
          },
        }),
      )

      const responses = await Promise.all(patchReqs)
      for (const r of responses) {
        expect(r.statusCode).toBe(200)
      }

      const noteFile = path.join(notesDir, `${noteId}.json`)
      const raw = fs.readFileSync(noteFile, "utf-8")
      const parsed = JSON.parse(raw)
      expect(parsed.schemaVersion).toBe(1)
      expect(parsed.id).toBe(noteId)
      expect(parsed.reply).toMatch(/^답변 번호 \d$/)
    })

    it("즐겨찾기 199개에서 POST 5개 동시 -> 파일에 200개, 1개 200·4개 400", async () => {
      const favFile = path.join(workDir, "doc-favorites.json")
      const initialItems = Array.from({ length: 199 }, (_, i) => ({
        source: "adk",
        path: `dummy-${i}.md`,
        type: "file" as const,
        addedAt: new Date().toISOString(),
      }))
      fs.writeFileSync(favFile, JSON.stringify({ schemaVersion: 1, items: initialItems }, null, 2), "utf-8")

      // dummy 5개 파일 생성
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(docsDir, `fav-candidate-${i}.md`), `# 후보 ${i}\n`, "utf-8")
      }

      const postReqs = Array.from({ length: 5 }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/api/portal/favorites",
          headers: {
            ...TRUSTED_HEADERS,
            "content-type": "application/json",
          },
          payload: {
            source: "adk",
            path: `fav-candidate-${i}.md`,
          },
        }),
      )

      const responses = await Promise.all(postReqs)
      const status200 = responses.filter((r) => r.statusCode === 200)
      const status400 = responses.filter((r) => r.statusCode === 400)

      expect(status200.length).toBe(1)
      expect(status400.length).toBe(4)

      const finalData = JSON.parse(fs.readFileSync(favFile, "utf-8"))
      expect(finalData.items.length).toBe(200)
    })

    it("잠금 파일을 미리 만들어 두면(최근 시각) PATCH가 2초 뒤 409이고 파일 바이트 유지, 오래된(31초 전) 잠금 파일이면 성공", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/portal/notes",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "sample.md",
          body: "잠금 테스트 메모",
        },
      })
      const noteId = JSON.parse(createRes.payload).note.id
      const noteFile = path.join(notesDir, `${noteId}.json`)
      const lockFile = `${noteFile}.lock`
      const beforeBytes = fs.readFileSync(noteFile, "utf-8")

      // 1) 최근 시각 잠금 파일 생성
      fs.writeFileSync(lockFile, `${process.pid} ${Date.now()}\n`)

      const start = Date.now()
      const failRes = await app.inject({
        method: "PATCH",
        url: `/api/portal/notes/${noteId}`,
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          reply: "실패해야 할 답변",
        },
      })
      const duration = Date.now() - start
      expect(failRes.statusCode).toBe(409)
      expect(JSON.parse(failRes.payload)).toEqual({ error: "changed" })
      expect(duration).toBeGreaterThanOrEqual(1900) // 약 2초 대기
      expect(fs.readFileSync(noteFile, "utf-8")).toBe(beforeBytes)

      // 2) 오래된(31초 전) 잠금 파일 생성
      fs.writeFileSync(lockFile, `${process.pid} ${Date.now() - 31000}\n`)
      const pastTime = new Date(Date.now() - 31000)
      fs.utimesSync(lockFile, pastTime, pastTime)

      const successRes = await app.inject({
        method: "PATCH",
        url: `/api/portal/notes/${noteId}`,
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          reply: "성공해야 할 답변",
        },
      })
      expect(successRes.statusCode).toBe(200)
      expect(JSON.parse(fs.readFileSync(noteFile, "utf-8")).reply).toBe("성공해야 할 답변")
    })

    it("CLI reply와 서버 PATCH가 같은 잠금을 쓰는지: 잠금을 잡은 상태에서 CLI reply가 오류 종료하고 파일이 그대로", () => {
      const noteId = generateNoteId()
      const note: DocNote = {
        schemaVersion: 1,
        id: noteId,
        source: "adk",
        path: "sample.md",
        quote: null,
        body: "CLI 잠금 테스트",
        status: "open",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        reply: null,
        resolvedAt: null,
      }
      const noteFile = path.join(notesDir, `${noteId}.json`)
      fs.writeFileSync(noteFile, JSON.stringify(note, null, 2), "utf-8")
      const beforeBytes = fs.readFileSync(noteFile, "utf-8")

      // 잠금 파일 생성
      const lockFile = `${noteFile}.lock`
      fs.writeFileSync(lockFile, `${process.pid} ${Date.now()}\n`)

      let cliFailed = false
      try {
        execFileSync(
          process.execPath,
          [DOC_NOTES_MJS, "reply", noteId, "--reply", "CLI 답변", "--root", tempRoot],
          { encoding: "utf-8", stdio: "pipe" },
        )
      } catch (err: any) {
        cliFailed = true
        expect(err.status).toBe(1)
      } finally {
        try { fs.unlinkSync(lockFile) } catch {}
      }

      expect(cliFailed).toBe(true)
      expect(fs.readFileSync(noteFile, "utf-8")).toBe(beforeBytes)
    })
  })

  // 7번: 큰 파일 및 링크 차단
  describe("7. 큰 파일 및 링크 차단 (메모 64KB, 즐겨찾기 256KB)", () => {
    it("64KB 넘는 메모 파일은 목록에 없고 단건 GET·PATCH·DELETE는 404이다", async () => {
      const largeNoteId = generateNoteId()
      const largeNote: DocNote = {
        schemaVersion: 1,
        id: largeNoteId,
        source: "adk",
        path: "sample.md",
        quote: null,
        body: "A".repeat(65 * 1024), // 65KB
        status: "open",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        reply: null,
        resolvedAt: null,
      }
      const noteFile = path.join(notesDir, `${largeNoteId}.json`)
      fs.writeFileSync(noteFile, JSON.stringify(largeNote), "utf-8")

      // 목록 조회: 없어야 함
      const listRes = await app.inject({
        method: "GET",
        url: "/api/portal/notes",
        headers: TRUSTED_HEADERS,
      })
      expect(listRes.statusCode).toBe(200)
      const notes = JSON.parse(listRes.payload).notes
      expect(notes.some((n: any) => n.id === largeNoteId)).toBe(false)

      // 단건 GET: 404
      const getRes = await app.inject({
        method: "GET",
        url: `/api/portal/notes/${largeNoteId}`,
        headers: TRUSTED_HEADERS,
      })
      expect(getRes.statusCode).toBe(404)

      // PATCH: 404
      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/portal/notes/${largeNoteId}`,
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          reply: "수정 시도",
        },
      })
      expect(patchRes.statusCode).toBe(404)

      // DELETE: 404
      const delRes = await app.inject({
        method: "DELETE",
        url: `/api/portal/notes/${largeNoteId}`,
        headers: TRUSTED_HEADERS,
      })
      expect(delRes.statusCode).toBe(404)
      expect(fs.existsSync(noteFile)).toBe(true)
    })

    it("메모 파일이 링크면 목록에 없고 단건 GET·PATCH·DELETE는 404, 링크 대상 바이트 유지", async () => {
      const targetNoteId = generateNoteId()
      const targetNote: DocNote = {
        schemaVersion: 1,
        id: targetNoteId,
        source: "adk",
        path: "sample.md",
        quote: null,
        body: "링크 대상 원본 내용",
        status: "open",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        reply: null,
        resolvedAt: null,
      }
      const realTargetFile = path.join(docsDir, "external-target-note.json")
      fs.writeFileSync(realTargetFile, JSON.stringify(targetNote), "utf-8")

      const linkNoteId = generateNoteId()
      const linkFile = path.join(notesDir, `${linkNoteId}.json`)
      fs.symlinkSync(realTargetFile, linkFile)

      // 목록 조회: 없어야 함
      const listRes = await app.inject({
        method: "GET",
        url: "/api/portal/notes",
        headers: TRUSTED_HEADERS,
      })
      expect(listRes.statusCode).toBe(200)
      const notes = JSON.parse(listRes.payload).notes
      expect(notes.some((n: any) => n.id === linkNoteId)).toBe(false)

      // 단건 GET: 404
      const getRes = await app.inject({
        method: "GET",
        url: `/api/portal/notes/${linkNoteId}`,
        headers: TRUSTED_HEADERS,
      })
      expect(getRes.statusCode).toBe(404)

      // PATCH: 404
      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/portal/notes/${linkNoteId}`,
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          reply: "링크 수정",
        },
      })
      expect(patchRes.statusCode).toBe(404)

      // DELETE: 404
      const delRes = await app.inject({
        method: "DELETE",
        url: `/api/portal/notes/${linkNoteId}`,
        headers: TRUSTED_HEADERS,
      })
      expect(delRes.statusCode).toBe(404)

      // 링크 및 링크 대상 파일 바이트 유지
      expect(fs.lstatSync(linkFile).isSymbolicLink()).toBe(true)
      expect(fs.readFileSync(realTargetFile, "utf-8")).toBe(JSON.stringify(targetNote))
    })

    it("256KB 넘는 즐겨찾기 파일에서 GET·POST·DELETE -> 409 거절, 파일 바이트 유지", async () => {
      const favFile = path.join(workDir, "doc-favorites.json")
      // 256KB + 100바이트 크기의 즐겨찾기 파일
      const bigItems = Array.from({ length: 1500 }, (_, i) => ({
        source: "adk",
        path: `big-item-with-long-path-padding-${i}-${"x".repeat(150)}.md`,
        type: "file" as const,
        addedAt: new Date().toISOString(),
      }))
      const bigContent = JSON.stringify({ schemaVersion: 1, items: bigItems }, null, 2)
      expect(Buffer.byteLength(bigContent, "utf-8")).toBeGreaterThan(256 * 1024)
      fs.writeFileSync(favFile, bigContent, "utf-8")

      // GET 거절 (409)
      const getRes = await app.inject({
        method: "GET",
        url: "/api/portal/favorites",
        headers: TRUSTED_HEADERS,
      })
      expect(getRes.statusCode).toBe(409)
      expect(JSON.parse(getRes.payload)).toEqual({ error: "favorites_file_invalid" })

      // POST 거절 (409)
      const postRes = await app.inject({
        method: "POST",
        url: "/api/portal/favorites",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "sample.md",
        },
      })
      expect(postRes.statusCode).toBe(409)
      expect(JSON.parse(postRes.payload)).toEqual({ error: "favorites_file_invalid" })

      // DELETE 거절 (409)
      const delRes = await app.inject({
        method: "DELETE",
        url: "/api/portal/favorites",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "sample.md",
        },
      })
      expect(delRes.statusCode).toBe(409)
      expect(JSON.parse(delRes.payload)).toEqual({ error: "favorites_file_invalid" })

      expect(fs.readFileSync(favFile, "utf-8")).toBe(bigContent)
    })

    it("링크인 즐겨찾기 파일에서 GET·POST·DELETE -> 409 거절, 파일(링크 대상 포함) 바이트 유지", async () => {
      const favFile = path.join(workDir, "doc-favorites.json")
      const realFavFile = path.join(docsDir, "external-favorites.json")
      const realFavContent = JSON.stringify({ schemaVersion: 1, items: [] }, null, 2)
      fs.writeFileSync(realFavFile, realFavContent, "utf-8")

      try { fs.unlinkSync(favFile) } catch {}
      fs.symlinkSync(realFavFile, favFile)

      // GET 거절 (409)
      const getRes = await app.inject({
        method: "GET",
        url: "/api/portal/favorites",
        headers: TRUSTED_HEADERS,
      })
      expect(getRes.statusCode).toBe(409)
      expect(JSON.parse(getRes.payload)).toEqual({ error: "favorites_file_invalid" })

      // POST 거절 (409)
      const postRes = await app.inject({
        method: "POST",
        url: "/api/portal/favorites",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "sample.md",
        },
      })
      expect(postRes.statusCode).toBe(409)
      expect(JSON.parse(postRes.payload)).toEqual({ error: "favorites_file_invalid" })

      // DELETE 거절 (409)
      const delRes = await app.inject({
        method: "DELETE",
        url: "/api/portal/favorites",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "sample.md",
        },
      })
      expect(delRes.statusCode).toBe(409)
      expect(JSON.parse(delRes.payload)).toEqual({ error: "favorites_file_invalid" })

      // 링크 및 링크 대상 파일 바이트 유지
      expect(fs.lstatSync(favFile).isSymbolicLink()).toBe(true)
      expect(fs.readFileSync(realFavFile, "utf-8")).toBe(realFavContent)
    })
  })

  // 8번: CLI 사례 표 시험 (서버와 판정 일치 검증)
  describe("8. CLI 사례 표 시험 (크기 초과·링크·정상 판정 서버와 일치)", () => {
    it("사례 표에 따른 서버와 CLI의 판정이 완전히 일치한다", () => {
      const caseWs = fs.mkdtempSync(path.join(os.tmpdir(), "doc-notes-case-test-"))
      const caseNotesDir = path.join(caseWs, ".agents", "work", "doc-notes")
      fs.mkdirSync(caseNotesDir, { recursive: true })

      try {
        // 1) 정상 메모
        const idNormal = generateNoteId(new Date(2026, 8, 26, 10, 0, 0))
        const noteNormal: DocNote = {
          schemaVersion: 1,
          id: idNormal,
          source: "adk",
          path: "test.md",
          quote: null,
          body: "정상 메모 본문",
          status: "open",
          createdAt: "2026-09-26T10:00:00.000Z",
          updatedAt: "2026-09-26T10:00:00.000Z",
          reply: null,
          resolvedAt: null,
        }
        fs.writeFileSync(path.join(caseNotesDir, `${idNormal}.json`), JSON.stringify(noteNormal, null, 2))

        // 2) 64KB 초과 메모
        const idTooLarge = generateNoteId(new Date(2026, 8, 26, 10, 1, 0))
        const noteTooLarge: DocNote = {
          ...noteNormal,
          id: idTooLarge,
          body: "Z".repeat(65 * 1024),
        }
        fs.writeFileSync(path.join(caseNotesDir, `${idTooLarge}.json`), JSON.stringify(noteTooLarge))

        // 3) 심볼릭 링크 메모
        const idTarget = generateNoteId(new Date(2026, 8, 26, 10, 2, 0))
        const realTarget = path.join(caseWs, "external-note.json")
        fs.writeFileSync(realTarget, JSON.stringify({ ...noteNormal, id: idTarget }))

        const idSymlink = generateNoteId(new Date(2026, 8, 26, 10, 3, 0))
        fs.symlinkSync(realTarget, path.join(caseNotesDir, `${idSymlink}.json`))

        // 4) 하드 링크 메모 (nlink > 1)
        const idHardlink = generateNoteId(new Date(2026, 8, 26, 10, 4, 0))
        const hardlinkSrc = path.join(caseWs, "hardlink-src.json")
        fs.writeFileSync(hardlinkSrc, JSON.stringify({ ...noteNormal, id: idHardlink }))
        fs.linkSync(hardlinkSrc, path.join(caseNotesDir, `${idHardlink}.json`))

        // 5) JSON 깨짐 메모
        const idInvalidJson = generateNoteId(new Date(2026, 8, 26, 10, 5, 0))
        fs.writeFileSync(path.join(caseNotesDir, `${idInvalidJson}.json`), "{ broken json ...")

        // 6) 존재하지 않는 메모
        const idNonExistent = generateNoteId(new Date(2026, 8, 26, 10, 6, 0))

        const cases: Array<{
          name: string
          id: string
          expectedOk: boolean
          expectedError?: string
        }> = [
          { name: "정상 메모 (<=64KB)", id: idNormal, expectedOk: true },
          { name: "64KB 초과 메모", id: idTooLarge, expectedOk: false, expectedError: "too_large" },
          { name: "심볼릭 링크 메모", id: idSymlink, expectedOk: false, expectedError: "link" },
          { name: "하드 링크 메모", id: idHardlink, expectedOk: false, expectedError: "link" },
          { name: "잘못된 JSON 메모", id: idInvalidJson, expectedOk: false, expectedError: "invalid" },
          { name: "존재하지 않는 메모", id: idNonExistent, expectedOk: false, expectedError: "not_found" },
        ]

        for (const tc of cases) {
          const serverSecure = serverReadNoteSecure(caseWs, tc.id)
          const cliSecure = cliReadNoteSecure(caseWs, tc.id)

          // 1. readNoteSecure 반환값 동등성
          expect(serverSecure.ok).toBe(tc.expectedOk)
          expect(cliSecure.ok).toBe(tc.expectedOk)
          if (!tc.expectedOk) {
            expect((serverSecure as any).error).toBe(tc.expectedError)
            expect((cliSecure as any).error).toBe(tc.expectedError)
          } else {
            expect(serverSecure.ok ? serverSecure.note.id : null).toBe(tc.id)
            expect(cliSecure.ok ? cliSecure.note.id : null).toBe(tc.id)
          }

          // 2. readNote 반환값 동등성 (null 여부 및 내용)
          const serverNote = serverReadNote(caseWs, tc.id)
          const cliNote = cliReadNote(caseWs, tc.id)
          if (tc.expectedOk) {
            expect(serverNote).not.toBeNull()
            expect(cliNote).not.toBeNull()
            expect(serverNote?.id).toBe(tc.id)
            expect(cliNote?.id).toBe(tc.id)
          } else {
            expect(serverNote).toBeNull()
            expect(cliNote).toBeNull()
          }
        }

        // 3. listNotes 결과 동등성: 오직 정상 메모만 목록에 포함됨
        const serverList = serverListNotes(caseWs)
        const cliList = cliListNotes(caseWs)

        expect(serverList.map((n) => n.id)).toEqual([idNormal])
        expect(cliList.map((n) => n.id)).toEqual([idNormal])
        expect(serverList).toEqual(cliList)
      } finally {
        try {
          fs.rmSync(caseWs, { recursive: true, force: true })
        } catch {}
      }
    })
  })
})
