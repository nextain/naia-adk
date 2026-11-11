import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawn } from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"
import { canonicalBytes, hashBytes } from "../src/publish-bundle.js"
import { assertPrivatePlacement, PublishStore, type PublishOperation } from "../src/publish-store.js"

function fixture() {
  const allowed = os.tmpdir()
  const temporary = fs.realpathSync(os.tmpdir())
  const relative = path.relative(allowed, temporary)
  expect(relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))).toBe(true)
  const directory = fs.mkdtempSync(path.join(temporary, "publish-store-"))
  const state = path.join(directory, "state")
  const workspace = path.join(directory, "workspace")
  const source = path.join(workspace, "docs")
  fs.mkdirSync(state, { mode: 0o700 })
  fs.mkdirSync(source, { recursive: true })
  const key = path.join(directory, "signing")
  fs.writeFileSync(key, "placement-only-key", { mode: 0o600 })
  return { directory, state, workspace, source, key }
}

afterEach(() => vi.restoreAllMocks())

describe("게시 서명키의 저장소 경계", () => {
  it("실제 체크아웃 안의 확장자 없는 비공개 키는 문서 출처 밖이어도 거절한다", () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.directory, ".git"), "gitdir: synthetic-worktree\n")
    expect(() => assertPrivatePlacement(f.state, [f.source], f.key)).toThrow(expect.objectContaining({ code: "PUBLISH_CONFIG_INVALID", message: expect.stringContaining("깃 작업 트리") }))
  })
  it("실제 체크아웃 내부 키의 별도 심벌릭 링크도 실제 경로로 거절한다", () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.directory, ".git"), "gitdir: synthetic-worktree\n")
    const alias = path.join(f.directory, "key-alias")
    fs.symlinkSync(f.key, alias)
    expect(() => assertPrivatePlacement(f.state, [f.source], alias)).toThrow(expect.objectContaining({ code: "PUBLISH_CONFIG_INVALID", message: expect.stringContaining("깃 작업 트리") }))
  })
  it.each(["directory", "file"])("합성 작업 트리의 .git %s 표지를 검사한다", (kind) => {
    const f = fixture()
    const marker = path.join(f.workspace, ".git")
    if (kind === "directory") fs.mkdirSync(marker)
    else fs.writeFileSync(marker, "gitdir: synthetic-linked-worktree\n")
    const key = path.join(f.workspace, "server-private/signing")
    fs.mkdirSync(path.dirname(key))
    fs.writeFileSync(key, "placement-only-key", { mode: 0o600 })
    expect(() => assertPrivatePlacement(f.state, [f.source], key)).toThrow(expect.objectContaining({ code: "PUBLISH_CONFIG_INVALID", message: expect.stringContaining("깃 작업 트리") }))
    const alias = path.join(f.directory, "outside-alias")
    fs.symlinkSync(key, alias)
    expect(() => assertPrivatePlacement(f.state, [f.source], alias)).toThrow(expect.objectContaining({ code: "PUBLISH_CONFIG_INVALID", message: expect.stringContaining("깃 작업 트리") }))
  })
  it("작업 트리와 문서·상태 폴더 밖의 형제 키를 허용한다", () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.workspace, ".git"), "gitdir: synthetic-linked-worktree\n")
    expect(() => assertPrivatePlacement(f.state, [f.source], f.key)).not.toThrow()
  })
  it("합성 외부 경계에서도 문서·상태 안의 키는 거절한다", () => {
    const f = fixture()
    for (const root of [f.source, f.state]) {
      const key = path.join(root, "signing")
      fs.writeFileSync(key, "placement-only-key", { mode: 0o600 })
      expect(() => assertPrivatePlacement(f.state, [f.source], key)).toThrow(expect.objectContaining({ code: "PUBLISH_CONFIG_INVALID" }))
    }
  })
})

function operation(request: string): PublishOperation {
  const scope = { actor_id: "gate:owner", slug: "test-post", action: "request-review" as const, key_hash: hashBytes(Buffer.from("same-key")) }
  return { operation_id: `op_${hashBytes(canonicalBytes(scope))}`, scope, request_hash: hashBytes(Buffer.from(request)), requester_id: scope.actor_id, state: "processing", updated_at: "2026-11-02T00:00:00Z" }
}

