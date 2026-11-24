"use client"

import React from "react"
import type { WorkspaceSettingsSnapshot } from "../settings-data.ts"
import { tFor } from "../../i18n/index.ts"
import { getActiveLocale } from "../../i18n/provider.tsx"
import type { Locale } from "../../i18n/types.ts"

export interface LLMSettingsViewProps {
  snapshot: WorkspaceSettingsSnapshot
  locale?: Locale
}

export function LLMSettingsView({ snapshot, locale: localeProp }: LLMSettingsViewProps) {
  const locale = localeProp ?? getActiveLocale()
  const { llm, tierProfile } = snapshot
  const t = tFor(locale)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t("llm.title")}</h1>
      <p className="text-neutral-400 text-sm">
        {t("llm.desc")}
      </p>

      <div data-testid="llm-providers-section">
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">{t("llm.providerSlots")}</h2>
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
          {t("llm.roleSlots")} (<code className="text-sm font-mono">{llm.jsonPath}</code>)
        </h2>
        <div className="p-4 rounded-lg border border-neutral-800 space-y-2">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="text-neutral-400">{t("llm.fileStatus")}</span>
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
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">{t("llm.configSources")}</h2>
        <div className="p-4 rounded-lg border border-neutral-800 space-y-2 text-sm text-neutral-400">
          <div>
            {t("llm.defaultProvider")}{" "}
            <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-xs font-mono text-neutral-200">
              {llm.defaultProvider ?? t("llm.notDeclared")}
            </code>
          </div>
          <div>
            {t("llm.providerOverrides")}{" "}
            <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-xs font-mono">
              {llm.yamlPath}
            </code>{" "}
            ({llm.yamlExists ? "present" : "not present — using defaults"})
          </div>
          <div>
            {t("llm.roleBindings")}{" "}
            <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-xs font-mono">
              {llm.jsonPath}
            </code>{" "}
            ({llm.jsonExists ? "present" : "missing"})
          </div>
          <div>
            {t("llm.runnerTemplate")}{" "}
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
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">{t("llm.apiKeys")}</h2>
        <div className="p-4 rounded-lg border border-neutral-800 text-sm text-neutral-400">
          <p>
            {t("llm.apiKeysDesc")}{" "}
            <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-xs">data-private/.env</code>{" "}
            (gitignored) + process env <code className="bg-neutral-800 px-1.5 py-0.5 rounded text-xs">apiKeyEnv</code>
          </p>
          <p className="mt-1 text-neutral-500">
            {t("llm.apiKeysSecret")}
          </p>
        </div>
      </div>
    </div>
  )
}
