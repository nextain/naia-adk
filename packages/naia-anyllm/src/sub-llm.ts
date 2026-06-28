// sub-llm — Phase 5: naia-adk 의 sub-LLM 배치 소비 경로(§5.1).
// shared config = `<adkPath>/naia-settings/config.json`(naia-os 가 write, naia-agent 가 loadMemoryConfig 로 읽는 동일 파일).
// memoryLlmProvider(naia/vllm/ollama) → 경량 배치 클라이언트(adk 워크플로우·스킬의 배치 LLM 작업).
// main any-llm gateway(chat()) 와 직교 — sub slot(light model)로 비용 절감.
// SoT: alpha-adk .agents/progress/naia-model-slots-architecture-2026-06-28.md §5.
import type { LLMMessage, LLMResponse } from "./types.js"

/** sub-LLM runtime config(shared config + env key 해석). provider="none"/미구성 = null(배치 비활성, 호출처 폴밍). */
export interface SubLlmRuntimeConfig {
	readonly provider: "naia" | "vllm" | "ollama"
	readonly baseUrl: string
	readonly model: string
	readonly apiKey?: string
}

/** fs 주입(node:fs 직접 import 금지 — 테스트는 fake). config.json 읽기. */
export interface SubLlmFs {
	existsSync(path: string): boolean
	readFileSync(path: string, encoding: "utf8"): string
}

export interface SubLlmLoadDeps {
	readonly fs: SubLlmFs
	readonly env?: NodeJS.ProcessEnv
}

/** NAIA_ADK_PATH/naia-settings/config.json 의 memoryLlm* → SubLlmRuntimeConfig(또는 null).
 *  naia-agent loadMemoryConfig 와 동일 필드 해석(비일관 방지). 순수·테스트 가능. */
export function loadSubLlmConfig(adkPath: string, deps: SubLlmLoadDeps): SubLlmRuntimeConfig | null {
	const env = deps.env ?? process.env
	const dir = `${(adkPath ?? "").replace(/\/+$/, "")}/naia-settings`
	const file = `${dir}/config.json`
	if (!deps.fs.existsSync(file)) return null
	let raw: string
	try {
		raw = deps.fs.readFileSync(file, "utf8")
	} catch {
		return null
	}
	let c: Record<string, unknown>
	try {
		c = JSON.parse(raw) as Record<string, unknown>
	} catch {
		return null
	}
	const str = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : undefined)
	const lp = str("memoryLlmProvider")
	const provider = (["naia", "vllm", "ollama"] as const).find((p) => p === lp)
	if (!provider) return null // "none"/미지정/불명 = 배치 비활성
	const model = str("memoryLlmModel")?.trim()
	if (!model) return null // 모델 누락 = 미구성
	// naia=게이트웨이(baseUrl=naiaGatewayUrl/NAIA_ANYLLM_BASE_URL/기본, key=NAIA_ANYLLM_API_KEY). 그 외=memoryLlmBaseUrl+NAIA_MEMORY_LLM_API_KEY.
	let baseUrl: string | undefined
	let apiKey: string | undefined
	if (provider === "naia") {
		baseUrl = str("naiaGatewayUrl") ?? str("NAIA_ANYLLM_BASE_URL") ?? "https://api.nextain.io"
		apiKey = env.NAIA_ANYLLM_API_KEY ?? env.NAIA_KEY
	} else {
		baseUrl = str("memoryLlmBaseUrl")
		apiKey = env.NAIA_MEMORY_LLM_API_KEY
	}
	if (!baseUrl?.trim()) return null
	return { provider, baseUrl, model, ...(apiKey ? { apiKey } : {}) }
}

/** fetch 주입(테스트·node fetch). OpenAI-compat /chat/completions 비스트리밍. */
export type SubLlmFetch = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>

/** sub-LLM 배치 호출. LLMResponse 호환(main chat() 과 동형 반환 — 소비처 통일). */
export async function subLlmChat(
	cfg: SubLlmRuntimeConfig,
	messages: readonly LLMMessage[],
	deps: { fetch: SubLlmFetch; signal?: AbortSignal },
): Promise<LLMResponse> {
	const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`
	const res = await deps.fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
		},
		body: JSON.stringify({
			model: cfg.model,
			messages: messages.map((m) => ({ role: m.role, content: m.content })),
			stream: false,
			temperature: 0,
		}),
		...(deps.signal ? { signal: deps.signal } : {}),
	})
	if (!res.ok) {
		const body = await res.text().catch(() => "")
		throw new Error(`sub-llm(${cfg.provider}) HTTP ${res.status}: ${body.slice(0, 200)}`)
	}
	const data = (await res.json()) as {
		choices?: ReadonlyArray<{ message?: { content?: string } }>
		model?: string
		usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
	}
	return {
		content: data.choices?.[0]?.message?.content ?? "",
		model: data.model ?? cfg.model,
		provider: cfg.provider,
		usage: {
			promptTokens: data.usage?.prompt_tokens ?? 0,
			completionTokens: data.usage?.completion_tokens ?? 0,
			totalTokens: data.usage?.total_tokens ?? 0,
		},
	}
}
