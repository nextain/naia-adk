import type { Metadata } from "next"

export const metadata: Metadata = { title: "LLM Settings — Naia ADK" }

const providers = [
  { id: "openai", name: "OpenAI", models: ["gpt-4.1", "gpt-4.1-mini", "o3", "o4-mini"] },
  { id: "anthropic", name: "Anthropic", models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"] },
  { id: "google", name: "Google", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  { id: "any-llm", name: "Any-LLM Gateway", models: ["(proxied — configured in gateway)"] },
]

export default function LLMSettingsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">LLM Settings</h1>
      <p className="text-neutral-400 text-sm">
        Configure LLM providers and model preferences. These settings are used by AI coding clients connected to this workspace.
      </p>

      <div>
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">Providers</h2>
        <div className="space-y-3">
          {providers.map((p) => (
            <div key={p.id} className="p-4 rounded-lg border border-neutral-800">
              <div className="flex items-center justify-between">
                <span className="font-medium">{p.name}</span>
                <span className="text-xs px-2 py-0.5 rounded bg-neutral-800 text-neutral-500">not configured</span>
              </div>
              <div className="text-xs text-neutral-500 mt-2 font-mono">
                {p.models.join(", ")}
              </div>
              {p.id === "any-llm" && (
                <div className="mt-2 text-xs text-neutral-500">
                  Gateway URL: <span className="text-neutral-400">https://naia-gateway-181404717065.asia-northeast3.run.app</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">Default Model</h2>
        <div className="p-4 rounded-lg border border-neutral-800">
          <div className="text-neutral-400 text-sm">
            Set via <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-xs">.agents/context/llm-config.yaml</code>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">API Keys</h2>
        <div className="p-4 rounded-lg border border-neutral-800 text-sm text-neutral-400">
          <p>API keys are stored in <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-xs">data-private/.env</code> (gitignored).</p>
          <p className="mt-1 text-neutral-500">Never commit API keys to the repository.</p>
        </div>
      </div>
    </div>
  )
}
