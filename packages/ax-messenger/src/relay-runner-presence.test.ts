import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { access, constants } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const sessionRunScript = path.resolve(here, "../../../scripts/ax-messenger/relay-session-run.mjs")

test("relay-session-run.mjs 존재·실행 가능·인자 없음 거부(종료 2)", async () => {
  await access(sessionRunScript, constants.X_OK)
  const child = spawn(process.execPath, [sessionRunScript], {
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", resolve)
  })
  assert.equal(code, 2)
  assert.match(stderr, /역할 세션 실행 설정이나 인자를 확인해 주세요\./)
})
