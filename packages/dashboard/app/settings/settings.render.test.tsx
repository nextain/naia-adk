import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { SettingsView } from "./settings-view.tsx"
import { LLMSettingsView } from "./llm/llm-settings-view.tsx"
import type { WorkspaceSettingsSnapshot } from "./settings-data.ts"

const configuredSnapshot: WorkspaceSettingsSnapshot = {
  runners: [
    {
      id: "agy",
      label: "agy",
      binary: "agy",
      available: true,
      profileHooksSupported: false,
      roles: ["tier-worker", "independent-reviewer", "sandbox"],
      configDetected: true,
    },
    {
      id: "muse",
      label: "muse",
      binary: "muse",
      available: true,
      profileHooksSupported: true,
      roles: ["tier-worker", "independent-reviewer", "profile-hooks"],
      configDetected: true,
    },
    {
      id: "claude",
      label: "Claude Code",
      binary: "claude",
      available: true,
      profileHooksSupported: true,
      roles: ["tier-worker", "independent-reviewer", "profile-hooks"],
      configDetected: true,
    },
    {
      id: "codex",
      label: "Codex",
      binary: "codex",
      available: false,
      profileHooksSupported: true,
      roles: ["tier-worker", "independent-reviewer", "profile-hooks"],
      configDetected: false,
    },
    {
      id: "opencode",
      label: "opencode",
      binary: "opencode",
      available: false,
      profileHooksSupported: false,
      roles: ["workspace-client", "tier-worker"],
      configDetected: false,
    },
    {
      id: "naia-os",
      label: "naia-os",
      binary: "naia-os",
      available: false,
      profileHooksSupported: false,
      roles: ["desktop-runtime", "local-agent"],
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
    priority: ["agy", "muse"],
    workerSteps: ["implementation", "design", "review"],
    tiers: [
      { tier: "2", purpose: "Design & implementation", candidateCount: 2, clis: ["agy", "muse"] },
      { tier: "4", purpose: "Independent review", candidateCount: 1, clis: ["muse"] },
    ],
  },
  reviewModels: {
    readOnly: true,
    approvalGate: "CFG-",
    supportedRunners: ["agy", "muse", "codex", "claude"],
    deployConfigPath: ".claude/deploy/config.json",
    deployConfigExists: true,
    overrideCount: 2,
    overrides: [
      { key: "argon", runner: "agy", effort: "high" },
      { key: "muse", runner: "muse", effort: "xhigh" },
    ],
    reviewConfigPath: "naia-settings/review.json",
    reviewConfigExists: true,
    reviewerSlots: ["claude", "codex"],
    reviewerCount: 2,
  },
  llm: {
    yamlPath: ".agents/context/llm-config.yaml",
    yamlExists: true,
    jsonPath: "naia-settings/llm.json",
    jsonExists: true,
    defaultProvider: "naia",
    gatewayUrlConfigured: true,
    roleSlots: [
      { role: "main", configured: true, provider: "openai-compat" },
      { role: "sub", configured: true, provider: "openai-compat" },
      { role: "embedded", configured: true, provider: "ollama-embed" },
    ],
    providers: [
      {
        id: "naia",
        name: "Naia Account",
        configured: true,
        source: ".agents/context/llm-config.yaml",
        note: "Workspace gateway provider slot",
      },
      {
        id: "any-llm",
        name: "Any-LLM Gateway",
        configured: true,
        source: "GATEWAY_URL",
        note: "Unified proxy gateway slot",
      },
      {
        id: "openai",
        name: "OpenAI",
        configured: false,
        note: "Direct provider slot",
      },
      {
        id: "anthropic",
        name: "Anthropic",
        configured: false,
        note: "Direct provider slot",
      },
      {
        id: "google",
        name: "Google",
        configured: false,
        note: "Direct provider slot",
      },
    ],
  },
  configFiles: [
    { name: "agents-rules.json", path: ".agents/context/agents-rules.json", exists: true },
    { name: "tier-profile.json", path: "config/tier-profile.json", exists: true },
    { name: "tier-profile.example.json", path: "config/tier-profile.example.json", exists: true },
    { name: "llm.json", path: "naia-settings/llm.json", exists: true },
    { name: "review.json", path: "naia-settings/review.json", exists: true },
    { name: "AGENTS.md", path: "AGENTS.md", exists: true },
  ],
}

describe("SettingsView and LLMSettingsView render", () => {
  it("renders all 6 runners (agy, muse, Claude Code, Codex, opencode, naia-os), configured tier-profile, and CFG- review_models notice", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        snapshot={configuredSnapshot}
        health={{ status: "ok", root: "/workspace/naia-adk" }}
      />,
    )

    for (const expected of [
      "agy",
      "muse",
      "Claude Code",
      "Codex",
      "opencode",
      "naia-os",
      "config/tier-profile.json",
      "review_models",
      "CFG- approval gate (read-only)",
      "naia-settings/review.json",
      "naia-settings/llm.json",
    ]) {
      assert.ok(html.includes(expected), `Expected SettingsView HTML to include "${expected}"`)
    }

    assert.ok(html.includes('data-testid="runner-card-agy"'))
    assert.ok(html.includes('data-testid="runner-card-muse"'))
    assert.ok(html.includes('data-testid="tier-profile-status-badge"'))
    assert.ok(html.includes(">configured<"))
  })

  it("renders missing tier-profile state pointing to config/tier-profile.example.json", () => {
    const missingSnapshot: WorkspaceSettingsSnapshot = {
      ...configuredSnapshot,
      tierProfile: {
        status: "missing",
        path: "config/tier-profile.json",
        sourcePath: "config/tier-profile.json",
        sourceKind: "workspace-default",
        examplePath: "config/tier-profile.example.json",
        exampleExists: true,
        priority: [],
        workerSteps: [],
        tiers: [],
      },
    }

    const html = renderToStaticMarkup(<SettingsView snapshot={missingSnapshot} health={null} />)
    assert.ok(html.includes(">missing<"))
    assert.ok(html.includes("config/tier-profile.example.json"))
  })

  it("renders LLMSettingsView with model-agnostic provider slots and zero dated vendor model strings", () => {
    const html = renderToStaticMarkup(<LLMSettingsView snapshot={configuredSnapshot} />)

    for (const providerId of ["naia", "any-llm", "openai", "anthropic", "google"]) {
      assert.ok(
        html.includes(`data-testid="llm-provider-${providerId}"`),
        `Expected LLMSettingsView to render provider slot "${providerId}"`,
      )
    }

    assert.ok(html.includes(">configured<"))
    assert.ok(html.includes(">not configured<"))
    assert.ok(html.includes("naia-settings/llm.json"))
    assert.ok(html.includes(".agents/context/llm-config.yaml"))

    const forbiddenVendorModels = [
      ["gpt", "4.1"].join("-"),
      ["claude", "sonnet", "4"].join("-"),
      ["gemini", "2.5"].join("-"),
    ]
    for (const forbidden of forbiddenVendorModels) {
      assert.ok(
        !html.includes(forbidden),
        `LLMSettingsView must not contain hardcoded vendor model "${forbidden}"`,
      )
    }
  })
})