describe("게시 확정 기록의 동기화 복구", () => {
  it("최종 이름 변경 뒤 부모 동기화 실패에도 확정 기록을 보존하고 재사용한다", () => {
    const f = fixture()
    const store = new PublishStore(f.state)
    const relative = "approvals/test-post/rev-test"
    const parent = path.join(f.state, "approvals/test-post")
    const record = { operation: operation("first"), result: { receipt: { receipt_id: "original-receipt" } } }
    const sync = store.syncDir.bind(store)
    vi.spyOn(store, "syncDir").mockImplementation((directory) => {
      if (directory === parent) throw Object.assign(new Error("parent sync failed"), { code: "EIO" })
      sync(directory)
    })
    expect(() => store.atomic(relative, {}, record)).toThrow(expect.objectContaining({ code: "EIO" }))
    expect(store.json(`${relative}/commit.json`)).toEqual(record)
    expect(store.directories("approvals/test-post")).toEqual(["rev-test"])
    vi.restoreAllMocks()
    const restarted = new PublishStore(f.state)
    const synced = vi.spyOn(restarted, "syncDir")
    expect(restarted.atomic(relative, {}, { result: { receipt: { receipt_id: "replacement" } } })).toBe(false)
    expect(synced).toHaveBeenCalledWith(parent)
    expect(restarted.json(`${relative}/commit.json`)).toEqual(record)
  })

  it.each(["approvals", "selections", "result"] as const)("%s 복구는 부모 동기화가 성공해야 같은 결과를 반환한다", (kind) => {
    const f = fixture()
    const store = new PublishStore(f.state)
    const original = operation("first")
    const relative = kind === "result" ? `operations/${original.operation_id}/result` : kind === "approvals" ? "approvals/test-post/rev-test" : "selections/selection-test"
    const result = { receipt: { receipt_id: "original-receipt" } }
    store.atomic(relative, {}, { operation: original, result })
    const synced = vi.spyOn(store, "syncDir").mockImplementation(() => { throw Object.assign(new Error("recovery sync failed"), { code: "EIO" }) })
    expect(() => store.recover(original)).toThrow(expect.objectContaining({ code: "EIO" }))
    expect(synced).toHaveBeenCalledExactlyOnceWith(path.dirname(store.file(relative)))
    expect(store.json(`${relative}/commit.json`)).toMatchObject({ result })
    synced.mockRestore()
    expect(new PublishStore(f.state).recover(original)).toMatchObject({ state: "committed", result })
  })

  it("확정 전 동기화 실패에서는 완성 기록을 복구하지 않는다", () => {
    const f = fixture()
    const original = operation("first")
    const store = new PublishStore(f.state, (point) => {
      if (point === "sync") throw Object.assign(new Error("precommit sync failed"), { code: "EIO" })
    })
    expect(() => store.atomic("approvals/test-post/rev-test", {}, { operation: original, result: { receipt: {} } })).toThrow(expect.objectContaining({ code: "EIO" }))
    expect(store.json("approvals/test-post/rev-test/commit.json")).toBeNull()
    expect(new PublishStore(f.state).recover(original)).toBeNull()
  })
})

describe("게시 멱등키의 프로세스 공유 예약", () => {
  it("별도 실행 상태가 없어도 재시작 뒤 예약을 유지하고 다른 본문은 거절한다", () => {
    const f = fixture()
    const first = operation("first")
    const store = new PublishStore(f.state)
    expect(store.reserveOperation(first)).toEqual(first)
    expect(store.json(`operations/${first.operation_id}/state.json`)).toBeNull()
    const restarted = new PublishStore(f.state)
    expect(restarted.reserveOperation(first)).toEqual(first)
    expect(() => restarted.reserveOperation(operation("changed"))).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT", status: 409 }))
    expect(restarted.json(`reservations/${first.operation_id}/commit.json`)).toEqual(first)
  })
  it("실제 여덟 프로세스의 동시 예약은 하나의 요청 지문만 확정한다", async () => {
    const f = fixture()
    const store = new PublishStore(f.state)
    const storeUrl = new URL("../src/publish-store.ts", import.meta.url).href
    const program = `
      import { PublishStore } from ${JSON.stringify(storeUrl)};
      const store = new PublishStore(process.argv[1]);
      const operation = JSON.parse(process.argv[2]);
      process.send({ ready: true });
      process.once('message', () => {
        try {
          const reserved = store.reserveOperation(operation);
          process.send({ request_hash: reserved.request_hash });
        } catch (error) { process.send({ code: error.code, status: error.status }); }
        process.disconnect();
      });
    `
    const children = Array.from({ length: 8 }, (_, i) => {
      const requested = operation(i % 2 ? "first" : "second")
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program, f.state, JSON.stringify(requested)], { cwd: new URL("../", import.meta.url), env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"] })
      let stderr = "", result: any
      child.stderr?.on("data", (chunk) => { stderr += chunk })
      let ready!: () => void
      const started = new Promise<void>((resolve) => { ready = resolve })
      child.on("message", (message: any) => { if (message.ready) ready(); else result = message })
      const completed = new Promise<any>((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", (code) => { if (code === 0 && result) resolve({ requested, result }); else reject(new Error(`reservation worker ${code}: ${stderr}`)) })
      })
      return { child, started, completed }
    })
    try {
      await Promise.all(children.map(({ started, completed }) => Promise.race([started, completed.then(() => { throw new Error("worker exited before barrier") })])))
      for (const { child } of children) child.send({ start: true })
      const results = await Promise.all(children.map(({ completed }) => completed))
      const reserved = store.json<PublishOperation>(`reservations/${operation("first").operation_id}/commit.json`)!
      expect(reserved.request_hash).toMatch(/^[a-f0-9]{64}$/)
      for (const { requested, result } of results) {
        if (requested.request_hash === reserved.request_hash) expect(result).toEqual({ request_hash: reserved.request_hash })
        else expect(result).toEqual({ code: "IDEMPOTENCY_CONFLICT", status: 409 })
      }
      expect(results.filter(({ result }) => result.request_hash === reserved.request_hash)).toHaveLength(4)
      expect(fs.readdirSync(path.join(f.state, "reservations"))).toEqual([reserved.operation_id])
    } finally { for (const { child } of children) if (child.exitCode === null) child.kill() }
  }, 15000)
})
