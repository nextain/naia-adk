import { describe, expect, it, vi } from "vitest"
import { loadSubLlmConfig, subLlmChat } from "../src/sub-llm.js"
import type { SubLlmFs } from "../src/sub-llm.js"

/**
 * Phase 5 — naia-adk sub-LLM 배치 소비 경로(§5.1) 계약.
 * shared config(naia-settings/config.json memoryLlm*) → 경량 배치 클라이언트.
 */
function fakeFs(files: Record<string, string>): SubLlmFs {
	return {
		existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
		readFileSync: (p) => files[p],
	}
}

describe("loadSubLlmConfig — shared config 해석", () => {
	it("provider='none'/부재 = null(배치 비활성)", () => {
		const fs = fakeFs({ "/ws/naia-settings/config.json": JSON.stringify({ memoryLlmProvider: "none" }) })
		expect(loadSubLlmConfig("/ws", { fs })).toBeNull()
	})

	it("config.json 부재 = null", () => {
		expect(loadSubLlmConfig("/ws", { fs: fakeFs({}) })).toBeNull()
	})

	it("naia provider = 게이트웨이 baseUrl + NAIA_ANYLLM_API_KEY", () => {
		const fs = fakeFs({
			"/ws/naia-settings/config.json": JSON.stringify({
				memoryLlmProvider: "naia",
				memoryLlmModel: "gemini-3.1-flash-lite",
				naiaGatewayUrl: "https://gw.example/v1",
			}),
		})
		const cfg = loadSubLlmConfig("/ws", { fs, env: { NAIA_ANYLLM_API_KEY: "nk" } as NodeJS.ProcessEnv })
		expect(cfg).toEqual({
			provider: "naia",
			baseUrl: "https://gw.example/v1",
			model: "gemini-3.1-flash-lite",
			apiKey: "nk",
		})
	})

	it("ollama provider = memoryLlmBaseUrl + NAIA_MEMORY_LLM_API_KEY(빈 값 허용)", () => {
		const fs = fakeFs({
			"/ws/naia-settings/config.json": JSON.stringify({
				memoryLlmProvider: "ollama",
				memoryLlmModel: "llama3",
				memoryLlmBaseUrl: "http://localhost:11434/v1",
			}),
		})
		const cfg = loadSubLlmConfig("/ws", { fs, env: {} as NodeJS.ProcessEnv })
		expect(cfg?.provider).toBe("ollama")
		expect(cfg?.baseUrl).toBe("http://localhost:11434/v1")
		expect(cfg?.apiKey).toBeUndefined() // 로컬 서버 = 키 없음 허용
	})

	it("model 누락 = null(미구성)", () => {
		const fs = fakeFs({
			"/ws/naia-settings/config.json": JSON.stringify({ memoryLlmProvider: "vllm", memoryLlmBaseUrl: "http://x/v1" }),
		})
		expect(loadSubLlmConfig("/ws", { fs, env: {} as NodeJS.ProcessEnv })).toBeNull()
	})

	it("naia provider baseUrl 기본 폴백(api.nextain.io)", () => {
		const fs = fakeFs({
			"/ws/naia-settings/config.json": JSON.stringify({ memoryLlmProvider: "naia", memoryLlmModel: "m" }),
		})
		const cfg = loadSubLlmConfig("/ws", { fs, env: {} as NodeJS.ProcessEnv })
		expect(cfg?.baseUrl).toBe("https://api.nextain.io")
	})
})

describe("subLlmChat — OpenAI-compat 배치 호출", () => {
	it("/chat/completions POST → LLMResponse(동형)", async () => {
		const fetchFn = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				choices: [{ message: { content: "배치 결과" } }],
				model: "gemini-3.1-flash-lite",
				usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			}),
			text: async () => "",
		}))
		const cfg = { provider: "naia" as const, baseUrl: "https://gw/v1", model: "m", apiKey: "k" }
		const out = await subLlmChat(cfg, [{ role: "user", content: "hi" }], { fetch: fetchFn })
		expect(out.content).toBe("배치 결과")
		expect(out.provider).toBe("naia")
		expect(out.usage.totalTokens).toBe(8)
		const [url, init] = fetchFn.mock.calls[0] as [string, { headers: Record<string, string> }]
		expect(url).toBe("https://gw/v1/chat/completions")
		expect(init.headers.authorization).toBe("Bearer k")
	})

	it("HTTP 실패 → throw", async () => {
		const fetchFn = vi.fn(async () => ({
			ok: false,
			status: 503,
			json: async () => ({}),
			text: async () => "unavailable",
		}))
		await expect(
			subLlmChat({ provider: "vllm", baseUrl: "http://x/v1", model: "m" }, [{ role: "user", content: "x" }], { fetch: fetchFn }),
		).rejects.toThrow(/HTTP 503/)
	})
})
