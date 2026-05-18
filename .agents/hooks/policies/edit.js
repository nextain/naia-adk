/**
 * Tool-agnostic Edit|Write hook policies (G-OC01 part2 — neutralization).
 *
 * Pure: (data, opts?) → { allow:true } | { block:<reason> } |
 *   { postContext:<str> } | null.  No host I/O envelope, no process.exit.
 * Shared by .claude/hooks/_claude-edit-hook.js (Claude) and the pi
 * adapter. Behavior byte-identical to the part1 S3 adapters.
 *
 * design-doc unlock file is __dirname-dependent → adapter passes it via
 * opts.unlockFile (adapter knows its own __dirname). Others have no path
 * dependency.
 */
const { existsSync } = require("fs");

/** design-doc-guard. opts.unlockFile REQUIRED (adapter: resolve(__dirname,"..","design-doc-unlock")). */
function designDoc(data, opts) {
	const filePath = data.tool_input?.file_path || data.parameters?.file_path || "";
	const normalized = filePath.replace(/\\/g, "/");
	const hasDesignExt = /\.(md|txt|yaml|json)$/.test(normalized);
	const isDesignDoc =
		(/\/docs\/design\//.test(normalized) && hasDesignExt) ||
		(/\/design\//.test(normalized) && hasDesignExt) ||
		(/\/spec\//.test(normalized) && hasDesignExt);
	if (!isDesignDoc) return null;
	if (existsSync(opts.unlockFile)) return { allow: true };
	return {
		block:
			`[Harness] 설계 문서 편집 차단: ${filePath}\n` +
			"\n" +
			"설계 문서에서 AI의 역할은 리뷰어입니다 — 저자가 아닙니다.\n" +
			"편집을 계속하려면 아래 중 무엇인지 사용자에게 먼저 보고하세요:\n" +
			"\n" +
			"  (A) 오타/문법 수정        → 사용자에게 보고 후 진행 가능\n" +
			"  (B) 문서 내부 모순 수정   → 사용자에게 보고 후 진행 가능\n" +
			"  (C) 깨진 링크/참조 수정   → 사용자에게 보고 후 진행 가능\n" +
			"  (D) 설계 결정 변경        → 사용자 명시적 승인 필수\n" +
			"  (E) 구현이 설계와 다름    → 편집 금지. 에스컬레이션 경로 따를 것:\n" +
			"      1. GitHub Issue 코멘트: 설계-구현 괴리 발견 내용 + 선택지 제시\n" +
			"      2. 사용자 결정 대기\n" +
			"\n" +
			`사용자 승인 후: ${(opts && opts.unlockHint) || ".claude/design-doc-unlock"} 파일 생성 → 편집 → 파일 삭제\n`,
	};
}

/** prod-gateway-guard */
function prodGateway(data) {
	const filePath = data.tool_input?.file_path || "";
	const isEnvLocal =
		filePath.endsWith(".env.local") ||
		filePath.endsWith("/.env") ||
		filePath === ".env";
	if (!isEnvLocal) return null;
	const PROD_GATEWAY_URL = "naia-gateway-181404717065.asia-northeast3.run.app";
	const PROD_MASTER_KEY = "11ypvgv9LEBEeeOLXsJODhEyhCyQr36UzNA6nl5-Ptg";
	const contentToCheck =
		data.tool_input?.content || data.tool_input?.new_string || "";
	const hasProdUrl = contentToCheck.includes(PROD_GATEWAY_URL);
	const hasProdKey = contentToCheck.includes(PROD_MASTER_KEY);
	if (hasProdUrl || hasProdKey) {
		const detected = [
			hasProdUrl ? "prod GATEWAY_URL" : null,
			hasProdKey ? "prod MASTER_KEY" : null,
		].filter(Boolean).join(", ");
		return {
			block:
				`[Harness] prod 게이트웨이 자격증명 차단: ${detected}\n` +
				".env.local에는 dev 게이트웨이를 사용해야 합니다.\n\n" +
				"  DEV URL:  https://naia-gateway-dev-181404717065.asia-northeast3.run.app\n" +
				"  DEV KEY:  qliT3Q4SC128rtR5o2dwud0vP25tu4usuvyFAP1oGAE\n\n" +
				"prod 값은 .env.production.local에만 허용됩니다.",
		};
	}
	return null;
}

/** cascade-check (PostToolUse) — mirror reminders */
function cascadeCheck(data) {
	const filePath = data.tool_input?.file_path || data.parameters?.file_path || "";
	const reminders = [];
	const normalized = filePath.replace(/\\/g, "/");
	const agentsMatch = normalized.match(/\.agents\/context\/([^/]+)\.(yaml|json)$/);
	if (agentsMatch) {
		const baseName = agentsMatch[1];
		reminders.push(
			`[Harness] You edited .agents/context/${baseName}.${agentsMatch[2]}. ` +
				`Triple-mirror rule: also update .users/context/${baseName}.md and .users/context/en/${baseName}.md if they exist.`,
		);
	}
	const usersKoMatch = normalized.match(/\.users\/context\/([^/]+)\.md$/);
	if (usersKoMatch && !normalized.includes("/en/")) {
		const baseName = usersKoMatch[1];
		reminders.push(
			`[Harness] You edited .users/context/${baseName}.md. ` +
				`Triple-mirror rule: also update .agents/context/${baseName}.yaml (or .json) and .users/context/en/${baseName}.md if they exist.`,
		);
	}
	const usersEnMatch = normalized.match(/\.users\/context\/en\/([^/]+)\.md$/);
	if (usersEnMatch) {
		const baseName = usersEnMatch[1];
		reminders.push(
			`[Harness] You edited .users/context/en/${baseName}.md. ` +
				`Triple-mirror rule: also update .agents/context/${baseName}.yaml (or .json) and .users/context/${baseName}.md if they exist.`,
		);
	}
	const agentsSkillMatch = normalized.match(/\.agents\/skills\/([^/]+)\/SKILL\.md$/);
	if (agentsSkillMatch) {
		const skillName = agentsSkillMatch[1];
		reminders.push(
			`[Harness] You edited .agents/skills/${skillName}/SKILL.md. ` +
				`Mirror rule: also update .users/skills/${skillName}/SKILL.md if it exists.`,
		);
	}
	const usersSkillMatch = normalized.match(/\.users\/skills\/([^/]+)\/SKILL\.md$/);
	if (usersSkillMatch) {
		const skillName = usersSkillMatch[1];
		reminders.push(
			`[Harness] You edited .users/skills/${skillName}/SKILL.md. ` +
				`Mirror rule: also update .agents/skills/${skillName}/SKILL.md if it exists.`,
		);
	}
	if (normalized.endsWith("agents-rules.json")) {
		reminders.push(
			"[Harness] agents-rules.json is the SoT. " +
				"You MUST update .users/context/agents-rules.md and .users/context/en/agents-rules.md to match.",
		);
	}
	if (reminders.length > 0) return { postContext: reminders.join("\n") };
	return null;
}

module.exports = { designDoc, prodGateway, cascadeCheck };
