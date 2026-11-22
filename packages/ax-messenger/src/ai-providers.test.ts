import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import test from "node:test"
import {
  AX_AI_OPENAI_COMPATIBLE_ID,
  AX_AI_PROVIDER_TIMEOUT_MS_DEFAULT,
  createOpenAiChatProvider,
} from "./ai-providers.js"

type SeenRequest = {
  url: string
  authorization: string
  body: Record<string, unknown>
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ""
    request.on("data", (chunk) => { raw += chunk })
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
  })
}

// 이 PC 안의 가짜 HTTP 서버(127.0.0.1, 시험 안에서만). 바깥 제공자 주소로는
// 한 번도 요청하지 않는다.
async function withLoopbackServer(
  handle: (seen: SeenRequest, request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  run: (baseUrl: string, seen: () => SeenRequest[]) => Promise<void>,
): Promise<void> {
  const seen: SeenRequest[] = []
  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        const body = await readJson(request)
        const record: SeenRequest = {
          url: request.url ?? "",
          authorization: String(request.headers["authorization"] ?? ""),
          body,
        }
        seen.push(record)
        await handle(record, request, response)
      } catch {
        response.statusCode = 500
        response.end("{}")
      }
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (typeof address !== "object" || !address) throw new Error("가짜 서버 주소를 읽지 못했습니다.")
    await run(`http://127.0.0.1:${address.port}`, () => seen)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const REQUEST = { callId: "tag-loop", orgId: "org-a", input: "짧은 질문", maxOutputTokens: 200 }

test("요청 모양·사용량 읽기가 OpenAI 호환 규격과 맞는다", async () => {
  await withLoopbackServer(
    (_seen, _request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({
        choices: [{ message: { content: "가짜 서버 답" } }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }))
    },
    async (baseUrl, seen) => {
      const provider = createOpenAiChatProvider({ baseUrl, model: "test-model", apiKey: "test-key" })
      assert.equal(provider.id, AX_AI_OPENAI_COMPATIBLE_ID)
      const answer = await provider.complete(REQUEST)
      assert.equal(answer.text, "가짜 서버 답")
      assert.deepEqual(answer.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 })
      assert.equal(seen().length, 1)
      const first = seen()[0] as SeenRequest
      assert.equal(first.url, "/chat/completions")
      assert.deepEqual(first.body["model"], "test-model")
      assert.deepEqual(first.body["max_tokens"], 200)
      assert.deepEqual(first.body["messages"], [{ role: "user", content: "짧은 질문" }])
      assert.equal(first.authorization, "Bearer test-key")
    },
  )
})

test("오류 응답·빈 답·시간 초과가 분명한 오류다", async () => {
  // 오류 응답.
  await withLoopbackServer(
    (_seen, _request, response) => {
      response.statusCode = 500
      response.end("{}")
    },
    async (baseUrl) => {
      const provider = createOpenAiChatProvider({ baseUrl, model: "m", apiKey: "k" })
      await assert.rejects(provider.complete(REQUEST), /오류 응답\(상태 500\)/)
    },
  )
  // 빈 답.
  await withLoopbackServer(
    (_seen, _request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ choices: [], usage: {} }))
    },
    async (baseUrl) => {
      const provider = createOpenAiChatProvider({ baseUrl, model: "m", apiKey: "k" })
      await assert.rejects(provider.complete(REQUEST), /답이 없습니다/)
    },
  )
  // 시간 초과.
  await withLoopbackServer(
    async (_seen, _request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      response.end("{}")
    },
    async (baseUrl) => {
      const provider = createOpenAiChatProvider({ baseUrl, model: "m", apiKey: "k", timeoutMs: 50 })
      await assert.rejects(provider.complete(REQUEST), /시간 초과/)
    },
  )
})

test("주소·모델·열쇠·시간 초과 값이 없으면 시작 때 오류다", () => {
  assert.throws(() => createOpenAiChatProvider({ baseUrl: "", model: "m", apiKey: "k" }), /주소/)
  assert.throws(
    () => createOpenAiChatProvider({ baseUrl: "https://api.example.com/v1", model: " ", apiKey: "k" }),
    /모델 이름/,
  )
  assert.throws(
    () => createOpenAiChatProvider({ baseUrl: "https://api.example.com/v1", model: "m", apiKey: "" }),
    /열쇠/,
  )
  assert.throws(
    () => createOpenAiChatProvider({ baseUrl: "ftp://x", model: "m", apiKey: "k" }),
    /주소/,
  )
  assert.throws(
    () => createOpenAiChatProvider({ baseUrl: "http://127.0.0.1:9", model: "m", apiKey: "k", timeoutMs: 0 }),
    /시간 초과/,
  )
  assert.equal(AX_AI_PROVIDER_TIMEOUT_MS_DEFAULT, 30_000)
})

test("원격 http 주소는 열쇠를 보내기 전에 시작 오류다", () => {
  // 로컬 시험 주소만 http를 허용한다.
  for (const baseUrl of ["http://127.0.0.1:9", "http://localhost:9", "http://[::1]:9"]) {
    const provider = createOpenAiChatProvider({ baseUrl, model: "m", apiKey: "k" })
    assert.equal(provider.id, AX_AI_OPENAI_COMPATIBLE_ID)
  }
  // 원격 http·비 http(s)는 시작 오류다.
  for (const baseUrl of [
    "http://192.168.10.11:8080/v1",
    "http://10.0.0.5/v1",
    "http://api.example.com/v1",
    "http://[2001:db8::1]/v1",
    "ftp://x",
  ]) {
    assert.throws(() => createOpenAiChatProvider({ baseUrl, model: "m", apiKey: "k" }), /주소/)
  }
  // 원격 https는 받는다(호출은 시험에서 하지 않는다).
  const remote = createOpenAiChatProvider({ baseUrl: "https://api.example.com/v1", model: "m", apiKey: "k" })
  assert.equal(remote.id, AX_AI_OPENAI_COMPATIBLE_ID)
})
