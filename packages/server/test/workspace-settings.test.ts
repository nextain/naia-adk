import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createServer } from "../src/server.js"
import { inspectWorkspaceSettings } from "../src/workspace-settings.js"

describe("workspace-settings inspector & GET /api/workspace/settings", () => {
  let tmpRoot: string
  let tmpBinDir: string
  let tmpHomeDir: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "naia-settings-root-"))
    tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "naia-settings-bin-"))
    tmpHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "naia-settings-home-"))
    fs.mkdirSync(path.join(tmpRoot, ".agents", "context"), { recursive: true })
    fs.mkdirSync(path.join(tmpRoot, "config"), { recursive: true })
    fs.mkdirSync(path.join(tmpRoot, "naia-settings"), { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, "AGENTS.md"), "# AGENTS\n", "utf-8")
    fs.writeFileSync(
      path.join(tmpRoot, "config", "tier-profile.example.json"),
      JSON.stringify({ schema: "tier-profile/v1" }, null, 2),
      "utf-8",
    )
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
    fs.rmSync(tmpHomeDir, { recursive: true, force: true })
  })

  it("detects agy and muse binaries on injectable PATH when executable and reports absent when missing", () => {
    const emptySnapshot = inspectWorkspaceSettings(tmpRoot, {
      pathEnv: tmpBinDir,
      homeDir: tmpHomeDir,
    })

    const agyBefore = emptySnapshot.runners.find((r) => r.id === "agy")
    const museBefore = emptySnapshot.runners.find((r) => r.id === "muse")
    expect(agyBefore).toBeDefined()
    expect(museBefore).toBeDefined()
    expect(agyBefore?.available).toBe(false)
    expect(museBefore?.available).toBe(false)
    expect(agyBefore?.profileHooksSupported).toBe(false)
    expect(museBefore?.profileHooksSupported).toBe(true)

    const agyBin = path.join(tmpBinDir, "agy")
    const museBin = path.join(tmpBinDir, "muse")
    fs.writeFileSync(agyBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    fs.writeFileSync(museBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    fs.chmodSync(agyBin, 0o755)
    fs.chmodSync(museBin, 0o755)

    fs.mkdirSync(path.join(tmpHomeDir, ".config", "muse"), { recursive: true })
    fs.writeFileSync(path.join(tmpHomeDir, ".config", "muse", "settings.json"), "{}", "utf-8")
    fs.writeFileSync(path.join(tmpRoot, "GEMINI.md"), "@AGENTS.md\n", "utf-8")

    const detectedSnapshot = inspectWorkspaceSettings(tmpRoot, {
      pathEnv: tmpBinDir,
      homeDir: tmpHomeDir,
    })

    const agyAfter = detectedSnapshot.runners.find((r) => r.id === "agy")
    const museAfter = detectedSnapshot.runners.find((r) => r.id === "muse")
    expect(agyAfter?.available).toBe(true)
    expect(agyAfter?.configDetected).toBe(true)
    expect(museAfter?.available).toBe(true)
    expect(museAfter?.configDetected).toBe(true)
    expect(detectedSnapshot.runners.map((r) => r.id)).toEqual([
      "agy",
      "muse",
      "claude",
      "codex",
      "opencode",
      "naia-os",
    ])
  })

  it("reports config/tier-profile.json in missing, configured, and unreplaced-placeholder invalid states", () => {
    const missing = inspectWorkspaceSettings(tmpRoot, { pathEnv: "", homeDir: tmpHomeDir })
    expect(missing.tierProfile.status).toBe("missing")
    expect(missing.tierProfile.exampleExists).toBe(true)
    expect(missing.tierProfile.tiers).toEqual([])

    const tierProfilePath = path.join(tmpRoot, "config", "tier-profile.json")
    fs.writeFileSync(
      tierProfilePath,
      JSON.stringify({
        schema: "tier-profile/v1",
        priority: ["<CLI_1>", "muse"],
        tiers: {
          "2": {
            candidates: [{ cli: "<CLI_1>", model: "<TIER2_MODEL_1>" }],
          },
        },
      }),
      "utf-8",
    )

    const invalid = inspectWorkspaceSettings(tmpRoot, { pathEnv: "", homeDir: tmpHomeDir })
    expect(invalid.tierProfile.status).toBe("invalid")
    expect(invalid.tierProfile.error).toBeTruthy()

    fs.writeFileSync(
      tierProfilePath,
      JSON.stringify({
        schema: "tier-profile/v1",
        priority: ["agy", "muse"],
        worker_steps: {
          implementation: { tier: 2, candidate: "primary" },
          review: { tier: 4, candidate: "reviewer" },
        },
        tiers: {
          "2": {
            purpose: "Design and implementation",
            candidates: [
              { id: "primary", cli: "agy", model: "tier2-primary-slot", argv: ["{cli}", "--model", "{model}"] },
              { id: "secondary", cli: "muse", model: "tier2-secondary-slot", argv: ["{cli}", "--model", "{model}"] },
            ],
          },
          "4": {
            purpose: "Independent review",
            candidates: [
              { id: "reviewer", cli: "muse", model: "tier4-review-slot", argv: ["{cli}", "--model", "{model}"] },
            ],
          },
        },
      }),
      "utf-8",
    )

    const configured = inspectWorkspaceSettings(tmpRoot, { pathEnv: "", homeDir: tmpHomeDir })
    expect(configured.tierProfile.status).toBe("configured")
    expect(configured.tierProfile.priority).toEqual(["agy", "muse"])
    expect(configured.tierProfile.workerSteps).toEqual(["implementation", "review"])
    expect(configured.tierProfile.tiers).toEqual([
      {
        tier: "2",
        purpose: "Design and implementation",
        candidateCount: 2,
        clis: ["agy", "muse"],
      },
      {
        tier: "4",
        purpose: "Independent review",
        candidateCount: 1,
        clis: ["muse"],
      },
    ])
  })

  it("reports review_models strictly read-only with CFG- gate metadata and safe overrides", () => {
    fs.mkdirSync(path.join(tmpRoot, ".claude", "deploy"), { recursive: true })
    fs.writeFileSync(
      path.join(tmpRoot, ".claude", "deploy", "config.json"),
      JSON.stringify({
        review_models: {
          _comment: "CFG- approved override",
          argon: { runner: "agy", effort: "high", model: "custom-argon-slot" },
          muse: { runner: "muse", effort: "xhigh", model: "custom-muse-slot" },
        },
      }),
      "utf-8",
    )
    fs.writeFileSync(
      path.join(tmpRoot, "naia-settings", "review.json"),
      JSON.stringify({
        version: 1,
        reviewers: [{ id: "claude" }, { id: "codex" }],
      }),
      "utf-8",
    )

    const snapshot = inspectWorkspaceSettings(tmpRoot, { pathEnv: "", homeDir: tmpHomeDir })
    expect(snapshot.reviewModels.readOnly).toBe(true)
    expect(snapshot.reviewModels.approvalGate).toBe("CFG-")
    expect(snapshot.reviewModels.supportedRunners).toEqual(["agy", "muse", "codex", "claude"])
    expect(snapshot.reviewModels.deployConfigExists).toBe(true)
    expect(snapshot.reviewModels.overrideCount).toBe(2)
    expect(snapshot.reviewModels.overrides).toEqual([
      { key: "argon", runner: "agy", effort: "high" },
      { key: "muse", runner: "muse", effort: "xhigh" },
    ])
    expect(snapshot.reviewModels.reviewConfigExists).toBe(true)
    expect(snapshot.reviewModels.reviewerSlots).toEqual(["claude", "codex"])
  })

  it("never leaks secrets from llm-config.yaml, naia-settings/llm.json, or data-private/.env", () => {
    const fakeSecret = ["sk", "test", "secret", "12345678901234567890"].join("-")

    fs.writeFileSync(
      path.join(tmpRoot, ".agents", "context", "llm-config.yaml"),
      [
        "defaultProvider: naia",
        "providers:",
        "  naia:",
        "    id: naia",
        `    apiKey: ${fakeSecret}`,
        `    endpoint: https://user:${fakeSecret}@api.nextain.io/v1`,
        "  openai:",
        "    id: openai",
        `    api_key: ${fakeSecret}`,
      ].join("\n"),
      "utf-8",
    )

    fs.writeFileSync(
      path.join(tmpRoot, "naia-settings", "llm.json"),
      JSON.stringify({
        version: 1,
        api_key: fakeSecret,
        token: fakeSecret,
        main: {
          provider: "openai-compat",
          baseUrl: `http://user:${fakeSecret}@127.0.0.1:11434/v1`,
          apiKey: fakeSecret,
        },
      }),
      "utf-8",
    )

    fs.mkdirSync(path.join(tmpRoot, "data-private"), { recursive: true })
    fs.writeFileSync(
      path.join(tmpRoot, "data-private", ".env"),
      `OPENAI_API_KEY=${fakeSecret}\nNAIA_KEY=${fakeSecret}\n`,
      "utf-8",
    )

    const result = inspectWorkspaceSettings(tmpRoot, {
      pathEnv: "",
      homeDir: tmpHomeDir,
      env: { GATEWAY_URL: `https://admin:${fakeSecret}@gateway.example.com` },
    })

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(fakeSecret)
    expect(result.llm.defaultProvider).toBe("naia")
    expect(result.llm.gatewayUrlConfigured).toBe(true)
    expect(result.llm.providers.find((p) => p.id === "naia")?.configured).toBe(true)
    expect(result.llm.providers.find((p) => p.id === "openai")?.configured).toBe(true)
    expect(result.llm.providers.find((p) => p.id === "any-llm")?.configured).toBe(true)
    expect(result.llm.providers.find((p) => p.id === "anthropic")?.configured).toBe(false)
  })

  it("serves GET /api/workspace/settings through Fastify with Host guard protection", async () => {
    const app = await createServer({
      root: tmpRoot,
      port: 3141,
      host: "127.0.0.1",
    })

    try {
      const blocked = await app.inject({
        method: "GET",
        url: "/api/workspace/settings",
        headers: { host: "evil.example.com:3141" },
      })
      expect(blocked.statusCode).toBe(421)

      const res = await app.inject({
        method: "GET",
        url: "/api/workspace/settings",
        headers: { host: "localhost:3141" },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(Array.isArray(body.runners)).toBe(true)
      expect(body.runners.map((r: { id: string }) => r.id)).toEqual([
        "agy",
        "muse",
        "claude",
        "codex",
        "opencode",
        "naia-os",
      ])
      expect(body.tierProfile.path).toBe("config/tier-profile.json")
      expect(body.reviewModels.readOnly).toBe(true)
      expect(body.reviewModels.approvalGate).toBe("CFG-")
      expect(body.llm.providers.map((p: { id: string }) => p.id)).toEqual([
        "naia",
        "any-llm",
        "openai",
        "anthropic",
        "google",
      ])
    } finally {
      await app.close()
    }
  })
})
