#!/usr/bin/env node
/**
 * Cascade Rule Check Hook (PostToolUse on Edit|Write)
 *
 * Detects edits to context files and reminds agent to update mirrors.
 * Based on project-index.yaml mirror_pairs and triple-mirror structure.
 *
 * Pattern: .agents/context/*.yaml edited → remind .users/context/*.md + .users/context/ko/*.md
 */

const fs = require("fs");
const path = require("path");

async function main() {
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
	}

	let data;
	try {
		data = JSON.parse(input);
	} catch {
		process.exit(0);
	}

	const toolName = data.tool_name || "";
	const filePath = data.tool_input?.file_path || data.parameters?.file_path || "";

	if (toolName !== "Edit" && toolName !== "Write") {
		process.exit(0);
	}

	const reminders = [];

	// Normalize path for matching
	const normalized = filePath.replace(/\\/g, "/");

	// Pattern 1: .agents/context/*.yaml or .agents/context/*.json → remind .users/ mirrors
	const agentsMatch = normalized.match(/\.agents\/context\/([^/]+)\.(yaml|json)$/);
	if (agentsMatch) {
		const baseName = agentsMatch[1];
		const usersKo = `.users/context/${baseName}.md`;
		const usersEn = `.users/context/en/${baseName}.md`;
		reminders.push(
			`[Harness] You edited .agents/context/${baseName}.${agentsMatch[2]}. ` +
				`Triple-mirror rule: also update ${usersKo} and ${usersEn} if they exist.`,
		);
	}

	// Pattern 2: .users/context/*.md (not in en/) → remind .agents/ and .users/context/en/
	const usersKoMatch = normalized.match(/\.users\/context\/([^/]+)\.md$/);
	if (usersKoMatch && !normalized.includes("/en/")) {
		const baseName = usersKoMatch[1];
		reminders.push(
			`[Harness] You edited .users/context/${baseName}.md. ` +
				`Triple-mirror rule: also update .agents/context/${baseName}.yaml (or .json) and .users/context/en/${baseName}.md if they exist.`,
		);
	}

	// Pattern 3: .users/context/en/*.md → remind .agents/ and .users/context/
	const usersEnMatch = normalized.match(/\.users\/context\/en\/([^/]+)\.md$/);
	if (usersEnMatch) {
		const baseName = usersEnMatch[1];
		reminders.push(
			`[Harness] You edited .users/context/en/${baseName}.md. ` +
				`Triple-mirror rule: also update .agents/context/${baseName}.yaml (or .json) and .users/context/${baseName}.md if they exist.`,
		);
	}

	// Pattern 5: .agents/skills/*/SKILL.md → remind .users/skills/
	const agentsSkillMatch = normalized.match(/\.agents\/skills\/([^/]+)\/SKILL\.md$/);
	if (agentsSkillMatch) {
		const skillName = agentsSkillMatch[1];
		reminders.push(
			`[Harness] You edited .agents/skills/${skillName}/SKILL.md. ` +
				`Mirror rule: also update .users/skills/${skillName}/SKILL.md if it exists.`,
		);
	}

	// Pattern 6: .users/skills/*/SKILL.md → remind .agents/skills/
	const usersSkillMatch = normalized.match(/\.users\/skills\/([^/]+)\/SKILL\.md$/);
	if (usersSkillMatch) {
		const skillName = usersSkillMatch[1];
		reminders.push(
			`[Harness] You edited .users/skills/${skillName}/SKILL.md. ` +
				`Mirror rule: also update .agents/skills/${skillName}/SKILL.md if it exists.`,
		);
	}

	// Pattern 4: agents-rules.json specifically → strongest reminder (SoT)
	if (normalized.endsWith("agents-rules.json")) {
		reminders.push(
			"[Harness] agents-rules.json is the SoT. " +
				"You MUST update .users/context/agents-rules.md and .users/context/en/agents-rules.md to match.",
		);
	}

	if (reminders.length > 0) {
		const result = {
			reason: "",
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext: reminders.join("\n"),
			},
		};
		process.stdout.write(JSON.stringify(result));
	}

	process.exit(0);
}

main().catch(() => process.exit(0));
