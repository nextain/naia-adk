// 실제 제공자 어댑터(OpenAI 호환 채팅 완성). 뒤쪽 서버 전용이며 화면 묶음은
// 패키지 출입구로 가져가지 않는다(상대 경로 dist/ai-providers.js로만 쓴다).
// FE-ax1-04-02는 "부분, 제공자 결정 대기"다. 실제 제공자 주소로는 시험하지
// 않는다. 시험은 127.0.0.1 가짜 HTTP 서버로만 한다(ai-providers.test.ts).
import type { AxAiProvider, AxAiProviderRequest, AxAiProviderResponse } from "./ai.js"

export const AX_AI_OPENAI_COMPATIBLE_ID = "openai-compatible"

// 제공자 요청 시간 초과의 기본값. 한도 값이 아니라 호출기 동작 기본값이다.
export const AX_AI_PROVIDER_TIMEOUT_MS_DEFAULT = 30_000

export type OpenAiChatProviderOptions = {
  // 채팅 완성 앞주소. 예: https://api.제공자/v1 (끝의 /chat/completions은 붙이지 않는다).
  baseUrl: string
  model: string
  // 기록·출력에 남기지 않는다.
  apiKey: string
  timeoutMs?: number
}

function checkBaseUrl(baseUrl: string): string {
  const value = (baseUrl ?? "").trim().replace(/\/$/, "")
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error("AI 제공자 주소를 확인해 주세요.(http(s)로 시작해야 합니다)")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("AI 제공자 주소를 확인해 주세요.(http(s)로 시작해야 합니다)")
  }
  // 열쇠를 Bearer로 보내기 전에 막는다. 원격은 https만 받고, http는 이 PC
  // 시험 주소(127.0.0.1·localhost·::1)만 허용한다.
  if (parsed.protocol === "http:") {
    // IPv6 자리는 대괄호가 붙어 나올 수 있다.
    const host = parsed.hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1")
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new Error("AI 제공자 주소를 확인해 주세요.(원격 http는 허용하지 않습니다. https 주소를 쓰세요)")
    }
  }
  return value
}

// OpenAI 호환 채팅 완성 요청. 주소·모델 이름·열쇠는 호출부가 환경 변수에서
// 받아 넘긴다. 응답의 사용량 칸(prompt_tokens·completion_tokens)에서
// 입력·출력 토큰을 읽고, 요청마다 출력 상한(max_tokens)을 싣는다.
// 시간 초과·오류 응답·빈 답은 분명한 오류로 낸다. 열쇠는 오류·기록에 남기지 않는다.
export function createOpenAiChatProvider(options: OpenAiChatProviderOptions): AxAiProvider {
  const baseUrl = checkBaseUrl(options?.baseUrl ?? "")
  const model = (options?.model ?? "").trim()
  if (!model) throw new Error("AI 제공자 모델 이름을 확인해 주세요.")
  const apiKey = options?.apiKey ?? ""
  if (!apiKey) throw new Error("AI 제공자 열쇠를 확인해 주세요.")
  const timeoutMs = options?.timeoutMs ?? AX_AI_PROVIDER_TIMEOUT_MS_DEFAULT
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("AI 제공자 시간 초과 값을 확인해 주세요.")
  }

  return {
    id: AX_AI_OPENAI_COMPATIBLE_ID,
    async complete(request: AxAiProviderRequest): Promise<AxAiProviderResponse> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        let response: Response
        try {
          response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: request.input }],
              max_tokens: request.maxOutputTokens,
            }),
            signal: controller.signal,
          })
        } catch (error) {
          if (controller.signal.aborted) {
            throw new Error(`AI 제공자 시간 초과(제한 ${timeoutMs}ms)입니다.`)
          }
          throw new Error("AI 제공자에 연결하지 못했습니다.")
        }
        if (!response.ok) {
          throw new Error(`AI 제공자 오류 응답(상태 ${response.status})입니다.`)
        }
        let parsed: Record<string, unknown> = {}
        try {
          parsed = (await response.json()) as Record<string, unknown>
        } catch {
          throw new Error("AI 제공자 응답을 읽지 못했습니다.")
        }
        const choices = parsed["choices"]
        const content =
          Array.isArray(choices) && choices.length > 0
            ? (choices[0] as Record<string, unknown>)?.["message"]
            : undefined
        const text =
          typeof content === "object" && content !== null
            ? (content as Record<string, unknown>)["content"]
            : undefined
        if (typeof text !== "string" || !text.trim()) {
          throw new Error("AI 제공자 응답에 답이 없습니다.")
        }
        const rawUsage =
          typeof parsed["usage"] === "object" && parsed["usage"] !== null
            ? (parsed["usage"] as Record<string, unknown>)
            : {}
        const usage: Record<string, number> = {}
        const pairs = [
          ["prompt_tokens", "inputTokens"],
          ["completion_tokens", "outputTokens"],
          ["total_tokens", "totalTokens"],
        ] as const
        for (const [wire, local] of pairs) {
          const value = rawUsage[wire]
          if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
            usage[local] = value
          }
        }
        return { text, usage }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
