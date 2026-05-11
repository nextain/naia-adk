/**
 * Emit a TypeScript module from parsed OpenClaw skills.
 *
 * Produces a single .ts file that exports one `const <name>Descriptor` per
 * skill, plus an `ALL_DESCRIPTORS` array. Drop-in shape compatible with
 * `@naia-adk/skills-builtin` so the user can paste into their own catalog
 * or import directly.
 */

import type { SkillDescriptor } from "@naia-adk/skill-spec";
import type { ParsedSkill } from "./parser.js";

function descriptorVar(name: string): string {
	return `${name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())}Descriptor`;
}

function quote(value: string): string {
	return JSON.stringify(value);
}

function emitDescriptor(d: SkillDescriptor): string {
	const tags = d.tags && d.tags.length > 0 ? `\n\ttags: ${JSON.stringify(d.tags)},` : "";
	return `export const ${descriptorVar(d.name)}: SkillDescriptor = {
\tname: ${quote(d.name)},
\tdescription: ${quote(d.description)},
\tversion: ${quote(d.version)},
\ttier: ${quote(d.tier)},
\tinputSchema: ${JSON.stringify(d.inputSchema, null, "\t").replace(/\n/g, "\n\t")},${tags}
};`;
}

export function emitCatalog(skills: ParsedSkill[]): string {
	const header = `/**
 * Auto-generated from OpenClaw catalog by @naia-adk/openclaw-compat.
 * Manually edit only if you accept drift from the source SKILL.md files.
 */
import type { SkillDescriptor } from "@naia-adk/skill-spec";
`;
	const descriptors = skills.map((s) => emitDescriptor(s.descriptor)).join("\n\n");
	const all = `\nexport const ALL_OPENCLAW_DESCRIPTORS: SkillDescriptor[] = [\n${skills
		.map((s) => `\t${descriptorVar(s.descriptor.name)},`)
		.join("\n")}\n];\n`;
	return `${header}\n${descriptors}\n${all}`;
}
