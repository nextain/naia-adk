// PR #2 dual-locale render tests: key views render clean Korean in "ko"
// and zero unexpected Korean UI chrome in "en".
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider } from "./provider.tsx"
import { Nav } from "../components/Nav.tsx"
import { HomeTodoSummary } from "../components/HomeTodoSummary.tsx"
import { SettingsView } from "../settings/settings-view.tsx"
import { LLMSettingsView } from "../settings/llm/llm-settings-view.tsx"
import type { WorkspaceSettingsSnapshot } from "../settings/settings-data.ts"
import { DecisionList } from "../decisions/DecisionList.tsx"
import { WorkBoard } from "../work/WorkBoard.tsx"
import type { LedgerPayload } from "../work/work-ledger-view.ts"
import { default as AxMessengerPage } from "../ax/messenger/page.tsx"

const HANGUL = /[\uAC00-\uD7A3]/

function renderEn(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nProvider initialLocale="en">{node}</I18nProvider>)
}

function renderKo(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nProvider initialLocale="ko">{node}</I18nProvider>)
}

const snapshot: WorkspaceSettingsSnapshot = {
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
    sourcePath: "config/tier-profile.json",
    sourceKind: "workspace-default",
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
    deployConfigExists: true,
    overrideCount: 1,
    overrides: [{ key: "argon", runner: "agy", effort: "high" }],
    reviewConfigPath: "naia-settings/review.json",
    reviewConfigExists: true,
    reviewerSlots: ["agy"],
    reviewerCount: 1,
  },
  llm: {
    yamlPath: ".agents/context/llm-config.yaml",
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
}

const ledger: LedgerPayload = {
  configured: true,
  available: true,
  view: "board",
  observedAt: "2026-11-18T06:00:00Z",
  todayDate: "2026-11-18",
  timezone: "Asia/Seoul",
  roles: ["coder"],
  summary: { total: 1, todoCount: 1, open: 1, waiting_human: 0, escalated_human: 0, done: 0, dropped: 0, overdue: 0 },
  filteredSummary: { total: 1, todoCount: 1, open: 1, waiting_human: 0, escalated_human: 0, done: 0, dropped: 0, overdue: 0 },
  items: [
    {
      id: "w-1",
      role: "coder",
      title: "Write the dashboard summary",
      status: "open",
      due: null,
      dueDate: null,
      overdue: false,
      isTodo: true,
      createdAt: null,
      checkedAt: null,
      note: "",
      channel: "",
      msgId: "",
      quote: "",
      sourceUrl: null,
      resultLinks: [],
      workerName: null,
      hasDrive: false,
    },
  ],
  warnings: [],
}

