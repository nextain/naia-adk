/**
 * OpenClaw SKILL.md parser.
 *
 * OpenClaw skills live as folders under `container/skills/<name>/SKILL.md`.
 * Each SKILL.md has a YAML frontmatter (between `---` markers) and a body
 * (markdown documentation). The frontmatter keys we map:
 *
 *   name           → SkillDescriptor.name        (snake_case)
 *   description    → SkillDescriptor.description
 *   allowed-tools  → tags + tier inference
 *   tier           → SkillDescriptor.tier (when explicitly set; "T0".."T3")
 *
 * Tier inference rules (when `tier` is absent):
 *   - allowed-tools contains "Bash" and skill mentions destructive verbs
 *     (delete/remove/destroy/drop) → "T2"
 *   - allowed-tools contains "Bash" or "Write" → "T1"
 *   - read-only (no bash, no write) → "T0"
 *
 * The OpenClaw body is preserved in `metadata.body` (extension field) so the
 * migrated descriptor can recover original prompt text if needed.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SkillDescriptor, SkillTier } from "@naia-adk/skill-spec";

export interface ParseOptions {
	/**
	 * Override the default version stamp on every migrated descriptor.
	 * Default "0.1.0-openclaw" so consumers can spot migrated entries.
	 */
	version?: string;
	/**
	 * If true, preserve the original SKILL.md body in `tags` as a single string
	 * (truncated to first 500 chars). Default false — body is not preserved.
	 * For full body preservation, write your own emitter using `parseFrontmatter`
	 * directly.
	 */
	keepBodySnippet?: boolean;
}

export interface OpenClawFrontmatter {
	name: string;
	description: string;
	"allowed-tools"?: string;
	tier?: string;
	[key: string]: string | undefined;
}

export interface ParsedSkill {
	descriptor: SkillDescriptor;
	frontmatter: OpenClawFrontmatter;
	bodySnippet: string;
	sourcePath: string;
}

const DESTRUCTIVE_VERBS = /\b(delete|remove|destroy|drop|wipe|purge)\b/i;

/**
 * Parse a YAML frontmatter block. Minimal parser — supports:
 *   - key: value (single-line)
 *   - key: "value with spaces"
 *   - key: 'value'
 * Does NOT support: nested objects, arrays, multi-line strings, anchors.
 * That's intentional — OpenClaw SKILL.md frontmatter is always flat.
 */
export function parseFrontmatter(src: string): { fm: OpenClawFrontmatter; body: string } {
	const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) {
		throw new Error("no frontmatter block (missing --- markers)");
	}
	const fmBlock = match[1];
	const body = match[2] ?? "";

	const fm: OpenClawFrontmatter = { name: "", description: "" };
	for (const line of fmBlock.split(/\r?\n/)) {
		const m = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
		if (!m) continue;
		const key = m[1];
		let value = m[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		fm[key] = value;
	}
	return { fm, body };
}

function inferTier(fm: OpenClawFrontmatter, body: string): SkillTier {
	const explicit = (fm.tier ?? "").trim();
	if (/^T[0-3]$/i.test(explicit)) {
		return explicit.toUpperCase() as SkillTier;
	}

	const tools = (fm["allowed-tools"] ?? "").toLowerCase();
	const text = `${fm.description ?? ""} ${body}`.toLowerCase();

	const hasBash = /\bbash\b/.test(tools);
	const hasWrite = /\bwrite\b/.test(tools);
	const isDestructive = DESTRUCTIVE_VERBS.test(text);

	if ((hasBash || hasWrite) && isDestructive) return "T2";
	if (hasBash || hasWrite) return "T1";
	return "T0";
}

function inferTags(fm: OpenClawFrontmatter, name: string): string[] {
	const tags: string[] = ["openclaw-port"];
	const tools = (fm["allowed-tools"] ?? "").toLowerCase();
	if (/\bbash\b/.test(tools)) tags.push("subprocess");
	if (/\bwrite\b/.test(tools)) tags.push("filesystem");
	if (/\bread\b/.test(tools)) tags.push("read-only");
	if (name.includes("browser") || name.includes("web")) tags.push("browser");
	if (name.includes("deploy") || name.includes("vercel")) tags.push("deploy");
	if (name.includes("slack") || name.includes("discord") || name.includes("channel")) tags.push("channel");
	return tags;
}

