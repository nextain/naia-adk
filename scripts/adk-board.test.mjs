import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolveBoardConfig } from "./adk-board.mjs"

describe("adk-board (scripts/adk-board.mjs)", () => {
  let tempRoot

  before(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-board-test-"))
  })

  after(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it("board 설정이 없을 때: resolveBoardConfig는 null을 반환하고 스크립트는 0으로 종료", () => {
    const emptyRoot = path.join(tempRoot, "empty-root")
    fs.mkdirSync(emptyRoot, { recursive: true })

    const result = resolveBoardConfig(emptyRoot)
    assert.equal(result, null, "board 설정이 없으면 null을 반환해야 합니다.")

    // CLI 실행 테스트
    const __dirname = path.dirname(fileURLToPath(import.meta.url))
    const boardScript = path.join(__dirname, "adk-board.mjs")

    // 임시 폴더에서 실행하여 설정이 없도록 함
    const output = execFileSync(process.execPath, [boardScript], {
      cwd: emptyRoot,
      encoding: "utf-8",
    })

    assert.ok(output.includes("작업보드 없음: pnpm adk:setup 먼저"), "안내 문구가 출력되어야 합니다.")
  })

  it("board 설정이 있을 때: 호스트, 포트, docs-viewer-url 인자를 올바르게 구성", () => {
    const rootWithBoard = path.join(tempRoot, "with-board")
    const companyDir = path.join(rootWithBoard, "data-company", "my-company")
    fs.mkdirSync(companyDir, { recursive: true })

    const hubRepoDir = path.join(rootWithBoard, "projects", "hub", "scripts")
    fs.mkdirSync(hubRepoDir, { recursive: true })
    const scriptFile = path.join(hubRepoDir, "board-server.mjs")
    fs.writeFileSync(scriptFile, "console.log('board running')")

    const companyConfig = {
      schemaVersion: 1,
      title: "회사 문서",
      repos: [
        {
          id: "hub",
          path: "projects/hub",
          remote: "https://example.com/hub.git",
        },
      ],
      board: {
        repo: "hub",
        script: "scripts/board-server.mjs",
        port: 8894,
      },
    }
    fs.writeFileSync(
      path.join(companyDir, "adk-company.json"),
      JSON.stringify(companyConfig, null, 2),
    )

    // 기본 환경 변수 테스트
    const boardConfig = resolveBoardConfig(rootWithBoard, {})
    assert.ok(boardConfig !== null, "boardConfig가 생성되어야 합니다.")
    assert.equal(boardConfig.host, "127.0.0.1")
    assert.equal(boardConfig.port, 8894)
    assert.equal(boardConfig.docsViewerUrl, "http://localhost:3142/docs")
    assert.deepEqual(boardConfig.args, [
      scriptFile,
      "--host",
      "127.0.0.1",
      "--port",
      "8894",
      "--docs-viewer-url",
      "http://localhost:3142/docs",
    ])

    // 커스텀 환경 변수 (ADK_HOST, ADK_PUBLIC_HOST) 테스트
    const customConfig = resolveBoardConfig(rootWithBoard, {
      ADK_HOST: "0.0.0.0",
      ADK_PUBLIC_HOST: "naia.local",
    })
    assert.ok(customConfig !== null)
    assert.equal(customConfig.host, "0.0.0.0")
    assert.equal(customConfig.docsViewerUrl, "http://naia.local:3142/docs")
    assert.ok(customConfig.args.includes("--host"))
    assert.ok(customConfig.args.includes("0.0.0.0"))
    assert.ok(customConfig.args.includes("http://naia.local:3142/docs"))
  })
})
