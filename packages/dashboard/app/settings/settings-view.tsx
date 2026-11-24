"use client"

import React from "react"
import type { ServerHealthSnapshot, WorkspaceSettingsSnapshot } from "./settings-data.ts"
import { formatMessage, tFor } from "../i18n/index.ts"
import { getActiveLocale } from "../i18n/provider.tsx"
import type { Locale } from "../i18n/types.ts"

export interface SettingsViewProps {
  snapshot: WorkspaceSettingsSnapshot
  health?: ServerHealthSnapshot | null
  locale?: Locale
}

export function SettingsView({ snapshot, health = null, locale: localeProp }: SettingsViewProps) {
  const locale = localeProp ?? getActiveLocale()
  const { runners, tierProfile, reviewModels, configFiles } = snapshot
  const t = tFor(locale)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t("settings.title")}</h1>

      <div>
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">{t("settings.llm")}</h2>
        <a
          href="/settings/llm"
          className="block p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors"
        >
          <div className="font-medium">LLM Providers &amp; Models</div>
          <div className="text-sm text-neutral-400 mt-0.5">
            {t("settings.llmDesc")}
          </div>
        </a>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">{t("settings.server")}</h2>
        <div className="p-4 rounded-lg border border-neutral-800 space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-neutral-400">{t("settings.status")}</span>
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                health ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"
              }`}
            >
              {health ? "connected" : "disconnected"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-neutral-400">{t("settings.apiPort")}</span>
            <span className="font-mono">3141</span>
          </div>
          <div className="flex justify-between">
            <span className="text-neutral-400">{t("settings.dashboardPort")}</span>
            <span className="font-mono">3142</span>
          </div>
          <div className="flex justify-between">
            <span className="text-neutral-400">{t("settings.host")}</span>
            <span className="font-mono">localhost</span>
          </div>
          {health?.root && (
            <div className="flex justify-between">
              <span className="text-neutral-400">{t("settings.workspace")}</span>
              <span className="font-mono text-xs truncate max-w-xs">{health.root}</span>
            </div>
          )}
        </div>
      </div>

      <div data-testid="settings-runners-section">
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">{t("settings.runners")}</h2>
        <div className="space-y-2">
          {runners.map((runner) => (
            <div
              key={runner.id}
              data-testid={`runner-card-${runner.id}`}
              className="p-4 rounded-lg border border-neutral-800 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{runner.label}</span>
                  <span className="text-xs font-mono text-neutral-500">({runner.binary})</span>
                </div>
                <div className="flex items-center gap-2">
                  {runner.profileHooksSupported && (
                    <span className="text-xs px-2 py-0.5 rounded bg-blue-900/30 text-blue-300">
                      profile hooks
                    </span>
                  )}
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      runner.configDetected
                        ? "bg-neutral-800 text-neutral-300"
                        : "bg-neutral-900 text-neutral-500"
                    }`}
                  >
                    {runner.configDetected ? "config detected" : "no local profile"}
                  </span>
                  <span
                    data-testid={`runner-availability-${runner.id}`}
                    className={`text-xs px-2 py-0.5 rounded ${
                      runner.available
                        ? "bg-green-900/30 text-green-400"
                        : "bg-neutral-800 text-neutral-500"
                    }`}
                  >
                    {runner.available ? "available" : "not found"}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {runner.roles.map((role) => (
                  <span
                    key={role}
                    className="text-xs px-2 py-0.5 rounded bg-neutral-900 text-neutral-400 font-mono"
                  >
                    {role}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div data-testid="settings-tier-profile-section">
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">
          {t("settings.tierProfile")} (<code className="text-sm font-mono">{tierProfile.path}</code>)
        </h2>
        <div className="p-4 rounded-lg border border-neutral-800 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-neutral-400">{t("settings.tierStatus")}</span>
            <span
              data-testid="tier-profile-status-badge"
              className={`text-xs px-2 py-0.5 rounded ${
                tierProfile.status === "configured"
                  ? "bg-green-900/30 text-green-400"
                  : tierProfile.status === "invalid"
                    ? "bg-red-900/30 text-red-400"
                    : "bg-amber-900/30 text-amber-300"
              }`}
            >
              {tierProfile.status}
            </span>
          </div>

          {tierProfile.status === "configured" && (
            <div className="space-y-2 text-sm">
              {tierProfile.priority.length > 0 && (
                <div className="flex justify-between">
                  <span className="text-neutral-400">{t("settings.cliPriority")}</span>
                  <span className="font-mono text-xs text-neutral-200">
                    {tierProfile.priority.join(" → ")}
                  </span>
                </div>
              )}
              {tierProfile.workerSteps.length > 0 && (
                <div className="flex justify-between">
                  <span className="text-neutral-400">{t("settings.workerSteps")}</span>
                  <span className="font-mono text-xs text-neutral-200">
                    {tierProfile.workerSteps.join(", ")}
                  </span>
                </div>
              )}
              <div className="space-y-1.5 pt-1">
                {tierProfile.tiers.map((tier) => (
                  <div
                    key={tier.tier}
                    data-testid={`tier-summary-${tier.tier}`}
                    className="p-2.5 rounded bg-neutral-900/70 border border-neutral-800 flex items-center justify-between text-xs"
                  >
                    <div>
                      <span className="font-mono font-medium text-neutral-200">Tier {tier.tier}</span>
                      {tier.purpose && <span className="text-neutral-400 ml-2">— {tier.purpose}</span>}
                    </div>
                    <div className="font-mono text-neutral-300">
                      {formatMessage(t("settings.tierCandidates"), {
                        clis: tier.clis.join(", "),
                        count: tier.candidateCount,
                        s: tier.candidateCount === 1 ? "" : "s",
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tierProfile.status === "missing" && (
            <div className="text-xs text-neutral-400 space-y-1">
              <p>
                {formatMessage(t("settings.tierMissingLead"), { path: tierProfile.path })}
              </p>
              <p>
                {formatMessage(t("settings.tierCopyGuide"), {
                  example: tierProfile.examplePath,
                  exampleState: tierProfile.exampleExists ? "present" : "missing",
                  path: tierProfile.path,
                })}
              </p>
            </div>
          )}

          {tierProfile.status === "invalid" && (
            <div className="text-xs text-red-400 space-y-1">
              <p>{t("settings.invalid")}: {tierProfile.error}</p>
              <p className="text-neutral-400">
                {formatMessage(t("settings.invalidGuide"), {
                  path: tierProfile.path,
                  example: tierProfile.examplePath,
                })}
              </p>
            </div>
          )}
        </div>
      </div>

      <div data-testid="settings-review-models-section">
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">
          {t("settings.reviewModels")} (<code className="text-sm font-mono">review_models</code>)
        </h2>
        <div className="p-4 rounded-lg border border-neutral-800 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-neutral-400">{t("settings.approvalPolicy")}</span>
            <span
              data-testid="review-models-gate-badge"
              className="text-xs px-2 py-0.5 rounded bg-amber-900/30 text-amber-300 font-mono"
            >
              {reviewModels.approvalGate} {t("settings.approvalGate")}
            </span>
          </div>
          <p className="text-xs text-neutral-400">
            {formatMessage(t("settings.reviewModelsGuide"), {
              path: reviewModels.deployConfigPath,
              gate: reviewModels.approvalGate,
            })}
          </p>
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-400">{t("settings.reviewRunners")}</span>
            <span className="font-mono text-neutral-200">
              {reviewModels.supportedRunners.join(", ")}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-400">
              {t("settings.deployConfig")} (<code className="font-mono">{reviewModels.deployConfigPath}</code>)
            </span>
            <span className="font-mono text-neutral-300">
              {reviewModels.deployConfigExists
                ? `present (${reviewModels.overrideCount} override${reviewModels.overrideCount === 1 ? "" : "s"})`
                : "not present (using defaults)"}
            </span>
          </div>
          {reviewModels.overrides.length > 0 && (
            <div className="space-y-1 pt-1">
              {reviewModels.overrides.map((ov) => (
                <div
                  key={ov.key}
                  className="p-2 rounded bg-neutral-900/70 border border-neutral-800 flex items-center justify-between text-xs font-mono"
                >
                  <span className="text-neutral-200">{ov.key}</span>
                  <span className="text-neutral-400">
                    runner: {ov.runner ?? "default"} · effort: {ov.effort ?? "default"}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between text-xs pt-1 border-t border-neutral-800/80">
            <span className="text-neutral-400">
              {t("settings.crossReview")} (<code className="font-mono">{reviewModels.reviewConfigPath}</code>)
            </span>
            <span className="font-mono text-neutral-300">
              {reviewModels.reviewConfigExists
                ? `present (${reviewModels.reviewerSlots.join(", ") || "0 slots"})`
                : "missing"}
            </span>
          </div>
        </div>
      </div>

      <div data-testid="settings-config-files-section">
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">{t("settings.configFiles")}</h2>
        <div className="space-y-2">
          {configFiles.map((f) => (
            <div
              key={f.path}
              className="p-3 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors flex items-center justify-between"
            >
              <div>
                <div className="font-medium font-mono text-sm">{f.name}</div>
                <div className="text-xs text-neutral-500">{f.path}</div>
              </div>
              <span
                className={`text-xs px-2 py-0.5 rounded ${
                  f.exists ? "bg-green-900/30 text-green-400" : "bg-neutral-800 text-neutral-500"
                }`}
              >
                {f.exists ? "present" : "missing"}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">{t("settings.dataDirs")}</h2>
        <div className="grid grid-cols-3 gap-3">
          {[
            { dir: "data-company", desc: "Company-wide docs", tier: "T2" },
            { dir: "data-teams", desc: "Team documents", tier: "T3" },
            { dir: "data-private", desc: "Personal data", tier: "T3+" },
            { dir: "projects", desc: "Project repos", tier: "T2" },
            { dir: "skills", desc: "AI skills", tier: "T1" },
            { dir: "scripts", desc: "Utility scripts", tier: "T1" },
          ].map((d) => (
            <div key={d.dir} className="p-3 rounded-lg border border-neutral-800">
              <div className="font-medium font-mono text-sm">{d.dir}/</div>
              <div className="text-xs text-neutral-400 mt-0.5">{d.desc}</div>
              <span className="text-xs px-2 py-0.5 rounded bg-neutral-800 text-neutral-500 mt-1 inline-block">
                {d.tier}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
