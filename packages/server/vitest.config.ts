import "../../scripts/test-signal-safety-setup.mjs";
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    pool: "threads",
    setupFiles: ["../../scripts/test-signal-safety-setup.mjs"],
    globalSetup: ["./test/global-setup.ts"],
    reporters: ["verbose"],
  },
})
