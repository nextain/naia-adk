import { describe, expect, it } from "vitest";
import {
  ALPHA_EXAMPLE_PERSONA,
  NAIA_DEFAULT_PERSONA,
  type PersonaSpec,
} from "../index.js";

describe("PersonaSpec — default + alpha example", () => {
  it("NAIA_DEFAULT_PERSONA has all required fields", () => {
    expect(NAIA_DEFAULT_PERSONA.label).toBe("Naia");
    expect(NAIA_DEFAULT_PERSONA.identity).toBeTruthy();
    expect(NAIA_DEFAULT_PERSONA.tone).toBeTruthy();
    expect(NAIA_DEFAULT_PERSONA.language).toBe("en");
  });

  it("ALPHA_EXAMPLE_PERSONA is Korean default", () => {
    expect(ALPHA_EXAMPLE_PERSONA.label).toBe("alpha");
    expect(ALPHA_EXAMPLE_PERSONA.language).toBe("ko");
    expect(ALPHA_EXAMPLE_PERSONA.systemPromptPrefix).toContain("alpha");
  });

  it("guidelines.do/dont are non-empty arrays", () => {
    for (const p of [NAIA_DEFAULT_PERSONA, ALPHA_EXAMPLE_PERSONA]) {
      expect(p.guidelines?.do?.length ?? 0).toBeGreaterThan(0);
      expect(p.guidelines?.dont?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("PersonaSpec type allows custom forks", () => {
    const bob: PersonaSpec = {
      label: "bob",
      identity: "bob's AI assistant",
      tone: "professional",
      language: "en",
    };
    expect(bob.label).toBe("bob");
  });
});
