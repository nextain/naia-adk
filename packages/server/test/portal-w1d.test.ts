import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createServer } from "../src/server.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DOC_NOTES_MJS = path.resolve(__dirname, "../../../scripts/doc-notes.mjs")

describe("W1d Integration: 문서 편집·메모·즐겨찾기·쓰기보호·doc-notes.mjs", () => {
  let tempRoot: string
  let dataFolderDir: string
  let app: Awaited<ReturnType<typeof createServer>>
  let docsDir: string

  const TEST_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  const TRUSTED_HEADERS = {
    host: "localhost:3141",
    "x-naia-proxy-secret": TEST_SECRET,
    "x-naia-peer": "127.0.0.1",
    "x-naia-local": "127.0.0.1",
    "x-naia-origin-ok": "1",
  }

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-w1d-root-"))
    dataFolderDir = fs.mkdtempSync(path.join(os.tmpdir(), "adk-w1d-data-"))

    docsDir = path.join(tempRoot, "docs")
    fs.mkdirSync(docsDir, { recursive: true })

    // 1. 일반 LF 문서
    fs.writeFileSync(path.join(docsDir, "edit-test.md"), "# 편집 시험 문서\n첫 번째 줄\n두 번째 줄\n", "utf-8")

    // 2. CRLF 문서
    fs.writeFileSync(path.join(docsDir, "crlf-test.md"), "# CRLF 문서\r\n줄바꿈 테스트\r\n마지막 줄\r\n", "utf-8")

    // 3. doc 아닌 파일
    fs.writeFileSync(path.join(docsDir, "not-doc.txt"), "텍스트 파일 내용", "utf-8")

    // 4. 데이터 폴더 (W1c 방식: view-folders.json)
    const workDir = path.join(tempRoot, ".agents", "work")
    fs.mkdirSync(workDir, { recursive: true })

    // 데이터 폴더 안에 .naia-view 표시 파일 및 md 파일
    fs.writeFileSync(path.join(dataFolderDir, ".naia-view"), "")
    fs.writeFileSync(path.join(dataFolderDir, "readonly-doc.md"), "# 데이터 폴더 읽기 전용 문서", "utf-8")

    const viewFoldersConfig = {
      schemaVersion: 1,
      folders: [
        {
          id: "test-data",
          label: "테스트 데이터 폴더",
          path: dataFolderDir,
          tab: "common",
        },
      ],
    }
    fs.writeFileSync(path.join(workDir, "view-folders.json"), JSON.stringify(viewFoldersConfig, null, 2))

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
      fs.rmSync(dataFolderDir, { recursive: true, force: true })
    } catch {}
    await app.close()
  })

  describe("1. FE 5장: GET /doc ETag 및 PUT /doc 편집", () => {
    it("GET /doc 응답에 ETag 헤더가 포함된다", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/portal/doc?source=adk&path=edit-test.md",
        headers: TRUSTED_HEADERS,
      })
      expect(res.statusCode).toBe(200)
      const content = fs.readFileSync(path.join(docsDir, "edit-test.md"))
      const expectedEtag = crypto.createHash("sha256").update(content).digest("hex")
      expect(res.headers.etag).toBe(expectedEtag)
    })

    it("PUT /doc: baseHash가 불일치하면 409 { error: 'changed' }이고 파일은 그대로다", async () => {
      const beforeContent = fs.readFileSync(path.join(docsDir, "edit-test.md"), "utf-8")
      const wrongHash = "0000000000000000000000000000000000000000000000000000000000000000"

      const res = await app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=edit-test.md",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          baseHash: wrongHash,
          content: "# 바뀐 내용",
        },
      })

      expect(res.statusCode).toBe(409)
      expect(JSON.parse(res.body)).toEqual({ error: "changed" })
      const afterContent = fs.readFileSync(path.join(docsDir, "edit-test.md"), "utf-8")
      expect(afterContent).toBe(beforeContent)
    })

    it("PUT /doc: baseHash가 일치하면 정상 수정(200)되고 ETag가 반환된다", async () => {
      const currentBuf = fs.readFileSync(path.join(docsDir, "edit-test.md"))
      const currentHash = crypto.createHash("sha256").update(currentBuf).digest("hex")
      const newContent = "# 수정 완료된 내용\n새로운 줄\n"

      const res = await app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=edit-test.md",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          baseHash: currentHash,
          content: newContent,
        },
      })

      expect(res.statusCode).toBe(200)
      const expectedNewHash = crypto.createHash("sha256").update(Buffer.from(newContent, "utf-8")).digest("hex")
      expect(res.headers.etag).toBe(expectedNewHash)

      const savedContent = fs.readFileSync(path.join(docsDir, "edit-test.md"), "utf-8")
      expect(savedContent).toBe(newContent)
    })

    it("PUT /doc: CRLF 파일은 브라우저 LF 입력을 받아도 CRLF 줄바꿈을 보존한다", async () => {
      const crlfBuf = fs.readFileSync(path.join(docsDir, "crlf-test.md"))
      const crlfHash = crypto.createHash("sha256").update(crlfBuf).digest("hex")
      // 브라우저가 LF로 보낸 새 내용
      const inputLfContent = "# 수정된 CRLF 파일\n두번째 줄\n세번째 줄\n"

      const res = await app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=crlf-test.md",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          baseHash: crlfHash,
          content: inputLfContent,
        },
      })

      expect(res.statusCode).toBe(200)
      const saved = fs.readFileSync(path.join(docsDir, "crlf-test.md"), "utf-8")
      expect(saved.includes("\r\n")).toBe(true)
      expect(saved.replace(/\r\n/g, "\n")).toBe(inputLfContent)
      expect(saved).toBe("# 수정된 CRLF 파일\r\n두번째 줄\r\n세번째 줄\r\n")
    })

    it("PUT /doc: 정확히 2MB인 본문은 200이고, 2MB 초과는 400 거절된다", async () => {
      // 2MB 파일 준비
      const largeFilePath = path.join(docsDir, "large-2mb.md")
      const target2MBBytes = 2 * 1024 * 1024 // 2097152
      const content2MB = "a".repeat(target2MBBytes)
      fs.writeFileSync(largeFilePath, content2MB, "utf-8")
      const hash2MB = crypto.createHash("sha256").update(Buffer.from(content2MB, "utf-8")).digest("hex")

      // 정확히 2MB 수정 요청 -> 200
      const res2MB = await app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=large-2mb.md",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          baseHash: hash2MB,
          content: content2MB,
        },
      })
      expect(res2MB.statusCode).toBe(200)

      // 2MB + 1바이트 초과 요청 -> 400 거절
      const content2MBPlus = "a".repeat(target2MBBytes + 1)
      const resOver = await app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=large-2mb.md",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          baseHash: res2MB.headers.etag as string,
          content: content2MBPlus,
        },
      })
      expect(resOver.statusCode).toBe(400)
      expect(resOver.body).toContain("2MB")
    })

    it("PUT /doc: 3MB 상향(bodyLimit) 확인 및 다른 라우트 1MiB 초과 413 확인", async () => {
      // 다른 쓰기 라우트 (POST /notes)에 1MiB 초과 본문 전송 -> 413
      const large1_5MB = "x".repeat(1.5 * 1024 * 1024)
      const notesRes = await app.inject({
        method: "POST",
        url: "/api/portal/notes",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "edit-test.md",
          body: large1_5MB,
        },
      })
      expect(notesRes.statusCode).toBe(413)

      // PUT /doc에 3MB 초과 본문 전송 -> 413
      const large3_5MB = "y".repeat(3.5 * 1024 * 1024)
      const docOverRes = await app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=edit-test.md",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          baseHash: "dummy",
          content: large3_5MB,
        },
      })
      expect(docOverRes.statusCode).toBe(413)
    })

    it("PUT /doc: data: 출처(readOnly) 문서로의 PUT은 403 거절된다", async () => {
      const dataBuf = fs.readFileSync(path.join(dataFolderDir, "readonly-doc.md"))
      const dataHash = crypto.createHash("sha256").update(dataBuf).digest("hex")

      const res = await app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=data:test-data&path=readonly-doc.md",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          baseHash: dataHash,
          content: "# 수정 시도",
        },
      })

      expect(res.statusCode).toBe(403)
    })

    it("PUT /doc: 없는 파일 및 doc 아닌 파일은 404 거절된다", async () => {
      const notFoundRes = await app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=non-existent.md",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          baseHash: "dummy",
          content: "내용",
        },
      })
      expect(notFoundRes.statusCode).toBe(404)

      const notDocRes = await app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=not-doc.txt",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          baseHash: "dummy",
          content: "내용",
        },
      })
      expect(notDocRes.statusCode).toBe(404)
    })
  })

  describe("2. FE 6장: 메모 API & CLI (doc-notes.mjs)", () => {
    let createdNoteId: string

    it("POST /notes: 메모를 생성하고 파일 바이트를 확인한다 (readOnly 출처도 가능)", async () => {
      // 1. data: 출처 문서에 메모 작성 성공
      const res = await app.inject({
        method: "POST",
        url: "/api/portal/notes",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "data:test-data",
          path: "readonly-doc.md",
          quote: "읽기 전용 문서",
          body: "이 문서를 검토해 주세요.",
        },
      })

      expect(res.statusCode).toBe(201)
      const json = JSON.parse(res.body)
      expect(json.ok).toBe(true)
      expect(json.note.id).toMatch(/^\d{8}-\d{6}-[a-z0-9]{6}$/)
      expect(json.note.status).toBe("open")
      createdNoteId = json.note.id

      // 임시 루트 파일 바이트 확인
      const noteFilePath = path.join(tempRoot, ".agents", "work", "doc-notes", `${createdNoteId}.json`)
      expect(fs.existsSync(noteFilePath)).toBe(true)
      const savedNote = JSON.parse(fs.readFileSync(noteFilePath, "utf-8"))
      expect(savedNote.id).toBe(createdNoteId)
      expect(savedNote.body).toBe("이 문서를 검토해 주세요.")
      expect(savedNote.source).toBe("data:test-data")
    })

    it("POST /notes: 없는 파일 및 doc 아닌 파일은 404 거절된다", async () => {
      const resNoFile = await app.inject({
        method: "POST",
        url: "/api/portal/notes",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "non-existent.md",
          body: "메모 내용",
        },
      })
      expect(resNoFile.statusCode).toBe(404)

      const resNotDoc = await app.inject({
        method: "POST",
        url: "/api/portal/notes",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "not-doc.txt",
          body: "메모 내용",
        },
      })
      expect(resNotDoc.statusCode).toBe(404)
    })

    it("메모 id 형식 검사 (경로 조작 ../x 포함) 거절", async () => {
      const invalidIds = ["../foo", "2026-09-25", "invalid_id", "20260925-120000-XYZ", "20260925-120000-1234567"]
      for (const badId of invalidIds) {
        const patchRes = await app.inject({
          method: "PATCH",
          url: `/api/portal/notes/${encodeURIComponent(badId)}`,
          headers: {
            ...TRUSTED_HEADERS,
            "content-type": "application/json",
          },
          payload: { body: "새 본문" },
        })
        expect(patchRes.statusCode).toBe(400)

        const deleteRes = await app.inject({
          method: "DELETE",
          url: `/api/portal/notes/${encodeURIComponent(badId)}`,
          headers: TRUSTED_HEADERS,
        })
        expect(deleteRes.statusCode).toBe(400)
      }
    })

    it("메모 길이 제한 검사 (body 1~4000자, quote 2000자, reply 4000자)", async () => {
      // body 빈 문자열 -> 400
      const resEmpty = await app.inject({
        method: "POST",
        url: "/api/portal/notes",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "edit-test.md",
          body: "",
        },
      })
      expect(resEmpty.statusCode).toBe(400)

      // body 4001자 -> 400
      const resLongBody = await app.inject({
        method: "POST",
        url: "/api/portal/notes",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "edit-test.md",
          body: "a".repeat(4001),
        },
      })
      expect(resLongBody.statusCode).toBe(400)

      // quote 2001자 -> 400
      const resLongQuote = await app.inject({
        method: "POST",
        url: "/api/portal/notes",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "edit-test.md",
          quote: "q".repeat(2001),
          body: "정상 본문",
        },
      })
      expect(resLongQuote.statusCode).toBe(400)
    })

    it("GET /notes/counts: 열린 메모 개수가 정확히 집계된다", async () => {
      // 현재 createdNoteId 하나(data:test-data, readonly-doc.md) open 상태
      const res = await app.inject({
        method: "GET",
        url: "/api/portal/notes/counts",
        headers: TRUSTED_HEADERS,
      })
      expect(res.statusCode).toBe(200)
      const counts = JSON.parse(res.body)
      expect(counts["data:test-data\u0000readonly-doc.md"]).toBe(1)
    })

    it("PATCH /notes/:id: 내용, 답변, 상태를 수정하고 파일 바이트를 확인한다", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/portal/notes/${createdNoteId}`,
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          body: "수정된 메모 내용",
          reply: "초기 질문 답변",
        },
      })

      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.note.body).toBe("수정된 메모 내용")
      expect(json.note.reply).toBe("초기 질문 답변")

      const noteFilePath = path.join(tempRoot, ".agents", "work", "doc-notes", `${createdNoteId}.json`)
      const fileContent = JSON.parse(fs.readFileSync(noteFilePath, "utf-8"))
      expect(fileContent.body).toBe("수정된 메모 내용")
      expect(fileContent.reply).toBe("초기 질문 답변")
    })

    it("doc-notes.mjs: --root 인자로 list, show, reply, resolve를 실행한다", () => {
      // 1. list
      const listOut = execFileSync("node", [DOC_NOTES_MJS, "list", "--open", "--root", tempRoot], {
        encoding: "utf-8",
      })
      expect(listOut).toContain(createdNoteId)
      expect(listOut).toContain("수정된 메모 내용")

      // 2. show
      const showOut = execFileSync("node", [DOC_NOTES_MJS, "show", createdNoteId, "--root", tempRoot], {
        encoding: "utf-8",
      })
      expect(showOut).toContain(createdNoteId)
      expect(showOut).toContain("상태: open")
      expect(showOut).toContain("초기 질문 답변")

      // 3. reply (status 유지)
      const replyOut = execFileSync(
        "node",
        [DOC_NOTES_MJS, "reply", createdNoteId, "--reply", "추가 질문입니다", "--root", tempRoot],
        { encoding: "utf-8" },
      )
      expect(replyOut).toContain("답글이 등록되었습니다")

      const noteAfterReply = JSON.parse(
        fs.readFileSync(path.join(tempRoot, ".agents", "work", "doc-notes", `${createdNoteId}.json`), "utf-8"),
      )
      expect(noteAfterReply.status).toBe("open")
      expect(noteAfterReply.reply).toBe("추가 질문입니다")

      // 4. resolve
      const resolveOut = execFileSync(
        "node",
        [DOC_NOTES_MJS, "resolve", createdNoteId, "--reply", "수정 완료했습니다", "--root", tempRoot],
        { encoding: "utf-8" },
      )
      expect(resolveOut).toContain("메모가 해결되었습니다")

      const noteAfterResolve = JSON.parse(
        fs.readFileSync(path.join(tempRoot, ".agents", "work", "doc-notes", `${createdNoteId}.json`), "utf-8"),
      )
      expect(noteAfterResolve.status).toBe("resolved")
      expect(noteAfterResolve.reply).toBe("수정 완료했습니다")
      expect(noteAfterResolve.resolvedAt).toBeDefined()
    })

    it("DELETE /notes/:id: 본문 및 Content-Type 없이 삭제 성공하고 파일이 제거된다", async () => {
      const noteFilePath = path.join(tempRoot, ".agents", "work", "doc-notes", `${createdNoteId}.json`)
      expect(fs.existsSync(noteFilePath)).toBe(true)

      const res = await app.inject({
        method: "DELETE",
        url: `/api/portal/notes/${createdNoteId}`,
        headers: TRUSTED_HEADERS, // content-type 없음
      })

      expect(res.statusCode).toBe(200)
      expect(fs.existsSync(noteFilePath)).toBe(false)
    })
  })

  describe("3. FE 7장: 즐겨찾기 API", () => {
    it("POST /favorites: 정상 추가 및 중복 200 반환", async () => {
      // 1. 파일 추가
      const resFile = await app.inject({
        method: "POST",
        url: "/api/portal/favorites",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "edit-test.md",
        },
      })
      expect(resFile.statusCode).toBe(200)
      const jsonFile = JSON.parse(resFile.body)
      expect(jsonFile.ok).toBe(true)
      expect(jsonFile.item.type).toBe("file")

      // 2. 빈 경로(출처 루트 디렉토리) 추가
      const resRoot = await app.inject({
        method: "POST",
        url: "/api/portal/favorites",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "",
        },
      })
      expect(resRoot.statusCode).toBe(200)
      const jsonRoot = JSON.parse(resRoot.body)
      expect(jsonRoot.item.type).toBe("directory")

      // 3. 중복 추가 시 200 반환 (개수 증가 없음)
      const resDup = await app.inject({
        method: "POST",
        url: "/api/portal/favorites",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "edit-test.md",
        },
      })
      expect(resDup.statusCode).toBe(200)
    })

    it("GET /favorites: exists 필드가 정확히 표시된다", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/portal/favorites",
        headers: TRUSTED_HEADERS,
      })
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.items.length).toBe(2)

      const fileItem = json.items.find((it: any) => it.path === "edit-test.md")
      expect(fileItem.exists).toBe(true)

      const rootItem = json.items.find((it: any) => it.path === "")
      expect(rootItem.exists).toBe(true)
    })

    it("POST /favorites: 200개 상한 도달 시 400 거절된다", async () => {
      const favFilePath = path.join(tempRoot, ".agents", "work", "doc-favorites.json")
      const current = JSON.parse(fs.readFileSync(favFilePath, "utf-8"))

      // 200개 채우기
      const fullItems = []
      for (let i = 0; i < 200; i++) {
        fullItems.push({
          source: "adk",
          path: `dummy-path-${i}.md`,
          type: "file" as const,
          addedAt: new Date().toISOString(),
        })
      }
      fs.writeFileSync(favFilePath, JSON.stringify({ schemaVersion: 1, items: fullItems }))

      const resOver = await app.inject({
        method: "POST",
        url: "/api/portal/favorites",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "adk",
          path: "edit-test.md",
        },
      })
      expect(resOver.statusCode).toBe(400)
      expect(resOver.body).toContain("200")

      // 복구
      fs.writeFileSync(favFilePath, JSON.stringify(current))
    })

    it("DELETE /favorites: 없는 파일이나 사라진 출처여도 삭제 성공한다", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/portal/favorites",
        headers: {
          ...TRUSTED_HEADERS,
          "content-type": "application/json",
        },
        payload: {
          source: "ghost-source",
          path: "ghost-file.md",
        },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  describe("4. FE 8장: 쓰기 및 새 보기 보안 가드", () => {
    it("쓰기 라우트 전체: x-naia-origin-ok가 없으면 403 거절된다", async () => {
      const noOriginHeaders = {
        host: "localhost:3141",
        "x-naia-proxy-secret": TEST_SECRET,
        "x-naia-peer": "127.0.0.1",
        "x-naia-local": "127.0.0.1",
        // x-naia-origin-ok 없음
      }

      // 1. PUT doc
      const putRes = await app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=edit-test.md",
        headers: { ...noOriginHeaders, "content-type": "application/json" },
        payload: { baseHash: "x", content: "y" },
      })
      expect(putRes.statusCode).toBe(403)

      // 2. POST notes
      const postNotesRes = await app.inject({
        method: "POST",
        url: "/api/portal/notes",
        headers: { ...noOriginHeaders, "content-type": "application/json" },
        payload: { source: "adk", path: "edit-test.md", body: "test" },
      })
      expect(postNotesRes.statusCode).toBe(403)

      // 3. PATCH notes
      const patchNotesRes = await app.inject({
        method: "PATCH",
        url: "/api/portal/notes/20260925-120000-a1b2c3",
        headers: { ...noOriginHeaders, "content-type": "application/json" },
        payload: { body: "test" },
      })
      expect(patchNotesRes.statusCode).toBe(403)

      // 4. DELETE notes
      const deleteNotesRes = await app.inject({
        method: "DELETE",
        url: "/api/portal/notes/20260925-120000-a1b2c3",
        headers: noOriginHeaders,
      })
      expect(deleteNotesRes.statusCode).toBe(403)

      // 5. POST favorites
      const postFavRes = await app.inject({
        method: "POST",
        url: "/api/portal/favorites",
        headers: { ...noOriginHeaders, "content-type": "application/json" },
        payload: { source: "adk", path: "" },
      })
      expect(postFavRes.statusCode).toBe(403)

      // 6. DELETE favorites
      const deleteFavRes = await app.inject({
        method: "DELETE",
        url: "/api/portal/favorites",
        headers: { ...noOriginHeaders, "content-type": "application/json" },
        payload: { source: "adk", path: "" },
      })
      expect(deleteFavRes.statusCode).toBe(403)
    })

    it("본문이 있는 쓰기는 JSON 형식이 아니면 거절(415)된다", async () => {
      // 1. PUT doc
      const putRes = await app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=edit-test.md",
        headers: { ...TRUSTED_HEADERS, "content-type": "text/plain" },
        payload: "plain text",
      })
      expect(putRes.statusCode).toBe(415)

      // 2. POST notes
      const postNotesRes = await app.inject({
        method: "POST",
        url: "/api/portal/notes",
        headers: { ...TRUSTED_HEADERS, "content-type": "text/plain" },
        payload: "plain text",
      })
      expect(postNotesRes.statusCode).toBe(415)

      // 3. POST favorites
      const postFavRes = await app.inject({
        method: "POST",
        url: "/api/portal/favorites",
        headers: { ...TRUSTED_HEADERS, "content-type": "text/plain" },
        payload: "plain text",
      })
      expect(postFavRes.statusCode).toBe(415)

      // 4. DELETE favorites
      const delFavRes = await app.inject({
        method: "DELETE",
        url: "/api/portal/favorites",
        headers: { ...TRUSTED_HEADERS, "content-type": "text/plain" },
        payload: "plain text",
      })
      expect(delFavRes.statusCode).toBe(415)
    })

    it("메모·즐겨찾기 읽기: cross-site는 403, 없으면 200, 비밀 없는 직접 요청은 403", async () => {
      // 1. Sec-Fetch-Site: cross-site -> 403
      const crossSiteHeaders = {
        ...TRUSTED_HEADERS,
        "sec-fetch-site": "cross-site",
      }

      const resNotesCross = await app.inject({
        method: "GET",
        url: "/api/portal/notes",
        headers: crossSiteHeaders,
      })
      expect(resNotesCross.statusCode).toBe(403)

      const resCountsCross = await app.inject({
        method: "GET",
        url: "/api/portal/notes/counts",
        headers: crossSiteHeaders,
      })
      expect(resCountsCross.statusCode).toBe(403)

      const resFavCross = await app.inject({
        method: "GET",
        url: "/api/portal/favorites",
        headers: crossSiteHeaders,
      })
      expect(resFavCross.statusCode).toBe(403)

      // 2. 정상 헤더 (sec-fetch-site 없음 또는 same-origin) -> 200
      const resNotesOk = await app.inject({
        method: "GET",
        url: "/api/portal/notes",
        headers: TRUSTED_HEADERS,
      })
      expect(resNotesOk.statusCode).toBe(200)

      const resCountsOk = await app.inject({
        method: "GET",
        url: "/api/portal/notes/counts",
        headers: TRUSTED_HEADERS,
      })
      expect(resCountsOk.statusCode).toBe(200)

      const resFavOk = await app.inject({
        method: "GET",
        url: "/api/portal/favorites",
        headers: TRUSTED_HEADERS,
      })
      expect(resFavOk.statusCode).toBe(200)

      // 3. 비밀 없는 직접 요청 -> 403
      const directHeaders = { host: "localhost:3141" }
      const resDirectNotes = await app.inject({
        method: "GET",
        url: "/api/portal/notes",
        headers: directHeaders,
      })
      expect(resDirectNotes.statusCode).toBe(403)

      const resDirectFav = await app.inject({
        method: "GET",
        url: "/api/portal/favorites",
        headers: directHeaders,
      })
      expect(resDirectFav.statusCode).toBe(403)
    })
  })
})