describe("dual-locale chrome: ko shows Korean, en shows zero Korean", () => {
  it("defaults to ko without a provider (backward compatibility)", () => {
    const html = renderToStaticMarkup(<AxMessengerPage />)
    assert.ok(html.includes("Matrix 계정"))
    const navHtml = renderToStaticMarkup(<Nav initialTheme="light" initialFontSize="md" />)
    assert.ok(navHtml.includes(">문서<") || navHtml.includes("문서"))
  })

  it("Nav renders the EN|KO switcher and localized tabs", () => {
    const koHtml = renderKo(
      <Nav initialTheme="light" initialFontSize="md" hasBoard={true} hasLedger={false} hasMessenger={true} hasAxMessenger={true} todoBadgeCount={3} />,
    )
    assert.ok(koHtml.includes('data-testid="locale-switcher"'))
    assert.ok(koHtml.includes('data-testid="locale-btn-en"'))
    assert.ok(koHtml.includes('data-testid="locale-btn-ko"'))
    assert.ok(koHtml.includes(">문서<"))
    assert.ok(koHtml.includes(">할 일 3<"))

    const enHtml = renderEn(
      <Nav initialTheme="light" initialFontSize="md" hasBoard={true} hasLedger={false} hasMessenger={true} hasAxMessenger={true} todoBadgeCount={3} />,
    )
    assert.ok(enHtml.includes('data-testid="locale-switcher"'))
    assert.ok(enHtml.includes(">Docs<"))
    assert.ok(enHtml.includes(">Tasks 3<"))
    assert.equal(HANGUL.test(enHtml), false, `unexpected Korean in en Nav: ${enHtml.slice(0, 400)}`)
  })

  it("SettingsView + LLMSettingsView localize chrome but keep model-agnostic tokens", () => {
    const koHtml = renderKo(<SettingsView snapshot={snapshot} health={{ status: "ok", root: "/w" }} />)
    assert.ok(koHtml.includes(">설정<"))
    assert.ok(koHtml.includes("작업 공간 클라이언트"))
    const koLlm = renderKo(<LLMSettingsView snapshot={snapshot} />)
    assert.ok(koLlm.includes(">LLM 설정<"))

    const enHtml = renderEn(<SettingsView snapshot={snapshot} health={{ status: "ok", root: "/w" }} />)
    assert.ok(enHtml.includes(">Settings<"))
    assert.ok(enHtml.includes("config/tier-profile.json"))
    assert.equal(HANGUL.test(enHtml), false, `unexpected Korean in en SettingsView`)
    const enLlm = renderEn(<LLMSettingsView snapshot={snapshot} />)
    assert.ok(enLlm.includes(">LLM Settings<"))
    assert.equal(HANGUL.test(enLlm), false, `unexpected Korean in en LLMSettingsView`)
  })

  it("AxMessengerPage localizes labels and never leaks raw Korean banners in en", () => {
    const koHtml = renderKo(<AxMessengerPage />)
    assert.ok(koHtml.includes("Matrix 계정"))
    assert.ok(koHtml.includes(">연결<"))

    const enHtml = renderEn(<AxMessengerPage />)
    assert.ok(enHtml.includes(">Matrix Chat<"))
    assert.ok(enHtml.includes("Matrix account"))
    assert.ok(enHtml.includes(">Connect<"))
    assert.equal(HANGUL.test(enHtml), false, `unexpected Korean in en AxMessengerPage: ${enHtml.slice(0, 300)}`)
  })

  it("HomeTodoSummary localizes summary chrome", () => {
    const koHtml = renderKo(<HomeTodoSummary initialLedger={ledger} nowMs={Date.parse("2026-11-18T06:00:00Z")} />)
    assert.ok(koHtml.includes("할 일 요약"))

    const enHtml = renderEn(<HomeTodoSummary initialLedger={ledger} nowMs={Date.parse("2026-11-18T06:00:00Z")} />)
    assert.ok(enHtml.includes("Task summary"))
    assert.ok(enHtml.includes("Write the dashboard summary"))
    assert.equal(HANGUL.test(enHtml), false, `unexpected Korean in en HomeTodoSummary`)
  })

  it("DecisionList localizes section chrome", () => {
    const markdown = "## pending\n| # | Task |\n|---|---|\n| 1 | Hello |\n## done\n| # | Task |\n|---|---|\n";
    const config = { source: "adk", path: "guide.md", pendingHeading: "## pending", doneHeading: "## done" }
    const koHtml = renderKo(<DecisionList markdown={markdown} config={config} />)
    assert.ok(koHtml.includes("지금 정할 것"))

    const enHtml = renderEn(<DecisionList markdown={markdown} config={config} />)
    assert.ok(enHtml.includes("To decide now"))
    assert.equal(HANGUL.test(enHtml), false, `unexpected Korean in en DecisionList`)
  })

  it("WorkBoard localizes board chrome with ASCII ledger data", () => {
    const koHtml = renderKo(
      <WorkBoard status="ready" ledger={ledger} hasBoard={false} initialTab="summary" onRefresh={() => {}} />,
    )
    assert.ok(koHtml.includes("작업 보드"))

    const enHtml = renderEn(
      <WorkBoard status="ready" ledger={ledger} hasBoard={false} initialTab="summary" onRefresh={() => {}} />,
    )
    assert.ok(enHtml.includes("Work board"))
    assert.equal(HANGUL.test(enHtml), false, `unexpected Korean in en WorkBoard`)
  })

})
