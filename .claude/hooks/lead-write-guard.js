#!/usr/bin/env node
/**
 * 3층 쓰기 막기 (PreToolUse: Bash·Edit·Write·NotebookEdit·MultiEdit·apply_patch)
 *
 * 3층(역할 세션)은 감시·평가·사용자 소통을 한다. 저장소 코드의 설계·구현·검증은 2층 일꾼에게 지시서로 맡긴다.
 * 3층 판정과 허용·예외 규칙은 lib/lead-guard.js, 설계는 docs/guides/lead-write-guard.md.
 * 역할 세션은 ADK 저장소 밖에서 돌므로 프로젝트 훅이 안 뜬다. 사용자 프로필(templates/claude-user-profile)이 절대 경로로 등록한다.
 * 기본 허용이다: 3층이 아니거나(표지 없음·일꾼·서브에이전트) 훅이 예외로 끝나면 통과한다. 막힘은 감사 기록에 남는다.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { isFileMutationTool, isShellTool } = require("./tool-names.js");
const { effectiveCommands, writtenPaths, interpreterProgram, gitClauseDirectory, resolvePathWord } = require("./lib/effective-argv.js");
const guard = require("./lib/lead-guard.js");

const GIT_WRITES = new Set(["apply", "am", "rm", "mv", "restore", "clean"]);

function block(reason, event) {
	guard.audit({ event: "block", ...event });
	process.stdout.write(JSON.stringify({ decision: "block", reason }));
	process.exit(0);
}

function guideMessage(target, rule) {
	if (rule === "self:role-file" || rule === "self:protected-path") {
		return `[3층 쓰기 막기] ${target} 는 역할 표지·훅 설정·예외 기록이라 3층이 바꿀 수 없습니다. 바꿔야 하면 대표님께 말씀드리십시오.`;
	}
	return `[3층 쓰기 막기] 3층은 저장소 코드를 직접 쓰지 않습니다(${target}). 2층 일꾼에게 지시서로 맡기십시오.\n`
		+ "1) /home/nextain/work/<일>/prompt.md 에 지시서를 씁니다(허용). 2) 한 줄로 띄웁니다: "
		+ "`claude -p --model sonnet \"$(cat /home/nextain/work/<일>/prompt.md)\" > /home/nextain/work/<일>/out.log 2>&1 &` "
		+ "(agy·muse 한 줄은 minho-kit/tier-profile.md). 3) 결과 파일을 읽고 평가합니다.\n"
		+ "허용 경로: 저장소 밖 파일, docs/common/<역할>/, .agents/progress/, .agents/work/. 긴급 예외는 대표님 허락이 있어야 하고 3층이 열 수 없습니다.";
}

function patchPaths(text) {
	const out = [];
	for (const line of String(text || "").split(/\r?\n/)) {
		const m = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) || line.match(/^\*\*\* Move to: (.+)$/);
		if (m) out.push(m[1].trim());
	}
	return out;
}

/** 파이썬·노드·루비·펄 코드가 쓰는 파일(글자 그대로 적힌 것만). */
function scriptWrites(text) {
	const out = [];
	const add = (re, pick, gate) => { let m; while ((m = re.exec(text))) if (!gate || gate(m)) out.push(pick(m)); };
	add(/\bopen\s*\(\s*(["'])(.+?)\1\s*,\s*(?:mode\s*=\s*)?(["'])([rwaxb+]+)\3/g, (m) => m[2], (m) => /[wax+]/.test(m[4]));
	add(/\bPath\s*\(\s*(["'])(.+?)\1\s*\)\.(?:write_text|write_bytes|open)/g, (m) => m[2]);
	add(/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|renameSync|unlinkSync|rmSync)\s*\(\s*(["'`])(.+?)\1/g, (m) => m[2]);
	add(/\bFile\.(?:write|binwrite)\s*\(\s*(["'])(.+?)\1/g, (m) => m[2]);
	add(/\bopen\s*(?:\([^)]*\)|\w+)\s*,\s*(["'])(?:>|>>|\+>)\s*(.*?)\1/g, (m) => m[2].trim());
	return out;
}

const nonFlags = (argv, from = 1) => { const o = []; let end = false; for (const a of argv.slice(from)) { if (a === "--") { end = true; continue; } if (end || !a.startsWith("-")) o.push(a); } return o; };

function clauseTargets(clause, command) {
	const argv = clause.argv || [];
	const head = path.basename(argv[0] || "");
	const dir = clause.dir;
	const abs = (w) => resolvePathWord(w, dir, command, clause.dirKnown) || (path.isAbsolute(w) ? w : clause.dirKnown === false ? null : path.resolve(dir, w));
	const t = [];
	const add = (w) => { const a = w && abs(w); if (a) t.push(a); };
	const heredocs = clause.heredocs || (clause.clause && clause.clause.heredocs);
	for (const [p] of writtenPaths(argv, dir, command, clause.dirKnown, heredocs)) t.push(p);
	if (head === "rm" || head === "truncate" || head === "shred" || head === "unlink") {
		const args = nonFlags(argv);
		(head === "truncate" ? args : args).forEach(add);
	}
	if (head === "mv") nonFlags(argv).forEach(add);
	if (head === "sed" || head === "perl" || head === "ruby" || head === "awk" || head === "gawk") {
		const inplace = argv.slice(1).some((a) => (head === "awk" || head === "gawk") ? /^inplace$/.test(a) : /^(--in-place(=.*)?|-[A-Za-z]*i.*)$/.test(a));
		if (inplace) {
			const hasScriptFlag = argv.slice(1).some((a) => /^(-e|-f|--expression|--file|-E)$/.test(a) || /^-[A-Za-z]*[ef]$/.test(a));
			const skipArgs = new Set();
			argv.forEach((a, i) => { if (/^(-e|-f|--expression|--file|-E|-pe|-ne)$/.test(a) && argv[i + 1]) skipArgs.add(i + 1); });
			const pos = argv.map((a, i) => [a, i]).slice(1).filter(([a, i]) => !a.startsWith("-") && !skipArgs.has(i)).map(([a]) => a);
			(hasScriptFlag || head === "perl" || head === "ruby" ? pos : pos.slice(1)).forEach(add);
		}
	}
	if (head === "patch") {
		let d = dir;
		argv.forEach((a, i) => { if (a === "-d" && argv[i + 1]) d = path.resolve(d, argv[i + 1]); else if (/^-d.+/.test(a)) d = path.resolve(d, a.slice(2)); });
		t.push(d);
	}
	if (head === "rsync") { const p = nonFlags(argv); if (p.length >= 2) add(p[p.length - 1]); }
	if (head === "dd") argv.forEach((a) => { if (a.startsWith("of=")) add(a.slice(3)); });
	if (head === "tar" && argv.slice(1).some((a) => /^-?[A-Za-z]*x/.test(a) || a === "--extract")) {
		let d = dir; argv.forEach((a, i) => { if ((a === "-C" || a === "--directory") && argv[i + 1]) d = abs(argv[i + 1]) || d; });
		t.push(d);
	}
	if (head === "git") {
		const gdir = gitClauseDirectory(clause);
		let sub = null;
		for (let i = 1; i < argv.length; i++) {
			if (/^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/.test(argv[i])) { i++; continue; }
			if (argv[i].startsWith("-")) continue;
			sub = argv[i]; break;
		}
		const hard = argv.includes("--hard") || argv.includes("--");
		if (sub && (GIT_WRITES.has(sub) || ((sub === "checkout" || sub === "reset") && hard))) t.push(gdir);
		if (sub === "apply" || sub === "am") for (const f of nonFlags(argv, argv.indexOf(sub) + 1)) { try { const text = fs.readFileSync(path.resolve(gdir, f), "utf8"); for (const p of text.split(/\r?\n/)) { const m = p.match(/^\+\+\+ (?:b\/)?([^\t]+)/) || p.match(/^diff --git a\/\S+ b\/(\S+)/); if (m && m[1] !== "/dev/null") t.push(path.resolve(gdir, m[1])); } } catch {} }
	}
	const interp = interpreterProgram(argv, heredocs);
	if (interp) {
		let body = interp.text || "";
		if (interp.file) { try { const f = path.resolve(dir, interp.file); if (fs.statSync(f).size < 1 << 20) body = fs.readFileSync(f, "utf8"); } catch {} }
		for (const w of scriptWrites(body)) add(w);
	}
	return t;
}

function main() {
	let data = {};
	try { data = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return; }
	const tool = data.tool_name;
	const isShell = isShellTool(tool);
	if (!isShell && !isFileMutationTool(tool) && !/^(multiedit)$/i.test(String(tool).split(/[.:/]/).pop())) return;
	const lead = guard.leadSession(data);
	if (!lead.lead) return;
	const input = data.tool_input || {};
	const cwd = typeof data.cwd === "string" ? data.cwd : process.cwd();
	const targets = [];
	let command = "";
	if (isShell) {
		command = String(input.command || input.cmd || "");
		for (const clause of effectiveCommands(command, cwd)) {
			if ((clause.argv || []).some((a) => /lead-guard-exception/.test(a)) && !(clause.argv || []).includes("status")) {
				block("[3층 쓰기 막기] 긴급 예외 기록은 대표님 허락으로 대표님이 엽니다. 3층은 열거나 닫을 수 없습니다.", { role: lead.role, session_id: data.session_id, tool, rule: "self:exception-script", command: command.slice(0, 300) });
			}
			targets.push(...clauseTargets(clause, command));
		}
	} else {
		const p = input.file_path || input.notebook_path || input.path || input.target_file;
		if (p) targets.push(path.resolve(cwd, p));
		for (const q of patchPaths(input.input || input.patch || input.command || input.patch_text)) targets.push(path.resolve(cwd, q));
	}
	for (const target of targets) {
		const r = guard.classify(target, lead);
		if (r.ok && r.exception) guard.audit({ event: "exception-used", exception_id: r.exception, role: lead.role, session_id: data.session_id, tool, target });
		if (!r.ok) block(guideMessage(target, r.rule), { role: lead.role, session_id: data.session_id, tool, rule: r.rule, target });
	}
}

if (require.main === module) {
	try { main(); } catch (e) { try { guard.audit({ event: "guard-error", error: String(e && e.message || e).slice(0, 200) }); } catch {} }
}
