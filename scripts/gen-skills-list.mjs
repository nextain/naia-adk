#!/usr/bin/env node
/**
 * gen-skills-list — `.agents/skills/<name>/SKILL.md` 들의 frontmatter 로 `.users/skills-list.md`
 *   (사람용 단일 색인 표)를 **결정론 생성**한다.
 *
 * ⚠️ 모델: skills 는 `.agents/skills/` 가 SoT. 사람용은 **색인 한 장**(skills-list.md)이다.
 *   `.users/skills/<name>/SKILL.md` 처럼 **per-skill 복사·번역은 하지 않는다**(중복·drift 원인).
 *   (hooks/commands 도 동일 — `*-list.md` 색인.)
 *
 * 사용:
 *   node scripts/gen-skills-list.mjs            # .users/skills-list.md 생성/갱신
 *   node scripts/gen-skills-list.mjs --check    # 최신인지만 (exit 0=최신, 1=갱신 필요), 쓰지 않음
 * env: SKILLS_PROJECT_ROOT (기본 cwd)
 * ESM.
 */
import fs from "fs";
import path from "path";

const ROOT = process.env.SKILLS_PROJECT_ROOT || process.cwd();
const SKILLS_DIR = path.join(ROOT, ".agents/skills");
const OUT = path.join(ROOT, ".users/skills-list.md");

// 아주 작은 frontmatter 파서 (YAML 의존 회피) — name/description/disable-model-invocation 만.
function parseFrontmatter(txt) {
	const m = txt.match(/^---\n([\s\S]*?)\n---/);
	if (!m) return {};
	const out = {};
	for (const line of m[1].split("\n")) {
		const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
		if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
	}
	return out;
}

function cell(s) { return String(s || "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim(); }

export function buildSkillsList(skillsDir = SKILLS_DIR) {
	let entries = [];
	if (fs.existsSync(skillsDir)) {
		for (const name of fs.readdirSync(skillsDir).sort()) {
			const f = path.join(skillsDir, name, "SKILL.md");
			if (name === "SKILL_TEMPLATE.md" || !fs.existsSync(f)) continue;
			const fm = parseFrontmatter(fs.readFileSync(f, "utf8"));
			const manual = String(fm["disable-model-invocation"]).toLowerCase() === "true";
			const trigger = manual ? `수동 \`/${fm.name || name}\`` : "자동(설명 조건)";
			entries.push({ name: fm.name || name, trigger, desc: fm.description || "" });
		}
	}
	const header = `# Skills 목록

> **SoT**: \`.agents/skills/\` (각 스킬의 실제 정의). 이 파일은 **사람용 단일 색인**이다.
> ⚠️ skills 는 \`.users/skills/\` 로 per-skill 복사·번역하지 않는다 — 이 색인 한 장만 둔다.
> 갱신: \`node scripts/gen-skills-list.mjs\` (결정론 생성).

| 스킬 | 파일 | 트리거 | 설명 |
|------|------|--------|------|
`;
	const rows = entries.length
		? entries.map((e) => `| ${cell(e.name)} | \`.agents/skills/${cell(e.name)}/SKILL.md\` | ${cell(e.trigger)} | ${cell(e.desc)} |`).join("\n")
		: "| _(등록된 스킬 없음)_ | — | — | — |";
	return header + rows + "\n";
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("gen-skills-list.mjs");
if (isMain) {
	const content = buildSkillsList();
	const check = process.argv.includes("--check");
	const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
	if (check) {
		const upToDate = cur === content;
		console.log(`[skills-list] ${upToDate ? "최신" : "갱신 필요"} → ${path.relative(ROOT, OUT)}`);
		process.exit(upToDate ? 0 : 1);
	}
	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	fs.writeFileSync(OUT, content);
	const n = (content.match(/^\| (?!_|스킬|---)/gm) || []).length;
	console.log(`[skills-list] 생성 → ${path.relative(ROOT, OUT)} (스킬 ${n}개)`);
}
