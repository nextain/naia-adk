import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emitCatalog } from "../emitter.js";
import { parseOpenClawCatalog } from "../parser.js";

// Integration tests against a real OpenClaw checkout (external reference repo, not
// vendored). Point at it via env var and skip when absent — keeps CI green.
const REAL_OPENCLAW = process.env.OPENCLAW_SKILLS_DIR ?? "";
const hasRealOpenClaw = REAL_OPENCLAW !== "" && existsSync(REAL_OPENCLAW);

describe.skipIf(!hasRealOpenClaw)("emitCatalog", () => {
	it("emits valid TypeScript header with import", () => {
		const skills = parseOpenClawCatalog(REAL_OPENCLAW);
		const ts = emitCatalog(skills);
		expect(ts).toContain('import type { SkillDescriptor } from "@naia-adk/skill-spec"');
		expect(ts).toContain("ALL_OPENCLAW_DESCRIPTORS");
	});

	it("emits one named export per skill (camelCase + 'Descriptor' suffix)", () => {
		const skills = parseOpenClawCatalog(REAL_OPENCLAW);
		const ts = emitCatalog(skills);
		for (const s of skills) {
			const camel = s.descriptor.name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
			expect(ts, `${s.descriptor.name} expected as export const`).toMatch(
				new RegExp(`export const ${camel}Descriptor`),
			);
		}
	});

	it("emitted TypeScript parses (round-trip via Function constructor — light syntax check)", () => {
		const skills = parseOpenClawCatalog(REAL_OPENCLAW);
		const ts = emitCatalog(skills);
		// Strip module-only syntax for plain-script evaluation:
		//   - imports (TS types only — we don't need at runtime)
		//   - `export const` → `const`
		//   - TypeScript type annotations on bindings
		const evalable = ts
			.replace(/^import [\s\S]*?;\n/m, "")
			.replace(/export const /g, "const ")
			.replace(/: SkillDescriptor\[\]/g, "")
			.replace(/: SkillDescriptor/g, "");
		// Run in a sandboxed Function — throws if not valid JS
		expect(() => new Function(`${evalable}; return ALL_OPENCLAW_DESCRIPTORS;`)()).not.toThrow();
	});

	it("preserves description, tier, tags in emitted output", () => {
		const skills = parseOpenClawCatalog(REAL_OPENCLAW);
		const ts = emitCatalog(skills);
		const agentBrowser = skills.find((s) => s.descriptor.name === "agent_browser");
		expect(agentBrowser).toBeDefined();
		expect(ts).toContain(agentBrowser?.descriptor.description ?? "");
		expect(ts).toContain('tier: "T1"');
		expect(ts).toContain("openclaw-port");
	});
});
