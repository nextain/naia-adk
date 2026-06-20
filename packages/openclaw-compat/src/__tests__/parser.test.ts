import { describe, expect, it } from "vitest";
import { parseFrontmatter, parseOpenClawSkill, parseOpenClawCatalog, parseOpenClawGroups } from "../parser.js";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Integration tests against a real OpenClaw checkout. The OpenClaw skills tree is
// an external reference repo (not vendored here), so point at it via env var and
// skip when it is absent — keeps the suite green in CI / for contributors.
const REAL_OPENCLAW = process.env.OPENCLAW_SKILLS_DIR ?? "";
const hasRealOpenClaw = REAL_OPENCLAW !== "" && existsSync(REAL_OPENCLAW);

describe("parseFrontmatter", () => {
	it("parses minimal frontmatter (name + description)", () => {
		const src = "---\nname: foo\ndescription: bar\n---\nbody here";
		const { fm, body } = parseFrontmatter(src);
		expect(fm.name).toBe("foo");
		expect(fm.description).toBe("bar");
		expect(body).toBe("body here");
	});

	it("strips surrounding quotes from values", () => {
		const { fm } = parseFrontmatter(`---\nname: "quoted"\ndesc: 'single'\n---\n`);
		expect(fm.name).toBe("quoted");
		expect(fm.desc).toBe("single");
	});

	it("preserves arbitrary frontmatter keys (allowed-tools, tier, etc.)", () => {
		const src = `---\nname: x\ndescription: y\nallowed-tools: Bash(foo:*)\ntier: T2\n---\n`;
		const { fm } = parseFrontmatter(src);
		expect(fm["allowed-tools"]).toBe("Bash(foo:*)");
		expect(fm.tier).toBe("T2");
	});

	it("throws when no frontmatter block is present", () => {
		expect(() => parseFrontmatter("just a body")).toThrow(/no frontmatter block/);
	});

	it("handles CRLF line endings (Windows)", () => {
		const src = "---\r\nname: foo\r\ndescription: bar\r\n---\r\nbody";
		const { fm, body } = parseFrontmatter(src);
		expect(fm.name).toBe("foo");
		expect(body).toBe("body");
	});
});

