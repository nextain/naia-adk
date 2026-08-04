import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { getApiKey, getProvider, loadLLMConfig } from "./index.js"

const originalEnv = { ...process.env }

afterEach(() => { process.env = { ...originalEnv } })

describe("Naia account defaults", () => {
  it("works from a fresh clone with NAIA_KEY", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "naia-anyllm-"))
    process.env.NAIA_KEY = "gw-test-only"
    const config = loadLLMConfig(root)
    const provider = getProvider(config)
    expect(config.defaultProvider).toBe("naia")
    expect(provider.endpoint).toBe("https://api.nextain.io/v1")
    expect(getApiKey(provider)).toBe("gw-test-only")
  })

  it("keeps built-in providers when a local config overrides one provider", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "naia-anyllm-"))
    const dir = path.join(root, ".agents", "context")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "llm-config.yaml"), "providers:\n  naia:\n    endpoint: https://example.test/v1\n")
    const config = loadLLMConfig(root)
    expect(config.providers.naia.endpoint).toBe("https://example.test/v1")
    expect(config.providers.naia.apiKeyEnv).toBe("NAIA_KEY")
    expect(config.providers.openai).toBeDefined()
  })

  it("prefers NAIA_KEY and accepts compatibility aliases", () => {
    process.env.NAIA_KEY = "gw-canonical-test-only"
    process.env.NAIA_API_KEY = "gw-api-alias-test-only"
    process.env.NAIA_ANYLLM_API_KEY = "gw-legacy-test-only"
    const provider = getProvider(loadLLMConfig("Z:/missing"), "naia")
    expect(getApiKey(provider)).toBe("gw-canonical-test-only")
    delete process.env.NAIA_KEY
    expect(getApiKey(provider)).toBe("gw-api-alias-test-only")
    delete process.env.NAIA_API_KEY
    expect(getApiKey(provider)).toBe("gw-legacy-test-only")
  })
})
