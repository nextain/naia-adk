import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

// 서버 전용 경계. `./ai`·`./ai-store` 같은 AI 계열 출입구가 패키지 공개
// 출입구에 다시 생기면 실패한다. AI 길은 뒤쪽 서버 코드만 상대 경로로 쓴다.
test("공개 출입구에 AI 계열이 없다", async () => {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8")
  const manifest = JSON.parse(raw) as { exports?: Record<string, unknown> }
  const keys = Object.keys(manifest.exports ?? {})
  assert.ok(keys.includes("."), "기본 출입구가 있어야 한다")
  assert.ok(keys.includes("./admin"), "관리 출입구가 있어야 한다")
  for (const key of keys) {
    assert.ok(!key.startsWith("./ai"), `AI 계열 출입구가 있으면 안 된다: ${key}`)
  }
});