describe.skipIf(!hasRealOpenClaw)("parseOpenClawSkill — against real OpenClaw skills", () => {
	it("parses agent-browser correctly", () => {
		const parsed = parseOpenClawSkill(join(REAL_OPENCLAW, "agent-browser"));
		expect(parsed.descriptor.name).toBe("agent_browser");
		expect(parsed.descriptor.description).toMatch(/Browse the web/);
		expect(parsed.descriptor.tier).toBe("T1"); // allowed-tools has Bash, no destructive verbs in description
		expect(parsed.descriptor.tags).toContain("openclaw-port");
		expect(parsed.descriptor.tags).toContain("subprocess"); // Bash() → subprocess tag
		expect(parsed.descriptor.tags).toContain("browser");
		expect(parsed.descriptor.version).toBe("0.1.0-openclaw");
	});

	it("parses welcome correctly", () => {
		const parsed = parseOpenClawSkill(join(REAL_OPENCLAW, "welcome"));
		expect(parsed.descriptor.name).toBe("welcome");
		expect(parsed.descriptor.description).toMatch(/Introduce yourself/);
		// No allowed-tools → tier T0 (read-only)
		expect(parsed.descriptor.tier).toBe("T0");
	});

	it("parses vercel-cli (deploy tag)", () => {
		const parsed = parseOpenClawSkill(join(REAL_OPENCLAW, "vercel-cli"));
		expect(parsed.descriptor.name).toBe("vercel_cli");
		expect(parsed.descriptor.tags).toContain("deploy");
	});

	it("parses slack-formatting (channel tag)", () => {
		const parsed = parseOpenClawSkill(join(REAL_OPENCLAW, "slack-formatting"));
		expect(parsed.descriptor.name).toBe("slack_formatting");
		expect(parsed.descriptor.tags).toContain("channel");
	});

	it("throws when name is missing", () => {
		const tmp = mkdtempSync(join(tmpdir(), "openclaw-test-"));
		try {
			mkdirSync(join(tmp, "broken"));
			writeFileSync(
				join(tmp, "broken", "SKILL.md"),
				"---\ndescription: no name here\n---\nbody",
			);
			expect(() => parseOpenClawSkill(join(tmp, "broken"))).toThrow(/missing 'name'/);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	it("respects explicit tier in frontmatter (T2)", () => {
		const tmp = mkdtempSync(join(tmpdir(), "openclaw-test-"));
		try {
			mkdirSync(join(tmp, "destructive"));
			writeFileSync(
				join(tmp, "destructive", "SKILL.md"),
				"---\nname: foo\ndescription: bar\ntier: T2\n---\nbody",
			);
			const parsed = parseOpenClawSkill(join(tmp, "destructive"));
			expect(parsed.descriptor.tier).toBe("T2");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	it("infers T2 for destructive verbs in description with Bash tool", () => {
		const tmp = mkdtempSync(join(tmpdir(), "openclaw-test-"));
		try {
			mkdirSync(join(tmp, "dangerous"));
			writeFileSync(
				join(tmp, "dangerous", "SKILL.md"),
				"---\nname: rm\ndescription: delete files from disk permanently\nallowed-tools: Bash(rm:*)\n---\nuse rm to delete",
			);
			const parsed = parseOpenClawSkill(join(tmp, "dangerous"));
			expect(parsed.descriptor.tier).toBe("T2");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});

describe.skipIf(!hasRealOpenClaw)("parseOpenClawCatalog — full OpenClaw catalog", () => {
	it("parses all 6 OpenClaw production skills without errors", () => {
		const skills = parseOpenClawCatalog(REAL_OPENCLAW);
		expect(skills.length).toBeGreaterThanOrEqual(6);
		const names = skills.map((s) => s.descriptor.name).sort();
		// Expected: agent_browser, frontend_engineer, self_customize,
		//           slack_formatting, vercel_cli, welcome
		expect(names).toContain("agent_browser");
		expect(names).toContain("welcome");
		expect(names).toContain("vercel_cli");
	});

	it("every descriptor has the openclaw-port tag", () => {
		const skills = parseOpenClawCatalog(REAL_OPENCLAW);
		for (const s of skills) {
			expect(s.descriptor.tags).toContain("openclaw-port");
		}
	});

	it("skips entries without SKILL.md", () => {
		const tmp = mkdtempSync(join(tmpdir(), "openclaw-test-"));
		try {
			// One valid, one missing SKILL.md
			mkdirSync(join(tmp, "valid"));
			writeFileSync(
				join(tmp, "valid", "SKILL.md"),
				"---\nname: valid\ndescription: ok\n---\n",
			);
			mkdirSync(join(tmp, "no-skillmd"));
			writeFileSync(join(tmp, "no-skillmd", "readme.txt"), "no skill here");
			const skills = parseOpenClawCatalog(tmp);
			expect(skills).toHaveLength(1);
			expect(skills[0].descriptor.name).toBe("valid");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});

describe("parseOpenClawGroups", () => {
	it("returns empty array for non-existent root", () => {
		const groups = parseOpenClawGroups("/nonexistent/path/that/does/not/exist");
		expect(groups).toEqual([]);
	});

	it("parses scope folders that contain a skills/ subdir", () => {
		const tmp = mkdtempSync(join(tmpdir(), "openclaw-groups-"));
		try {
			mkdirSync(join(tmp, "global", "skills", "first"), { recursive: true });
			writeFileSync(
				join(tmp, "global", "skills", "first", "SKILL.md"),
				"---\nname: first\ndescription: a\n---\n",
			);
			mkdirSync(join(tmp, "main", "skills", "second"), { recursive: true });
			writeFileSync(
				join(tmp, "main", "skills", "second", "SKILL.md"),
				"---\nname: second\ndescription: b\n---\n",
			);

			const groups = parseOpenClawGroups(tmp);
			expect(groups.map((g) => g.scope).sort()).toEqual(["global", "main"]);
			expect(groups.find((g) => g.scope === "global")?.skills[0]?.descriptor.name).toBe("first");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});
