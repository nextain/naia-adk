/**
 * @naia-adk/openclaw-compat — OpenClaw → naia skill catalog migration.
 *
 * Reads OpenClaw SKILL.md frontmatter and emits @naia-adk/skill-spec
 * SkillDescriptor objects. Designed for one-shot migration of an OpenClaw
 * skill library into a naia-compatible catalog file.
 *
 * Quick start:
 *
 *   import { parseOpenClawCatalog, emitCatalog } from "@naia-adk/openclaw-compat";
 *   const skills = parseOpenClawCatalog("/path/to/openclaw/container/skills");
 *   const tsSource = emitCatalog(skills);
 *   fs.writeFileSync("my-catalog.ts", tsSource);
 *
 * CLI:
 *
 *   npx naia-openclaw-migrate <openclaw-skills-dir> <output-file.ts>
 */

export {
	parseFrontmatter,
	parseOpenClawSkill,
	parseOpenClawCatalog,
	parseOpenClawGroups,
	type ParseOptions,
	type OpenClawFrontmatter,
	type ParsedSkill,
	type ParsedGroup,
} from "./parser.js";

export { emitCatalog } from "./emitter.js";
