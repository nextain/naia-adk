// fx1 repair-round regression tests: verify2 finding 5 (hard-coded Korean
// search error, wrong aria-label key on the calendar/list switcher, and two
// out-of-scope English copy changes in the settings views).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { formatMessage, tFor } from "./index.ts"
import { I18nProvider } from "./provider.tsx"
import { ScheduleControls } from "../schedule/ScheduleControls.tsx"
import type { useScheduleView } from "../schedule/useScheduleView"
import { SettingsView } from "../settings/settings-view.tsx"
import { LLMSettingsView } from "../settings/llm/llm-settings-view.tsx"
import type { WorkspaceSettingsSnapshot } from "../settings/settings-data.ts"

type View = ReturnType<typeof useScheduleView>

const snapshot = {
  runners: [
    {
      id: "agy",
      label: "agy",
      binary: "agy",
      available: true,
      profileHooksSupported: false,
      roles: ["tier-worker"],
      configDetected: true,
    },
  ],
  tierProfile: {
    status: "configured",
    path: "config/tier-profile.json",
    examplePath: "config/tier-profile.example.json",
    exampleExists: true,
    priority: ["agy"],
    workerSteps: ["implementation"],
    tiers: [{ tier: "2", purpose: "Design & implementation", candidateCount: 1, clis: ["agy"] }],
  },
  reviewModels: {
    readOnly: true,
    approvalGate: "CFG-",
    supportedRunners: ["agy"],
    deployConfigPath: ".claude/deploy/config.json",
    deployConfigExists: false,
    overrideCount: 1,
    overrides: [{ key: "argon", runner: "agy", effort: "high" }],
    reviewConfigPath: "naia-settings/review.json",
    reviewConfigExists: true,
    reviewerSlots: ["agy"],
    reviewerCount: 1,
  },
  llm: {
    yamlPath: "naia-settings/llm.json",
    yamlExists: true,
    jsonPath: "naia-settings/llm.json",
    jsonExists: true,
    defaultProvider: "naia",
    gatewayUrlConfigured: true,
    roleSlots: [{ role: "main", configured: true, provider: "openai-compat" }],
    providers: [
      { id: "naia", name: "Naia Account", configured: true, source: "file", note: "Workspace gateway provider slot" },
      { id: "any-llm", name: "Any-LLM Gateway", configured: true, source: "GATEWAY_URL", note: "Unified proxy gateway slot" },
    ],
  },
  configFiles: [{ name: "llm.json", path: "naia-settings/llm.json", exists: true }],
} as unknown as WorkspaceSettingsSnapshot

function stubView(): View {
  return {
    mode: "calendar",
    layers: { personal: true, company: true, work: true, milestone: true, queue: false },
    userLabel: null,
    personalIdentityRequired: false,
    personalWarningsLocked: false,
    personalLoading: false,
    personalUnavailable: false,
    canMutatePersonal: false,
    formOpen: false,
    formError: null,
    saving: false,
    setMode: () => {},
    toggleLayer: () => {},
    layerCounts: {},
  } as unknown as View
}

describe("fx1 finding 5: localized chrome and untouched English copy", () => {
  it("docs search failure goes through the docs.searchFailed key", () => {
    assert.equal(
      formatMessage(tFor("en")("docs.searchFailed"), { status: 500 }),
      "Search failed (500)",
    )
    assert.equal(
      formatMessage(tFor("ko")("docs.searchFailed"), { status: 500 }),
      "검색하지 못했습니다 (500)",
    )
  })

  it("calendar/list switcher group uses the sched.viewMode key", () => {
    assert.equal(tFor("en")("sched.viewMode"), "View mode")
    assert.equal(tFor("ko")("sched.viewMode"), "보기 방식")
    const enHtml = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <ScheduleControls view={stubView()} />
      </I18nProvider>,
    )
    assert.ok(enHtml.includes('aria-label="View mode"'))
    const koHtml = renderToStaticMarkup(
      <I18nProvider initialLocale="ko">
        <ScheduleControls view={stubView()} />
      </I18nProvider>,
    )
    assert.ok(koHtml.includes('aria-label="보기 방식"'))
  })

  it("settings review-config fallback keeps the base copy", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="ko">
        <SettingsView snapshot={snapshot} health={{ status: "ok", root: "/w" }} />
      </I18nProvider>,
    )
    assert.ok(html.includes("not present (using policy defaults)"))
  })

  it("llm api-keys paragraph keeps the base copy", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="ko">
        <LLMSettingsView snapshot={snapshot} />
      </I18nProvider>,
    )
    assert.ok(html.includes("or process environment variables referenced by"))
  })
})
