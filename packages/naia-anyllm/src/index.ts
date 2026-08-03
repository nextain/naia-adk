import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import OpenAI from "openai"
import type { LLMConfig, LLMProvider, LLMMessage, LLMResponse } from "./types.js"

function naiaEndpoint(): string {
  const base = (process.env.NAIA_BASE_URL || "https://api.nextain.io").replace(/\/$/, "")
  return base.endsWith("/v1") ? base : base + "/v1"
}

// Phase 5: sub-LLM 배치 소비 경로(§5.1) 재노출.
export {
	loadSubLlmConfig,
	subLlmChat,
	type SubLlmRuntimeConfig,
	type SubLlmFs,
	type SubLlmLoadDeps,
	type SubLlmFetch,
} from "./sub-llm.js"

const DEFAULT_CONFIG: LLMConfig = {
  defaultProvider: "naia",
  defaultModel: process.env.NAIA_MODEL || "deepseek-v4-flash",
  providers: {
    naia: {
      id: "naia",
      name: "Naia Account",
      type: "gateway",
      endpoint: naiaEndpoint(),
      apiKeyEnv: "NAIA_KEY",
      models: ["deepseek-v4-flash", "deepseek-v4-pro", "gpt-5.6-luna", "gpt-5.6-sol", "grok-4.3"],
      defaultModel: process.env.NAIA_MODEL || "deepseek-v4-flash",
    },
    "any-llm": {
      id: "any-llm",
      name: "Any-LLM Gateway",
      type: "gateway",
      // Gateway endpoint comes from env so no deployment-specific URL is baked
      // into the public source. Set GATEWAY_URL to your gateway's base URL.
      endpoint: (process.env.GATEWAY_URL || "https://your-gateway.example.com") + "/v1",
      apiKeyEnv: "GATEWAY_MASTER_KEY",
      models: ["claude-sonnet-4-20250514", "gpt-4.1", "gemini-2.5-pro"],
      defaultModel: "claude-sonnet-4-20250514",
    },
    openai: {
      id: "openai",
      name: "OpenAI",
      type: "direct",
      endpoint: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      models: ["gpt-4.1", "gpt-4.1-mini", "o3", "o4-mini"],
    },
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      type: "direct",
      endpoint: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
    },
    google: {
      id: "google",
      name: "Google",
      type: "direct",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKeyEnv: "GOOGLE_API_KEY",
      models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    },
  },
}

export function loadLLMConfig(root: string): LLMConfig {
  const configPath = path.join(root, ".agents", "context", "llm-config.yaml")
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf-8")
    const override = YAML.parse(raw) || {}
    const providerOverrides = override.providers || {}
    const providers = { ...DEFAULT_CONFIG.providers }
    for (const [id, providerOverride] of Object.entries(providerOverrides)) {
      providers[id] = {
        ...(DEFAULT_CONFIG.providers[id] || {}),
        ...(providerOverride as Partial<LLMProvider>),
      } as LLMProvider
    }
    return {
      ...DEFAULT_CONFIG,
      ...override,
      providers,
    }
  }
  return DEFAULT_CONFIG
}

export function getProvider(config: LLMConfig, providerId?: string): LLMProvider {
  const id = providerId || config.defaultProvider
  return config.providers[id] || config.providers[config.defaultProvider]
}

export function getApiKey(provider: LLMProvider): string | undefined {
  if (provider.id === "naia") {
    return process.env.NAIA_KEY || process.env.NAIA_API_KEY || process.env.NAIA_ANYLLM_API_KEY
  }
  return process.env[provider.apiKeyEnv]
}

export async function chat(
  config: LLMConfig,
  messages: LLMMessage[],
  options?: { provider?: string; model?: string },
): Promise<LLMResponse> {
  const provider = getProvider(config, options?.provider)
  const apiKey = getApiKey(provider)
  if (!apiKey) {
    throw new Error(`API key not found: set ${provider.apiKeyEnv}`)
  }

  const client = new OpenAI({
    apiKey,
    baseURL: provider.endpoint,
  })

  const model = options?.model || provider.defaultModel || config.defaultModel

  const response = await client.chat.completions.create({
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  })

  return {
    content: response.choices[0]?.message?.content || "",
    model: response.model,
    provider: provider.id,
    usage: {
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0,
      totalTokens: response.usage?.total_tokens || 0,
    },
  }
}
