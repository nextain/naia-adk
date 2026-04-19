export interface LLMProvider {
  id: string
  name: string
  type: "gateway" | "direct"
  endpoint: string
  apiKeyEnv: string
  models: string[]
  defaultModel?: string
}

export interface LLMConfig {
  defaultProvider: string
  defaultModel: string
  providers: Record<string, LLMProvider>
}

export interface LLMMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface LLMResponse {
  content: string
  model: string
  provider: string
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}
