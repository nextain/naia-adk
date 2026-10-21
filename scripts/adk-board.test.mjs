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

  // (가) 없음 세 값(undefined, null, "")
  it("(가) board.queueRepo 없음 세 값(undefined, null, ''): --repo-root 없이 기본 인자 유지, queueRepoDir === null", () => {
    const noneValues = [undefined, null, ""]
    for (const [idx, val] of noneValues.entries()) {
      const root = path.join(tempRoot, `none-val-${idx}`)
      const companyDir = path.join(root, "data-company", "my-company")
      fs.mkdirSync(companyDir, { recursive: true })
      const hubDir = path.join(root, "projects", "hub", "scripts")
      fs.mkdirSync(hubDir, { recursive: true })
      const scriptFile = path.join(hubDir, "board-server.mjs")
      fs.writeFileSync(scriptFile, "console.log('board')")

      const config = {
        schemaVersion: 1,
        repos: [{ id: "hub", path: "projects/hub" }],
        board: {
          repo: "hub",
          script: "scripts/board-server.mjs",
          port: 8894,
          ...(val !== undefined ? { queueRepo: val } : {}),
        },
      }
      fs.writeFileSync(path.join(companyDir, "adk-company.json"), JSON.stringify(config, null, 2))

      const result = resolveBoardConfig(root, {})
      assert.ok(result !== null, `val=${val} 이어도 result가 null이 아니어야 합니다.`)
      assert.equal(result.queueRepoDir, null)
      assert.equal(result.args.includes("--repo-root"), false)
      assert.deepEqual(result.args, [
        scriptFile,
        "--host",
        "127.0.0.1",
        "--port",
        "8894",
        "--docs-viewer-url",
        "http://localhost:3142/docs",
      ])
    }
  })

  // (나) 유효한 queueRepo
  it("(나) board.queueRepo 유효: --repo-root와 queueRepoDir에 큐 저장소 절대 경로 설정, repoDir는 유지", () => {
    const root = path.join(tempRoot, "valid-queue-repo")
    const companyDir = path.join(root, "data-company", "my-company")
    fs.mkdirSync(companyDir, { recursive: true })
    const hubDir = path.join(root, "projects", "hub", "scripts")
    fs.mkdirSync(hubDir, { recursive: true })
    const scriptFile = path.join(hubDir, "board-server.mjs")
    fs.writeFileSync(scriptFile, "console.log('board')")
    const queueDir = path.join(root, "projects", "queue-repo")
    fs.mkdirSync(queueDir, { recursive: true })

    const config = {
      schemaVersion: 1,
      repos: [
        { id: "hub", path: "projects/hub" },
        { id: "queue-repo", path: "projects/queue-repo" },
      ],
      board: {
        repo: "hub",
        script: "scripts/board-server.mjs",
        port: 8894,
        queueRepo: "queue-repo",
      },
    }
    fs.writeFileSync(path.join(companyDir, "adk-company.json"), JSON.stringify(config, null, 2))

    const result = resolveBoardConfig(root, {})
    assert.ok(result !== null)
    assert.equal(result.repoDir, path.resolve(root, "projects/hub"))
    assert.equal(result.queueRepoDir, queueDir)
    assert.equal(result.args[result.args.length - 2], "--repo-root")
    assert.equal(result.args[result.args.length - 1], queueDir)
    assert.deepEqual(result.args.slice(0, -2), [
      scriptFile,
      "--host",
      "127.0.0.1",
      "--port",
      "8894",
      "--docs-viewer-url",
      "http://localhost:3142/docs",
    ])
  })

  // (다) 잘못된 값 각각
  it("(다) 잘못된 queueRepo 값 각각: 예외 없이 null 반환 및 console.warn 1회 호출", () => {
    const cases = [
      { name: "false", queueRepo: false },
      { name: "true", queueRepo: true },
      { name: "0", queueRepo: 0 },
      { name: "42", queueRepo: 42 },
      { name: "empty-object", queueRepo: {} },
      { name: "empty-array", queueRepo: [] },
      { name: "whitespace-only", queueRepo: "   " },
      { name: "missing-id", queueRepo: "missing-id" },
      { name: "repos-missing", queueRepo: "queue", omitRepos: true },
      { name: "repos-null", queueRepo: "queue", reposValue: null },
      { name: "repos-object", queueRepo: "queue", reposValue: {} },
      { name: "path-missing", queueRepo: "queue", repoEntry: { id: "queue" } },
      { name: "path-number", queueRepo: "queue", repoEntry: { id: "queue", path: 123 } },
      { name: "path-empty-string", queueRepo: "queue", repoEntry: { id: "queue", path: "" } },
      { name: "path-non-existent", queueRepo: "queue", repoEntry: { id: "queue", path: "projects/non-existent" } },
      { name: "path-is-file", queueRepo: "queue", isFile: true },
      { name: "path-symlink-loop", queueRepo: "queue", isSymlinkLoop: true },
    ]

    for (const [idx, c] of cases.entries()) {
      const root = path.join(tempRoot, `invalid-case-${idx}`)
      const companyDir = path.join(root, "data-company", "my-company")
      fs.mkdirSync(companyDir, { recursive: true })
      const hubDir = path.join(root, "projects", "hub", "scripts")
      fs.mkdirSync(hubDir, { recursive: true })
      const scriptFile = path.join(hubDir, "board-server.mjs")
      fs.writeFileSync(scriptFile, "console.log('board')")

      let repos = [{ id: "hub", path: "projects/hub" }]
      if (c.repoEntry) {
        repos.push(c.repoEntry)
      } else if (c.isFile) {
        const filePath = path.join(root, "projects", "a-file.txt")
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, "regular file")
        repos.push({ id: "queue", path: "projects/a-file.txt" })
      } else if (c.isSymlinkLoop) {
        const loopPath = path.join(root, "projects", "loop")
        fs.mkdirSync(path.dirname(loopPath), { recursive: true })
        fs.symlinkSync("loop", loopPath)
        repos.push({ id: "queue", path: "projects/loop" })
      } else if (c.reposValue !== undefined) {
        repos = c.reposValue
      }

      const config = {
        schemaVersion: 1,
        board: {
          repo: "hub",
          script: "scripts/board-server.mjs",
          port: 8894,
          queueRepo: c.queueRepo,
        },
      }
      if (!c.omitRepos) {
        config.repos = repos
      }

      const configPath = path.join(companyDir, "adk-company.json")
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

      let expectedMsg = `작업보드 대기열 저장소(queueRepo) 설정이 잘못되어 작업보드를 띄우지 않습니다: ${configPath}`
      if (typeof c.queueRepo === "string") {
        expectedMsg += ` (${c.queueRepo})`
      }

      const warnings = []
      const origWarn = console.warn
      console.warn = (...args) => warnings.push(args.join(" "))
      try {
        const result = resolveBoardConfig(root, {})
        assert.equal(result, null, `case ${c.name}: 결과는 null이어야 합니다.`)
        assert.equal(warnings.length, 1, `case ${c.name}: 경고가 정확히 1회 호출되어야 합니다.`)
        assert.equal(warnings[0], expectedMsg, `case ${c.name}: 경고 문구가 일치해야 합니다.`)
      } finally {
        console.warn = origWarn
      }
    }
  })

  // (라) 다른 설정으로 넘어가지 않음
  it("(라) 다른 설정으로 넘어가지 않음: 잘못된 queueRepo와 유효 설정이 함께 있으면 어느 순서든 결과는 null", () => {
    // 순서 1: a=잘못, b=유효
    {
      const root = path.join(tempRoot, "no-fallback-order-1")
      const compA = path.join(root, "data-company", "a")
      const compB = path.join(root, "data-company", "b")
      fs.mkdirSync(compA, { recursive: true })
      fs.mkdirSync(compB, { recursive: true })

      const hubDir = path.join(root, "projects", "hub", "scripts")
      fs.mkdirSync(hubDir, { recursive: true })
      fs.writeFileSync(path.join(hubDir, "board-server.mjs"), "console.log('board')")

      fs.writeFileSync(
        path.join(compA, "adk-company.json"),
        JSON.stringify({
          schemaVersion: 1,
          repos: [{ id: "hub", path: "projects/hub" }],
          board: { repo: "hub", script: "scripts/board-server.mjs", port: 8894, queueRepo: "non-existent" },
        }),
      )
      fs.writeFileSync(
        path.join(compB, "adk-company.json"),
        JSON.stringify({
          schemaVersion: 1,
          repos: [{ id: "hub", path: "projects/hub" }],
          board: { repo: "hub", script: "scripts/board-server.mjs", port: 8895 },
        }),
      )

      const origWarn = console.warn
      console.warn = () => {}
      try {
        const res = resolveBoardConfig(root, {})
        assert.equal(res, null, "a가 잘못되었을 때 b로 넘어가지 않고 null을 반환해야 합니다.")
      } finally {
        console.warn = origWarn
      }
    }

    // 순서 2: a=유효, b=잘못
    {
      const root = path.join(tempRoot, "no-fallback-order-2")
      const compA = path.join(root, "data-company", "a")
      const compB = path.join(root, "data-company", "b")
      fs.mkdirSync(compA, { recursive: true })
      fs.mkdirSync(compB, { recursive: true })

      const hubDir = path.join(root, "projects", "hub", "scripts")
      fs.mkdirSync(hubDir, { recursive: true })
      fs.writeFileSync(path.join(hubDir, "board-server.mjs"), "console.log('board')")

      fs.writeFileSync(
        path.join(compA, "adk-company.json"),
        JSON.stringify({
          schemaVersion: 1,
          repos: [{ id: "hub", path: "projects/hub" }],
          board: { repo: "hub", script: "scripts/board-server.mjs", port: 8894 },
        }),
      )
      fs.writeFileSync(
        path.join(compB, "adk-company.json"),
        JSON.stringify({
          schemaVersion: 1,
          repos: [{ id: "hub", path: "projects/hub" }],
          board: { repo: "hub", script: "scripts/board-server.mjs", port: 8895, queueRepo: "non-existent" },
        }),
      )

      const origWarn = console.warn
      console.warn = () => {}
      try {
        const res = resolveBoardConfig(root, {})
        assert.equal(res, null, "b가 잘못되었을 때 a가 유효하더라도 1단계에서 null을 반환해야 합니다.")
      } finally {
        console.warn = origWarn
      }
    }
  })

  // (마) 기존 조건보다 먼저 차단
  it("(마) 기존 조건보다 먼저 차단: board.script 없는 설정(queueRepo 잘못됨)과 유효 설정 공존 시 두 배치 모두 null 및 경고 1회", () => {
    // 배치 1: a=script없음+queueRepo잘못, b=유효
    {
      const root = path.join(tempRoot, "block-before-script-1")
      const compA = path.join(root, "data-company", "a")
      const compB = path.join(root, "data-company", "b")
      fs.mkdirSync(compA, { recursive: true })
      fs.mkdirSync(compB, { recursive: true })

      const hubDir = path.join(root, "projects", "hub", "scripts")
      fs.mkdirSync(hubDir, { recursive: true })
      fs.writeFileSync(path.join(hubDir, "board-server.mjs"), "console.log('board')")

      fs.writeFileSync(
        path.join(compA, "adk-company.json"),
        JSON.stringify({
          schemaVersion: 1,
          repos: [{ id: "hub", path: "projects/hub" }],
          board: { repo: "hub", script: "scripts/no-such-script.mjs", port: 8894, queueRepo: "invalid-id" },
        }),
      )
      fs.writeFileSync(
        path.join(compB, "adk-company.json"),
        JSON.stringify({
          schemaVersion: 1,
          repos: [{ id: "hub", path: "projects/hub" }],
          board: { repo: "hub", script: "scripts/board-server.mjs", port: 8895 },
        }),
      )

      const warnings = []
      const origWarn = console.warn
      console.warn = (...args) => warnings.push(args.join(" "))
      try {
        const res = resolveBoardConfig(root, {})
        assert.equal(res, null)
        assert.equal(warnings.length, 1)
        assert.ok(warnings[0].includes("작업보드 대기열 저장소(queueRepo) 설정이 잘못되어 작업보드를 띄우지 않습니다:"))
      } finally {
        console.warn = origWarn
      }
    }

    // 배치 2: a=유효, b=script없음+queueRepo잘못
    {
      const root = path.join(tempRoot, "block-before-script-2")
      const compA = path.join(root, "data-company", "a")
      const compB = path.join(root, "data-company", "b")
      fs.mkdirSync(compA, { recursive: true })
      fs.mkdirSync(compB, { recursive: true })

      const hubDir = path.join(root, "projects", "hub", "scripts")
      fs.mkdirSync(hubDir, { recursive: true })
      fs.writeFileSync(path.join(hubDir, "board-server.mjs"), "console.log('board')")

      fs.writeFileSync(
        path.join(compA, "adk-company.json"),
        JSON.stringify({
          schemaVersion: 1,
          repos: [{ id: "hub", path: "projects/hub" }],
          board: { repo: "hub", script: "scripts/board-server.mjs", port: 8894 },
        }),
      )
      fs.writeFileSync(
        path.join(compB, "adk-company.json"),
        JSON.stringify({
          schemaVersion: 1,
          repos: [{ id: "hub", path: "projects/hub" }],
          board: { repo: "hub", script: "scripts/no-such-script.mjs", port: 8895, queueRepo: "invalid-id" },
        }),
      )

      const warnings = []
      const origWarn = console.warn
      console.warn = (...args) => warnings.push(args.join(" "))
      try {
        const res = resolveBoardConfig(root, {})
        assert.equal(res, null)
        assert.equal(warnings.length, 1)
        assert.ok(warnings[0].includes("작업보드 대기열 저장소(queueRepo) 설정이 잘못되어 작업보드를 띄우지 않습니다:"))
      } finally {
        console.warn = origWarn
      }
    }
  })

  // (바) 기존 건너뛰기 회귀
  it("(바) 기존 건너뛰기 회귀: board.script 없는 설정(queueRepo 없음)과 그 뒤의 유효 설정(queueRepo 없음)이 있으면 유효 설정 반환 및 경고 없음", () => {
    const root = path.join(tempRoot, "regression-skip-missing-script")
    const compA = path.join(root, "data-company", "a")
    const compB = path.join(root, "data-company", "b")
    fs.mkdirSync(compA, { recursive: true })
    fs.mkdirSync(compB, { recursive: true })

    const hubDir = path.join(root, "projects", "hub", "scripts")
    fs.mkdirSync(hubDir, { recursive: true })
    fs.writeFileSync(path.join(hubDir, "board-server.mjs"), "console.log('board')")

    fs.writeFileSync(
      path.join(compA, "adk-company.json"),
      JSON.stringify({
        schemaVersion: 1,
        repos: [{ id: "hub", path: "projects/hub" }],
        board: { repo: "hub", script: "scripts/no-such-script.mjs", port: 8894 },
      }),
    )
    fs.writeFileSync(
      path.join(compB, "adk-company.json"),
      JSON.stringify({
        schemaVersion: 1,
        repos: [{ id: "hub", path: "projects/hub" }],
        board: { repo: "hub", script: "scripts/board-server.mjs", port: 8895 },
      }),
    )

    const warnings = []
    const origWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(" "))
    try {
      const res = resolveBoardConfig(root, {})
      assert.ok(res !== null, "유효한 b 설정이 반환되어야 합니다.")
      assert.equal(res.port, 8895)
      assert.equal(res.queueRepoDir, null)
      assert.equal(warnings.length, 0, "경고가 발생하지 않아야 합니다.")
    } finally {
      console.warn = origWarn
    }
  })

  // (사) 1단계와 2단계 사이 대기열 폴더 사라짐 (statSync가 ENOENT를 던짐): null 반환, 경고 정확히 1회, --repo-root 없는 인자 반환 차단
  it("(사) 1단계 통과 후 2단계 전 대기열 폴더 소실: null 반환 및 경고 정확히 1회", () => {
    const root = path.join(tempRoot, "step2-queue-dir-vanished")
    const companyDir = path.join(root, "data-company", "my-company")
    fs.mkdirSync(companyDir, { recursive: true })
    const hubDir = path.join(root, "projects", "hub", "scripts")
    fs.mkdirSync(hubDir, { recursive: true })
    const scriptFile = path.join(hubDir, "board-server.mjs")
    fs.writeFileSync(scriptFile, "console.log('board')")
    const queueDir = path.join(root, "projects", "queue-repo")
    fs.mkdirSync(queueDir, { recursive: true })

    const config = {
      schemaVersion: 1,
      repos: [
        { id: "hub", path: "projects/hub" },
        { id: "queue-repo", path: "projects/queue-repo" },
      ],
      board: {
        repo: "hub",
        script: "scripts/board-server.mjs",
        port: 8894,
        queueRepo: "queue-repo",
      },
    }
    const configPath = path.join(companyDir, "adk-company.json")
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

    const origStatSync = fs.statSync
    const origWarn = console.warn
    const warnings = []
    let statCount = 0

    try {
      console.warn = (...args) => warnings.push(args.join(" "))
      fs.statSync = (targetPath, ...args) => {
        if (targetPath === queueDir || path.resolve(targetPath) === queueDir) {
          statCount++
          if (statCount === 2) {
            const err = new Error(`ENOENT: no such file or directory, stat '${targetPath}'`)
            err.code = "ENOENT"
            throw err
          }
        }
        return origStatSync(targetPath, ...args)
      }

      const result = resolveBoardConfig(root, {})
      assert.equal(result, null, "2단계에서 대기열 폴더가 사라지면 null을 반환해야 합니다.")
      assert.equal(warnings.length, 1, "경고가 정확히 1회 발생해야 합니다.")
      const expectedMsg = `작업보드 대기열 저장소(queueRepo) 설정이 잘못되어 작업보드를 띄우지 않습니다: ${configPath} (queue-repo)`
      assert.equal(warnings[0], expectedMsg)
    } finally {
      fs.statSync = origStatSync
      console.warn = origWarn
    }
  })

  // (아) 1단계 통과 후 2단계 전 adk-company.json의 queueRepo가 없는 id로 바뀜: null 반환, 경고 정확히 1회, --repo-root 없는 인자 반환 차단
  it("(아) 1단계 통과 후 2단계 전 queueRepo 설정이 유효하지 않은 id로 변경: null 반환 및 경고 정확히 1회", () => {
    const root = path.join(tempRoot, "step2-queue-repo-changed")
    const companyDir = path.join(root, "data-company", "my-company")
    fs.mkdirSync(companyDir, { recursive: true })
    const hubDir = path.join(root, "projects", "hub", "scripts")
    fs.mkdirSync(hubDir, { recursive: true })
    const scriptFile = path.join(hubDir, "board-server.mjs")
    fs.writeFileSync(scriptFile, "console.log('board')")
    const queueDir = path.join(root, "projects", "queue-repo")
    fs.mkdirSync(queueDir, { recursive: true })

    const validConfig = {
      schemaVersion: 1,
      repos: [
        { id: "hub", path: "projects/hub" },
        { id: "queue-repo", path: "projects/queue-repo" },
      ],
      board: {
        repo: "hub",
        script: "scripts/board-server.mjs",
        port: 8894,
        queueRepo: "queue-repo",
      },
    }
    const configPath = path.join(companyDir, "adk-company.json")
    fs.writeFileSync(configPath, JSON.stringify(validConfig, null, 2))

    const origReadFileSync = fs.readFileSync
    const origWarn = console.warn
    const warnings = []
    let readCount = 0

    try {
      console.warn = (...args) => warnings.push(args.join(" "))
      fs.readFileSync = (targetPath, ...args) => {
        if (targetPath === configPath) {
          readCount++
          if (readCount === 2) {
            const modifiedConfig = {
              ...validConfig,
              board: {
                ...validConfig.board,
                queueRepo: "non-existent-id",
              },
            }
            return JSON.stringify(modifiedConfig)
          }
        }
        return origReadFileSync(targetPath, ...args)
      }

      const result = resolveBoardConfig(root, {})
      assert.equal(result, null, "2단계에서 queueRepo id가 유효하지 않게 바뀌면 null을 반환해야 합니다.")
      assert.equal(warnings.length, 1, "경고가 정확히 1회 발생해야 합니다.")
      const expectedMsg = `작업보드 대기열 저장소(queueRepo) 설정이 잘못되어 작업보드를 띄우지 않습니다: ${configPath} (non-existent-id)`
      assert.equal(warnings[0], expectedMsg)
    } finally {
      fs.readFileSync = origReadFileSync
      console.warn = origWarn
    }
  })

  // (자) repos[].path가 공백 이름(' ') 디렉터리를 가리킬 때: 실제 디렉터리면 유효 판정 및 --repo-root 인자 포함
  it("(자) repos[].path가 공백 이름(' ') 디렉터리를 가리킬 때: 실제 디렉터리면 유효 판정 및 --repo-root 인자 포함", () => {
    const root = path.join(tempRoot, "space-path-repo")
    const companyDir = path.join(root, "data-company", "my-company")
    fs.mkdirSync(companyDir, { recursive: true })
    const hubDir = path.join(root, "projects", "hub", "scripts")
    fs.mkdirSync(hubDir, { recursive: true })
    const scriptFile = path.join(hubDir, "board-server.mjs")
    fs.writeFileSync(scriptFile, "console.log('board')")

    // 이름이 공백 한 칸(" ")인 실제 디렉터리 생성
    const spaceDir = path.join(root, " ")
    fs.mkdirSync(spaceDir, { recursive: true })

    const config = {
      schemaVersion: 1,
      repos: [
        { id: "hub", path: "projects/hub" },
        { id: "space-repo", path: " " },
      ],
      board: {
        repo: "hub",
        script: "scripts/board-server.mjs",
        port: 8894,
        queueRepo: "space-repo",
      },
    }
    fs.writeFileSync(path.join(companyDir, "adk-company.json"), JSON.stringify(config, null, 2))

    const result = resolveBoardConfig(root, {})
    assert.ok(result !== null, "이름이 공백 한 칸인 디렉터리를 가리키면 유효해야 합니다.")
    assert.equal(result.queueRepoDir, spaceDir)
    assert.equal(result.args[result.args.length - 2], "--repo-root")
    assert.equal(result.args[result.args.length - 1], spaceDir)
  })
})