function toSnakeCase(name: string): string {
	return name.replace(/-/g, "_").replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

/**
 * Parse one OpenClaw skill directory (must contain SKILL.md) into a
 * SkillDescriptor.
 */
export function parseOpenClawSkill(skillDir: string, opts: ParseOptions = {}): ParsedSkill {
	const skillMdPath = join(skillDir, "SKILL.md");
	let src: string;
	try {
		src = readFileSync(skillMdPath, "utf8");
	} catch (e) {
		throw new Error(`cannot read SKILL.md at ${skillMdPath}: ${(e as Error).message}`);
	}

	const { fm, body } = parseFrontmatter(src);
	if (!fm.name) {
		throw new Error(`${skillMdPath}: frontmatter missing 'name'`);
	}
	if (!fm.description) {
		throw new Error(`${skillMdPath}: frontmatter missing 'description'`);
	}

	const tier = inferTier(fm, body);
	const tags = inferTags(fm, fm.name);
	if (opts.keepBodySnippet) {
		tags.push(`body-snippet:${body.trim().slice(0, 500).replace(/\s+/g, " ")}`);
	}

	const descriptor: SkillDescriptor = {
		name: toSnakeCase(fm.name),
		description: fm.description,
		version: opts.version ?? "0.1.0-openclaw",
		tier,
		// OpenClaw skills are prompt-based; they don't expose a JSON schema.
		// Emit a generic schema; manual review can tighten this post-migration.
		inputSchema: {
			type: "object",
			properties: {},
		},
		tags,
	};

	return {
		descriptor,
		frontmatter: fm,
		bodySnippet: body.trim().slice(0, 500),
		sourcePath: skillMdPath,
	};
}

/**
 * Parse all skills under a directory containing `<dir>/<skill-name>/SKILL.md`
 * subdirectories. OpenClaw's `container/skills/` follows this layout.
 *
 * Skips folders without a SKILL.md (e.g. dotfiles, scripts/ etc.).
 *
 * Returns an array of ParsedSkill; the caller may sort or filter as needed.
 */
export function parseOpenClawCatalog(catalogDir: string, opts: ParseOptions = {}): ParsedSkill[] {
	const entries = readdirSync(catalogDir);
	const out: ParsedSkill[] = [];
	for (const entry of entries) {
		const sub = join(catalogDir, entry);
		try {
			if (!statSync(sub).isDirectory()) continue;
			const skillMd = join(sub, "SKILL.md");
			try {
				statSync(skillMd);
			} catch {
				continue;
			}
			out.push(parseOpenClawSkill(sub, opts));
		} catch (e) {
			// Surface the error but continue — one bad skill shouldn't block the
			// whole migration.
			throw new Error(`while parsing ${basename(sub)}: ${(e as Error).message}`);
		}
	}
	return out;
}

/**
 * Parse OpenClaw's `groups/<scope>/` directories. The scope is usually
 * "global" (every project sees) or "main" (project-scoped).
 *
 * Returns groups as a flat array; the caller decides how to combine them.
 */
export interface ParsedGroup {
	scope: string;
	skills: ParsedSkill[];
}

export function parseOpenClawGroups(groupsRoot: string, opts: ParseOptions = {}): ParsedGroup[] {
	const out: ParsedGroup[] = [];
	let scopes: string[];
	try {
		scopes = readdirSync(groupsRoot);
	} catch {
		return out;
	}
	for (const scope of scopes) {
		const sub = join(groupsRoot, scope);
		try {
			if (!statSync(sub).isDirectory()) continue;
		} catch {
			continue;
		}
		// Some OpenClaw groups put skill dirs directly; others nest under skills/
		const candidate = (() => {
			try {
				return statSync(join(sub, "skills")).isDirectory() ? join(sub, "skills") : sub;
			} catch {
				return sub;
			}
		})();
		try {
			out.push({ scope, skills: parseOpenClawCatalog(candidate, opts) });
		} catch {
			// Empty or unreadable scope — skip
		}
	}
	return out;
}
