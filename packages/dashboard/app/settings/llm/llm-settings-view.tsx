import React from "react"
import type { WorkspaceSettingsSnapshot } from "../settings-data.ts"

export interface LLMSettingsViewProps {
  snapshot: WorkspaceSettingsSnapshot
}

export function LLMSettingsView({ snapshot }: LLMSettingsViewProps) {
  const { llm, tierProfile } = snapshot

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">LLM Settings</h1>
      <p className="text-neutral-400 text-sm">
        Read-only view of model-agnostic LLM provider slots and role bindings. Concrete model selections are
        bound in workspace configuration files without hardcoding vendor model versions in UI code.
      </p>

      <div data-testid="llm-providers-section">
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">Provider Slots</h2>
        <div className="space-y-3">
          {llm.providers.map((p) => (
            <div
              key={p.id}
              data-testid={`llm-provider-${p.id}`}
              className="p-4 rounded-lg border border-neutral-800 space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs font-mono text-neutral-500">({p.id})</span>
                </div>
                <span
                  data-testid={`llm-provider-status-${p.id}`}
                  className={`text-xs px-2 py-0.5 rounded ${
                    p.configured
                      ? "bg-green-900/30 text-green-400"
                      : "bg-neutral-800 text-neutral-500"
                  }`}
                >
                  {p.configured ? "configured" : "not configured"}
                </span>
              </div>
              <div className="text-xs text-neutral-400">{p.note}</div>
              {p.source && (
                <div className="text-xs text-neutral-500 font-mono">Source: {p.source}</div>
              )}
              {p.id === "any-llm" && (
                <div className="text-xs text-neutral-500">
                  Gateway URL environment:{" "}
                  <span className="text-neutral-400 font-mono">
                    {llm.gatewayUrlConfigured ? "GATEWAY_URL configured" : "GATEWAY_URL not set"}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div data-testid="llm-role-slots-section">
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">
          Runtime Role Slots (<code className="text-sm font-mono">{llm.jsonPath}</code>)
        </h2>
        <div className="p-4 rounded-lg border border-neutral-800 space-y-2">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="text-neutral-400">File Status</span>
            <span className="font-mono text-neutral-300">
              {llm.jsonExists ? "present" : "missing"}
            </span>
          </div>
          {llm.roleSlots.map((slot) => (
            <div
              key={slot.role}
              className="p-2.5 rounded bg-neutral-900/70 border border-neutral-800 flex items-center justify-between text-xs"
            >
              <span className="font-mono font-medium text-neutral-200">{slot.role}</span>
              <span className="font-mono text-neutral-400">
                {slot.configured ? `configured (${slot.provider ?? "custom"})` : "not configured"}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">Configuration Sources</h2>
        <div className="p-4 rounded-lg border border-neutral-800 space-y-2 text-sm text-neutral-400">
          <div>
            Default Provider:{" "}
            <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-xs font-mono text-neutral-200">
              {llm.defaultProvider ?? "not declared"}
            </code>
          </div>
          <div>
            Provider overrides:{" "}
            <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-xs font-mono">
              {llm.yamlPath}
            </code>{" "}
            ({llm.yamlExists ? "present" : "not present — using defaults"})
          </div>
          <div>
            Role slot bindings:{" "}
            <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-xs font-mono">
              {llm.jsonPath}
            </code>{" "}
            ({llm.jsonExists ? "present" : "missing"})
          </div>
          <div>
            Runner tier profile template:{" "}
            <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-xs font-mono">
              {tierProfile.examplePath}
            </code>{" "}
            →{" "}
            <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-xs font-mono">
              {tierProfile.path}
            </code>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">API Keys</h2>
        <div className="p-4 rounded-lg border border-neutral-800 text-sm text-neutral-400">
          <p>
            API keys are stored in{" "}
            <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-xs">data-private/.env</code>{" "}
            (gitignored) or process environment variables referenced by{" "}
            <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-xs">apiKeyEnv</code>.
          </p>
          <p className="mt-1 text-neutral-500">
            Secrets are never read or displayed by the Settings inspector.
          </p>
        </div>
      </div>
    </div>
  )
}
