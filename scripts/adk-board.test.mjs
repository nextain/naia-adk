import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import net from "node:net"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolveBoardConfig, portInUse, portBusyMessage } from "./adk-board.mjs"

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
  // 작업 공간 하나를 임시로 만들고 그 안에 실행기를 복사한다. 실행기는 자기 위치로 작업 공간을 찾는다.
  function makeWorkspace(name, port) {
    const root = path.join(tempRoot, name)
    const companyDir = path.join(root, "data-company", "my-company")
    fs.mkdirSync(companyDir, { recursive: true })
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true })
    const __dirname = path.dirname(fileURLToPath(import.meta.url))
    fs.copyFileSync(path.join(__dirname, "adk-board.mjs"), path.join(root, "scripts", "adk-board.mjs"))
    const hubScripts = path.join(root, "projects", "hub", "scripts")
    fs.mkdirSync(hubScripts, { recursive: true })
    // 작업보드가 실제로 실행되면 표시 파일을 남긴다.
    fs.writeFileSync(
      path.join(hubScripts, "board-server.mjs"),
      "import fs from 'node:fs'; fs.writeFileSync('board-ran', 'yes'); console.log('board running')",
    )
    fs.writeFileSync(
      path.join(companyDir, "adk-company.json"),
      JSON.stringify({
        schemaVersion: 1,
        title: "회사 문서",
        repos: [{ id: "hub", path: "projects/hub", remote: "https://example.com/hub.git" }],
        board: { repo: "hub", script: "scripts/board-server.mjs", port },
      }),
    )
    return { root, marker: path.join(root, "projects", "hub", "board-ran") }
  }

  function listen(port) {
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once("error", reject)
      server.listen(port, "127.0.0.1", () => resolve(server))
    })
  }

  it("작업보드 포트를 다른 프로그램이 쓰면: 스택 추적 없이 한 줄로 알리고 0으로 종료, 작업보드는 띄우지 않음", async () => {
    const holder = await listen(0)
    const port = holder.address().port
    try {
      assert.equal(await portInUse("127.0.0.1", port), true)
      const { root, marker } = makeWorkspace("port-busy", port)
      const result = spawnSync(process.execPath, [path.join(root, "scripts", "adk-board.mjs")], {
        cwd: root,
        encoding: "utf-8",
        env: { ...process.env, ADK_HOST: "127.0.0.1" },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), portBusyMessage(port))
      assert.equal(result.stderr, "", "스택 추적이 나오면 안 됩니다.")
      assert.equal(fs.existsSync(marker), false, "겹친 포트로 작업보드를 띄우면 안 됩니다.")
    } finally {
      await new Promise((resolve) => holder.close(resolve))
    }
  })

  it("작업보드 포트가 비어 있으면: 작업보드를 그대로 띄움", async () => {
    const holder = await listen(0)
    const port = holder.address().port
    await new Promise((resolve) => holder.close(resolve))
    assert.equal(await portInUse("127.0.0.1", port), false)
    const { root, marker } = makeWorkspace("port-free", port)
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "adk-board.mjs")], {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env, ADK_HOST: "127.0.0.1" },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes("board running"))
    assert.equal(fs.existsSync(marker), true)
  })
})
